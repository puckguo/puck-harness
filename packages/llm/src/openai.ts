/**
 * OpenAI chat/completions streaming adapter.
 *
 * Works with every OpenAI-compatible endpoint: OpenAI, DeepSeek, Moonshot,
 * Qwen/DashScope, Groq, OpenRouter, Together, ollama, vllm, lmstudio, ...
 * Also consumes DeepSeek-style `reasoning_content` deltas as thinking.
 */

import type {
	AssistantMessage,
	AssistantStream,
	ImageContent,
	LlmContext,
	StreamEvent,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingContent,
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

type OpenAiMessage = Record<string, unknown>;

function userContentToOpenAi(content: string | (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") return content;
	return content.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
	);
}

export function toOpenAiMessages(context: LlmContext): OpenAiMessage[] {
	const messages: OpenAiMessage[] = [];
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: userContentToOpenAi(message.content) });
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
			const toolCalls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
			messages.push({
				role: "assistant",
				...(text ? { content: text } : {}),
				...(toolCalls.length > 0
					? {
							tool_calls: toolCalls.map((call) => ({
								id: call.id,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							})),
						}
					: {}),
			});
		} else {
			const text = message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
			messages.push({ role: "tool", tool_call_id: message.toolCallId, content: text });
		}
	}
	return messages;
}

export function toOpenAiTools(tools: Tool[] | undefined): unknown[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
	id: string;
	name: string;
	argumentsJson: string;
}

export function streamOpenAi(model: Model, credentials?: CredentialStore): StreamFn {
	return (context: LlmContext, options?: StreamOptions): AssistantStream => {
		return createAssistantStream(model.id, async (emit) => {
			const apiKey = resolveApiKey(model, credentials, options?.apiKey);
			if (!apiKey) {
				return errorMessage(model.id, `Missing API key: set ${model.apiKeyEnv} or pass options.apiKey`, false);
			}

			const baseUrl = (options?.baseUrl ?? model.baseUrl).replace(/\/$/, "");
			const thinkingBody = thinkingRequestBody(model, options?.thinkingEffort);
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
					...(options?.headers ?? {}),
				},
				body: JSON.stringify({
					model: model.id,
					messages: toOpenAiMessages(context),
					tools: toOpenAiTools(context.tools),
					stream: true,
					stream_options: { include_usage: true },
					...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
					...((options?.maxTokens ?? model.maxOutputTokens) !== undefined
						? { max_tokens: options?.maxTokens ?? model.maxOutputTokens }
						: {}),
					...(thinkingBody ?? {}),
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
					`OpenAI-compatible request failed (HTTP ${response.status})${detail ? `: ${truncate(detail, 500)}` : ""}`,
					response.status === 499,
				);
			}

			// Accumulators. rawContent holds the full visible-content stream; for
			// thinkingTags models, thinking/text are re-derived from it on every delta,
			// which is immune to tags split across chunk boundaries.
			let rawContent = "";
			let text = "";
			let reasoning = ""; // reasoning_content deltas (DeepSeek / GLM coding endpoints)
			let thinking = "";
			const toolCalls: ToolCallAccumulator[] = [];
			let finishReason: string | undefined;
			let usage: Usage | undefined;

			const buildPartial = (): AssistantMessage => {
				let think = thinking;
				let visible = text;
				if (model.thinkingTags) {
					// Reasoning arrives one of two ways depending on the vendor: inline
					// <think> tags in content, or a separate reasoning_content stream
					// (GLM coding endpoints). Take whichever is non-empty — the split
					// must never clobber the accumulated reasoning field.
					const split = splitThinkTags(rawContent);
					think = reasoning || split.thinking;
					visible = split.text;
				}
				return {
					role: "assistant",
					content: [
						...(think ? [{ type: "thinking", thinking: think } satisfies ThinkingContent] : []),
					...(visible ? [{ type: "text", text: visible } satisfies TextContent] : []),
					...toolCalls.map(
						(call): ToolCall => ({
							type: "toolCall",
							id: call.id,
							name: call.name,
							arguments: safeParse(call.argumentsJson),
						}),
					),
				],
					model: model.id,
					stopReason: "stop",
					usage: usage ?? { input: 0, output: 0, totalTokens: 0 },
					timestamp: Date.now(),
				};
			};

			let started = false;
			try {
				for await (const payload of parseSse(response.body)) {
					if (payload === "[DONE]") break;
					let chunk: any;
					try {
						chunk = JSON.parse(payload);
					} catch {
						continue;
					}

					if (chunk.usage) {
						const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
						usage = computeUsage(model, chunk.usage.prompt_tokens ?? 0, chunk.usage.completion_tokens ?? 0, cached);
					}

					const choice = chunk.choices?.[0];
					if (!choice) continue;
					const delta = choice.delta ?? {};

					if (delta.content) {
						rawContent += delta.content;
						if (!model.thinkingTags) text += delta.content;
					}
					if (delta.reasoning_content) {
						reasoning += delta.reasoning_content;
					}
					for (const call of delta.tool_calls ?? []) {
						const acc = toolCalls[call.index] ?? (toolCalls[call.index] = { id: "", name: "", argumentsJson: "" });
						if (call.id) acc.id = call.id;
						if (call.function?.name) acc.name += call.function.name;
						if (call.function?.arguments) acc.argumentsJson += call.function.arguments;
					}
					if (choice.finish_reason) {
						finishReason = choice.finish_reason;
					}

					if (!started) {
						started = true;
						emit({ type: "start", partial: buildPartial() });
					}
					emit({ type: "delta", partial: buildPartial() });
				}
			} catch (error) {
				if (options?.signal?.aborted) return errorMessage(model.id, "Aborted", true);
				throw error;
			}

			const final = buildPartial();
			final.stopReason = mapStopReason(finishReason, toolCalls.length > 0);
			final.usage = usage ?? { input: 0, output: 0, totalTokens: 0 };
			if (final.stopReason === "error") final.errorMessage = `Unexpected finish reason: ${finishReason}`;
			emit({ type: final.stopReason === "error" ? "error" : "done", message: final });
			return final;
		});
	};
}

