// Scan every file changed in this push range for credential patterns.
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const range = process.argv[2] ?? "f37d74a..HEAD";
const files = execSync(`git diff ${range} --name-only`, { encoding: "utf8" })
	.split("\n")
	.filter(Boolean);
console.log("files in range", range, ":", files.length);

const patterns = [
	[/sk-[a-zA-Z0-9]{20,}/, "openai-style key"],
	[/ghp_[a-zA-Z0-9]{30,}/, "github PAT"],
	[/npm_[a-zA-Z0-9]{30,}/, "npm token"],
	[/AIza[a-zA-Z0-9_-]{30,}/, "google api key"],
	[/eyJ[a-zA-Z0-9_-]{20,}\./, "JWT"],
];
let hits = 0;
for (const f of files) {
	let t;
	try {
		t = fs.readFileSync(f, "utf8");
	} catch {
		continue;
	}
	for (const [p, label] of patterns) {
		const m = t.match(p);
		if (m) {
			console.log("HIT", label, f, m[0].slice(0, 10) + "...");
			hits++;
		}
	}
}
console.log(hits === 0 ? "OK: no credential patterns" : "FOUND " + hits + " — DO NOT PUSH");
process.exit(hits === 0 ? 0 : 1);
