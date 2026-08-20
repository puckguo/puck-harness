/**
 * puck web client — vanilla JS, zero build. Full parity with the CLI REPL.
 *
 *   POST /api/run  → SSE stream of WebEvent (AgentEvent passthrough)
 *   /api/state /api/sessions /api/models /api/providers /api/status
 *   /api/model /api/think /api/compact /api/timings /api/login /api/logout /api/abort
 *
 * Rendering mirrors the CLI's term.ts visual language exactly:
 *   - turn divider (dim ───) before every user message
 *   - thinking gray stream + newline separator before body
 *   - tool lines: ⏳ name + colored operand, edit shows -old/+new diff
 *   - tool results: ✅/❌ + 3-line fold + "└─ +N more"
 *   - per-run stats line: — N tokens · 首字 X.Xs · 本轮 Y.Ys —
 *   - spinner during silent periods (⠹ thinking … 1.3s)
 *   - status bar: cwd · ↑in ↓out · ctx% (yellow>70% / red>90%) · model
 *   - last-turn summary line + document.title (puck · 摘要…)
 *   - file trail: ✎ 最新 ← 较旧
 *   - slash command popup with prefix filtering
 *   - history: ↑/↓ recall, persisted server-side by the browser
 *   - Ctrl+C guard: first press warns, second within 3s aborts
 */

const $ = (id) => document.getElementById(id);
const stream = $("stream");
const input = $("input");
const sendBtn = $("send");
const abortBtn = $("abort");
const modal = $("modal");
const modalCard = $("modal-card");

const SLASH_COMMANDS = [
	{ name: "model", args: "[id]", desc: "切换模型（provider/model，同时设为默认）" },
	{ name: "models", desc: "列出已接入 provider 的可用模型（实时）" },
	{ name: "think", args: "[off|low|medium|high]", desc: "调整 thinking 等级（下一轮生效）" },
	{ name: "compact", desc: "手动压缩上下文（摘要折叠旧对话，保留最近轮）" },
	{ name: "clear", desc: "清空上下文，开始新对话（原会话保留，/resume 可找回）" },
	{ name: "resume", desc: "选择一个历史会话继续对话" },
	{ name: "timings", desc: "模型用时统计摘要" },
	{ name: "status", desc: "当前模型 / 会话 / key 状态" },
	{ name: "login", args: "[provider]", desc: "接入 provider / 存 API key" },
	{ name: "logout", args: "<provider>", desc: "移除已存的 key" },
	{ name: "help", desc: "显示命令帮助" },
];

let sessionId = null;
let running = false;
let abortCtl = null;
let bar = { model: "", cwd: "", inTokens: 0, outTokens: 0, ctxTokens: 0, ctxWindow: 0 };
let summary = "";
let history = [];
let thinkingEffort = null;

try {
	history = JSON.parse(localStorage.getItem("puck-history") ?? "[]");
} catch {
	history = [];
}
let historyIdx = -1;
let historyDraft = "";

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

function scrolledToBottom() {
	return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
}

function append(node) {
	const stick = scrolledToBottom();
	stream.appendChild(node);
	if (stick) stream.scrollTop = stream.scrollHeight;
	return node;
}

