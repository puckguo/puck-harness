/**
 * Subagent tool — spawn a nested puck agent with its own tools and prompt.
 *
 * This is the "multi-agent" feature and the canonical example of a puck
 * feature you can delete wholesale: nothing else imports this file, and
 * removing the folder (plus its exports entry) leaves the rest intact.
 */

import type { Agent, StreamFn, Tool, ToolResult } from "@puckguo123/core";
import { Agent as AgentClass } from "@puckguo123/core";

export interface SubagentOptions {
	/** Stream function for the nested agent (usually the parent's). */
	streamFn: StreamFn;
	/** Tools available to the subagent (default: none). */
	tools?: Tool[];
	/** System prompt for the subagent. */
	systemPrompt?: string;
	/** Tool name (default "agent"). */
	name?: string;
	/** Hard cap on nested turns (default 10). */
	maxTurns?: number;
	/** Max nesting depth for this tool instance (default 2). */
	maxDepth?: number;
}

export function createSubagentTool(options: SubagentOptions): Tool {
	const name = options.name ?? "agent";
	const maxDepth = options.maxDepth ?? 2;
	let active = 0; // reentrancy-safe nesting counter for this tool instance

	return {
		name,
		description:
			"Spawn a subagent that independently completes a task with its own toolset and returns " +
			"a final report. Use for parallelizable or self-contained subtasks.",
		parameters: {
			type: "object",
			properties: {
				task: { type: "string", description: "Complete, self-contained description of the task" },
			},
			required: ["task"],
		},
		async execute(args): Promise<ToolResult> {
			if (active >= maxDepth) {
				return {
					content: [{ type: "text", text: `Subagent nesting limit (${maxDepth}) reached` }],
					isError: true,
				};
			}
			active++;
			try {
				const subagent: Agent = new AgentClass({
					systemPrompt: options.systemPrompt ?? "You are a focused task agent. Complete the task, then stop.",
					tools: options.tools ?? [],
					streamFn: options.streamFn,
					hooks: { maxTurns: options.maxTurns ?? 10 },
				});

				const added = await subagent.prompt((args as { task: string }).task);
				const final = [...added].reverse().find((m) => m.role === "assistant");
				if (final?.role === "assistant" && final.stopReason === "error") {
					return {
						content: [{ type: "text", text: `Subagent failed: ${final.errorMessage ?? "unknown error"}` }],
						isError: true,
					};
				}
				const text =
					final?.role === "assistant"
						? final.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("")
						: "(subagent produced no answer)";
				return { content: [{ type: "text", text }] };
			} finally {
				active--;
			}
		},
	};
}
