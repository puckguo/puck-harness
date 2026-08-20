// scripts/publish-all.mjs
// =====================================================================
//  一键发布所有 11 个包到 npm（按依赖顺序）
// =====================================================================
//  用法：
//    1. npm login                        (登录你的 npm 账号)
//    2. node scripts/publish-all.mjs --dry-run    # 验证会发哪些文件
//    3. node scripts/publish-all.mjs              # 真发
//
//  发布顺序（底层先发，因为高层依赖底层）：
//    core → llm → session → tools → features → timing
//        → store → memory → sdk → web → cli
//
//  ⚠️  必须在 root (puck/) 目录运行！
//  ⚠️  必须先确认 audit-publish.mjs 0 错 0 警！（本脚本会自动跑）
//  ⚠️  24h 内可 unpublish；超过 24h 只能 deprecate。
//
//  版本号替换说明（关键）：
//    source package.json 里 @puckguo123/* 依赖写的是 "*"（workspace
//    本地解析用——npm install 时会 symlink 到本地 packages/）。
//    但 publish 出去的 tarball 必须是真实 semver 范围，否则用户安装
//    时会拉到任意版本（未来 1.0 不兼容会直接炸）。
//    所以本脚本在 publish 前把每个包的依赖临时改写为 "^<当前版本>"，
//    publish 完成后恢复原样。git 历史里永远只看到 "*"。
// =====================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const DRY = process.argv.includes("--dry-run");
const SKIP_AUDIT = process.argv.includes("--skip-audit");

const ROOT = process.cwd();
const PKGS = join(ROOT, "packages");

const ORDER = [
	"core",
	"llm",
	"session",
	"tools",
	"features",
	"timing",
	"store",
	"memory",
	"sdk",
	"web",
	"cli",
];

// ── 0. audit 检查 ─────────────────────────────────────────────
if (!SKIP_AUDIT) {
	console.log("→ 跑 audit-publish.mjs（带 --pack 看每个包的 tarball）...\n");
	const r = spawnSync("node", ["scripts/audit-publish.mjs", "--pack"], { stdio: "inherit" });
	if (r.status !== 0) {
		console.error("\n❌ audit 没通过，先修问题再 publish。");
		console.error("   (加 --skip-audit 跳过此步，**不推荐**)");
		process.exit(1);
	}
	console.log("\n✓ audit 通过。\n");
}

// ── 1. 验证 login 状态 ────────────────────────────────────────
let whoami = "";
try {
	whoami = execSync("npm whoami", { encoding: "utf8" }).trim();
	console.log(`npm 登录身份: ${whoami}\n`);
} catch {
	console.error("❌ 未登录 npm。先跑 `npm login` 或 `npm adduser`。");
	process.exit(1);
}

// ── 2. 验证每个包都存在 + 读取元数据 ──────────────────────────
const pkgMeta = [];
for (const name of ORDER) {
	const pkgPath = join(PKGS, name, "package.json");
	if (!existsSync(pkgPath)) {
		console.error(`❌ 缺包: packages/${name}/package.json`);
		process.exit(1);
	}
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	pkgMeta.push({ dir: name, path: pkgPath, name: pkg.name, version: pkg.version });
}

// ── 3. 把 @puckguo123/* 的 "*" 改写为 "^<version>" ─────────────
// source 里保持 "*"（workspace 用），publish 临时改，发完恢复。
console.log("→ 改写 inter-package 依赖: * → ^<version>（publish 后恢复）\n");
const savedOriginals = [];
for (const m of pkgMeta) {
	const original = readFileSync(m.path, "utf8");
	savedOriginals.push({ path: m.path, content: original });
	const pkg = JSON.parse(original);
	let changed = false;
	for (const depField of ["dependencies", "peerDependencies", "optionalDependencies"]) {
		const deps = pkg[depField];
		if (!deps) continue;
		for (const dep of Object.keys(deps)) {
			// 匹配 @puckguo123/* 且值为 "*" 或 "workspace:*"
			if (dep.startsWith("@puckguo123/") && (deps[dep] === "*" || deps[dep] === "workspace:*")) {
				// 找到这个依赖的版本（从 pkgMeta 里）
				const target = pkgMeta.find((p) => p.name === dep);
				if (!target) {
					console.error(`❌ 依赖 ${dep} 在 packages/ 里找不到（${m.name} 的 ${depField}）`);
					process.exit(1);
				}
				deps[dep] = `^${target.version}`;
				changed = true;
			}
		}
	}
	if (changed) {
		writeFileSync(m.path, JSON.stringify(pkg, null, "\t") + "\n");
	}
}

// ── 4. 发布（依赖顺序）────────────────────────────────────────
const results = [];
let failed = false;
try {
	for (const m of pkgMeta) {
		const label = `${m.name}@${m.version}`;
		console.log(`\n→ ${label}  (${m.dir})`);
		const args = DRY ? ["publish", "--dry-run", "--access", "public"] : ["publish", "--access", "public"];
		const r = spawnSync("npm", args, { cwd: join(PKGS, m.dir), stdio: "inherit" });
		if (r.status !== 0) {
			console.error(`\n❌ ${label} publish 失败（exit ${r.status}）。`);
			if (!DRY) {
				console.error("   24h 内可 `npm unpublish <pkg>@<ver> -f` 撤回；或改 version 后重发。");
			}
			results.push({ ...m, status: "fail" });
			failed = true;
			break; // 后续包依赖它，继续没意义
		}
		results.push({ ...m, status: "ok" });
	}
} finally {
	// ── 5. 恢复 source package.json（无论成败）─────────────────
	console.log("\n→ 恢复 source package.json（依赖回到 workspace 形式）");
	for (const { path, content } of savedOriginals) {
		writeFileSync(path, content);
	}
}

// ── 6. 总结 ───────────────────────────────────────────────────
console.log("\n\n=== 发布总结 ===");
for (const r of results) {
	console.log(`  ${r.status === "ok" ? "✓" : "✗"} ${r.name}@${r.version}`);
}
const okCount = results.filter((r) => r.status === "ok").length;
console.log(`\n${okCount}/${results.length} 成功${DRY ? "（dry-run）" : ""}。`);

if (DRY) {
	console.log("\n下一步：去掉 --dry-run 重跑以真实发布。");
} else if (!failed) {
	console.log("\n✓ 全部完成！验证：npm view puck version / npm view @puckguo123/core version");
} else {
	process.exit(1);
}
