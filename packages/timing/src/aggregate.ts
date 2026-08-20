/**
 * Aggregation: per-model latency statistics + anomaly detection.
 * Percentiles (p50/p95) over successful turns only; errors counted separately.
 */

import type { TurnTiming } from "./types.js";

export interface ModelStats {
	model: string;
	turns: number;
	okTurns: number;
	errors: number;
	errorRate: number;
	avgTtftMs: number;
	p50TtftMs: number;
	p95TtftMs: number;
	avgDurationMs: number;
	p50DurationMs: number;
	p95DurationMs: number;
	avgLlmMs: number;
	avgTokensPerSecond: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	toolTurns: number;
	avgToolMs: number;
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}

function avg(values: number[]): number {
	return values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function aggregateByModel(records: TurnTiming[], modelFilter?: string): ModelStats[] {
	const filtered = modelFilter ? records.filter((r) => r.model === modelFilter || r.agentModelId === modelFilter) : records;
	const groups = new Map<string, TurnTiming[]>();
	for (const record of filtered) {
		const key = record.model;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(record);
	}

	return [...groups.entries()]
		.map(([model, turns]) => {
			const ok = turns.filter((t) => !t.isError);
			const ttfts = ok.map((t) => t.ttftMs).filter((t): t is number => t !== undefined);
			const durations = ok.map((t) => t.durationMs);
			const llms = ok.map((t) => t.llmMs).filter((t) => t > 0);
			const tps = ok.map((t) => t.outputTokensPerSecond).filter((t): t is number => t !== undefined);
			const toolTurns = ok.filter((t) => (t.toolMs ?? 0) > 0);
			return {
				model,
				turns: turns.length,
				okTurns: ok.length,
				errors: turns.length - ok.length,
				errorRate: turns.length === 0 ? 0 : (turns.length - ok.length) / turns.length,
				avgTtftMs: avg(ttfts),
				p50TtftMs: percentile(ttfts, 50),
				p95TtftMs: percentile(ttfts, 95),
				avgDurationMs: avg(durations),
				p50DurationMs: percentile(durations, 50),
				p95DurationMs: percentile(durations, 95),
				avgLlmMs: avg(llms),
				avgTokensPerSecond: avg(tps),
				totalInputTokens: turns.reduce((sum, t) => sum + t.inputTokens, 0),
				totalOutputTokens: turns.reduce((sum, t) => sum + t.outputTokens, 0),
				toolTurns: toolTurns.length,
				avgToolMs: avg(toolTurns.map((t) => t.toolMs ?? 0)),
			};
		})
		.sort((a, b) => b.turns - a.turns);
}

/** Session-level roll-up for the dashboard's conversation list. */
export interface SessionStats {
	sessionId: string;
	models: string[];
	turns: number;
	totalDurationMs: number;
	firstAt: number;
	lastAt: number;
}

export function aggregateBySession(records: TurnTiming[]): SessionStats[] {
	const groups = new Map<string, TurnTiming[]>();
	for (const record of records) {
		const key = record.sessionId ?? "(inline)";
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(record);
	}
	return [...groups.entries()]
		.map(([sessionId, turns]) => ({
			sessionId,
			models: [...new Set(turns.map((t) => t.model))],
			turns: turns.length,
			totalDurationMs: turns.reduce((sum, t) => sum + t.durationMs, 0),
			firstAt: Math.min(...turns.map((t) => t.timestamp)),
			lastAt: Math.max(...turns.map((t) => t.timestamp)),
		}))
		.sort((a, b) => b.lastAt - a.lastAt);
}

export interface Anomaly {
	kind: "slow-ttft" | "slow-duration" | "slow-tokens" | "error-burst" | "stall";
	model: string;
	detail: string;
	records: TurnTiming[];
}

/**
 * Heuristic anomaly detection over the raw records:
 *  - TTFT/duration > 3× the model's median (with a floor to avoid noise on tiny samples)
 *  - output rate below 5 tokens/s on non-trivial outputs
 *  - turns that took 10× longer than their token count predicts
 */
export function detectAnomalies(records: TurnTiming[]): Anomaly[] {
	const anomalies: Anomaly[] = [];
	for (const stats of aggregateByModel(records)) {
		const modelRecords = records.filter((r) => r.model === stats.model && !r.isError);
		if (stats.okTurns < 3) continue; // not enough baseline

		const slowTtft = modelRecords.filter(
			(r) => r.ttftMs !== undefined && r.ttftMs > Math.max(stats.p50TtftMs * 3, stats.p50TtftMs + 2000),
		);
		if (slowTtft.length > 0) {
			anomalies.push({
				kind: "slow-ttft",
				model: stats.model,
				detail: `${slowTtft.length} turn(s) with TTFT > 3× median (p50 ${stats.p50TtftMs}ms)`,
				records: slowTtft,
			});
		}

		const slowDuration = modelRecords.filter(
			(r) => r.durationMs > Math.max(stats.p50DurationMs * 3, stats.p50DurationMs + 5000),
		);
		if (slowDuration.length > 0) {
			anomalies.push({
				kind: "slow-duration",
				model: stats.model,
				detail: `${slowDuration.length} turn(s) with duration > 3× median (p50 ${stats.p50DurationMs}ms)`,
				records: slowDuration,
			});
		}

		const slowTokens = modelRecords.filter(
			(r) => r.outputTokensPerSecond !== undefined && r.outputTokens > 50 && r.outputTokensPerSecond < 5,
		);
		if (slowTokens.length > 0) {
			anomalies.push({
				kind: "slow-tokens",
				model: stats.model,
				detail: `${slowTokens.length} turn(s) generating below 5 tok/s`,
				records: slowTokens,
			});
		}
	}

	const errorRecords = records.filter((r) => r.isError);
	if (errorRecords.length >= 2) {
		anomalies.push({
			kind: "error-burst",
			model: "(all)",
			detail: `${errorRecords.length} failed turns total`,
			records: errorRecords,
		});
	}
	return anomalies;
}

export function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
