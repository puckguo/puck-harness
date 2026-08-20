/**
 * Anthropic messages streaming adapter.
 */

import type {
	AssistantMessage,
	AssistantStream,
	LlmContext,
	StreamFn,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	Usage,
} from "@puckguo123/core";
import type { CredentialStore } from "./auth.js";
import { resolveApiKey } from "./auth.js";
import type { Model } from "./models.js";
import { parseSse } from "./sse.js";
import { computeUsage, createAssistantStream, errorMessage } from "./stream-utils.js";

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

type AnthropicMessage = Record<string, unknown>;

export function toAnthropicMessages(context: LlmContext): AnthropicMessage[] {
	const messages: AnthropicMessage[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: toAnthropicUserContent(message.content) });
		} else if (message.role === "assistant") {
			const blocks: Record<string, unknown>[] = [];
			for (const part of message.content) {
				if (part.type === "text" && part.text) {
					blocks.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
				}
			}
			messages.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
		} else {
			// Tool results become tool_result blocks inside a user message.
			// Consecutive tool results merge into one user turn.
			const last = messages[messages.length - 1];
			const block = {
				type: "tool_result",
				tool_use_id: message.toolCallId,
				content: message.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => ({ type: "text", text: c.text })),
				is_error: message.isError,
			};
			if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
				last.content.push(block);
			} else {
				messages.push({ role: "user", content: [block] });
			}
		}
	}
	return messages;
}

function toAnthropicUserContent(content: string | (TextContent | { type: "image"; data: string; mimeType: string })[]): unknown {
	if (typeof content === "string") return content;
	return content.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } },
	);
}

export function toAnthropicTools(tools: Tool[] | undefined): unknown[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

interface BlockAccumulator {
	text: string;
	toolCall?: { id: string; name: string; argumentsJson: string };
}

export function streamAnthropic(model: Model, credentials?: CredentialStore): StreamFn {
	return (context: LlmContext, options?: StreamOptions): AssistantStream => {
		return createAssistantStream(model.id, async (emit) => {
			const apiKey = resolveApiKey(model, credentials, options?.apiKey);
			if (!apiKey) {
				return errorMessage(model.id, `Missing API key: set ${model.apiKeyEnv} or pass options.apiKey`, false);
			}

			// registry baseUrls carry /v1 (for GET /models) — don't double it on /v1/messages
			const baseUrl = (options?.baseUrl ?? model.baseUrl).replace(/\/$/, "").replace(/\/v1$/, "");
			// thinking levels → budget_tokens; the API requires max_tokens > budget
			const effort = options?.thinkingEffort;
			const budget = effort !== undefined && effort !== "off" ? ANTHROPIC_EFFORT_BUDGET[effort] : undefined;
			let maxTokens = options?.maxTokens ?? model.maxOutputTokens ?? 4096;
			if (budget !== undefined) maxTokens = Math.max(maxTokens, budget + 2048);
			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					...(options?.headers ?? {}),
				},
				body: JSON.stringify({
					model: model.id,
					system: context.systemPrompt,
					messages: toAnthropicMessages(context),
					tools: toAnthropicTools(context.tools),
					max_tokens: maxTokens,
					stream: true,
					...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
					...(budget !== undefined ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
				}),
				signal: options?.signal,
			}).catch((error) => {
				const aborted = options?.signal?.aborted === true;
				return new Response(null, { status: aborted ? 499 : 0, statusText: String(error) });
			});

			if (!response.ok || !response.body) {
				const detail = response.body ? await response.text().catch(() => "") : response.statusText;
				return errorMessage(
					model.id,
					`Anthropic request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
					response.status === 499,
				);
			}

			const blocks: BlockAccumulator[] = [];
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheRead = 0;
			let stopReason: string | undefined;

			const buildPartial = (): AssistantMessage => ({
				role: "assistant",
				content: blocks.flatMap((block) => {
					const out: (TextContent | ToolCall)[] = [];
					if (block.toolCall) {
						out.push({
							type: "toolCall",
							id: block.toolCall.id,
							name: block.toolCall.name,
							arguments: safeParse(block.toolCall.argumentsJson),
						});
					} else if (block.text) {
						out.push({ type: "text", text: block.text });
					}
					return out;
				}),
				model: model.id,
				stopReason: "stop",
				usage: currentUsage(),
				timestamp: Date.now(),
			});

			const currentUsage = (): Usage => computeUsage(model, inputTokens, outputTokens, cacheRead);

			let started = false;
			try {
				for await (const payload of parseSse(response.body)) {
					let event: any;
					try {
						event = JSON.parse(payload);
					} catch {
						continue;
					}

					switch (event.type) {
						case "message_start":
							inputTokens = event.message?.usage?.input_tokens ?? 0;
							cacheRead = event.message?.usage?.cache_read_input_tokens ?? 0;
							break;
						case "content_block_start": {
							const block = event.content_block;
							if (block?.type === "tool_use") {
								blocks[event.index] = { text: "", toolCall: { id: block.id, name: block.name, argumentsJson: "" } };
							} else {
								blocks[event.index] = { text: "" };
							}
							break;
						}
						case "content_block_delta": {
							const block = blocks[event.index] ?? (blocks[event.index] = { text: "" });
							const delta = event.delta;
							if (delta?.type === "text_delta") block.text += delta.text;
							else if (delta?.type === "input_json_delta") block.toolCall && (block.toolCall.argumentsJson += delta.partial_json);
							// thinking_delta arrives without extended thinking enabled — ignored.
							break;
						}
						case "message_delta":
							if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
							if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
							break;
						case "error":
							return errorMessage(model.id, event.error?.message ?? "Unknown Anthropic stream error", false);
						default:
							break;
					}

					if (!started && event.type === "content_block_start") {
						started = true;
						emit({ type: "start", partial: buildPartial() });
					}
					if (started && (event.type === "content_block_delta" || event.type === "content_block_stop")) {
						emit({ type: "delta", partial: buildPartial() });
					}
				}
			} catch (error) {
				if (options?.signal?.aborted) return errorMessage(model.id, "Aborted", true);
				throw error;
			}

			const final = buildPartial();
			final.stopReason = mapStopReason(stopReason);
			final.usage = currentUsage();
			emit({ type: "done", message: final });
			return final;
		});
	};
}

/** thinkingEffort → Anthropic extended-thinking budget (tokens). */
const ANTHROPIC_EFFORT_BUDGET: Record<Exclude<StreamOptions["thinkingEffort"], "off" | undefined>, number> = {
	low: 2048,
	medium: 8192,
	high: 16384,
};

function mapStopReason(reason: string | undefined): AssistantMessage["stopReason"] {
	switch (reason) {
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "stop";
	}
}

function safeParse(json: string): Record<string, unknown> {
	if (!json) return {};
	try {
		const parsed = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return { _unparsableArguments: json };
	}
}