function textOf(content) {
	return (content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

function brief(s, max = 110) {
	const one = String(s ?? "").replace(/\s*\n\s*/g, " ⌉ ");
	return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** CLI-equivalent tool-start line (renderToolStart in term.ts). */
function toolLine(name, args) {
	const line = el("div", "tool-line");
	const a = args ?? {};
	if (name === "bash") {
		line.append(el("span", "name", "⏳ bash "), el("span", "cmd", "$ " + brief(a.command)));
	} else if (name === "read") {
		line.append(el("span", "name", "⏳ read "), el("span", "pth", brief(a.path)));
	} else if (name === "write") {
		line.append(el("span", "name", "⏳ write "), el("span", "pth", brief(a.path)));
	} else if (name === "edit") {
		line.append(el("span", "name", "⏳ edit "), el("span", "pth", brief(a.path)));
		const edits = Array.isArray(a.edits) ? a.edits : [];
		for (const e of edits.slice(0, 3)) {
			if (typeof e.oldText === "string" && e.oldText) line.append(el("div", "diff-del", "- " + brief(e.oldText, 72)));
			if (typeof e.newText === "string" && e.newText) line.append(el("div", "diff-add", "+ " + brief(e.newText, 72)));
		}
	} else {
		line.append(el("span", "name", "⏳ " + name + " "), el("span", "", brief(JSON.stringify(args))));
	}
	return line;
}

/** CLI-equivalent tool-end fold (renderToolEnd in term.ts): 3 lines + +N. */
function toolFold(result) {
	const lines = (result?.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n")
		.split("\n")
		.filter((l, i, arr) => l.trim() !== "" || i < arr.length - 1);
	const fold = el("div", "tool-fold");
	for (const line of lines.slice(0, 3)) fold.append(el("div", "", line));
	if (lines.length > 3) fold.append(el("div", "", `└─ +${lines.length - 3} more`));
	return fold;
}

function fmtTok(n) {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1000) return Math.round(n / 1000) + "k";
	return String(n ?? 0);
}

function fmtMs(ms) {
	return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function relTime(ts) {
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h} 小时前`;
	const d = Math.floor(h / 24);
	if (d === 1) return "昨天";
	if (d < 7) return `${d} 天前`;
	const t = new Date(ts);
	return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/** CLI summarizeTurn: user intent + file/command actions, no extra LLM call. */
function summarizeTurn(messages) {
	let userFirstLine = "";
	const files = [];
	let bashCount = 0;
	let answered = false;
	for (const m of messages) {
		if (m.role === "user" && !userFirstLine) {
			const text = typeof m.content === "string" ? m.content : textOf(m.content);
			const line = text.split("\n").map((t) => t.trim()).find(Boolean);
			if (line) userFirstLine = line.replace(/\s+/g, " ");
		} else if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content) {
				if (block.type === "toolCall") {
					const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
					if ((block.name === "write" || block.name === "edit") && path) {
						if (!files.includes(path)) files.push(path);
					} else if (block.name === "bash") bashCount++;
				}
			}
			if (m.content.some((b) => b.type === "text" && b.text)) answered = true;
		}
	}
	const fileNames = files.map((p) => p.split(/[\\/]/).pop() || p);
	const action =
		fileNames.length > 0
			? `改动 ${fileNames.slice(0, 2).join("、")}${fileNames.length > 2 ? ` 等${fileNames.length}个文件` : ""}`
			: bashCount > 0
				? `执行命令 ×${bashCount}`
				: answered
					? "回答"
					: "";
	const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
	return {
		short: userFirstLine ? clip(userFirstLine, 10) : clip(fileNames[0] ?? action, 10),
		oneLine: clip(action && userFirstLine ? `${userFirstLine} → ${action}` : userFirstLine || action, 120),
	};
}

// ---------------------------------------------------------------------------
// chrome: spinner / status bar / summary / file trail
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const spinner = {
	active: false,
	node: null,
	timer: null,
	startedAt: 0,
	start() {
		if (this.active) return;
		this.active = true;
		this.startedAt = Date.now();
		this.node = el("div", "spinner-line");
		this.node.append(el("span", "spin-glyph", SPINNER_FRAMES[0]), el("span", "", " thinking …"));
		append(this.node);
		let i = 0;
		this.timer = setInterval(() => {
			i = (i + 1) % SPINNER_FRAMES.length;
			this.node.firstChild.textContent = SPINNER_FRAMES[i];
			this.node.lastChild.textContent = ` thinking … ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
		}, 100);
	},
	stop() {
		if (!this.active) return;
		this.active = false;
		clearInterval(this.timer);
		this.node?.remove();
		this.node = null;
	},
};

const fileTrail = {
	files: [],
	record(path) {
		this.files = [path, ...this.files.filter((p) => p !== path)].slice(0, 8);
		renderTrail();
	},
	clear() {
		this.files = [];
		renderTrail();
	},
};

function renderTrail() {
	const trail = $("trail");
	if (fileTrail.files.length === 0) {
		trail.textContent = "";
		return;
	}
	trail.replaceChildren();
	trail.append(el("span", "trail-mark", "✎ "));
	fileTrail.files.forEach((f, i) => {
		if (i > 0) trail.append(el("span", "trail-sep", " ← "));
		trail.append(el("span", i === 0 ? "trail-new" : "trail-old", f.split(/[\\/]/).pop() || f));
	});
}

