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
import { createSkillTool, loadSkills, skillsToPrompt } from "@puckguo123/features/skills";
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
