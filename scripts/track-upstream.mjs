// scripts/track-upstream.mjs
// =====================================================================
//  上游 harness 版本跟踪：pi / codex / dsh(DeepSeek Harness)
// =====================================================================
//  做什么：
//    1. 查询三个上游仓库的最新 release / tag / commit（GitHub 公开 API，
//       匿名额度 60 req/h，够用；GITHUB_TOKEN 可提到 5000）
//    2. 与 docs/upstream-tracker/state.json 里记录的"上次已知版本"对比
//    3. 有更新时：
//         - 拉取 release notes / 最近提交列表（新功能的原始材料）
//         - 生成 docs/upstream-tracker/reports/YYYY-MM-DD.md 分析报告骨架
//           （预填上游材料，留空"是否融合进 puck"的分析区）
//         - 更新 state.json
//
//  用法：
//    node scripts/track-upstream.mjs              # 检查 + 生成报告（默认）
//    node scripts/track-upstream.mjs --check      # 只看状态，不写文件
//    GITHUB_TOKEN=xxx node scripts/track-upstream.mjs   # 提升 API 额度
//
//  设计约束（与 puck 哲学一致）：
//    - 零依赖：只用 node:fetch / node:fs，不装 npm 包
//    - 幂等：同一周重复跑不会生成重复报告
//    - 失败安全：单个上游查询失败不影响其他两个；全失败 exit 1
//    - 报告是"骨架"不是"结论"——分析必须由人（或 agent 会话）完成，
//      脚本只负责收集材料，避免自动生成的空话污染决策记录
// =====================================================================

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import process from "node:process";

const ROOT = join(import.meta.dirname, "..");
const TRACKER_DIR = join(ROOT, "docs", "upstream-tracker");
const REPORTS_DIR = join(TRACKER_DIR, "reports");
const STATE_FILE = join(TRACKER_DIR, "state.json");
const INTEGRATIONS_DIR = join(TRACKER_DIR, "integrations");

const CHECK_ONLY = process.argv.includes("--check");

// ── 上游注册表 ─────────────────────────────────────────────────
const UPSTREAMS = [
	{
		id: "pi",
		label: "pi",
		repo: "badlogic/pi-mono", // npm: pi-coding-agent / @mariozechner/pi-*
		why: "分层复用派：pi 是 puck 最大的参考来源（StreamFn 接缝、/resume 的 cwd 限定、agent.md 约定都源自 pi）",
	},
	{
		id: "codex",
		label: "Codex CLI",
		repo: "openai/codex", // npm: @openai/codex
		why: "工业沙箱派：强制沙箱（Landlock/seccomp）、exec 模式协议、多 provider 配置值得跟进",
	},
	{
		id: "dsh",
		label: "DeepSeek Harness (dsh)",
		repo: "deepseek-ai/DeepSeek-Harness",
		why: "插件生态派：插件市场、UI 形态、模型路由的做法可以借鉴",
	},
];

