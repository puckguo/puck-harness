/**
 * Timing types — one record per agent turn.
 *
 * A "turn" is one LLM request plus its tool calls (matches the loop's
 * turn_start/turn_end events). Metrics:
 *   - ttftMs:   time to first streamed token (user-perceived responsiveness)
 *   - llmMs:    full LLM streaming duration (turn start → assistant message_end)
 *   - toolMs:   wall-clock of the tool-execution phase of the turn
 *   - durationMs: the whole turn
 *   - outputTokensPerSecond: generation speed during llmMs
 */

export interface TurnTiming {
	/** Turn start, Unix ms. */
	timestamp: number;
	/** Model id from the assistant message (authoritative). */
	model: string;
	/** Logical model id from the agent (falls back to message model). */
	agentModelId?: string;
	sessionId?: string;
	durationMs: number;
	/** Time to first streamed token. Undefined for error turns without output. */
	ttftMs?: number;
	/** LLM streaming duration. */
	llmMs: number;
	/** Wall-clock of the tool phase (last tool_end − first tool_start). */
	toolMs?: number;
	inputTokens: number;
	outputTokens: number;
	outputTokensPerSecond?: number;
	toolCalls: number;
	stopReason: string;
	isError: boolean;
	/** Turn index within the run (0-based). */
	turn: number;
}