function renderBar() {
	$("model").textContent = bar.model || "mock";
	$("model2").textContent = bar.model || "";
	$("cwd").textContent = bar.cwd || "";
	const tok = [];
	if (bar.inTokens || bar.outTokens) tok.push(`↑${fmtTok(bar.inTokens)} ↓${fmtTok(bar.outTokens)}`);
	$("tok").textContent = tok.join("  ");
	if (bar.ctxWindow > 0) {
		const pct = (bar.ctxTokens / bar.ctxWindow) * 100;
		const ctx = $("ctx");
		ctx.textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%/${fmtTok(bar.ctxWindow)}`;
		ctx.className = "ctx " + (pct > 90 ? "hot" : pct > 70 ? "warn" : "");
	} else {
		$("ctx").textContent = "";
		$("ctx").className = "ctx";
	}
}

function renderSummary() {
	$("summary").textContent = summary || "";
	document.title = summary ? `puck · ${summarizeShort(summary)}` : "puck";
}

function summarizeShort(oneLine) {
	return oneLine.length > 10 ? oneLine.slice(0, 9) + "…" : oneLine;
}

// ---------------------------------------------------------------------------
// live event rendering — mirrors renderEvents() in the CLI
// ---------------------------------------------------------------------------

let current = null; // { wrap, think, text, thinkText, textText }
let runStartAt = 0;
let firstTokenAt = 0;

function beginAssistant() {
	if (current) return;
	const wrap = el("div", "block");
	current = { wrap, think: null, text: null, thinkText: "", textText: "" };
	append(wrap);
}

function updateAssistant(message) {
	beginAssistant();
	const think = (message.content ?? []).filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("");
	const text = textOf(message.content);
	const grew = (think.length > current.thinkText.length || text.length > current.textText.length) && (think || text);
	if (grew) spinner.stop(); // first visible delta retires the spinner
	if (think && !current.think) {
		current.think = el("div", "think");
		current.wrap.append(current.think);
	}
	if (think.startsWith(current.thinkText) && think.length > current.thinkText.length) {
		current.think.append(document.createTextNode(think.slice(current.thinkText.length)));
		current.thinkText = think;
	}
	if (text && !current.text && current.think) current.wrap.append(el("div", "sep", "")); // newline separator
	if (text && !current.text) {
		current.text = el("div", "text");
		current.wrap.append(current.text);
	}
	if (text.startsWith(current.textText) && text.length > current.textText.length) {
		current.text.append(document.createTextNode(text.slice(current.textText.length)));
		current.textText = text;
	}
	if (running && firstTokenAt === 0 && runStartAt && grew) firstTokenAt = Date.now() - runStartAt;
	const stick = scrolledToBottom();
	if (stick) stream.scrollTop = stream.scrollHeight;
}

function endAssistant(message) {
	spinner.stop();
	if (message.stopReason === "error") {
		append(el("div", "srv", "✗ " + (message.errorMessage ?? "error")));
	}
	current = null;
}

function handleEvent(event) {
	switch (event.type) {
		case "run_start":
			spinner.start();
			workingTitle(true);
			break;
		case "message_start":
			if (event.message.role === "assistant") {
				updateAssistant(event.message);
			} else if (event.message.role === "user") {
				// NOT rendered — the composer already echoed it locally (the
				// server-side user frame is protocol completeness, not UI input)
			}
			break;
		case "message_update":
			// THE streaming path: every delta snapshot re-renders append-only
			if (event.message.role === "assistant") updateAssistant(event.message);
			break;
		case "message_end":
			if (event.message.role === "assistant") {
				endAssistant(event.message);
			}
			break;
		case "tool_start":
			spinner.stop();
			if ((event.toolName === "write" || event.toolName === "edit") && typeof event.args?.path === "string") {
				fileTrail.record(event.args.path);
			}
			append(toolLine(event.toolName, event.args));
			break;
		case "tool_end": {
			append(el("div", event.isError ? "tool-err" : "tool-ok", (event.isError ? "❌ " : "✅ ") + event.toolName));
			const fold = toolFold(event.result);
			if (fold.childNodes.length > 0) append(fold);
			spinner.start(); // tools done → next LLM turn is another silent period
			break;
		}
		case "turn_end":
			bar.inTokens += event.message.usage?.input ?? 0;
			bar.outTokens += event.message.usage?.output ?? 0;
			bar.ctxTokens = event.message.usage?.input ?? bar.ctxTokens;
			renderBar();
			break;
		case "run_end": {
			spinner.stop();
			workingTitle(false);
			// CLI parity: the run's own messages drive the turn summary
			const s = summarizeTurn(event.messages ?? []);
			if (s.oneLine) {
				summary = s.oneLine;
				renderSummary();
			}
			const usage = (event.messages ?? []).reduce((t, m) => t + (m.usage?.totalTokens ?? 0), 0);
			const parts = [];
			if (usage > 0) parts.push(`${usage} tokens`);
			if (firstTokenAt) parts.push(`首字 ${fmtMs(firstTokenAt)}`);
			if (runStartAt) parts.push(`本轮 ${fmtMs(Date.now() - runStartAt)}`);
			if (parts.length > 0) append(el("div", "stats", `— ${parts.join(" · ")} —`));
			firstTokenAt = 0;
			runStartAt = 0;
			break;
		}
		case "model_update":
			if (event.modelId) {
				bar.model = event.modelId;
				renderBar();
			}
			break;
		case "server_notice":
			if (event.message.startsWith("session ")) {
				if (!sessionId) sessionId = event.message.slice(8);
			} else if (event.message.startsWith("model → ")) {
				// already handled by model_update
			} else {
				append(el("div", "srv", event.message));
			}
			break;
		case "server_error":
			append(el("div", "srv", "✗ " + event.message));
			break;
		case "run_settled":
			setRunning(false);
			break;
		default:
			break;
	}
}

/** Document-title spinner while working (CLI WorkingTitle). */
let titleTimer = null;
function workingTitle(on) {
	clearInterval(titleTimer);
	if (on) {
		const frames = ["✻", "✽", "✶", "✳"];
		let i = 0;
		titleTimer = setInterval(() => {
			document.title = `${frames[i++ % frames.length]} Working…`;
		}, 200);
	} else {
		document.title = summary ? `puck · ${summarizeShort(summary)}` : "puck";
	}
}

// ---------------------------------------------------------------------------
// run loop
// ---------------------------------------------------------------------------

function setRunning(on) {
	running = on;
	sendBtn.disabled = on;
	abortBtn.style.display = on ? "" : "none";
	if (!on) spinner.stop();
}

function rememberHistory(line) {
	if (!line) return;
	if (history[history.length - 1] === line) return;
	history.push(line);
	while (history.length > 500) history.shift();
	try {
		localStorage.setItem("puck-history", JSON.stringify(history));
	} catch {
		/* storage may be unavailable */
	}
}

async function send() {
	const text = input.value.trim();
	if (!text || running) return;

	// slash command → local handling (parity with the REPL)
	if (text.startsWith("/")) {
		input.value = "";
		input.style.height = "auto";
		hidePopup();
		await handleSlash(text.slice(1));
		return;
	}

	input.value = "";
	input.style.height = "auto";
	hidePopup();
	rememberHistory(text);
	historyIdx = -1;

	// divider + local echo of the user message (CLI: divider → "you › …")
	append(el("div", "divider", "─".repeat(72)));
	append(el("div", "block you", text));

	setRunning(true);
	runStartAt = Date.now();
	firstTokenAt = 0;
	abortCtl = new AbortController();
	try {
		const res = await fetch("/api/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId, input: text }),
			signal: abortCtl.signal,
		});
		if (!res.ok || !res.body) {
			const detail = await res.text().catch(() => "");
			append(el("div", "srv", `✗ HTTP ${res.status} ${detail}`));
			setRunning(false);
			return;
		}
		await readSse(res, handleEvent);
	} catch (error) {
		if (error?.name !== "AbortError") append(el("div", "srv", "✗ " + (error?.message ?? error)));
	} finally {
		setRunning(false);
		workingTitle(false);
	}
}

async function readSse(res, onEvent) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx;
		while ((idx = buf.indexOf("\n\n")) >= 0) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const line = frame.split("\n").find((l) => l.startsWith("data: "));
			if (line) {
				try {
					onEvent(JSON.parse(line.slice(6)));
				} catch {
					/* skip malformed frame */
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// slash commands — parity with handleSlashCommand() in the CLI
// ---------------------------------------------------------------------------

async function handleSlash(name) {
	const [cmd, ...rest] = name.split(/\s+/);
	const arg = rest.join(" ");
	append(el("div", "block you", "/" + name));

	switch (cmd) {
		case "help": {
			const box = el("div", "block help");
			for (const c of SLASH_COMMANDS) {
				box.append(el("div", "", ("/" + c.name + (c.args ? " " + c.args : "")).padEnd(24) + c.desc));
			}
			append(box);
			break;
		}
		case "model": {
			if (!arg) {
				await showModels();
				break;
			}
			const res = await api("/api/model", { sessionId, model: arg, persist: true });
			if (res.ok) {
				bar.model = arg;
				bar.ctxWindow = res.json?.ctxWindow ?? bar.ctxWindow;
				renderBar();
				append(el("div", "block sys", `Switched to ${arg} (also saved as default)`));
			} else {
				append(el("div", "srv", "✗ " + (res.json?.error ?? res.status)));
			}
			break;
		}
		case "models":
			await showModels();
			break;
		case "think": {
			const levels = ["off", "low", "medium", "high"];
			if (!arg || !levels.includes(arg)) {
				append(el("div", "block sys", `当前 thinking 等级: ${thinkingEffort ?? "(模型默认)"}`));
				append(el("div", "block sys", "用法: /think off|low|medium|high（下一轮生效）"));
				break;
			}
			thinkingEffort = arg;
			await api("/api/think", { sessionId, effort: arg });
			append(el("div", "block sys", `thinking 等级已设为 ${arg}（下一轮生效）`));
			break;
		}
		case "compact": {
			const res = await api("/api/compact", { sessionId });
			if (res.json?.ok) {
				bar.ctxTokens = res.json.afterTokens;
				renderBar();
				append(el("div", "block sys", `已压缩 折叠 ${res.json.folded} 条 → 保留 ${res.json.keptRecent + 1} 条（~${fmtTok(res.json.beforeTokens)} → ~${fmtTok(res.json.afterTokens)} tok）`));
				append(el("div", "block sys dim", "摘要: " + (String(res.json.summary ?? "").replace(/\s+/g, " ").slice(0, 120) || "(空)") + "…"));
			} else {
				append(el("div", "block sys", res.json?.reason ?? "压缩失败"));
			}
			break;
		}
		case "clear": {
			sessionId = null;
			stream.replaceChildren();
			fileTrail.clear();
			summary = "";
			renderSummary();
			bar.inTokens = 0;
			bar.outTokens = 0;
			bar.ctxTokens = 0;
			renderBar();
			append(el("div", "block sys", "上下文已清空，开始新对话（原会话保留，/resume 可找回）"));
			break;
		}
		case "resume":
			await showSessions();
			break;
		case "timings": {
			const res = await fetch("/api/timings").then((r) => r.json()).catch(() => null);
			if (!Array.isArray(res) || res.length === 0) {
				append(el("div", "block sys", "(尚无计时记录)"));
				break;
			}
			const box = el("div", "block sys");
			for (const s of res) {
				box.append(el("div", "", `${s.model}: ${s.turns}轮 TTFT avg ${fmtMs(s.avgTtftMs)} / p95 ${fmtMs(s.p95TtftMs)}，时长 p50 ${fmtMs(s.p50DurationMs)}，${s.avgTokensPerSecond || "?"} tok/s，错误 ${s.errors}`));
			}
			append(box);
			break;
		}
		case "status": {
			const res = await fetch("/api/status" + (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "")).then((r) => r.json()).catch(() => null);
			if (!res) break;
			const box = el("div", "block sys");
			box.append(el("div", "", `model:    ${res.model}`));
			box.append(el("div", "", `thinking: ${res.thinking ?? "(模型默认)"}`));
			box.append(el("div", "", `keys:     ${res.keysPath}`));
			box.append(el("div", "", `cwd:      ${res.cwd}`));
			box.append(el("div", "", `session:  ${res.session ? `${res.session.id} (${res.session.turns} 轮 · compact ×${res.session.compactions})` : "(in-memory)"}`));
			append(box);
			break;
		}
		case "login":
			await showLogin();
			break;
		case "logout": {
			if (!arg) {
				append(el("div", "block sys", "usage: /logout <provider>"));
				break;
			}
			const res = await api("/api/logout", { provider: arg });
			append(el("div", "block sys", res.ok ? `Removed ${arg} key` : `No stored key for ${arg}`));
			break;
		}
		default:
			append(el("div", "block sys", `Unknown command /${cmd}. Try /help`));
	}
}

async function api(path, body) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* no body */
	}
	return { ok: res.ok, status: res.status, json };
}

// ---------------------------------------------------------------------------
// slash command popup — parity with SlashPopup in term.ts
// ---------------------------------------------------------------------------

let popupSel = 0;

function popupMatches() {
	const q = input.value.slice(1); // strip "/"
	if (!input.value.startsWith("/")) return [];
	return SLASH_COMMANDS.filter((c) => c.name.startsWith(q.toLowerCase()));
}

function renderPopup() {
	hidePopup();
	const matches = popupMatches();
	if (matches.length === 0 || !input.value.startsWith("/")) return;
	const box = el("div", "popup");
	const labelLen = Math.max(...matches.map((m) => ("/" + m.name + " " + (m.args ?? "")).trimEnd().length));
	matches.slice(0, 8).forEach((m, i) => {
		const row = el("div", "popup-row" + (i === popupSel ? " sel" : ""));
		row.append(el("span", "popup-mark", i === popupSel ? "→ " : "  "));
		row.append(el("span", "popup-label", ("/" + m.name + " " + (m.args ?? "")).trimEnd().padEnd(labelLen + 2)));
		row.append(el("span", "popup-desc", m.desc));
		box.append(row);
	});
	box.append(el("div", "popup-sep", "─".repeat(48)));
	box.id = "popup";
	document.body.appendChild(box);
	const rect = input.getBoundingClientRect();
	box.style.left = rect.left + "px";
	box.style.bottom = window.innerHeight - rect.top + 6 + "px";
	box.style.maxWidth = Math.min(640, rect.width) + "px";
}

function hidePopup() {
	document.getElementById("popup")?.remove();
}

// ---------------------------------------------------------------------------
// modals
// ---------------------------------------------------------------------------

function openModal(title, body) {
	modalCard.replaceChildren(el("h3", "", title), body);
	modal.classList.add("open");
}

function closeModal() {
	modal.classList.remove("open");
}

modal.addEventListener("click", (e) => {
	if (e.target === modal) closeModal();
});

async function showSessions() {
	const body = el("div");
	const sessions = await fetch("/api/sessions").then((r) => r.json()).catch(() => []);
	if (!Array.isArray(sessions) || sessions.length === 0) {
		body.append(el("div", "hint", "没有其他历史会话。每轮对话自动保存。"));
	}
	for (const s of sessions.slice(0, 30)) {
		if (s.id === sessionId) continue;
		const item = el("div", "item");
		item.append(el("span", "id", s.title));
		item.append(
			el(
				"span",
				"meta",
				`${s.turns} 轮 · ${s.assistantMessages} 条回复${s.toolCalls > 0 ? ` · ${s.toolCalls} 次工具` : ""}${s.compactions > 0 ? ` · compact ×${s.compactions}` : ""}${s.model ? " · " + s.model : ""} · ${relTime(s.updatedAt)}`,
			),
		);
		item.onclick = () => {
			closeModal();
			void resumeSession(s.id, s.model);
		};
		body.append(item);
	}
	openModal("历史会话 — 选择恢复", body);
}

async function resumeSession(id, model) {
	const state = await fetch(`/api/state?sessionId=${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => null);
	if (!state) return;
	sessionId = id;
	thinkingEffort = state.thinking ?? null;
	bar = {
		model: state.model ?? model ?? "",
		cwd: bar.cwd,
		inTokens: state.inTokens ?? 0,
		outTokens: state.outTokens ?? 0,
		ctxTokens: state.ctxTokens ?? 0,
		ctxWindow: state.ctxWindow ?? 0,
	};
	renderBar();
	stream.replaceChildren();
	fileTrail.clear();
	const messages = state.messages ?? [];
	append(el("div", "block sys", `── 已恢复会话 · ${state.session?.turns ?? "?"} 轮${state.session?.compactions ? ` · 历史压缩 ×${state.session.compactions}` : ""} · 以下是历史回放 ──`));
	for (const m of messages) renderHistoryMessage(m);
	// rehydrate file trail + summary from history (parity with /resume in the CLI)
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content ?? []) {
			if (block.type === "toolCall" && (block.name === "write" || block.name === "edit") && typeof block.arguments?.path === "string") {
				fileTrail.record(block.arguments.path);
			}
		}
	}
	let lastUser = -1;
	for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") lastUser = i;
	if (lastUser >= 0) {
		const s = summarizeTurn(messages.slice(lastUser));
		if (s.oneLine) {
			summary = s.oneLine;
			renderSummary();
		}
	}
}

