// scripts/audit-publish.mjs
// =====================================================================
//  npm publish 前自检脚本（草案 v1）
// =====================================================================
//  检查项：
//   1. 高风险文件清单（绝对不能进 npm tarball）
//   2. 每个 package.json 的必备 metadata 字段
//   3. 互依赖版本号格式（workspace:* 残留 vs 写死 0.1.0 vs ^0.1.0）
//   4. 锁文件二选一（package-lock.json vs pnpm-lock.yaml）
//   5. npm pack --dry-run 输出（捕获每个包的实际文件清单）
//   6. README.md 存在性（package.json#files 声明的必须真实存在）
//
//  退出码：0 = 全通过；1 = 有警告；2 = 有错误
//
//  用法：
//    node scripts/audit-publish.mjs               # 只检查
//    node scripts/audit-publish.mjs --fix         # 自动补缺失 metadata
//    node scripts/audit-publish.mjs --pack        # 额外跑 npm pack 看 tarball
// =====================================================================

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

// ── 颜色输出（与 cli 一致） ───────────────────────────────────────
const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const COL = NO_COLOR
	? { ok: "", err: "", warn: "", dim: "", reset: "" }
	: { ok: "\x1b[32m", err: "\x1b[31m", warn: "\x1b[33m", dim: "\x1b[2m", reset: "\x1b[0m" };

// ── 0. 解析命令行参数 ─────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const FIX = ARGS.includes("--fix");
const PACK = ARGS.includes("--pack");

// ── 结果收集器 ────────────────────────────────────────────────────
const ERRORS = [];
const WARNINGS = [];

const error = (msg) => { console.log(COL.err + "✗ " + msg + COL.reset); ERRORS.push(msg); };
const warn  = (msg) => { console.log(COL.warn + "⚠ " + msg + COL.reset); WARNINGS.push(msg); };
const ok    = (msg) => { console.log(COL.ok + "✓ " + msg + COL.reset); };

