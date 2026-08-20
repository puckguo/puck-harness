/**
 * Web wire protocol — the puck AgentEvent stream projected onto HTTP/SSE.
 *
 * The browser talks to this server over two channels:
 *
 *   POST /api/run          { sessionId, input }   → SSE stream of WebEvent
 *   GET  /api/state?sessionId=…                    → snapshot (see below)
 *   GET  /api/sessions                              → SessionStats[]
 *   GET  /api/models                                → usable provider models
 *   POST /api/login                                 → store a provider key
 *   POST /api/abort  { sessionId }                  → abort active run
 *
 * Every SSE payload is one JSON object per `data:` line. Two families:
 *
 *   1. passthrough AgentEvents (message_update, tool_start, …) — the exact
 *      same discriminated union defined in @puck-agent/core, rendered live.
 *   2. server-side lifecycle events (done/error/notice) — added by this
 *      server to bracket a run over the wire.
 */

import type { AgentEvent } from "@puck-agent/core";

/** Passthrough events keep their core shape; only lifecycle wrappers are new. */
export type WebEvent =
	| AgentEvent
	| { type: "server_notice"; message: string }
	| { type: "server_error"; message: string }
	| { type: "run_settled"; ok: boolean };

/** Sent as the initial SSE frame: everything the UI needs to hydrate. */
export interface WebSnapshot {
	sessionId: string;
	model: string | undefined;
	/** Canonical transcript (already hydrated from the session log). */
	messages: unknown[];
	/** Estimated tokens currently in context. */
	ctxTokens: number;
	ctxWindow: number;
	inTokens: number;
	outTokens: number;
	running: boolean;
}

/** POST /api/run request body. */
export interface RunRequestBody {
	sessionId?: string;
	input: string;
	/** Optional model override for this run (`provider/model` or bare id). */
	model?: string;
	/** Server-side working directory for tool calls. */
	cwd?: string;
	/** Thinking effort hint (next-turn). */
	thinkingEffort?: "off" | "low" | "medium" | "high";
}

/** One SSE frame: `data: {json}\n\n`. */
export function encodeSse(event: WebEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}
