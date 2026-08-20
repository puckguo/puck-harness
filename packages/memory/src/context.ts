/**
 * agent.md context loading — the instructions layer of the memory system.
 *
 * Sources, outermost first (later sections are more specific, so the model
 * reads them as refinements):
 *   1. system dir agent.md      (~/.puck/agent.md — user's global preferences)
 *   2. project agent.md files   (walk up from cwd to the filesystem root;
 *                                AGENTS.md is accepted as an alias — pi/codex
 *                                convention, so existing repos just work)
 *   3. experience.md head       (auto-distilled lessons, capped — the live part)
 *
 * Everything is read-once at startup (or /memory reload); the composed text is
 * appended to the system prompt via the SDK's `agentContext` option.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

export interface ContextSource {
	/** Absolute path the text came from. */
	path: string;
	kind: "system" | "project" | "experience" | "longterm";
	text: string;
}

export interface AgentContext {
	/** Ready-to-append system-prompt text ("" when nothing was found). */
	text: string;
	sources: ContextSource[];
}

/** Collect project agent.md files walking up from cwd (deepest first in the list → root last). */
export function findProjectAgentFiles(cwd: string): string[] {
	const found: string[] = [];
	let dir = resolve(cwd);
	const seen = new Set<string>();
	for (;;) {
		for (const name of ["agent.md", "AGENTS.md"] as const) {
			const p = join(dir, name);
			if (!seen.has(p.toLowerCase()) && existsSync(p)) {
				seen.add(p.toLowerCase());
				found.push(p); // deepest first — appended last below so it reads as most specific
			}
		}
		const parent = dirname(dir);
		if (parent === dir || seen.has(parent.toLowerCase())) break;
		dir = parent;
	}
	return found;
}

/** Read a file, normalizing BOM and trailing whitespace; "" when missing. */
function readIfExists(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, "utf8").replace(/^\uFEFF/, "").trimEnd() : "";
	} catch {
		return "";
	}
}

export const EXPERIENCE_CAP_LINES = 60;
export const LONG_TERM_CAP_LINES = 80;

/** Clip the experience file to the newest head (entries are newest-first by convention). */
export function clipExperience(text: string, maxLines = EXPERIENCE_CAP_LINES): string {
	const lines = text.split("\n");
	return lines.length <= maxLines ? text : lines.slice(0, maxLines).join("\n") + "\n…（已截断，完整版见 experience.md）";
}

/** Clip the long-term memory to its head (same newest-first convention). */
export function clipLongTerm(text: string, maxLines = LONG_TERM_CAP_LINES): string {
	const lines = text.split("\n");
	return lines.length <= maxLines ? text : lines.slice(0, maxLines).join("\n") + "\n…（已截断，完整版见 long-term.md）";
}

export function loadAgentContext(cwd: string, home: string): AgentContext {
	const sources: ContextSource[] = [];
	const sysPath = isAbsolute(home) ? join(home, "agent.md") : resolve(home);
	const system = readIfExists(sysPath);
	if (system) sources.push({ path: sysPath, kind: "system", text: system });
	const projectFiles = findProjectAgentFiles(cwd).reverse(); // root → deepest
	for (const p of projectFiles) {
		const text = readIfExists(p);
		if (text) sources.push({ path: p, kind: "project", text });
	}
	const expPath = join(dirname(sysPath), "experience.md");
	const experience = clipExperience(readIfExists(expPath));
	if (experience) sources.push({ path: expPath, kind: "experience", text: experience });
	// long-term memory: stable knowledge distilled from daily summaries — read
	// BEFORE experience in the prompt (stable facts first, recent lessons last)
	const ltPath = join(dirname(sysPath), "long-term.md");
	const ltIdx = sources.findIndex((s) => s.kind === "experience");
	const longTerm = clipLongTerm(readIfExists(ltPath));
	if (longTerm) sources.splice(ltIdx < 0 ? sources.length : ltIdx, 0, { path: ltPath, kind: "longterm", text: longTerm });

	const sections = sources.map((s) => {
		const label = s.kind === "system" ? "全局指令" : s.kind === "project" ? `项目指令（${basename(s.path)}）` : s.kind === "longterm" ? "长期记忆（自动蒸馏）" : "历史经验（自动归纳）";
		return `## ${label}\n\n${s.text}`;
	});
	return { text: sections.length ? "# 用户与项目上下文\n\n" + sections.join("\n\n") + "\n" : "", sources };
}
