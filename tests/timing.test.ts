/**
 * Timing feature tests: collector state machine, store, aggregation,
 * anomaly detection, dashboard generation, LLM analysis (mocked).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, Message, Tool } from "@puck-agent/core";
import { Agent } from "@puck-agent/core";
import { createMockStreamFn } from "@puck-agent/llm";
import {
	aggregateByModel,
	aggregateBySession,
	analyzeTimings,
	detectAnomalies,
	formatMs,
	generateDashboard,
	TimingCollector,
	TimingStore,
	type TurnTiming,
} from "@puck-agent/timing";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fakeTiming(partial: Partial<TurnTiming>): TurnTiming {
	return {
		timestamp: Date.now(),
		model: "test-model",
		durationMs: 1000,
		llmMs: 900,
		inputTokens: 100,
		outputTokens: 50,
		toolCalls: 0,
		stopReason: "stop",
		isError: false,
		turn: 0,
		...partial,
	};
}

/** Drive the collector through a synthetic event sequence with controlled clocks. */
function collect(events: Array<{ event: AgentEvent; at: number }>, options?: { sessionId?: string }): TurnTiming[] {
	const records: TurnTiming[] = [];
	const collector = new TimingCollector({ ...options, onTurn: (r) => records.push(r) });
	for (const { event, at } of events) {
		const realNow = Date.now;
		(Date as unknown as { now: () => number }).now = () => at;
		collector.onEvent(event);
		(Date as unknown as { now: () => number }).now = realNow;
	}
	return records;
}

function userMsg(): Message {
	return { role: "user", content: "hi", timestamp: 0 };
}

function assistantMsg(partial: { model?: string; usage?: Partial<import("@puck-agent/core").Usage>; stopReason?: import("@puck-agent/core").StopReason } = {}): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		model: partial.model ?? "test-model",
		stopReason: partial.stopReason ?? "stop",
		usage: { input: 100, output: 50, totalTokens: 150, ...partial.usage },
		timestamp: 0,
	};
}

// ---------------------------------------------------------------------------
// collector
// ---------------------------------------------------------------------------

test("collector: records ttft / llm / duration from event stream", () => {
	const records = collect([
		{ event: { type: "run_start" }, at: 0 },
		{ event: { type: "turn_start", turn: 0 }, at: 0 },
		{ event: { type: "message_start", message: assistantMsg() }, at: 100 }, // stream start (no text yet)
		{ event: { type: "message_update", message: assistantMsg() }, at: 350 }, // first streamed token
		{ event: { type: "message_update", message: assistantMsg() }, at: 500 },
		{ event: { type: "message_end", message: assistantMsg() }, at: 900 },
		{ event: { type: "turn_end", turn: 0, message: assistantMsg() as never, toolResults: [] }, at: 1000 },
	]);

	assert.equal(records.length, 1);
	const record = records[0];
	assert.equal(record.ttftMs, 350);
	assert.equal(record.llmMs, 900);
	assert.equal(record.durationMs, 1000);
	assert.equal(record.model, "test-model");
	assert.equal(record.inputTokens, 100);
	assert.equal(record.outputTokens, 50);
	// 50 tokens over 900ms → ~55.6 tok/s
	assert.ok(record.outputTokensPerSecond && record.outputTokensPerSecond > 50 && record.outputTokensPerSecond < 60);
	assert.equal(record.isError, false);
});

test("collector: tool phase wall-clock tracked per turn", () => {
	const records = collect([
		{ event: { type: "turn_start", turn: 0 }, at: 0 },
		{ event: { type: "message_update", message: assistantMsg() }, at: 100 },
		{ event: { type: "message_end", message: assistantMsg() }, at: 400 },
		{ event: { type: "tool_start", toolCallId: "a", toolName: "bash", args: {} }, at: 400 },
		{ event: { type: "tool_start", toolCallId: "b", toolName: "read", args: {} }, at: 450 },
		{ event: { type: "tool_end", toolCallId: "b", toolName: "read", result: { content: [] }, isError: false }, at: 600 },
		{ event: { type: "tool_end", toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false }, at: 800 },
		{ event: { type: "turn_end", turn: 0, message: assistantMsg() as never, toolResults: [] }, at: 810 },
	]);

	assert.equal(records.length, 1);
	assert.equal(records[0].toolCalls, 2);
	assert.equal(records[0].toolMs, 400); // 800 - 400, wall clock of the phase
	assert.equal(records[0].llmMs, 400);
});