function renderHistoryMessage(m) {
	if (m.role === "user") {
		const text = typeof m.content === "string" ? m.content : textOf(m.content);
		if (text.trim()) {
			const lines = text.replace(/\s+$/, "").split("\n");
			append(el("div", "block you", lines.slice(0, 12).join("\n") + (lines.length > 12 ? `\n… (+${lines.length - 12} 行)` : "")));
		}
	} else if (m.role === "assistant") {
		const think = (m.content ?? []).filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("");
		if (think.trim()) {
			const lines = think.trim().split("\n");
			append(el("div", "block think", lines.slice(0, 3).join("\n") + (lines.length > 3 ? `\n… (思考共 ${lines.length} 行)` : "")));
		}
		const text = textOf(m.content).replace(/\s+$/, "");
		if (text) append(el("div", "block text", text));
		for (const block of m.content ?? []) {
			if (block.type === "toolCall") append(toolLine(block.name, block.arguments));
		}
	} else if (m.role === "toolResult") {
		append(el("div", m.isError ? "tool-err" : "tool-ok", (m.isError ? "❌ " : "✅ ") + m.toolName));
		const fold = toolFold({ content: m.content });
		if (fold.childNodes.length > 0) append(fold);
	}
}

async function showModels() {
	// Single entry for ALL model picking. Sources, best-effort each:
	//   /api/catalog — every provider + built-in fallbacks (key-less)
	//   /api/providers — older server fallback (same info, no fallback list)
	//   /api/models — live lists for providers with a usable key
	// Any failure degrades gracefully: the modal ALWAYS opens with whatever
	// we have, plus an explicit diagnostic line when a source failed.
	const body = el("div");
	const notes = [];

	const jsonOr = async (path, fallback) => {
		try {
			const res = await fetch(path);
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				notes.push(`${path} → HTTP ${res.status}`);
				return fallback;
			}
			if (!Array.isArray(data)) {
				notes.push(`${path} → 非预期响应`);
				return fallback;
			}
			return data;
		} catch (error) {
			notes.push(`${path} → ${error?.message ?? error}`);
			return fallback;
		}
	};

	const [catalog, providers, live] = await Promise.all([
		jsonOr("/api/catalog", null),
		jsonOr("/api/providers", []),
		jsonOr("/api/models", []),
	]);
	const liveByProvider = new Map((live ?? []).map((e) => [e.provider, e.models]));

	// normalize: catalog shape (provider/name/state/fallback) or providers shape (id/name/state)
	const entries = (catalog ?? providers.map((p) => ({ provider: p.id, name: p.name, state: p.state, fallback: undefined }))).slice();
	// known fallbacks client-side too, so even a keyless old server shows real ids
	const CLIENT_FALLBACKS = {
		anthropic: "claude-sonnet-4-5",
		deepseek: "deepseek-chat",
		groq: "llama-3.3-70b-versatile",
		minimax: "MiniMax-M3",
		"minimax-cn": "MiniMax-M3",
		moonshot: "kimi-k2-0905-vision-preview",
		"moonshot-cn": "kimi-k2-0905-vision-preview",
		openai: "gpt-4o",
		openrouter: "openrouter/auto",
		ollama: "qwen3:8b",
		"qwen-token-plan": "qwen3-coder-plus",
		"qwen-token-plan-cn": "qwen3-coder-plus",
		xai: "grok-4",
	};

	if (notes.length > 0) {
		const box = el("div", "hint warn");
		for (const n of notes) box.append(el("div", "", n));
		body.append(box);
	}
	if (entries.length === 0) {
		body.append(el("div", "hint", "无法获取 provider 目录 — 服务器可能是旧版，请重启：npm run web"));
	} else {
		body.append(el("div", "hint", "点击模型即切换并设为默认；无 key 的 provider 先接入"));
	}

	for (const entry of entries) {
		const fallback = entry.fallback ?? CLIENT_FALLBACKS[entry.provider];
		const group = el("div", "group");
		const head = el("div", "group-head");
		head.append(
			el("span", "group-name", entry.name),
			el("span", "meta " + (entry.state === "stored" ? "ok" : ""), entry.state === "stored" ? "✓ stored" : entry.state === "env" ? "~ env" : "• 无 key"),
		);
		group.append(head);

		const models = [...(liveByProvider.get(entry.provider) ?? [])];
		if (fallback && !models.includes(fallback)) models.unshift(fallback);

		if (models.length === 0) {
			// nothing known at all → offer login
			const loginRow = el("div", "item action");
			loginRow.append(el("span", "id", "接入 " + entry.name + " …"));
			loginRow.onclick = () => {
				closeModal();
				void loginProviderFlow(entry);
			};
			group.append(loginRow);
		} else {
			for (const id of models.slice(0, 25)) {
				group.append(modelRow(`${entry.provider}/${id}`));
			}
			if (models.length > 25) group.append(el("div", "hint pad", `… 还有 ${models.length - 25} 个`));
			if (entry.state === "none") {
				const loginRow = el("div", "item action");
				loginRow.append(el("span", "id", "接入 " + entry.name + " 拉取全部模型 …"));
				loginRow.onclick = () => {
					closeModal();
					void loginProviderFlow(entry);
				};
				group.append(loginRow);
			}
		}
		body.append(group);
	}

	// manual entry — always available, works with any server version
	const manual = el("div", "manual");
	const manualInput = el("input");
	manualInput.placeholder = "或手动输入 provider/model …";
	const manualGo = el("button", "", "切换");
	const applyManual = async () => {
		const value = manualInput.value.trim();
		if (!value) return;
		closeModal();
		const res = await api("/api/model", { sessionId, model: value, persist: true });
		if (res.ok) {
			bar.model = value;
			bar.ctxWindow = res.json?.ctxWindow ?? bar.ctxWindow;
			renderBar();
			append(el("div", "block sys", `Switched to ${value} (also saved as default)`));
		} else {
			append(el("div", "srv", "✗ " + (res.json?.error ?? res.status)));
		}
	};
	manualGo.onclick = () => void applyManual();
	manualInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void applyManual();
		}
	});
	manual.append(manualInput, manualGo);
	body.append(manual);

	openModal("切换模型", body);
}

