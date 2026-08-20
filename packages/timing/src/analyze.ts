/**
 * LLM-based sanity analysis of timing records.
 *
 * Feeds aggregated statistics + anomaly evidence to any StreamFn (the host's
 * current model, or a cheap/fast one) and returns a readable report. The
 * analysis prompt is deliberately structured: the model checks baseline
 * plausibility, compares models, and interprets the flagged anomalies.
 */

import type { AssistantMessage, StreamFn, TextContent } from "@puck-agent/core";
import { userMessage } from "@puck-agent/core";
import { aggregateByModel, detectAnomalies, formatMs } from "./aggregate.js";
import type { TurnTiming } from "./types.js";

export interface AnalyzeOptions {
	/** Only analyze records newer than this Unix ms timestamp. */
	since?: number;
	/** Limit raw examples fed to the model. */
	maxExamples?: number;
}

export async function analyzeTimings(
	records: TurnTiming[],
	streamFn: StreamFn,
	options: AnalyzeOptions = {},
): Promise<string> {
	const scoped = options.since !== undefined ? records.filter((r) => r.timestamp >= options.since!) : records;
	if (scoped.length === 0) return "没有可分析的计时记录。";

	const stats = aggregateByModel(scoped);
	const anomalies = detectAnomalies(scoped);
	const maxExamples = options.maxExamples ?? 12;

	const statsText = stats
		.map((s) => {
			const parts = [
				`模型 ${s.model}:`,
				`  轮数 ${s.turns}（成功 ${s.okTurns}，错误 ${s.errors}，错误率 ${(s.errorRate * 100).toFixed(0)}%）`,
				`  TTFT（首 token 延迟）平均 ${formatMs(s.avgTtftMs)} / p50 ${formatMs(s.p50TtftMs)} / p95 ${formatMs(s.p95TtftMs)}`,
				`  整轮时长平均 ${formatMs(s.avgDurationMs)} / p50 ${formatMs(s.p50DurationMs)} / p95 ${formatMs(s.p95DurationMs)}`,
				`  LLM 流式平均 ${formatMs(s.avgLlmMs)}，输出速率 ${s.avgTokensPerSecond || "?"} tok/s`,
				`  tokens: 输入 ${s.totalInputTokens} / 输出 ${s.totalOutputTokens}；带工具的轮 ${s.toolTurns}，工具平均 ${formatMs(s.avgToolMs)}`,
			];
			return parts.join("\n");
		})
		.join("\n\n");

	const anomalyText =
		anomalies.length === 0
			? "（启发式未标记异常）"
			: anomalies
					.map((a) => {
						const examples = a.records
							.slice(0, maxExamples)
							.map(
								(r) =>
									`  - ${new Date(r.timestamp).toISOString()} ${r.model}: duration=${formatMs(r.durationMs)} ttft=${r.ttftMs !== undefined ? formatMs(r.ttftMs) : "?"} out=${r.outputTokens}tok tools=${r.toolCalls} stop=${r.stopReason}`,
							)
							.join("\n");
						return `[${a.kind}] ${a.model}: ${a.detail}\n${examples}`;
					})
					.join("\n\n");

	const prompt = `你是一名 LLM 性能分析师。下面是一个 agent harness 的逐轮计时统计（指标：TTFT=首 token 延迟；整轮时长=LLM 流式+工具执行；tok/s=输出速率）。

<统计>
${statsText}
</统计>

<启发式标记的异常>
${anomalyText}
</启发式>

请输出中文分析报告，包含：
1. **总体合理性判断**：TTFT、时长、tok/s 是否在正常范围（一般 API 模型 TTFT 0.3–3s，推理模型 3–15s；输出 20–100+ tok/s 常见）。明确说明哪些指标正常、哪些偏慢。
2. **模型对比**：如有多个模型，按响应速度/稳定性/性价比给出对比结论。
3. **异常解读**：对每个标记的异常给出可能原因（网络抖动、服务端排队、输出过长、reasoning 模型思考、工具慢等）与置信度。
4. **建议**：3 条以内可操作建议（如换模型、拆分任务、增加超时、检查网络）。
保持简洁，用表格呈现关键数字，不要编造数据里没有的结论。`;

	const stream = streamFn({ messages: [userMessage(prompt)] }, { maxTokens: 4096 });
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") final = event.message;
	}
	if (final?.stopReason === "error") {
		throw new Error(`Timing analysis failed: ${final.errorMessage ?? "unknown error"}`);
	}
	return (
		final?.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("") ?? ""
	);
}