/**
 * Provider-specific thinking-level → request fields.
 * GLM coding endpoints take thinking.type on/off (verified live: disabled
 * removes the <think> block entirely); the generic OpenAI protocol takes
 * reasoning_effort (accepted by MiniMax/OpenAI; no portable "off" exists).
 */
function thinkingRequestBody(model: Model, effort: StreamOptions["thinkingEffort"]): Record<string, unknown> | undefined {
	if (effort === undefined) return undefined;
	if (model.provider === "zai" || model.provider === "zai-coding-cn") {
		return { thinking: { type: effort === "off" ? "disabled" : "enabled" } };
	}
	if (effort === "off") return undefined;
	return { reasoning_effort: effort };
}

function mapStopReason(reason: string | undefined, hasToolCalls: boolean): AssistantMessage["stopReason"] {
	switch (reason) {
		case "length":
			return "length";
		case "tool_calls":
		case "function_call":
			return "toolUse";
		case undefined:
			return hasToolCalls ? "toolUse" : "stop";
		case "stop":
			return hasToolCalls ? "toolUse" : "stop";
		case "content_filter":
			return "error";
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

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Split inline <think>...</think> reasoning from visible text.
 * Stateless full-reparse of the accumulated stream — immune to tags split
 * across chunk boundaries. An unterminated <think> swallows the rest as
 * thinking (the model is still reasoning); text before <think> is kept.
 */
export function splitThinkTags(content: string): { thinking: string; text: string } {
	const open = content.indexOf('<think>');
	if (open === -1) return { thinking: '', text: content };
	const before = content.slice(0, open);
	const afterOpen = content.slice(open + 7);
	const close = afterOpen.indexOf('</think>');
	if (close === -1) return { thinking: afterOpen, text: before };
	return {
		thinking: afterOpen.slice(0, close),
		text: before + afterOpen.slice(close + 8),
	};
}
