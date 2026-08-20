/**
 * Small helpers shared by the loop and the Agent wrapper.
 */

import type { AssistantMessage, Message, TextContent, Usage, UserMessage } from "./types.js";

export const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	totalTokens: 0,
};

export function now(): number {
	return Date.now();
}

export function uuid(): string {
	return globalThis.crypto?.randomUUID?.() ?? `id-${now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function textContent(text: string): TextContent {
	return { type: "text", text };
}

export function userMessage(content: string | UserMessage["content"]): Message {
	return { role: "user", content, timestamp: now() };
}

export function errorResult(message: string): { content: TextContent[]; isError: boolean } {
	return { content: [textContent(message)], isError: true };
}

/** Concatenate all text blocks of a message's content. */
export function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** Sum usage across all assistant messages of a transcript (or run). */
export function sumUsage(messages: Message[]): Usage {
	const totals: Usage = { ...EMPTY_USAGE, cost: { input: 0, output: 0, total: 0 } };
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		totals.input += message.usage.input;
		totals.output += message.usage.output;
		totals.cacheRead = (totals.cacheRead ?? 0) + (message.usage.cacheRead ?? 0);
		totals.cacheWrite = (totals.cacheWrite ?? 0) + (message.usage.cacheWrite ?? 0);
		totals.totalTokens += message.usage.totalTokens;
		if (message.usage.cost) {
			totals.cost!.input += message.usage.cost.input;
			totals.cost!.output += message.usage.cost.output;
			totals.cost!.total += message.usage.cost.total;
		}
	}
	return totals;
}

/** Final text of an assistant message, ignoring thinking and tool calls. */
export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** Rough token estimate: ~4 chars per token. Good enough for budgeting decisions. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Estimate the token weight of a transcript for compaction decisions. */
export function estimateMessageTokens(messages: Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") total += estimateTokens(block.text);
				else if (block.type === "thinking") total += estimateTokens(block.thinking);
			}
		} else if (message.role === "user") {
			total += estimateTokens(typeof message.content === "string" ? message.content : messageText(message));
		} else {
			total += estimateTokens(messageText(message));
		}
	}
	return total;
}