function modelRow(full) {
	const item = el("div", "item");
	item.append(el("span", "id", full));
	if (full === bar.model) item.append(el("span", "meta", "● 当前"));
	item.onclick = async () => {
		closeModal();
		const res = await api("/api/model", { sessionId, model: full, persist: true });
		if (res.ok) {
			bar.model = full;
			bar.ctxWindow = res.json?.ctxWindow ?? bar.ctxWindow;
			bar.inTokens = 0;
			bar.outTokens = 0;
			renderBar();
			append(el("div", "block sys", `Switched to ${full} (also saved as default)`));
		} else {
			append(el("div", "srv", "✗ " + (res.json?.error ?? res.status)));
		}
	};
	return item;
}

/** Provider login: verify key (dryRun) → store → pick from the live model list. */
async function loginProviderFlow(entry) {
	const key = prompt(`${entry.name} 的 API key:`);
	if (!key) return;
	append(el("div", "block sys dim", `验证 ${entry.name} key …`));
	const verify = await api("/api/login", { provider: entry.provider, apiKey: key, dryRun: true });
	const models = verify.json?.models ?? [];
	if (!verify.json?.ok) {
		append(el("div", "srv", `✗ key 验证失败：${verify.json?.error ?? verify.status}`));
		return;
	}
	// key works → store it
	const stored = await api("/api/login", { provider: entry.provider, apiKey: key });
	if (!stored.ok) {
		append(el("div", "srv", "✗ " + (stored.json?.error ?? stored.status)));
		return;
	}
	append(el("div", "block sys", `Saved ${entry.name} key（可用模型 ${models.length} 个）`));
	if (models.length === 0) {
		append(el("div", "block sys dim", "该端点未返回模型列表 — 用 /model <id> 手动指定"));
		return;
	}
	// live list → pick the default (Enter = first)
	const body = el("div");
	body.append(el("div", "hint", `${entry.name} 可用模型 — 选择默认（Enter 选第一个）`));
	for (const id of models.slice(0, 40)) body.append(modelRow(`${entry.provider}/${id}`));
	openModal(`接入 ${entry.name} — 选择默认模型`, body);
}

