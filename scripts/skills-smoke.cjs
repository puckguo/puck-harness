// Smoke: run the real CLI in mock mode, issue /skills, capture the listing.
const { execSync } = require("node:child_process");
try {
	const out = execSync("node packages/cli/dist/index.js --mock", {
		input: "/skills\nexit\n",
		timeout: 60000,
		encoding: "utf8",
	});
	const lines = out.split(/\r?\n/);
	const start = lines.findIndex((l) => l.includes("技能（"));
	const listed = lines.filter((l) => /^  [a-z]/.test(l));
	const lark = listed.filter((l) => l.toLowerCase().includes("lark"));
	console.log("banner:", lines.find((l) => l.startsWith("技能:")) ?? "(none)");
	console.log("header:", lines[start]);
	console.log("listed lines:", listed.length);
	console.log("lark lines:", lark.length, "(1 = the pack line; children hidden)");
	console.log(listed.slice(0, 3).map((l) => l.slice(0, 100)).join("\n"));
} catch (e) {
	console.error("CLI smoke failed:", e.message);
	process.exit(1);
}