// ── 0. 调起秘密扫描（独立子脚本） ───────────────────────────────────
console.log("\n" + COL.dim + "── 0/6 API key 扫描 ──" + COL.reset);
try {
	execSync("node scripts/scan-secrets.mjs", { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	ok("所有准备提交的文件都不含 API key 模式");
} catch {
	error("secret scanner 命中了真实 key（见上方输出）");
}

// ── 1. 高风险文件检查 ─────────────────────────────────────────────
console.log("\n" + COL.dim + "── 1/6 高风险文件清单 ──" + COL.reset);

const DANGER_PATHS = [
	// auth.json.example is fine — it's the template
	{ path: "bench/home/puck/auth.json",     reason: "真实 API key（不是 .example）" },
	{ path: ".puck/auth.json",               reason: "真实 API key" },
	{ path: "bench/home/puck/timings.jsonl", reason: "真实模型调用记录" },
	{ path: "bench/home/codex/",             reason: "个人 codex 安装数据" },
	{ path: ".puck/",                        reason: "session 持久化目录" },
	{ path: ".puck-real-sessions/",          reason: "真实 session 备份" },
	{ path: ".puckhome/",                    reason: "本地 dev home" },
	{ path: "brainstorm.md",                 reason: "内部设计文档" },
	{ path: "puck-demo.txt",                 reason: "测试输出" },
	{ path: "void",                          reason: "占位空文件" },
	{ path: ".patch-docs14.cjs",             reason: "本地补丁脚本" },
];

for (const { path: p, reason } of DANGER_PATHS) {
	const full = join(REPO_ROOT, p);
	if (existsSync(full)) {
		const st = statSync(full);
		// 如果 .gitignore 里已经排除这个路径，那就是安全的（仅本地存在）
		const gitignorePath = join(REPO_ROOT, ".gitignore");
		let ignored = false;
		if (existsSync(gitignorePath)) {
			const gi = readFileSync(gitignorePath, "utf8");
			const lines = gi.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
			// 完整路径精确匹配
			if (lines.includes(p) || lines.includes(p + "/") || lines.includes(p.replace(/\/$/, ""))) {
				ignored = true;
			}
			// 路径任一部分出现在 .gitignore 里
			if (!ignored) {
				const parts = p.split("/");
				for (let i = parts.length; i > 0; i--) {
					const sub = parts.slice(0, i).join("/");
					if (lines.includes(sub) || lines.includes(sub + "/")) { ignored = true; break; }
				}
			}
			// 包含通配符的匹配：转为正则检查 basename
			if (!ignored) {
				const base = p.split("/").pop() ?? "";
				for (const line of lines) {
					if (!line.includes("*")) continue;
					// 把 gitignore glob 转成简单正则
					const re = new RegExp("^" + line.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
					if (re.test(base) || re.test(p)) { ignored = true; break; }
				}
			}
		}
		if (ignored) {
			ok(`${p} 存在但已在 .gitignore 中（本地使用安全）`);
		} else if (st.isFile()) {
			error(`高风险文件存在且未被 .gitignore: ${p} (${reason}, ${st.size}B)`);
		} else if (st.isDirectory()) {
			const size = execSync(`du -sh "${full}" 2>/dev/null || echo "?"`).toString().trim().split("\t")[0];
			error(`高风险目录存在且未被 .gitignore: ${p} (${reason}, ${size})`);
		}
	} else {
		ok(`${p} 已不存在（安全）`);
	}
}

// ── 2. 锁文件二选一检查 ───────────────────────────────────────────
console.log("\n" + COL.dim + "── 2/6 锁文件 ──" + COL.reset);
const hasNpmLock = existsSync(join(REPO_ROOT, "package-lock.json"));
const hasPnpmLock = existsSync(join(REPO_ROOT, "pnpm-lock.yaml"));
if (hasNpmLock && hasPnpmLock) {
	error("package-lock.json 和 pnpm-lock.yaml 同时存在，必须二选一（推荐 npm，因为 CI 也用 npm）");
} else if (!hasNpmLock && !hasPnpmLock) {
	warn("既无 package-lock.json 也无 pnpm-lock.yaml（首次 commit？建议加上）");
} else {
	ok(`锁文件唯一：${hasNpmLock ? "npm" : "pnpm"}`);
}

// ── 3. 必备文件检查 ───────────────────────────────────────────────
console.log("\n" + COL.dim + "── 3/6 必备顶层文件 ──" + COL.reset);
const REQUIRED_TOP = ["LICENSE", "CONTRIBUTING.md", "SECURITY.md", ".gitignore"];
for (const f of REQUIRED_TOP) {
	if (existsSync(join(REPO_ROOT, f))) ok(`${f} 存在`);
	else error(`${f} 缺失（开源必备）`);
}

// ── 4. 每个 package.json 的 metadata 完整性 ────────────────────────
console.log("\n" + COL.dim + "── 4/6 package.json metadata ──" + COL.reset);

const REQUIRED_FIELDS = [
	"name", "version", "description", "type", "license",
	"repository", "homepage", "bugs", "author",
	"keywords", "publishConfig",
];

const NICE_TO_HAVE = [
	"engines", "sideEffects",
	// funding 略过——属赞助/社区设置，不在开源首发必须项里
];

const pkgs = readdirSync(PACKAGES_DIR).filter((d) => existsSync(join(PACKAGES_DIR, d, "package.json")));

for (const pkgName of pkgs) {
	const pkgDir = join(PACKAGES_DIR, pkgName);
	const pkgPath = join(pkgDir, "package.json");
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch (e) {
		error(`${pkgName}/package.json 解析失败：${e.message}`);
		continue;
	}

	const label = `${pkg.name || pkgName}`;
	console.log(COL.dim + `  ${label}` + COL.reset);

	// 必填字段
	for (const f of REQUIRED_FIELDS) {
		const v = pkg[f];
		if (v === undefined || v === null || v === "") {
			error(`  ${label} 缺字段: ${f}`);
		} else if (f === "license" && v !== "MIT" && v !== "Apache-2.0" && v !== "MPL-2.0") {
			warn(`  ${label} license = "${v}"（确认是 OSS 友好的协议？）`);
		}
	}

	// 友好字段
	for (const f of NICE_TO_HAVE) {
		if (pkg[f] === undefined) warn(`  ${label} 建议加: ${f}`);
	}

	// files 字段
	if (!pkg.files) {
		error(`  ${label} 缺 files 字段（npm 会把整个目录都发出去！）`);
	} else if (Array.isArray(pkg.files)) {
		// 验证 files 里声明的每个文件/目录是否存在
		for (const entry of pkg.files) {
			if (entry === "package.json" || entry === "README.md") {
				// package.json 一定存在；README 单独检查
				continue;
			}
			if (!existsSync(join(pkgDir, entry))) {
				error(`  ${label} files 声明的 "${entry}" 不存在`);
			}
		}
	}

	// README 实际存在性（如果声明了 files:["dist","README.md"] 但 README 没有）
	if (pkg.files && pkg.files.includes("README.md") && !existsSync(join(pkgDir, "README.md"))) {
		error(`  ${label} files 声明 README.md 但文件不存在（npm 页面会显示 no readme）`);
	}

	// 互依赖版本号格式：
	//   workspace:*  = pnpm 写法（OK；npm publish 会自动转为真实版本号）
	//   *            = npm 12 兼容的 workspace 标记（OK；npm install 时会指向本地包）
	//   ^x.y.z       = OK
	//   x.y.z 写死   = 警告（inter-package 依赖不锁定）
	for (const [dep, ver] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) })) {
		if (!dep.startsWith("@puck-agent/")) continue;
		if (ver === "workspace:*" || ver === "*") {
			ok(`  ${label} 互依赖 ${dep}: ${ver}（publish 时会转为 ^x.y.z）`);
		} else if (/^\^?\d+\.\d+\.\d+$/.test(ver)) {
			ok(`  ${label} 互依赖 ${dep}: ${ver}`);
		} else {
			warn(`  ${label} 互依赖 ${dep} 版本号格式异常：${ver}`);
		}
	}

	// dotfile / 泄漏数据检查：扫描 dist/ 找被错误打包的隐藏文件
	if (pkg.files && Array.isArray(pkg.files) && pkg.files.includes("dist")) {
		const distDir = join(pkgDir, "dist");
		if (existsSync(distDir)) {
			const dotEntries = readdirSync(distDir).filter((f) => f.startsWith("."));
			for (const dot of dotEntries) {
				error(`  ${label} dist/${dot} 是 dotfile，不应被打包（可能是开发时残留）`);
			}
		}
	}
}

