/**
 * Scripted mock provider — puck's debugging workhorse.
 *
 * Runs a deterministic script with zero network access: perfect for tests,
 * CI, offline demos, and reproducing multi-turn tool flows exactly.
 * Each LLM call consumes the next step; when the script is exhausted the
 * mock answers with a plain stop.
 */

import type {
	AssistantMessage,
	AssistantStream,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@puckguo123/core";
import { EMPTY_USAGE } from "@puckguo123/core";
import { chunkText, createAssistantStream, errorMessage } from "./stream-utils.js";

export interface MockToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface MockStep {
	/** Assistant text, streamed in chunks. */
	text?: string;
	/** Thinking content (reasoning models). */
	thinking?: string;
	/** Tool calls emitted with this step. */
	toolCalls?: MockToolCall[];
	/** stopReason override. Default: "toolUse" when toolCalls present, else "stop". */
	stopReason?: AssistantMessage["stopReason"];
	/** Error text; sets stopReason "error". */
	error?: string;
	/** Usage override for cost/token assertions. */
	usage?: Partial<Usage>;
	/** Delay between streamed chunks (default: none). */
	delayMs?: number;
}

export interface MockOptions {
	steps: MockStep[];
	model?: string;
}

export function createMockStreamFn(options: MockOptions | MockStep[]): StreamFn {
	const opts = Array.isArray(options) ? { steps: options } : options;
	const modelName = opts.model ?? "mock";
	let cursor = 0;

	return (_context, options?: StreamOptions): AssistantStream => {
		return createAssistantStream(modelName, async (emit) => {
			const signal = options?.signal;
			const step: MockStep = cursor < opts.steps.length ? opts.steps[cursor] : { text: "(mock script complete)" };
			cursor++;

			const usage: Usage = { ...EMPTY_USAGE, ...step.usage };
			const callIndex = cursor;
			const build = (thinkingSoFar: string, textSoFar: string): AssistantMessage => ({
				role: "assistant",
				content: [
					...(thinkingSoFar ? [{ type: "thinking", thinking: thinkingSoFar } satisfies ThinkingContent] : []),
					...(textSoFar ? [{ type: "text", text: textSoFar } satisfies TextContent] : []),
					...(step.toolCalls?.map(
						(call, i): ToolCall => ({
							type: "toolCall",
							id: `mock-${callIndex}-${i}`,
							name: call.name,
							arguments: call.arguments,
						}),
					) ?? []),
				],
				model: modelName,
				stopReason: "stop",
				usage,
				timestamp: Date.now(),
			});

			let thinkingSoFar = "";
			let textSoFar = "";
			emit({ type: "start", partial: build(thinkingSoFar, textSoFar) });

			const streamPiece = async (piece: string, kind: "thinking" | "text"): Promise<boolean> => {
				for (const chunk of chunkText(piece, 24)) {
					if (signal?.aborted) return false;
					if (kind === "thinking") thinkingSoFar += chunk;
					else textSoFar += chunk;
					if (step.delayMs) await sleep(step.delayMs, signal);
					if (signal?.aborted) return false;
					emit({ type: "delta", partial: build(thinkingSoFar, textSoFar) });
				}
				return true;
			};

			if (step.thinking && !(await streamPiece(step.thinking, "thinking"))) {
				const final = errorMessage(modelName, "aborted", true);
				emit({ type: "error", message: final });
				return final;
			}
			if (step.text && !(await streamPiece(step.text, "text"))) {
				const final = errorMessage(modelName, "aborted", true);
				emit({ type: "error", message: final });
				return final;
			}

			const stopReason = step.error !== undefined ? "error" : (step.stopReason ?? (step.toolCalls?.length ? "toolUse" : "stop"));
			if (step.error !== undefined && step.delayMs) {
				await sleep(step.delayMs, signal);
				if (signal?.aborted) {
					const aborted = errorMessage(modelName, "aborted", true);
					emit({ type: "error", message: aborted });
					return aborted;
				}
			}
			const final = build(thinkingSoFar, textSoFar);
			final.stopReason = stopReason;
			if (step.error !== undefined) final.errorMessage = step.error;
			emit({ type: stopReason === "error" ? "error" : "done", message: final });
			return final;
		});
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
