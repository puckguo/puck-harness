// scripts/publish-all.mjs
// =====================================================================
//  一键发布所有 11 个包到 npm（按依赖顺序）
// =====================================================================
//  用法：
//    1. npm login          (登录你的 npm 账号)
//    2. node scripts/publish-all.mjs --dry-run    # 验证会发哪些文件
//    3. node scripts/publish-all.mjs              # 真发
//
//  发布顺序（底层先发，因为高层依赖底层）：
//    core → llm → session → tools → features → timing
//        → store → memory → sdk → web → cli
//
//  ⚠️  必须在 root (puck/) 目录运行！
//  ⚠️  必须先确认 audit-publish.mjs 0 错 0 警！
//  ⚠️  24h 内可 unpublish；超过 24h 只能 deprecate。
// =====================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const DRY = process.argv.includes("--dry-run");
const SKIP_AUDIT = process.argv.includes("--skip-audit");

const ROOT = process.cwd();
const PKGS = join(ROOT, "packages");

// 发布顺序：依赖图拓扑排序（手算）
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
	console.log("→ 跑 audit-publish.mjs（带 --pack 看每个包的 tarball）...");
	const r = spawnSync("node", ["scripts/audit-publish.mjs", "--pack"], { stdio: "inherit" });
	if (r.status !== 0) {
		console.error("\n❌ audit 没通过，先修问题再 publish。");
		console.error("   (加 --skip-audit 跳过此步，**不推荐**)");
		process.exit(1);
	}
	console.log("\n✓ audit 通过。\n");
}

// ── 1. 验证 login 状态 ────────────────────────────────────────
try {
	const whoami = execSync("npm whoami", { encoding: "utf8" }).trim();
	console.log(`npm 登录身份: ${whoami}\n`);
} catch {
	console.error("❌ 未登录 npm。先跑 `npm login` 或 `npm adduser`。");
	process.exit(1);
}

// ── 2. 验证每个包都存在 ──────────────────────────────────────
for (const name of ORDER) {
	if (!existsSync(join(PKGS, name, "package.json"))) {
		console.error(`❌ 缺包: packages/${name}/package.json`);
		process.exit(1);
	}
}

// ── 3. 发布 ───────────────────────────────────────────────────
const results = [];
for (const name of ORDER) {
	const pkgPath = join(PKGS, name, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	const label = `${pkg.name}@${pkg.version}`;

	console.log(`\n→ ${label}  (${name})`);
	if (DRY) {
		const r = spawnSync("npm", ["publish", "--dry-run", "--access", "public"], {
			cwd: join(PKGS, name),
			stdio: "inherit",
		});
		results.push({ name, version: pkg.version, status: r.status === 0 ? "ok" : "fail" });
		continue;
	}

	const r = spawnSync("npm", ["publish", "--access", "public"], {
		cwd: join(PKGS, name),
		stdio: "inherit",
	});
	if (r.status !== 0) {
		console.error(`\n❌ ${label} publish 失败（exit ${r.status}）。`);
		console.error("   可以用 `npm unpublish <pkg>@<ver> -f` 撤回（24h 内）。");
		console.error("   或者改 version 后重发。");
		process.exit(1);
	}
	results.push({ name, version: pkg.version, status: "ok" });
}

// ── 4. 总结 ───────────────────────────────────────────────────
console.log("\n\n=== 发布总结 ===");
for (const r of results) {
	console.log(`  ${r.status === "ok" ? "✓" : "✗"} ${r.name}@${r.version}`);
}
const fails = results.filter((r) => r.status !== "ok").length;
console.log(`\n${results.length - fails}/${results.length} 成功${DRY ? "（dry-run）" : ""}。`);

if (DRY) {
	console.log("\n下一步：去掉 --dry-run 重跑以真实发布。");
} else {
	console.log("\n✓ 全部完成！可以跑 `npm view puck version` 验证。");
}
