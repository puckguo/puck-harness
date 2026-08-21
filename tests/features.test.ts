/**
 * Feature tests: compaction, approval gate, skills, subagent — all offline.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, Tool } from "@puckguo123/core";
import { userMessage } from "@puckguo123/core";
import { createApprovalGate } from "@puckguo123/features/approval";
import { compactNow, createCompactionHook } from "@puckguo123/features/compaction";
import { createSubagentTool } from "@puckguo123/features/subagent";
import { createIndexedSkillTool, createSkillTool, loadAllHarnessSkills, loadHarnessSkillsDetailed, loadHarnessSkillsIndexed, loadSkillPacks, loadSkills, skillsIndexToPrompt, skillsToPrompt, type SkillIndex } from "@puckguo123/features/skills";
import { createMockStreamFn } from "@puckguo123/llm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "mock",
		stopReason: "stop",
		usage: { input: 1, output: 1, totalTokens: 2 },
		timestamp: Date.now(),
	};
}

test("compaction: summarizes the prefix and keeps recent turns", async () => {
	const summarizer = createMockStreamFn([{ text: "SUMMARY" }]);
	const hook = createCompactionHook({ streamFn: summarizer, maxTokens: 50, keepRecent: 4 });
	assert.ok(hook);

	const messages: Message[] = [];
	for (let i = 0; i < 10; i++) {
		messages.push(userMessage(`question number ${i} with some padding text to grow tokens`));
		messages.push(assistant(`answer number ${i} with some padding text to grow tokens`));
	}

	const view = await hook(messages);

	// The view is projected, not the transcript itself
	assert.ok(view.length < messages.length);
	assert.equal(view[0].role, "user");
	assert.match(String((view[0] as { content: unknown }).content), /SUMMARY/);

	// small transcripts pass through untouched
	const small = await hook([userMessage("hi"), assistant("hello")]);
	assert.equal(small.length, 2);
});

test("compaction: onCompact fires with summary + prefix size", async () => {
	const summarizer = createMockStreamFn([{ text: "S" }]);
	let fired = 0;
	let lastPrefix = -1;
	const hook = createCompactionHook({
		streamFn: summarizer as NonNullable<typeof summarizer>,
		maxTokens: 50,
		keepRecent: 4,
		onCompact: (_summary, prefixMessages) => {
			fired++;
			lastPrefix = prefixMessages;
		},
	});
	const messages: Message[] = [];
	for (let i = 0; i < 10; i++) {
		messages.push(userMessage("question number " + i + " with padding to grow tokens"));
		messages.push(assistant("answer number " + i + " with padding to grow tokens"));
	}
	if (!hook) throw new Error("hook undefined");
	await hook(messages);
	assert.equal(fired, 1);
	assert.ok(lastPrefix > 0 && lastPrefix < messages.length);
	// cached prefix → same summary, hook NOT re-fired
	await hook(messages);
	assert.equal(fired, 1);
});

const gateInfo = {
	toolCall: { type: "toolCall" as const, id: "1", name: "bash", arguments: {} },
	args: {},
	assistantMessage: assistant("x"),
};

test("approval: policy + ask wiring", async () => {
	const gate = createApprovalGate({ policy: "never" });
	assert.ok(gate);
	assert.equal((await gate(gateInfo))?.block, undefined);

	const alwaysDeny = createApprovalGate({ policy: "always" });
	assert.ok(alwaysDeny);
	const denied = await alwaysDeny(gateInfo);
	assert.equal(denied?.block, true);

	const allow = createApprovalGate({ policy: (call) => call.toolName === "bash", ask: () => true });
	assert.ok(allow);
	const allowed = await allow(gateInfo);
	assert.equal(allowed, undefined);

	// "always-allow" caches the decision per tool name
	let asked = 0;
	const sticky = createApprovalGate({ policy: "always", ask: () => { asked++; return "always-allow"; } });
	assert.ok(sticky);
	await sticky(gateInfo);
	await sticky(gateInfo);
	assert.equal(asked, 1);
});

test("skills: load from directory and expose via tool", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-skills-"));
	try {
		mkdirSync(join(dir, "deploy"));
		writeFileSync(
			join(dir, "deploy", "SKILL.md"),
			"# deploy\ndescription: deploy the service to ECS\n\nRun ecs-smartdeploy skill steps.",
		);

		const skills = await loadSkills(dir);
		assert.equal(skills.length, 1);
		assert.equal(skills[0].name, "deploy");
		assert.match(skills[0].description, /ECS/);

		assert.match(skillsToPrompt(skills), /deploy/);

		const tool: Tool = createSkillTool(skills);
		const loaded = await tool.execute({ name: "deploy" }, { cwd: dir });
		assert.match((loaded.content[0] as { text: string }).text, /ecs-smartdeploy/);

		const unknown = await tool.execute({ name: "nope" }, { cwd: dir });
		assert.equal(unknown.isError, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skills: parses claude/codex YAML frontmatter SKILL.md", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-skills-fm-"));
	try {
		// quoted-scalar form (claude)
		mkdirSync(join(dir, "implement"));
		writeFileSync(
			join(dir, "implement", "SKILL.md"),
			'---\nname: implement\ndescription: "Implement a piece of work based on a PRD."\ndisable-model-invocation: true\n---\n\nImplement the work described in the PRD.',
		);
		// block-scalar form (codex kimi-webbridge style)
		mkdirSync(join(dir, "webbridge"));
		writeFileSync(
			join(dir, "webbridge", "SKILL.md"),
			'---\nname: webbridge\ndescription: |\n  Control the user browser.\n  Navigate, click, screenshot.\n---\n\nBridge docs.',
		);

		const skills = await loadSkills(dir);
		assert.equal(skills.length, 2);
		const impl = skills.find((s) => s.name === "implement");
		const bridge = skills.find((s) => s.name === "webbridge");
		assert.ok(impl, "quoted-scalar name parsed");
		assert.equal(impl.description, "Implement a piece of work based on a PRD.");
		assert.ok(bridge, "block-scalar name parsed");
		assert.match(bridge.description, /Control the user browser\./);
		assert.match(bridge.description, /screenshot/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skills: loadAllHarnessSkills merges harness dirs and dedupes by name", async () => {
	const home = mkdtempSync(join(tmpdir(), "puck-skills-home-"));
	try {
		// same skill name in .claude and .puck → puck wins (first source)
		mkdirSync(join(home, ".puck", "skills", "deploy"), { recursive: true });
		writeFileSync(join(home, ".puck", "skills", "deploy", "SKILL.md"), "# deploy\ndescription: puck flavor\n");
		mkdirSync(join(home, ".claude", "skills", "deploy"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: claude flavor\n---\n");
		// claude-only skill is kept
		mkdirSync(join(home, ".claude", "skills", "review"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: review code\n---\n");

		const skills = await loadAllHarnessSkills(home);
		const names = skills.map((s) => s.name).sort();
		assert.deepEqual(names, ["deploy", "review"]);
		assert.equal(skills.find((s) => s.name === "deploy")?.description, "puck flavor");
		// missing dirs (.codex/.pi) are skipped silently — no throw, no entries
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("skills: dedup is case-insensitive and reports origins", async () => {
	const home = mkdtempSync(join(tmpdir(), "puck-skills-dedup-"));
	try {
		// "Deploy" (claude) vs "deploy" (codex) → one skill, claude wins
		mkdirSync(join(home, ".claude", "skills", "Deploy"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "Deploy", "SKILL.md"), "---\nname: Deploy\ndescription: claude casing\n---\n");
		mkdirSync(join(home, ".codex", "skills", "deploy"), { recursive: true });
		writeFileSync(join(home, ".codex", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: codex casing\n---\n");
		// exact same name in two harnesses also collapses
		mkdirSync(join(home, ".claude", "skills", "bridge"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "bridge", "SKILL.md"), "---\nname: bridge\ndescription: claude bridge\n---\n");
		mkdirSync(join(home, ".codex", "skills", "bridge"), { recursive: true });
		writeFileSync(join(home, ".codex", "skills", "bridge", "SKILL.md"), "---\nname: bridge\ndescription: codex bridge\n---\n");

		const detailed = await loadHarnessSkillsDetailed(home);
		assert.equal(detailed.skills.length, 2, "Deploy+deploy and bridge×2 collapse to 2");
		assert.equal(detailed.duplicates, 2);
		// canonical name is the FIRST seen (claude before codex in priority)
		const deploy = detailed.skills.find((s) => s.name.toLowerCase() === "deploy");
		assert.equal(deploy?.name, "Deploy");
		assert.equal(deploy?.description, "claude casing");
		// origins list every harness that carried the skill
		assert.deepEqual(detailed.origins.get("Deploy"), [".claude", ".codex"]);
		assert.deepEqual(detailed.origins.get("bridge"), [".claude", ".codex"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("skills: disable-model-invocation hides from prompt but stays loadable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-skills-dmi-"));
	try {
		mkdirSync(join(dir, "auto"));
		writeFileSync(join(dir, "auto", "SKILL.md"), "---\nname: auto\ndescription: fine to auto-load\n---\nbody");
		mkdirSync(join(dir, "manual"));
		writeFileSync(
			join(dir, "manual", "SKILL.md"),
			'---\nname: manual\ndescription: user only\ndisable-model-invocation: true\n---\nbody',
		);

		const skills = await loadSkills(dir);
		const manual = skills.find((s) => s.name === "manual");
		assert.equal(manual?.userInvokedOnly, true, "flag parsed");

		// prompt listing omits it (model can't discover it)…
		const prompt = skillsToPrompt(skills);
		assert.doesNotMatch(prompt, /manual/);
		assert.match(prompt, /auto/);
		// …but the tool still serves it when the user explicitly asks
		const tool: Tool = createSkillTool(skills);
		const loaded = await tool.execute({ name: "manual" }, { cwd: dir });
		assert.equal(loaded.isError, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skills: CRLF line endings parse identically (Windows-authored SKILL.md)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-skills-crlf-"));
	try {
		// quoted-scalar frontmatter with \r\n everywhere — the lark suite on
		// Windows is authored this way; $-anchored regexes silently failed
		// before, leaving description empty (model couldn't route to the skill)
		mkdirSync(join(dir, "lark-base"));
		writeFileSync(
			join(dir, "lark-base", "SKILL.md"),
			'---\r\nname: lark-base\r\ndescription: "操作飞书多维表格"\r\ndisable-model-invocation: true\r\n---\r\nbody',
		);
		// block-scalar form with CRLF
		mkdirSync(join(dir, "lark-doc"));
		writeFileSync(
			join(dir, "lark-doc", "SKILL.md"),
			'---\r\nname: lark-doc\r\ndescription: >\r\n  操作飞书文档\r\n  新建、读取、更新\r\n---\r\nbody',
		);
		// puck-native markdown format with CRLF
		mkdirSync(join(dir, "deploy"));
		writeFileSync(join(dir, "deploy", "SKILL.md"), "# deploy\r\ndescription: CRLF native format\r\n\r\nbody");

		const skills = await loadSkills(dir);
		assert.equal(skills.length, 3);
		assert.equal(skills.find((s) => s.name === "lark-base")?.description, "操作飞书多维表格");
		assert.equal(skills.find((s) => s.name === "lark-base")?.userInvokedOnly, true, "flag parses under CRLF");
		assert.equal(skills.find((s) => s.name === "lark-doc")?.description, "操作飞书文档 新建、读取、更新");
		assert.equal(skills.find((s) => s.name === "deploy")?.description, "CRLF native format");
		// descriptions reach the prompt — the router signal (lark-base is
		// userInvokedOnly so it stays hidden; that's asserted above via the flag)
		assert.match(skillsToPrompt(skills), /操作飞书文档/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skill packs: loadSkillPacks reads PACK.md and nests children", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-packs-"));
	try {
		// a pack: PACK.md + two children
		mkdirSync(join(dir, "lark"), { recursive: true });
		writeFileSync(
			join(dir, "lark", "PACK.md"),
			'---\nname: lark\ndescription: "飞书全家桶"\n---\n\n先读 lark-shared，再选子技能。',
		);
		mkdirSync(join(dir, "lark", "lark-shared"));
		writeFileSync(join(dir, "lark", "lark-shared", "SKILL.md"), "---\nname: lark-shared\ndescription: 认证与身份\n---\nauth body");
		mkdirSync(join(dir, "lark", "lark-base"));
		writeFileSync(join(dir, "lark", "lark-base", "SKILL.md"), "---\nname: lark-base\ndescription: 多维表格\n---\nbase body");
		// a loose skill next to it: must NOT appear as a pack child
		mkdirSync(join(dir, "deploy"));
		writeFileSync(join(dir, "deploy", "SKILL.md"), "# deploy\ndescription: ship it\n");
		// a bare directory (no SKILL.md/PACK.md): skipped everywhere
		mkdirSync(join(dir, "junk"));

		const packs = await loadSkillPacks(dir);
		assert.equal(packs.length, 1);
		assert.equal(packs[0].name, "lark");
		assert.equal(packs[0].description, "飞书全家桶");
		assert.equal(packs[0].children.length, 2);
		assert.ok(packs[0].children.find((s) => s.name === "lark-base"));

		// flat loader skips pack dirs entirely (children live inside the pack)
		const loose = await loadSkills(dir);
		assert.deepEqual(loose.map((s) => s.name).sort(), ["deploy"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skill packs: prompt shows one line per pack, children hidden", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-packs-prompt-"));
	try {
		mkdirSync(join(dir, "lark"), { recursive: true });
		writeFileSync(join(dir, "lark", "PACK.md"), '---\nname: lark\ndescription: 飞书全家桶，含 25 个子技能\n---\nrouting table here');
		for (const child of ["lark-shared", "lark-base", "lark-doc"]) {
			mkdirSync(join(dir, "lark", child), { recursive: true });
			writeFileSync(join(dir, "lark", child, "SKILL.md"), `---\nname: ${child}\ndescription: ${child} 用途\n---\nbody`);
		}
		mkdirSync(join(dir, "review"));
		writeFileSync(join(dir, "review", "SKILL.md"), "---\nname: review\ndescription: review code\n---\nbody");

		const index: SkillIndex = {
			packs: await loadSkillPacks(dir),
			loose: await loadSkills(dir),
		};
		const prompt = skillsIndexToPrompt(index);
		// one line for the pack, one for the loose skill — that's the whole listing
		assert.match(prompt, /- lark: 飞书全家桶/);
		assert.match(prompt, /- review: review code/);
		assert.doesNotMatch(prompt, /lark-base/);
		assert.doesNotMatch(prompt, /lark-shared/);
		assert.match(prompt, /<pack>\/<skill>/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skill packs: createIndexedSkillTool resolves pack and pack/child, points at the right layer on miss", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-packs-tool-"));
	try {
		mkdirSync(join(dir, "lark"), { recursive: true });
		writeFileSync(join(dir, "lark", "PACK.md"), '---\nname: lark\ndescription: 飞书全家桶\n---\n# lark\n先读 lark-shared。');
		mkdirSync(join(dir, "lark", "lark-shared"));
		writeFileSync(join(dir, "lark", "lark-shared", "SKILL.md"), "---\nname: lark-shared\ndescription: 认证\n---\nauth body");
		mkdirSync(join(dir, "lark", "lark-base"));
		writeFileSync(join(dir, "lark", "lark-base", "SKILL.md"), "---\nname: lark-base\ndescription: 表格\n---\nbase body");
		mkdirSync(join(dir, "deploy"));
		writeFileSync(join(dir, "deploy", "SKILL.md"), "# deploy\ndescription: ship\n");

		const index: SkillIndex = { packs: await loadSkillPacks(dir), loose: await loadSkills(dir) };
		const tool: Tool = createIndexedSkillTool(index);

		// enum lists packs + loose skills, NOT children (25-child suite = 1 entry)
		const enumValues = (tool.parameters as { properties: { name: { enum: string[] } } }).properties.name.enum;
		assert.deepEqual(enumValues.sort(), ["deploy", "lark"]);

		// load the pack → routing table + generated child index
		const pack = await tool.execute({ name: "lark" }, { cwd: dir });
		const packText = (pack.content[0] as { text: string }).text;
		assert.match(packText, /先读 lark-shared/);
		assert.match(packText, /lark-base: 表格/);
		assert.match(packText, /<pack>\/<skill>/);

		// drill into a child by address
		const child = await tool.execute({ name: "lark/lark-base" }, { cwd: dir });
		assert.equal(child.isError, undefined);
		assert.match((child.content[0] as { text: string }).text, /base body/);

		// loose skill still works, case-insensitively
		const loose = await tool.execute({ name: "Deploy" }, { cwd: dir });
		assert.equal(loose.isError, undefined);

		// unknown child inside a known pack → error lists THAT pack's children
		const miss = await tool.execute({ name: "lark/nope" }, { cwd: dir });
		assert.equal(miss.isError, true);
		assert.match((miss.content[0] as { text: string }).text, /lark-base, lark-shared/);

		// unknown top-level → flat available list
		const miss2 = await tool.execute({ name: "nope" }, { cwd: dir });
		assert.equal(miss2.isError, true);
		assert.match((miss2.content[0] as { text: string }).text, /Available: deploy, lark/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skill packs: cross-harness indexed loader dedupes within and across tiers", async () => {
	const home = mkdtempSync(join(tmpdir(), "puck-packs-home-"));
	try {
		// .claude carries the lark pack; .codex carries a same-name LOOSE skill
		// "lark" → pack wins, loose copy dropped as duplicate
		mkdirSync(join(home, ".claude", "skills", "lark", "lark-base"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "lark", "PACK.md"), '---\nname: lark\ndescription: claude pack\n---\nroute');
		writeFileSync(join(home, ".claude", "skills", "lark", "lark-base", "SKILL.md"), "---\nname: lark-base\ndescription: 表格\n---\nbody");
		mkdirSync(join(home, ".codex", "skills", "lark"), { recursive: true });
		writeFileSync(join(home, ".codex", "skills", "lark", "SKILL.md"), "---\nname: lark\ndescription: codex loose flavor\n---\nbody");
		// same pack in two harnesses → one pack, origins record both
		mkdirSync(join(home, ".puck", "skills", "lark", "lark-doc"), { recursive: true });
		writeFileSync(join(home, ".puck", "skills", "lark", "PACK.md"), '---\nname: lark\ndescription: puck pack\n---\nroute');
		writeFileSync(join(home, ".puck", "skills", "lark", "lark-doc", "SKILL.md"), "---\nname: lark-doc\ndescription: 文档\n---\nbody");
		// ordinary loose dedup still works
		mkdirSync(join(home, ".claude", "skills", "review"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: claude review\n---\nbody");
		mkdirSync(join(home, ".codex", "skills", "review"), { recursive: true });
		writeFileSync(join(home, ".codex", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: codex review\n---\nbody");

		const { index, origins, duplicates } = await loadHarnessSkillsIndexed(home);
		// one lark pack (puck flavor wins), no loose lark, one review (claude wins)
		assert.equal(index.packs.length, 1);
		assert.equal(index.packs[0].description, "puck pack");
		assert.equal(index.loose.length, 1);
		assert.equal(index.loose[0].description, "claude review");
		// drops: codex pack copy + codex loose lark + codex review = 3
		assert.equal(duplicates, 3);
		// origins follow source-scan order (.puck first), not insertion order
		assert.deepEqual(origins.get("lark"), [".puck", ".claude", ".codex"]);
		assert.deepEqual(origins.get("review"), [".claude", ".codex"]);

		// a loose skill colliding with a pack name in the SAME source is dropped too
		mkdirSync(join(home, ".puck", "skills", "hub"), { recursive: true });
		writeFileSync(join(home, ".puck", "skills", "hub", "SKILL.md"), "---\nname: lark\ndescription: name-matches-the-pack\n---\nbody");
		mkdirSync(join(home, ".puck", "skills", "realhub"), { recursive: true });
		writeFileSync(join(home, ".puck", "skills", "realhub", "SKILL.md"), "---\nname: realhub\ndescription: fine\n---\nbody");
		const second = await loadHarnessSkillsIndexed(home);
		assert.equal(second.index.packs.length, 1, "pack unchanged");
		assert.equal(second.index.loose.filter((s) => s.name === "lark").length, 0, "loose lark dropped against the pack");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("skill packs: pack children absorb same-name loose skills across harnesses", async () => {
	const home = mkdtempSync(join(tmpdir(), "puck-packs-absorb-"));
	try {
		// .puck carries the lark pack; .claude carries the same skills LOOSE
		// (Claude Code still needs them flat). The pack's children must absorb
		// the loose copies — one prompt line for the pack, none for the copies,
		// but the bare name still resolves to the child through the pack.
		mkdirSync(join(home, ".puck", "skills", "lark", "lark-base"), { recursive: true });
		mkdirSync(join(home, ".puck", "skills", "lark", "lark-doc"), { recursive: true });
		writeFileSync(join(home, ".puck", "skills", "lark", "PACK.md"), '---\nname: lark\ndescription: 飞书全家桶\n---\nroute');
		writeFileSync(join(home, ".puck", "skills", "lark", "lark-base", "SKILL.md"), "---\nname: lark-base\ndescription: 包内版本\n---\npack child body");
		writeFileSync(join(home, ".puck", "skills", "lark", "lark-doc", "SKILL.md"), "---\nname: lark-doc\ndescription: 包内文档\n---\ndoc child body");
		for (const s of ["lark-base", "lark-doc"]) {
			mkdirSync(join(home, ".claude", "skills", s), { recursive: true });
			writeFileSync(join(home, ".claude", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: 平铺版本\n---\nloose body`);
		}
		// a non-lark loose skill stays untouched
		mkdirSync(join(home, ".claude", "skills", "review"), { recursive: true });
		writeFileSync(join(home, ".claude", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: keep me\n---\nbody");

		const { index, duplicates } = await loadHarnessSkillsIndexed(home);
		assert.equal(index.packs.length, 1);
		assert.equal(index.loose.length, 1, "lark-base/lark-doc absorbed, review kept");
		assert.equal(index.loose[0].name, "review");
		assert.equal(duplicates, 2, "both loose lark copies absorbed");

		// absorbed copy leaves no prompt line…
		const prompt = skillsIndexToPrompt(index);
		assert.match(prompt, /- lark: /);
		assert.doesNotMatch(prompt, /- lark-doc: /);
		// …and the bare name still resolves to the pack child
		const tool: Tool = createIndexedSkillTool(index);
		const bare = await tool.execute({ name: "lark-base" }, { cwd: home });
		assert.equal(bare.isError, true, "bare name is not in the enum by design — pack/child is");
		const addr = await tool.execute({ name: "lark/lark-base" }, { cwd: home });
		assert.match((addr.content[0] as { text: string }).text, /pack child body/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("skill packs: CRLF PACK.md parses (Windows-authored pack)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-packs-crlf-"));
	try {
		mkdirSync(join(dir, "lark"), { recursive: true });
		writeFileSync(
			join(dir, "lark", "PACK.md"),
			'---\r\nname: lark\r\ndescription: "飞书全家桶"\r\n---\r\n路由表',
		);
		mkdirSync(join(dir, "lark", "lark-base"));
		writeFileSync(join(dir, "lark", "lark-base", "SKILL.md"), '---\r\nname: lark-base\r\ndescription: "表格"\r\n---\r\nbody');

		const packs = await loadSkillPacks(dir);
		assert.equal(packs.length, 1);
		assert.equal(packs[0].description, "飞书全家桶");
		assert.equal(packs[0].children[0].description, "表格");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("subagent: runs a nested agent and returns its final text", async () => {
	const tool = createSubagentTool({
		streamFn: createMockStreamFn([{ text: "subagent says done" }]),
		maxTurns: 3,
	});

	const result = await tool.execute({ task: "do the thing" }, { cwd: process.cwd() });
	assert.equal(result.isError, undefined);
	assert.match((result.content[0] as { text: string }).text, /subagent says done/);
});

test("subagent: reports nested failure", async () => {
	const tool = createSubagentTool({
		streamFn: createMockStreamFn([{ error: "nested boom" }]),
	});
	const result = await tool.execute({ task: "fail" }, { cwd: process.cwd() });
	assert.equal(result.isError, true);
	assert.match((result.content[0] as { text: string }).text, /nested boom/);
});

test("compactNow: folds the prefix into a summary, keeps the recent window", async () => {
	const summarizer = createMockStreamFn([{ text: "SUMMARY" }]);
	const messages: Message[] = [];
	for (let i = 0; i < 10; i++) {
		messages.push(userMessage(`question ${i}`));
		messages.push(assistant(`answer ${i}`));
	}
	const result = await compactNow(messages, summarizer, { keepRecent: 4 });
	assert.ok(result);
	assert.equal(result.folded, messages.length - 4);
	assert.equal(result.view[0].role, "user");
	assert.ok(String((result.view[0] as { content: unknown }).content).includes("[Context compaction]"));
	assert.ok(String((result.view[0] as { content: unknown }).content).includes("SUMMARY"));
	assert.equal(result.view.length, 5); // summary + 4 kept
	assert.deepEqual(result.view.slice(1), messages.slice(-4));

	// nothing to fold → undefined
	assert.equal(await compactNow(messages.slice(0, 2), summarizer, { keepRecent: 10 }), undefined);
});