test("collector: error turns marked, no ttft when nothing streamed", () => {
	const records = collect([
		{ event: { type: "turn_start", turn: 0 }, at: 0 },
		{ event: { type: "message_end", message: assistantMsg({ stopReason: "error" }) }, at: 2000 },
		{ event: { type: "turn_end", turn: 0, message: assistantMsg({ stopReason: "error" }) as never, toolResults: [] }, at: 2000 },
	]);

	assert.equal(records[0].isError, true);
	assert.equal(records[0].ttftMs, undefined);
	assert.equal(records[0].stopReason, "error");
});

test("collector: multi-turn run produces one record per turn", () => {
	const records = collect([
		{ event: { type: "turn_start", turn: 0 }, at: 0 },
		{ event: { type: "message_end", message: assistantMsg() }, at: 100 },
		{ event: { type: "turn_end", turn: 0, message: assistantMsg() as never, toolResults: [] }, at: 100 },
		{ event: { type: "turn_start", turn: 1 }, at: 100 },
		{ event: { type: "message_end", message: assistantMsg({ model: "other-model" }) }, at: 700 },
		{ event: { type: "turn_end", turn: 1, message: assistantMsg() as never, toolResults: [] }, at: 700 },
	]);

	assert.equal(records.length, 2);
	assert.equal(records[0].model, "test-model");
	assert.equal(records[1].model, "other-model");
	assert.equal(records[1].turn, 1);
});

