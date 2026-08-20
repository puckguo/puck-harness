/**
 * Context compaction — a LoopHooks.transformContext implementation.
 *
 * When the estimated token weight of the transcript crosses a threshold,
 * older messages are serialized and summarized by one LLM call, and the
 * model-facing view becomes: [summary user message] + [recent window].
 * The canonical transcript is never modified.
 *
 * The summary is cached per prefix length, so an unchanged prefix is not
 * re-summarized on every turn.
 */

import type {
	AssistantMessage,
	LlmContext,
	LoopHooks,
	Message,
	StreamFn,
	TextContent,
	ToolCall,
	UserMessage,
} from "@puck-agent/core";
import { estimateMessageTokens, now } from "@puck-agent/core";

export interface CompactionOptions {
	/** Summarizing stream function (usually the same as the agent's). */
	streamFn: StreamFn;
	/** Summarize when the transcript estimate exceeds this many tokens. */
	maxTokens: number;
	/** Always keep the most recent messages uncompacted (default 20). */
	keepRecent?: number;
	/** Prompt template; {transcript} is replaced with the serialized prefix. */
	summarizePrompt?: string;
	/** Fires when a compaction actually folds the prefix (session history hook). */
	onCompact?: (summary: string, prefixMessages: number) => void;
}

const DEFAULT_PROMPT =
	"Summarize the following conversation between a user and an AI assistant. " +
	"Preserve: the user's goals, decisions made, files touched, commands run and their outcomes, " +
	"and any unresolved problems. Be concise but complete — the summary replaces the transcript.\n\n" +
	"<transcript>\n{transcript}\n</transcript>";

interface SummaryCache {
	prefixCount: number;
	summary: string;
}

export function createCompactionHook(options: CompactionOptions): LoopHooks["transformContext"] {
	const keepRecent = options.keepRecent ?? 20;
	let cache: SummaryCache | undefined;

	return async (messages: Message[]): Promise<Message[]> => {
		if (estimateMessageTokens(messages) <= options.maxTokens) return messages;

		// Cut at a turn boundary: keep whole user→assistant(+tools) blocks.
		const cut = findCutPoint(messages, keepRecent);
		if (cut <= 0) return messages;

		const prefix = messages.slice(0, cut);
		const recent = messages.slice(cut);

		if (!cache || cache.prefixCount !== prefix.length) {
			const transcript = serializeTranscript(prefix);
			const summary = await summarize(options.streamFn, transcript, options.summarizePrompt);
			cache = { prefixCount: prefix.length, summary };
			options.onCompact?.(summary, prefix.length);
		}

		const summaryMessage: UserMessage = {
			role: "user",
			content:
				"[Context compaction] The beginning of this conversation was summarized to save space:\n\n" +
				cache.summary,
			timestamp: now(),
		};
		return [summaryMessage, ...recent];
	};
}

/** One-shot manual compaction (the /compact command): fold everything older
 * than the recent window into an LLM summary. Returns the compacted view
 * ([summary user message, ...recent]) or undefined when there is nothing to fold. */
export interface CompactNowResult {
	view: Message[];
	summary: string;
	/** Messages folded into the summary. */
	folded: number;
	/** Messages kept verbatim after the cut. */
	keptRecent: number;
}

export async function compactNow(
	messages: Message[],
	streamFn: StreamFn,
	options: { keepRecent?: number; summarizePrompt?: string } = {},
): Promise<CompactNowResult | undefined> {
	const cut = findCutPoint(messages, options.keepRecent ?? 10);
	if (cut <= 0) return undefined;
	const prefix = messages.slice(0, cut);
	const recent = messages.slice(cut);
	const summary = await summarize(streamFn, serializeTranscript(prefix), options.summarizePrompt);
	const summaryMessage: UserMessage = {
		role: "user",
		content:
			"[Context compaction] The beginning of this conversation was summarized to save space:\n\n" + summary,
		timestamp: now(),
	};
	return { view: [summaryMessage, ...recent], summary, folded: prefix.length, keptRecent: recent.length };
}

/** Find the index where the recent window starts, snapped to a turn boundary. */
function findCutPoint(messages: Message[], keepRecent: number): number {
	// Walk backwards over the last `keepRecent` messages, then extend to the
	// start of that turn's user message.
	let index = messages.length - keepRecent;
	while (index > 0 && messages[index]?.role !== "user") index--;
	return index;
}

function serializeTranscript(messages: Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : textOf(message.content);
			parts.push(`USER: ${text}`);
		} else if (message.role === "assistant") {
			const text = message.content
				.map((block) =>
					block.type === "text" ? block.text : block.type === "toolCall" ? `[tool call: ${block.name}]` : "",
				)
				.filter(Boolean)
				.join(" ");
			parts.push(`ASSISTANT: ${text}`);
		} else {
			parts.push(`TOOL RESULT (${message.toolName}): ${textOf(message.content)}`);
		}
	}
	return parts.join("\n");
}

function textOf(content: (TextContent | { type: "image" })[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join(" ");
}

async function summarize(streamFn: StreamFn, transcript: string, customPrompt?: string): Promise<string> {
	const prompt = (customPrompt ?? DEFAULT_PROMPT).replace("{transcript}", () => transcript);
	const stream = streamFn(
		{
			systemPrompt: "You are a precise summarization assistant.",
			messages: [{ role: "user", content: prompt, timestamp: now() }],
		},
		{},
	);
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") final = event.message;
	}
	const text =
		final?.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("") ?? "";
	if (final?.stopReason === "error") {
		throw new Error(`Compaction summarization failed: ${final.errorMessage ?? "unknown error"}`);
	}
	return text || "(empty summary)";
}

// Re-exported for consumers that build their own compaction policies.
export type { ToolCall };
export type { LlmContext };
