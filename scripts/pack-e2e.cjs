// End-to-end check of the two-tier skill system against a real copy of the
// user's ~/.claude/skills (lark-* bundled into one pack). Run: node scripts/pack-e2e.cjs
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
	loadHarnessSkillsIndexed,
	skillsIndexToPrompt,
	createIndexedSkillTool,
} = require("../packages/features/dist/skills/index.js");

(async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "puck-pack-home-"));
	const src = path.join(os.homedir(), ".claude", "skills");
	if (!fs.existsSync(src)) {
		console.log("no ~/.claude/skills on this machine; skipping real-data check");
		return;
	}
	fs.mkdirSync(path.join(home, ".claude", "skills", "lark"), { recursive: true });
	let copied = 0;
	for (const d of fs.readdirSync(src)) {
		if (d.startsWith("lark")) {
			fs.cpSync(path.join(src, d), path.join(home, ".claude", "skills", "lark", d), { recursive: true });
			copied++;
		} else {
			fs.cpSync(path.join(src, d), path.join(home, ".claude", "skills", d), { recursive: true });
		}
	}
	fs.writeFileSync(
		path.join(home, ".claude", "skills", "lark", "PACK.md"),
		"---\nname: lark\ndescription: 飞书/Lark 全家桶：文档、多维表格、日历、消息、邮件、视频会议、OKR、任务、Wiki、画板等。所有 lark-cli 操作先读 lark-shared。\n---\n\n# lark 技能包\n\n## 路由\n- 认证/身份/scope → lark-shared（所有操作的前置）\n- 多维表格 → lark-base；云文档 → lark-doc；日历 → lark-calendar\n- 消息 → lark-im；邮件 → lark-mail；视频会议 → lark-vc / lark-vc-agent\n",
	);

	const t0 = Date.now();
	const { index, duplicates } = await loadHarnessSkillsIndexed(home);
	const loadMs = Date.now() - t0;
	const prompt = skillsIndexToPrompt(index);
	console.log("copied lark skills:", copied);
	console.log("packs:", index.packs.length, "pack children:", index.packs[0].children.length, "loose:", index.loose.length, "dups:", duplicates);
	console.log("two-tier prompt chars:", prompt.length);
	console.log("load time:", loadMs + "ms");
	const lines = prompt.split("\n").filter((l) => l.startsWith("- "));
	console.log("prompt lines:", lines.length);
	console.log("first:", JSON.stringify(lines[0]));

	const tool = createIndexedSkillTool(index);
	const enumV = tool.parameters.properties.name.enum;
	console.log("enum size:", enumV.length, "contains lark:", enumV.includes("lark"), "contains lark-base:", enumV.includes("lark-base"));
	const pack = await tool.execute({ name: "lark" }, { cwd: home });
	const packText = pack.content[0].text;
	console.log("pack load: isError=", pack.isError, "len=", packText.length, "routing-table:", packText.includes("lark-shared"), "child-index:", packText.includes("lark-base:"));
	const child = await tool.execute({ name: "lark/lark-base" }, { cwd: home });
	console.log("child load: isError=", child.isError, "head:", JSON.stringify(child.content[0].text.slice(0, 30)));
	const miss = await tool.execute({ name: "lark/typo" }, { cwd: home });
	console.log("miss child: isError=", miss.isError, "mentions available:", miss.content[0].text.includes("Skills in this pack"));
	fs.rmSync(home, { recursive: true, force: true });
})().catch((e) => {
	console.error("ERR", e);
	process.exit(1);
});
