// scripts/_scan-for-secrets.mjs
// 扫描 git 准备 add 的所有文件，检查是否含 API key pattern
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dirname.replace(/[\\/]scripts$/, "");

// 1. 获取 git 即将 add / 已 staged 的所有文件。
//    总是包含工作区 + staged 两个集合。
const dryRunOut = execSync('git add -A --dry-run', { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const dryRunFiles = dryRunOut
	.split("\n")
	.map((l) => l.replace(/^add\s+'/, "").replace(/'$/, "").trim())
	.filter((l) => l && !l.startsWith("remove") && !l.startsWith("unchanged"));

const cachedOut = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const cachedFiles = cachedOut.split("\n").map((l) => l.trim()).filter(Boolean);

const files = [...new Set([...dryRunFiles, ...cachedFiles])];
console.error(`(scanning ${files.length} files: ${dryRunFiles.length} untracked + ${cachedFiles.length} staged)`);

console.log(`scanning ${files.length} files for API key patterns...`);

const KEY_PATTERNS = [
	/sk-cp-[A-Za-z0-9_-]{20,}/,    // minimax-cn
	/sk-ant-[A-Za-z0-9_-]{20,}/,   // anthropic
	/sk-[A-Za-z0-9]{20,}/,         // openai
	/ghp_[A-Za-z0-9]{20,}/,        // github PAT
	/eyJ[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{20,}/,  // JWT
];

let hits = 0;
for (const f of files) {
	const full = join(ROOT, f);
	let st;
	try { st = statSync(full); } catch { continue; }
	if (!st.isFile()) continue;
	if (st.size > 10_000_000) continue; // skip huge
	// *.example 文件是故意公开的模板，包含 placeholder。
	// 里面命中 key pattern 是预期的（EXAMPLE-DO-NOT-USE 之类的）。
	if (f.endsWith(".example")) {
		console.log(`skip ${f} (.example template)`);
		continue;
	}
	const text = readFileSync(full, "utf8");
	for (const re of KEY_PATTERNS) {
		if (re.test(text)) {
			console.log(`HIT  ${f}`);
			hits++;
			break;
		}
	}
}
console.log(`\ndone. ${hits} files contain key patterns.`);
process.exit(hits > 0 ? 1 : 0);