async function showLogin() {
	const providers = await fetch("/api/providers").then((r) => r.json()).catch(() => []);
	const body = el("div");
	body.append(el("div", "hint", "选择 provider 录入 API key（存到服务器 ~/.puck/auth.json）"));
	for (const p of providers) {
		const item = el("div", "item");
		item.append(el("span", "id", p.name));
		const stateText = p.state === "stored" ? "✓ stored" : p.state === "env" ? "~ env" : "• unconfigured";
		item.append(el("span", "meta " + (p.state === "stored" ? "ok" : ""), stateText));
		item.onclick = () => {
			closeModal();
			void loginProviderFlow(p);
		};
		body.append(item);
	}
	openModal("接入 API — 选择 provider", body);
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

sendBtn.onclick = () => void send();
abortBtn.onclick = () => {
	abortCtl?.abort();
	if (sessionId) void api("/api/abort", { sessionId });
};
$("new").onclick = () => {
	sessionId = null;
	stream.replaceChildren();
	fileTrail.clear();
	summary = "";
	renderSummary();
	bar.inTokens = 0;
	bar.outTokens = 0;
	bar.ctxTokens = 0;
	renderBar();
	append(el("div", "block sys", "── 新会话 ──"));
};
$("resume").onclick = () => void showSessions();
$("model").onclick = () => void showModels();

let lastCtrlC = 0;
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		closeModal();
		hidePopup();
		return;
	}
	// Ctrl+C guard (parity with the REPL): first press warns during a run
	if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C") && running) {
		e.preventDefault();
		const now = Date.now();
		if (now - lastCtrlC < 3000) {
			abortCtl?.abort();
			if (sessionId) void api("/api/abort", { sessionId });
			append(el("div", "block sys", "已中止"));
		} else {
			append(el("div", "block sys dim", "运行中 — 再按一次 Ctrl+C 中止"));
		}
		lastCtrlC = now;
	}
});

