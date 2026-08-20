/**
 * TimingCollector — subscribes to AgentEvent and produces one TurnTiming per turn.
 *
 * Pure event-driven: no timers of its own, no core changes. Attach with
 * `collector.attach(agent)` or feed events manually from your own subscriber.
 */

import type { Agent, AgentEvent, AgentEventListener } from "@puck-agent/core";
import type { TurnTiming } from "./types.js";

export interface TimingCollectorOptions {
	sessionId?: string;
	/** Logical model id (when the host knows it; assistant message model wins otherwise). */
	modelId?: string;
	/** Called for every completed turn record. */
	onTurn?: (record: TurnTiming) => void;
}

interface TurnState {
	turn: number;
	startedAt: number;
	firstTokenAt?: number;
	llmEndedAt?: number;
	firstToolStartAt?: number;
	lastToolEndAt?: number;
	toolCallCount: number;
	model?: string;
	inputTokens: number;
	outputTokens: number;
	stopReason?: string;
	isError: boolean;
	toolStarts: Map<string, number>;
}

export class TimingCollector {
	private readonly options: TimingCollectorOptions;
	private state: TurnState | undefined;

	constructor(options: TimingCollectorOptions = {}) {
		this.options = options;
	}

	/** Subscribe to an agent. Returns an unsubscribe function. */
	attach(agent: Agent): () => void {
		return agent.subscribe((event) => void this.onEvent(event));
	}

	/** Feed one event (for hosts that already own the subscription). */
	onEvent(event: AgentEvent): void {
		switch (event.type) {
			case "turn_start":
				this.state = {
					turn: event.turn,
					startedAt: Date.now(),
					toolCallCount: 0,
					inputTokens: 0,
					outputTokens: 0,
					isError: false,
					toolStarts: new Map(),
				};
				break;

			case "message_update":
				// First streamed assistant delta = time to first token.
				if (event.message.role === "assistant" && this.state && this.state.firstTokenAt === undefined) {
					this.state.firstTokenAt = Date.now();
				}
				break;

			case "message_end":
				if (event.message.role === "assistant" && this.state) {
					this.state.llmEndedAt = Date.now();
					this.state.model = event.message.model;
					this.state.inputTokens = event.message.usage.input;
					this.state.outputTokens = event.message.usage.output;
					this.state.stopReason = event.message.stopReason;
					if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
						this.state.isError = true;
					}
				}
				break;

			case "tool_start":
				if (this.state) {
					this.state.toolCallCount++;
					if (this.state.firstToolStartAt === undefined) this.state.firstToolStartAt = Date.now();
					this.state.toolStarts.set(event.toolCallId, Date.now());
				}
				break;

			case "tool_end":
				if (this.state) {
					this.state.lastToolEndAt = Date.now();
					this.state.toolStarts.delete(event.toolCallId);
				}
				break;

			case "turn_end": {
				const state = this.state;
				if (!state) break;
				this.state = undefined;

				const endedAt = Date.now();
				const llmMs = state.llmEndedAt !== undefined ? state.llmEndedAt - state.startedAt : 0;
				const record: TurnTiming = {
					timestamp: state.startedAt,
					model: state.model ?? this.options.modelId ?? "unknown",
					...(this.options.modelId && this.options.modelId !== state.model
						? { agentModelId: this.options.modelId }
						: {}),
					...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
					durationMs: endedAt - state.startedAt,
					...(state.firstTokenAt !== undefined ? { ttftMs: state.firstTokenAt - state.startedAt } : {}),
					llmMs,
					...(state.firstToolStartAt !== undefined && state.lastToolEndAt !== undefined
						? { toolMs: state.lastToolEndAt - state.firstToolStartAt }
						: {}),
					inputTokens: state.inputTokens,
					outputTokens: state.outputTokens,
					...(state.outputTokens > 0 && llmMs > 0
						? { outputTokensPerSecond: Math.round((state.outputTokens / llmMs) * 1000 * 10) / 10 }
						: {}),
					toolCalls: state.toolCallCount,
					stopReason: state.stopReason ?? "stop",
					isError: state.isError,
					turn: state.turn,
				};
				this.options.onTurn?.(record);
				break;
			}
			default:
				break;
		}
	}
}

/** Convenience: build a listener for custom subscription chains. */
export function createTimingListener(options: TimingCollectorOptions): {
	listener: AgentEventListener;
	collector: TimingCollector;
} {
	const collector = new TimingCollector(options);
	return { listener: (event) => collector.onEvent(event), collector };
}