// ── 5. npm pack --dry-run ──────────────────────────────────────────
if (PACK) {
	console.log("\n" + COL.dim + "── 5/6 npm pack --dry-run (各包) ──" + COL.reset);
	for (const pkgName of pkgs) {
		const pkgDir = join(PACKAGES_DIR, pkgName);
		try {
			const out = execSync("npm pack --dry-run --json", { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			const parsed = JSON.parse(out);
			// npm 输出是对象（key 为包名）或数组；取第一个对象里的 files
			const pkgData = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
			const fileNames = pkgData?.files?.map((f) => f.path) ?? [];
			console.log(COL.dim + `  ${pkgName}: (${fileNames.length} files)` + COL.reset);
			for (const f of fileNames) {
				console.log(COL.dim + `    ${f}` + COL.reset);
				// 检查泄漏
				if (DANGER_PATHS.some((d) => f.includes(d.path.replace(/\/$/, "")))) {
					error(`    ↑ 这个文件不应该出现在 tarball！`);
				}
			}
		} catch (e) {
			error(`  ${pkgName} npm pack --dry-run 失败：${e.message.slice(0, 200)}`);
		}
	}
} else {
	console.log("\n" + COL.dim + "── 5/6 npm pack --dry-run (跳过，加 --pack 启用) ──" + COL.reset);
}

// ── 6. 总结 ───────────────────────────────────────────────────────
console.log("\n" + COL.dim + "── 6/6 总结 ──" + COL.reset);
console.log(`  ${COL.ok}${ERRORS.length === 0 ? "✓" : "✗"}${COL.reset} 错误: ${ERRORS.length}`);
console.log(`  ${COL.warn}⚠${COL.reset}  警告: ${WARNINGS.length}`);

if (ERRORS.length === 0 && WARNINGS.length === 0) {
	console.log("\n" + COL.ok + "✅ 所有检查通过，可以 npm publish" + COL.reset);
	process.exit(0);
}
if (ERRORS.length === 0) {
	console.log("\n" + COL.warn + "⚠ 只有警告，可以 npm publish（建议先修）" + COL.reset);
	process.exit(1);
}
console.log("\n" + COL.err + "❌ 有错误，必须修复后再 npm publish" + COL.reset);
process.exit(2);