test("collector: attaches to a real Agent and records real runs", async () => {
	const echoTool: Tool = {
		name: "echo",
		description: "echo",
		parameters: { type: "object", properties: {} },
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const agent = new Agent({
		tools: [echoTool],
		streamFn: createMockStreamFn([
			{ toolCalls: [{ name: "echo", arguments: {} }] },
			{ text: "done" },
		]),
		modelId: "mock",
	});

	const records: TurnTiming[] = [];
	const collector = new TimingCollector({ sessionId: "s1", modelId: "mock", onTurn: (r) => records.push(r) });
	collector.attach(agent);

	await agent.prompt("hi");
	assert.equal(records.length, 2);
	assert.equal(records[0].sessionId, "s1");
	assert.equal(records[0].toolCalls, 1);
	assert.ok(records[0].toolMs !== undefined && records[0].toolMs >= 0);
	assert.equal(records[0].model, "mock");
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test("store: append/load roundtrip, torn tail tolerated", () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-timing-"));
	try {
		const store = new TimingStore(join(dir, "timings.jsonl"));
		store.append(fakeTiming({ model: "a", durationMs: 1 }));
		store.append(fakeTiming({ model: "b", durationMs: 2 }));
		assert.equal(store.load().length, 2);

		appendFileSync(store.path, '{"timestamp": BROKEN', "utf8");
		assert.equal(store.load().length, 2); // torn line skipped

		store.clear();
		assert.equal(store.load().length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// aggregation + anomalies
// ---------------------------------------------------------------------------

test("aggregate: per-model percentiles exclude errors from latency stats", () => {
	const records = [
		fakeTiming({ model: "m", durationMs: 100, ttftMs: 10 }),
		fakeTiming({ model: "m", durationMs: 200, ttftMs: 20 }),
		fakeTiming({ model: "m", durationMs: 300, ttftMs: 30 }),
		fakeTiming({ model: "m", durationMs: 99_999, isError: true, stopReason: "error" }),
		fakeTiming({ model: "n", durationMs: 50, ttftMs: 5, toolMs: 30, toolCalls: 1 }),
	];

	const stats = aggregateByModel(records);
	const m = stats.find((s) => s.model === "m")!;
	assert.equal(m.turns, 4);
	assert.equal(m.okTurns, 3);
	assert.equal(m.errors, 1);
	assert.equal(m.avgDurationMs, 200);
	assert.equal(m.p50DurationMs, 200);
	// error turn excluded from latency
	assert.equal(m.p95DurationMs, 300);

	const n = stats.find((s) => s.model === "n")!;
	assert.equal(n.toolTurns, 1);
	assert.equal(n.avgToolMs, 30);
});

test("aggregate: session roll-up groups by sessionId", () => {
	const records = [
		fakeTiming({ sessionId: "a", durationMs: 100 }),
		fakeTiming({ sessionId: "a", durationMs: 200 }),
		fakeTiming({ sessionId: "b", durationMs: 50 }),
	];
	const sessions = aggregateBySession(records);
	assert.equal(sessions.length, 2);
	assert.equal(sessions.find((s) => s.sessionId === "a")!.turns, 2);
	assert.equal(sessions.find((s) => s.sessionId === "a")!.totalDurationMs, 300);
});

test("anomalies: flags 3× median outliers and slow token rates", () => {
	const normal = Array.from({ length: 5 }, (_, i) =>
		fakeTiming({ model: "m", durationMs: 1000 + i * 100, ttftMs: 500, outputTokens: 200, llmMs: 900 }),
	);
	const slow = [
		fakeTiming({ model: "m", durationMs: 30_000, ttftMs: 20_000, outputTokens: 100, llmMs: 29_000 }),
		fakeTiming({ model: "m", durationMs: 1000, ttftMs: 500, outputTokens: 500, llmMs: 90_000, outputTokensPerSecond: 5.5 }),
	];

	const anomalies = detectAnomalies([...normal, ...slow]);
	const kinds = anomalies.map((a) => a.kind);
	assert.ok(kinds.includes("slow-ttft"));
	assert.ok(kinds.includes("slow-duration"));

	// few records → no baseline, no anomalies
	assert.equal(detectAnomalies(normal.slice(0, 2)).length, 0);
});

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

test("dashboard: self-contained HTML embeds data and sections", () => {
	const records = [
		fakeTiming({ model: "MiniMax-M3", durationMs: 1234, ttftMs: 400, outputTokens: 100, llmMs: 1100 }),
		fakeTiming({ model: "deepseek-chat", durationMs: 900, ttftMs: 300, outputTokens: 80, llmMs: 800 }),
	];
	const html = generateDashboard(records);

	assert.ok(html.includes("<!doctype html>"));
	assert.ok(!html.includes("http://") && !html.includes("https://cdn"), "no external resources");
	assert.ok(html.includes("MiniMax-M3"));
	assert.ok(html.includes("按模型统计"));
	assert.ok(html.includes("每轮耗时"));
	assert.ok(html.includes("const DATA ="));
	// JSON data is valid when extracted
	const match = html.match(/const DATA = (\{.*?\});\n/s);
	assert.ok(match, "DATA block found");
	assert.doesNotThrow(() => JSON.parse(match[1]!));
});

// ---------------------------------------------------------------------------
// LLM analysis
// ---------------------------------------------------------------------------

test("analyze: feeds stats to the model and returns its report", async () => {
	const records = [
		...Array.from({ length: 4 }, () =>
			fakeTiming({ model: "fast-model", durationMs: 1200, ttftMs: 400, outputTokens: 200, llmMs: 1100, outputTokensPerSecond: 180 }),
		),
		fakeTiming({ model: "slow-model", durationMs: 9000, ttftMs: 6000, outputTokens: 300, llmMs: 8500, outputTokensPerSecond: 35 }),
	];

	let receivedPrompt = "";
	const mockStream = createMockStreamFn([{ text: "分析报告：fast-model 正常，slow-model TTFT 偏高。" }]);
	const wrappedStream = (context: { messages: Message[] }, options?: unknown) => {
		receivedPrompt = typeof context.messages[0]?.content === "string" ? context.messages[0].content : "";
		return mockStream(context as never, options as never);
	};

	const report = await analyzeTimings(records, wrappedStream as never);
	assert.match(report, /分析报告/);
	assert.match(receivedPrompt, /fast-model/);
	assert.match(receivedPrompt, /slow-model/);
	assert.match(receivedPrompt, /合理性/);
});

test("analyze: empty records return early", async () => {
	const result = await analyzeTimings([], createMockStreamFn([{ text: "x" }]));
	assert.match(result, /没有可分析/);
});

test("formatMs renders human units", () => {
	assert.equal(formatMs(950), "950ms");
	assert.equal(formatMs(1500), "1.5s");
	assert.match(formatMs(125_000), /2m5s|2m4s/);
});
