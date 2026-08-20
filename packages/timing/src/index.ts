/**
 * @puckguo123/timing — per-turn model latency metrics for puck.
 *
 * Collector (event-driven) → TimingStore (JSONL) → dashboard (self-contained
 * HTML) / aggregate stats / LLM sanity analysis. Depends only on core types.
 */

export type { TurnTiming } from "./types.js";
export { TimingCollector, createTimingListener, type TimingCollectorOptions } from "./collector.js";
export { TimingStore } from "./store.js";
export {
	aggregateByModel,
	aggregateBySession,
	detectAnomalies,
	formatMs,
	percentile,
	type Anomaly,
	type ModelStats,
	type SessionStats,
} from "./aggregate.js";
export { generateDashboard, type DashboardOptions } from "./dashboard.js";
export { analyzeTimings, type AnalyzeOptions } from "./analyze.js";
