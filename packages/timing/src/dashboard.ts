/**
 * Self-contained HTML dashboard for timing records.
 *
 * Zero dependencies, zero CDN: data is inlined as JSON and rendered with
 * plain CSS + a little JS (div bar charts). Open the file directly in a
 * browser; it also works from file:// with no server.
 */

import { aggregateByModel, aggregateBySession, detectAnomalies, formatMs } from "./aggregate.js";
import type { TurnTiming } from "./types.js";

export interface DashboardOptions {
	title?: string;
	/** Cap rendered turns (charts stay readable on huge stores). */
	maxTurns?: number;
}

export function generateDashboard(records: TurnTiming[], options: DashboardOptions = {}): string {
	const title = options.title ?? "puck timing dashboard";
	const maxTurns = options.maxTurns ?? 500;
	const recent = records.slice(-maxTurns);
	const byModel = aggregateByModel(records);
	const bySession = aggregateBySession(records);
	const anomalies = detectAnomalies(records);

	const totalTurns = records.length;
	const okTurns = records.filter((r) => !r.isError);
	const totalTokens = records.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
	const wallMs = records.length > 0 ? Math.max(...records.map((r) => r.timestamp + r.durationMs)) - Math.min(...records.map((r) => r.timestamp)) : 0;

	const data = {
		records: recent,
		byModel,
		bySession,
		anomalies: anomalies.map((a) => ({ ...a, records: a.records.slice(0, 20) })),
		kpi: { totalTurns, totalTokens, wallMs, models: byModel.length, sessions: bySession.length },
	};

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
	:root { --bg:#0f1115; --card:#171a21; --border:#252a35; --text:#d7dce5; --dim:#8b93a5; --accent:#4f8cff; --good:#3fb970; --warn:#e0a93f; --bad:#e05b5b; }
	* { box-sizing: border-box; margin: 0; }
	body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 24px; }
	h1 { font-size: 20px; margin-bottom: 4px; }
	h2 { font-size: 15px; margin: 28px 0 12px; color: var(--accent); }
	.sub { color: var(--dim); margin-bottom: 20px; }
	.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
	.kpi { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
	.kpi .v { font-size: 22px; font-weight: 700; }
	.kpi .l { color: var(--dim); font-size: 12px; }
	table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
	th, td { padding: 8px 12px; text-align: right; font-variant-numeric: tabular-nums; }
	th { background: #1c2029; color: var(--dim); font-weight: 500; font-size: 12px; }
	th:first-child, td:first-child { text-align: left; }
	tr:nth-child(even) td { background: rgba(255,255,255,0.015); }
	.bars { display: flex; flex-direction: column; gap: 4px; }
	.bar-row { display: grid; grid-template-columns: 160px 1fr 70px; gap: 10px; align-items: center; font-size: 12px; }
	.bar-label { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
	.bar-track { background: #20242e; border-radius: 4px; height: 14px; position: relative; }
	.bar-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }
	.bar-ttft { position: absolute; inset: 0 auto 0 0; border-radius: 4px 0 0 4px; background: var(--warn); }
	.bar-val { color: var(--dim); }
	.tag { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
	.tag.good { background: rgba(63,185,112,.15); color: var(--good); }
	.tag.bad { background: rgba(224,91,91,.15); color: var(--bad); }
	.tag.warn { background: rgba(224,169,63,.15); color: var(--warn); }
	.legend { display: flex; gap: 16px; margin: 8px 0; font-size: 12px; color: var(--dim); }
	.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
	select { background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
	.anomaly { background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--warn); border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; }
	.anomaly b { color: var(--warn); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="sub" id="sub"></div>

<h2>总览</h2>
<div class="kpis" id="kpis"></div>

<h2>按模型统计 <select id="modelFilter"><option value="">全部模型</option></select></h2>
<div id="modelTable"></div>

<h2>每轮耗时（最近 ${recent.length} 轮）</h2>
<div class="legend"><span><i style="background:var(--warn)"></i>TTFT（首 token）</span><span><i style="background:var(--accent)"></i>整轮时长</span></div>
<div class="bars" id="turnBars"></div>

<h2>按会话</h2>
<div id="sessionTable"></div>

<h2>异常点</h2>
<div id="anomalies"></div>

<script>
const DATA = ${JSON.stringify(data)};
const fmt = ms => ms < 1000 ? Math.round(ms) + "ms" : ms < 60000 ? (ms/1000).toFixed(1) + "s" : Math.floor(ms/60000) + "m" + Math.round((ms%60000)/1000) + "s";
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

document.getElementById("sub").textContent =
	DATA.kpi.totalTurns + " 轮 · " + DATA.kpi.models + " 个模型 · " + DATA.kpi.sessions + " 个会话 · 生成于 " + new Date().toLocaleString();

document.getElementById("kpis").innerHTML = [
	["总轮数", DATA.kpi.totalTurns],
	["总 tokens", DATA.kpi.totalTokens.toLocaleString()],
	["累计活跃时长", fmt(DATA.kpi.wallMs)],
	["模型数", DATA.kpi.models],
].map(([l, v]) => '<div class="kpi"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>').join("");

function renderModelTable(filter) {
	const rows = DATA.byModel.filter(s => !filter || s.model === filter);
	document.getElementById("modelTable").innerHTML =
		'<table><tr><th>模型</th><th>轮数</th><th>错误</th><th>TTFT avg</th><th>TTFT p95</th><th>时长 p50</th><th>时长 p95</th><th>tok/s</th><th>工具轮</th></tr>' +
		rows.map(s => '<tr><td>' + esc(s.model) + '</td><td>' + s.turns + '</td><td>' +
			(s.errorRate > 0 ? '<span class="tag bad">' + s.errors + " (" + Math.round(s.errorRate * 100) + "%)</span>" : '<span class="tag good">0</span>') +
			'</td><td>' + fmt(s.avgTtftMs) + '</td><td>' + fmt(s.p95TtftMs) + '</td><td>' + fmt(s.p50DurationMs) + '</td><td>' + fmt(s.p95DurationMs) +
			'</td><td>' + (s.avgTokensPerSecond || "–") + '</td><td>' + s.toolTurns + " (" + fmt(s.avgToolMs) + ")</td></tr>").join("") + "</table>";
}

const select = document.getElementById("modelFilter");
for (const s of DATA.byModel) {
	const option = document.createElement("option");
	option.value = s.model; option.textContent = s.model + " (" + s.turns + ")";
	select.appendChild(option);
}
select.onchange = () => renderModelTable(select.value);
renderModelTable("");

const records = [...DATA.records].reverse(); // newest first
const maxDur = Math.max(1, ...records.map(r => r.durationMs));
document.getElementById("turnBars").innerHTML = records.slice(0, 120).map(r => {
	const ttft = r.ttftMs || 0;
	return '<div class="bar-row"><div class="bar-label">' + new Date(r.timestamp).toLocaleTimeString() + " · " + esc(r.model) +
		'</div><div class="bar-track"><div class="bar-fill" style="width:' + (r.durationMs / maxDur * 100) + '%"></div>' +
		'<div class="bar-ttft" style="width:' + (ttft / maxDur * 100) + '%"></div></div>' +
		'<div class="bar-val">' + fmt(r.durationMs) + (r.isError ? " ✗" : "") + "</div></div>";
}).join("");

document.getElementById("sessionTable").innerHTML =
	'<table><tr><th>会话</th><th>模型</th><th>轮数</th><th>累计时长</th><th>最近活动</th></tr>' +
	DATA.bySession.slice(0, 30).map(s => '<tr><td>' + esc(s.sessionId.slice(0, 18)) + '</td><td>' + s.models.map(esc).join(", ") +
		'</td><td>' + s.turns + '</td><td>' + fmt(s.totalDurationMs) + '</td><td>' + new Date(s.lastAt).toLocaleString() + "</td></tr>").join("") + "</table>";

document.getElementById("anomalies").innerHTML = DATA.anomalies.length === 0
	? '<div class="anomaly"><b>✓</b> 未发现明显异常（样本 ≥3 时生效）</div>'
	: DATA.anomalies.map(a => '<div class="anomaly"><b>' + esc(a.kind) + "</b> · " + esc(a.model) + " — " + esc(a.detail) + "</div>").join("");
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
