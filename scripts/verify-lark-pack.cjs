// Verify the deployed lark pack against the REAL home dirs.
const { loadHarnessSkillsIndexed, skillsIndexToPrompt, createIndexedSkillTool } = require("../packages/features/dist/skills/index.js");

(async () => {
	const { index, duplicates } = await loadHarnessSkillsIndexed("C:/Users/Administrator");
	const prompt = skillsIndexToPrompt(index);
	const lines = prompt.split("\n").filter((l) => l.startsWith("- "));
	console.log("packs:", index.packs.length, "children:", index.packs[0]?.children.length, "loose:", index.loose.length, "dups:", duplicates);
	console.log("prompt chars:", prompt.length, "lines:", lines.length);
	const larkLine = lines.find((l) => l.startsWith("- lark"));
	console.log("lark line:", larkLine?.slice(0, 90));
	const larkLoose = index.loose.filter((s) => s.name.startsWith("lark"));
	console.log("lark still loose (must be 0):", larkLoose.length);

	const tool = createIndexedSkillTool(index);
	const en = tool.parameters.properties.name.enum;
	console.log("enum:", en.length, "lark in enum:", en.includes("lark"), "lark-base in enum (must be false):", en.includes("lark-base"));

	const pack = await tool.execute({ name: "lark" }, { cwd: "." });
	const t = pack.content[0].text;
	console.log("pack load len:", t.length, "| routing table:", t.includes("路由表"), "| child index:", t.includes("lark-base:"));
	const child = await tool.execute({ name: "lark/lark-shared" }, { cwd: "." });
	console.log("child lark/lark-shared ok:", !child.isError, "| has auth section:", child.content[0].text.includes("认证"));
})().catch((e) => {
	console.error("ERR", e);
	process.exit(1);
});
