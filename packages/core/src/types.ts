/**
 * puck core types — the entire data model of the harness.
 *
 * Everything else in puck (llm adapters, tools, sessions, features, sdk)
 * is written against just these types. If you can hold this file in your
 * head, you can debug any puck agent.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** base64 encoded image data */
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Usage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens: number;
	/** USD cost, when the model definition carries pricing. */
	cost?: { input: number; output: number; total: number };
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	model: string;
	stopReason: StopReason;
	usage: Usage;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Result returned by a tool execution. */
export interface ToolResult {
	/** Content sent back to the model. */
	content: (TextContent | ImageContent)[];
	/** Mark the result as an error. The model sees it as a failed call. */
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the batch containing this result.
	 * The loop only stops when every result in the batch sets this.
	 */
	terminate?: boolean;
}

/** Runtime context handed to every tool execution. */
export interface ToolContext {
	cwd: string;
	signal?: AbortSignal;
	/** Free-form bag for host applications (e.g. approval state, loggers). */
	[key: string]: unknown;
}

/**
 * A tool. `parameters` is a plain JSON Schema object describing `args`.
 * Tools are plain objects: no registry, no lifecycle, no base class.
 */
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// LLM boundary
// ---------------------------------------------------------------------------

/** What the model sees on a request. */
export interface LlmContext {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export interface StreamOptions {
	apiKey?: string;
	baseUrl?: string;
	signal?: AbortSignal;
	temperature?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	/** Thinking/reasoning effort hint. Provider-specific mapping ("off" only disables where the API supports it). */
	thinkingEffort?: "off" | "low" | "medium" | "high";
}

export type StreamEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "delta"; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; message: AssistantMessage };

/**
 * A streaming assistant response. Iterate events for partial updates,
 * or await `.result()` for the final message.
 */
export interface AssistantStream extends AsyncIterable<StreamEvent> {
	result(): Promise<AssistantMessage>;
}

/**
 * The single seam between the agent loop and any LLM provider.
 *
 * Contract: never throw. Failures are reported as a final `error` event
 * carrying an AssistantMessage with stopReason "error" (or "aborted").
 */
export type StreamFn = (context: LlmContext, options?: StreamOptions) => AssistantStream;

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

/**
 * Events emitted by the agent loop. Roughly codex's thread/turn/item model
 * flattened into one discriminated union:
 *
 *   run_start
 *     turn_start
 *       message_start (user / toolResult: instant)
 *       message_start → message_update* → message_end (assistant, streamed)
 *       tool_start → tool_end
 *     turn_end
 *   run_end
 */
export type AgentEvent =
	| { type: "run_start" }
	| { type: "run_end"; messages: Message[] }
	| { type: "turn_start"; turn: number }
	| { type: "turn_end"; turn: number; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: Message }
	| { type: "message_end"; message: Message }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
	/** Model switched mid-session. Takes effect from the next LLM call. */
	| { type: "model_update"; modelId: string; previousModelId?: string };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Loop configuration / hooks
// ---------------------------------------------------------------------------

export interface BeforeToolCallResult {
	/** Prevent execution; the model receives `reason` as an error result. */
	block?: boolean;
	reason?: string;
}

export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	isError?: boolean;
}

export interface LoopHooks {
	/** Intercept a tool call after argument validation. Block or allow. */
	beforeToolCall?(info: {
		toolCall: ToolCall;
		args: unknown;
		assistantMessage: AssistantMessage;
	}): BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
	/** Rewrite a tool result before it is shown to the model / events. */
	afterToolCall?(info: {
		toolCall: ToolCall;
		args: unknown;
		result: ToolResult;
		isError: boolean;
	}): AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;
	/**
	 * Project the canonical transcript into what the LLM actually sees.
	 * Use for compaction / pruning / context injection. Canonical state
	 * is never modified by this.
	 */
	transformContext?(messages: Message[]): Message[] | Promise<Message[]>;
	/** Return true to stop the loop after the current turn. */
	shouldStop?(info: { turn: number; message: AssistantMessage; toolResults: ToolResultMessage[] }): boolean;
	/**
	 * Messages injected before the next LLM call while the run is active
	 * (steering). Polled after each turn.
	 */
	getSteeringMessages?(): Message[] | undefined;
	/** Hard cap on turns per run. The loop stops cleanly when reached. */
	maxTurns?: number;
	/** Execute tool calls of one assistant message sequentially or in parallel (default). */
	toolExecution?: "sequential" | "parallel";
}