// ── GitHub API（匿名可用，带 token 更稳）─────────────────────────
const GH_API = "https://api.github.com";
const headers = {
	Accept: "application/vnd.github+json",
	"User-Agent": "puck-harness-upstream-tracker",
	...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function gh(path) {
	const res = await fetch(`${GH_API}${path}`, { headers });
	if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
	return res.json();
}

// ── 状态存取 ───────────────────────────────────────────────────
function loadState() {
	if (!existsSync(STATE_FILE)) return {};
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function saveState(state) {
	writeFileSync(STATE_FILE, JSON.stringify(state, null, "\t") + "\n");
}

// ── 单个上游：拉最新版本 + 变更材料 ─────────────────────────────
async function fetchUpstream(u) {
	// release 优先；无 release 的仓库退到 tag；再退到默认分支 HEAD
	let release = null;
	try {
		const r = await gh(`/repos/${u.repo}/releases/latest`);
		release = {
			tag: r.tag_name,
			publishedAt: r.published_at,
			url: r.html_url,
			// release notes 正文（可能为空）
			notes: (r.body || "").trim(),
		};
	} catch {
		/* 无 release → 走 tag */
	}

	let tag = null;
	if (!release) {
		try {
			const tags = await gh(`/repos/${u.repo}/tags?per_page=1`);
			if (tags[0]) tag = { tag: tags[0].name };
		} catch {
			/* 无 tag → 走 commit */
		}
	}

	// 默认分支最近提交（无论有没有 release 都拉，作为补充材料）
	const repo = await gh(`/repos/${u.repo}`);
	const branch = repo.default_branch;
	const commits = await gh(`/repos/${u.repo}/commits?sha=${branch}&per_page=15`);
	const head = commits[0];

	const current = {
		branch,
		headSha: head.sha,
		headDate: head.commit.committer.date,
		headMessage: head.commit.message.split("\n")[0],
		version: release ? `release ${release.tag}` : tag ? `tag ${tag.tag}` : `commit ${head.sha.slice(0, 8)}`,
		versionUrl: release ? release.url : `https://github.com/${u.repo}/commits/${branch}`,
	};

	const material = {
		release,
		tag,
		commits: commits.map((c) => ({
			sha: c.sha.slice(0, 8),
			date: c.commit.committer.date,
			message: c.commit.message.split("\n")[0],
			url: c.html_url,
		})),
	};

	return { current, material };
}

// ── 版本对比 ───────────────────────────────────────────────────
function hasChanged(prev, current) {
	if (!prev) return true; // 首次跟踪 → 全部视为"新"
	if (prev.version !== current.version) return true;
	if (prev.headSha !== current.headSha) return true;
	return false;
}

// ── 报告骨架生成 ───────────────────────────────────────────────
function isoWeek(date = new Date()) {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = d.getUTCDay() || 7; // 周一=1..周日=7
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function renderReport(dateStr, week, results) {
	const lines = [];
	lines.push(`# 上游跟踪分析 — ${dateStr}（${week}）`);
	lines.push("");
	lines.push(`> 由 \`scripts/track-upstream.mjs\` 于 ${new Date().toISOString()} 自动生成。`);
	lines.push("> 材料是脚本收集的原始事实；**「分析与融合决策」区必须由人 / agent 会话填写**，写完才算完成本周跟踪。");
	lines.push("");
	lines.push("---");
	lines.push("");
	for (const r of results) {
		const u = r.upstream;
		lines.push(`## ${u.label}`);
		lines.push("");
		lines.push(`- 仓库：https://github.com/${u.repo}`);
		lines.push(`- 当前版本：[${r.current.version}](${r.current.versionUrl})（HEAD ${r.current.headSha.slice(0, 8)} @ ${r.current.headDate}）`);
		if (r.prev) {
			lines.push(`- 上次记录：${r.prev.version}（HEAD ${(r.prev.headSha || "").slice(0, 8)} @ ${r.prev.headDate ?? "?"}）`);
			lines.push(`- **状态：${r.changed ? "有更新" : "无变化"}**`);
		} else {
			lines.push(`- **状态：首次跟踪（建立基线）**`);
		}
		lines.push(`- 为什么跟踪它：${u.why}`);
		lines.push("");
		if (r.changed || !r.prev) {
			lines.push("### 本期变更材料");
			lines.push("");
			if (r.material.release?.notes) {
				lines.push("#### Release notes");
				lines.push("");
				lines.push("```text");
				// release notes 可能很长——截到前 4000 字，足够分析用
				const notes = r.material.release.notes;
				lines.push(notes.length > 4000 ? notes.slice(0, 4000) + "\n…（截断，全文见 release 页）" : notes);
				lines.push("```");
				lines.push("");
			}
			lines.push(`#### 默认分支（\`${r.current.branch}\`）最近 ${r.material.commits.length} 条提交`);
			lines.push("");
			lines.push("| 日期 | 提交 | 说明 |");
			lines.push("|---|---|---|");
			for (const c of r.material.commits) {
				lines.push(`| ${c.date.slice(0, 10)} | [\`${c.sha}\`](${c.url}) | ${c.message.replace(/\|/g, "\\|")} |`);
			}
			lines.push("");
			lines.push("### 分析与融合决策（人工填写）");
			lines.push("");
			lines.push("<!-- 按下面的模板填，删掉不适用的 -->");
			lines.push("");
			lines.push("1. **新功能清单**（从上面材料里挑出「功能层面」的变更，忽略纯 CI/依赖/重构）：");
			lines.push("   - （待填）");
			lines.push("2. **逐条评估：适合融合进 puck 吗？**");
			lines.push("   - （待填。判断标准：是否符合 puck 的极简/裁切哲学；core 是否仍是 ~700 行零依赖；");
			lines.push("     是否只是一个目录可加的特性而不是必须进 core 的能力；实现成本）");
			lines.push("3. **决策**：");
			lines.push("   - 融合 → 在 docs/upstream-tracker/integrations/ 建对应记录，标题含本周期号");
			lines.push("   - 不融合（理由）→ 写在这里");
			lines.push("   - 观察（下期再看）→ 写在这里");
			lines.push("");
		} else {
			lines.push("_无变化——本期跳过分析。_");
			lines.push("");
		}
		lines.push("---");
		lines.push("");
	}
	lines.push("## 本周总结（人工填写）");
	lines.push("");
	lines.push("- 融合了什么：");
	lines.push("- 明确拒绝什么（含理由）：");
	lines.push("- 挂起观察什么：");
	lines.push("");
	return lines.join("\n");
}

// ── 主流程 ─────────────────────────────────────────────────────
async function main() {
	mkdirSync(REPORTS_DIR, { recursive: true });
	mkdirSync(INTEGRATIONS_DIR, { recursive: true });

	const state = loadState();
	const today = new Date();
	const dateStr = today.toISOString().slice(0, 10);
	const week = isoWeek(today);

	console.log(`上游跟踪 · ${dateStr}（${week}）${CHECK_ONLY ? " [check-only]" : ""}\n`);

	const results = [];
	let failures = 0;
	for (const u of UPSTREAMS) {
		try {
			const { current, material } = await fetchUpstream(u);
			const prev = state[u.id] ?? null;
			const changed = hasChanged(prev, current);
			results.push({ upstream: u, current, material, prev, changed });
			const delta = !prev ? "首次跟踪" : changed ? `更新：${prev.version} → ${current.version}` : "无变化";
			console.log(`  ${u.label}: ${current.version} · ${delta}`);
		} catch (e) {
			failures++;
			console.error(`  ${u.label}: 查询失败 — ${e.message}`);
		}
	}

	if (results.length === 0) {
		console.error("\n所有上游都查询失败（网络 / 限流？）。不写任何文件。");
		process.exit(1);
	}

	if (CHECK_ONLY) {
		console.log("\n[check-only] 不写 state / 不生成报告。");
		return;
	}

	// 有任一更新 → 写周报；全无变化 → 只更新 state 里的 headSha（保持新鲜）
	const anyChange = results.some((r) => r.changed);
	const reportFile = join(REPORTS_DIR, `${week}.md`);
	if (anyChange && !existsSync(reportFile)) {
		writeFileSync(reportFile, renderReport(dateStr, week, results));
		console.log(`\n报告骨架已生成：docs/upstream-tracker/reports/${week}.md`);
		console.log("→ 请打开填写「分析与融合决策」，完成后本周期跟踪才算关闭。");
	} else if (anyChange && existsSync(reportFile)) {
		console.log(`\n本周报告已存在（${week}.md），不覆盖——只刷新 state。`);
	} else {
		console.log("\n无上游更新——不生成报告。");
	}

	const nextState = { ...state, updatedAt: today.toISOString() };
	for (const r of results) nextState[r.upstream.id] = r.current;
	saveState(nextState);
	console.log("state 已更新：docs/upstream-tracker/state.json");

	if (failures > 0) {
		console.error(`\n⚠ ${failures} 个上游查询失败（见上）；state 只记录成功的。`);
		process.exitCode = 1;
	}
}

main().catch((e) => {
	console.error("tracker crashed:", e);
	process.exit(1);
});
