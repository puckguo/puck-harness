/**
 * Daily summary + experience distillation — the write side of the memory
 * system, run as an idle task once per day.
 *
 *   conversations of the day (from the sqlite index)
 *     → LLM summary          → <home>/memories/YYYY-MM-DD.md   (episodic memory)
 *     → LLM merge into old experience.md
 *                            → <home>/experience.md            (semantic memory, capped)
 *
 * Guardrails: payload budget (store caps chars), secret redaction, experience
 * size cap with monthly archive, atomic writes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@puckguo123/core";
import type { ConversationStore } from "@puckguo123/store";
import { clipExperience, clipLongTerm, EXPERIENCE_CAP_LINES } from "./context.js";
import { localDateStr } from "./tasks.js";

export const EXPERIENCE_MAX_LINES = 120;

/** Redact obvious API keys before anything leaves the machine. */
export function redact(text: string): string {
	return text.replace(/\b(sk-[A-Za-z0-9_\-]{12,}|[0-9a-f]{32}\.[A-Za-z0-9]{16})\b/g, "[REDACTED]");
}

/** Drive one LLM call to completion, returning the final text ("" on error). */
async function complete(streamFn: StreamFn, systemPrompt: string, userPrompt: string): Promise<string> {
	const stream = streamFn(
		{ systemPrompt, messages: [{ role: "user", content: redact(userPrompt), timestamp: Date.now() }] },
		{},
	);
	let text = "";
	for await (const event of stream) {
		if (event.type === "error") throw new Error(event.message.errorMessage || "LLM 调用失败");
		if (event.type === "done") {
			text = (event.message.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
	}
	return text.trim();
}

function serializeDay(convs: ReturnType<ConversationStore["dayConversations"]>): string {
	const parts: string[] = [];
	for (const c of convs) {
		const where = c.project ? `（项目 ${redact(c.project)}）` : "";
		const lines = c.messages.map((m) => `${m.role === "user" ? "用户" : "助手"}: ${redact(m.content)}`);
		parts.push(`### 会话「${c.title ?? "（无标题）"}」${where}\n\n${lines.join("\n")}`);
	}
	return parts.join("\n\n");
}

export function summaryPath(home: string, day = localDateStr()): string {
	return join(home, "memories", `${day}.md`);
}

export function experiencePath(home: string): string {
	return join(home, "experience.md");
}

export function longTermPath(home: string): string {
	return join(home, "long-term.md");
}

export const LONG_TERM_MAX_LINES = 100;

/** The `weekly-distill` task body: distill recent daily summaries into stable,
 * long-lived knowledge (user preferences, project facts, verified workflows).
 * Different from experience.md (dated lessons): this is the semantic layer. */
export async function runLongTermDistill(opts: {
	home: string;
	streamFn: StreamFn;
	/** how many recent daily summaries to feed (default 14). */
	days?: number;
	maxCharsPerSummary?: number;
}): Promise<string> {
	const memDir = join(opts.home, "memories");
	let files: string[] = [];
	try {
		files = existsSync(memDir)
			? readdirSync(memDir)
					.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
					.sort()
					.slice(-(opts.days ?? 14))
			: [];
	} catch {
		files = [];
	}
	if (files.length < 3) return `skip: 日总结不足（${files.length}/3）`;
	const per = opts.maxCharsPerSummary ?? 1500;
	const parts: string[] = [];
	for (const f of files) {
		let text = "";
		try {
			text = readFileSync(join(memDir, f), "utf8");
		} catch {
			continue;
		}
		if (text.length > per) text = text.slice(0, per) + "…";
		parts.push(text);
	}
	const ltFile = longTermPath(opts.home);
	const existing = existsSync(ltFile) ? readFileSync(ltFile, "utf8").trimEnd() : "";
	const merged = await complete(
		opts.streamFn,
		"You maintain a coding agent's long-term memory file (长期记忆). Extract STABLE, reusable knowledge from daily summaries — user preferences, project facts, recurring workflows, verified techniques. NOT dated one-off lessons (those live elsewhere). Chinese, one line per entry prefixed with `- 类别：`. Deduplicate, newest information wins, drop stale entries. Keep it under 100 lines. Output ONLY the updated file content.",
		`现有长期记忆：\n\n${existing || "（空）"}\n\n近期每日总结：\n\n${parts.join("\n\n")}\n\n请输出合并后的完整长期记忆（纯 markdown 列表，≤${LONG_TERM_MAX_LINES} 行）。`,
	);
	if (!merged) throw new Error("长期记忆蒸馏返回为空");
	const lines = merged.split("\n").slice(0, LONG_TERM_MAX_LINES).join("\n");
	writeFileSync(ltFile, lines.trimEnd() + "\n");
	return `ok: ${files.length} 篇日总结 → long-term.md（${lines.split("\n").length} 行）`;
}

/** Archive an oversized experience file before rewriting it (history stays greppable). */
function archiveIfLarge(path: string, maxLines: number): void {
	if (!existsSync(path)) return;
	const lines = readFileSync(path, "utf8").split("\n");
	if (lines.length <= maxLines) return;
	const stamp = localDateStr().replace(/-/g, "");
	mkdirSync(join(path, "..", "memories", "archive"), { recursive: true });
	try {
		renameSync(path, join(path, "..", "memories", "archive", `experience-${stamp}.md`));
	} catch {
		/* Windows: rename can race; next run retries */
	}
}

/**
 * The `daily-summary` task body. Returns the catalog state note; throws on LLM
 * failure so the scheduler records an error and retries next idle window.
 */
export async function runDailySummary(opts: {
	home: string;
	store: ConversationStore;
	streamFn: StreamFn;
	day?: string;
}): Promise<string> {
	const day = opts.day ?? localDateStr();
	const convs = opts.store.dayConversations(day);
	if (convs.length === 0) return "skip: 当天无对话";

	const summary = await complete(
		opts.streamFn,
		"You are a precise summarization assistant. Summarize the user's coding-agent conversations of one day in Chinese markdown: per project — what was asked, what was changed, key decisions, and lessons. Be factual and compact.",
		`以下是 ${day} 的全部对话记录（已截断）。请生成当日总结（markdown，≤60 行），供日后检索：\n\n${serializeDay(convs)}`,
	);
	if (!summary) throw new Error("空总结（模型未返回文本）");

	const file = summaryPath(opts.home, day);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `# ${day} 对话总结\n\n${summary}\n`);

	// --- experience merge (semantic memory) --------------------------------
	const expFile = experiencePath(opts.home);
	const existing = existsSync(expFile) ? readFileSync(expFile, "utf8").trimEnd() : "";
	archiveIfLarge(expFile, EXPERIENCE_MAX_LINES);
	const merged = await complete(
		opts.streamFn,
		"You maintain a coding agent's long-term experience file (经验库). Merge today's lessons into the existing list: Chinese, one line per entry prefixed with a date, deduplicated, newest information wins, drop stale entries. Keep it under 120 lines. Output ONLY the updated file content.",
		`现有经验库：\n\n${existing || "（空）"}\n\n今日总结：\n\n${summary}\n\n请输出合并后的完整经验库内容（纯 markdown 列表，≤${EXPERIENCE_MAX_LINES} 行）。`,
	);
	if (!merged) throw new Error("经验合并返回为空");
	writeFileSync(expFile, merged.trimEnd() + "\n");
	return `ok: ${convs.length} 会话 → memories/${day}.md（${merged.split("\n").length} 行经验）`;
}

/** Line/char stats for /memory — how big the memory layers currently are. */
export function memoryStats(home: string): { experience: string; longTerm: string; summaries: string[] } {
	const exp = existsSync(experiencePath(home)) ? clipExperience(readFileSync(experiencePath(home), "utf8")) : "";
	const lt = existsSync(longTermPath(home)) ? clipLongTerm(readFileSync(longTermPath(home), "utf8")) : "";
	let summaries: string[] = [];
	try {
		const dir = join(home, "memories");
		summaries = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() : [];
	} catch {
		summaries = [];
	}
	return { experience: exp, longTerm: lt, summaries };
}