input.addEventListener("keydown", (e) => {
	// slash popup navigation while typing "/"
	if (input.value.startsWith("/")) {
		const matches = popupMatches();
		if (e.key === "ArrowDown" && matches.length > 0) {
			e.preventDefault();
			popupSel = (popupSel + 1) % Math.min(matches.length, 8);
			renderPopup();
			return;
		}
		if (e.key === "ArrowUp" && matches.length > 0) {
			e.preventDefault();
			popupSel = (popupSel - 1 + Math.min(matches.length, 8)) % Math.min(matches.length, 8);
			return;
		}
		if (e.key === "Tab" && matches.length > 0) {
			e.preventDefault();
			input.value = "/" + matches[popupSel].name + " ";
			renderPopup();
			return;
		}
	}
	// history recall (↑/↓ on an empty or history-browsing input)
	if (e.key === "ArrowUp" && !input.value.startsWith("/")) {
		if (history.length === 0) return;
		if (historyIdx === -1) {
			historyDraft = input.value;
			historyIdx = history.length - 1;
		} else if (historyIdx > 0) {
			historyIdx--;
		}
		input.value = history[historyIdx];
		e.preventDefault();
		return;
	}
	if (e.key === "ArrowDown" && !input.value.startsWith("/")) {
		if (historyIdx === -1) return;
		if (historyIdx < history.length - 1) {
			historyIdx++;
			input.value = history[historyIdx];
		} else {
			historyIdx = -1;
			input.value = historyDraft;
		}
		e.preventDefault();
		return;
	}
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		void send();
	}
});

input.addEventListener("input", () => {
	popupSel = 0;
	if (input.value.startsWith("/")) renderPopup();
	else hidePopup();
	input.style.height = "auto";
	input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

// boot: health → bar
(async () => {
	try {
		const health = await fetch("/api/health").then((r) => r.json());
		bar.model = health.model ?? "";
		bar.cwd = (health.cwd ?? "").replace(/\\/g, "/");
		renderBar();
		if (health.mock) append(el("div", "block sys dim", "── mock 模式（零网络剧本）· 顶部模型名或 /model 切换真实模型 ──"));
	} catch {
		/* server unreachable — the composer will surface errors */
	}
	input.focus();
})();
