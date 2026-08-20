/**
 * Helper for building AssistantStream objects from a producer coroutine.
 *
 * Contract enforcement: the producer must never throw. If it does anyway,
 * the failure is converted into a final error event so the agent loop
 * always sees a well-formed stream.
 */

import type { AssistantMessage, AssistantStream, StreamEvent, Usage } from "@puckguo123/core";
import { EMPTY_USAGE } from "@puckguo123/core";

export function errorMessage(model: string, message: string, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		model,
		stopReason: aborted ? "aborted" : "error",
		usage: { ...EMPTY_USAGE },
		errorMessage: message,
		timestamp: Date.now(),
	};
}

export function computeUsage(model: { cost?: { input: number; output: number } }, input: number, output: number, cacheRead = 0): Usage {
	const usage: Usage = { input, output, cacheRead, totalTokens: input + output };
	if (model.cost) {
		const inputCost = (input / 1_000_000) * model.cost.input + (cacheRead / 1_000_000) * model.cost.input * 0.1;
		const outputCost = (output / 1_000_000) * model.cost.output;
		usage.cost = { input: inputCost, output: outputCost, total: inputCost + outputCost };
	}
	return usage;
}

export function createAssistantStream(
	model: string,
	run: (emit: (event: StreamEvent) => void) => Promise<AssistantMessage>,
): AssistantStream {
	const queue: StreamEvent[] = [];
	let resolveWaiter: (() => void) | undefined;
	let settled = false;
	let terminalEmitted = false;

	const push = (event: StreamEvent): void => {
		if (event.type === "done" || event.type === "error") terminalEmitted = true;
		queue.push(event);
		resolveWaiter?.();
	};

	const result = run(push)
		.then((message) => {
			// Producers that early-return (missing key, HTTP error) never emit a
			// terminal event. Event-only consumers (analyze/compaction) would see an
			// empty stream — synthesize the terminal event from the return value.
			if (!terminalEmitted) {
				const isError = message.stopReason === "error" || message.stopReason === "aborted";
				push({ type: isError ? "error" : "done", message });
			}
			return message;
		})
		.catch((error) => {
			const message = errorMessage(model, error instanceof Error ? error.message : String(error), false);
			if (!terminalEmitted) push({ type: "error", message });
			return message;
		})
		.finally(() => {
			settled = true;
			resolveWaiter?.();
		});

	return {
		async *[Symbol.asyncIterator]() {
			while (true) {
				while (queue.length > 0) {
					yield queue.shift()!;
				}
				if (settled) return;
				await new Promise<void>((resolve) => {
					resolveWaiter = resolve;
				});
			}
		},
		result: () => result,
	};
}

/** Split text into chunks for realistic streaming in mocks. */
export function chunkText(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks.length > 0 ? chunks : [""];
}
