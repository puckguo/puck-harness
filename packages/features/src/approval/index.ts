/**
 * Human-in-the-loop approval gate — a LoopHooks.beforeToolCall implementation.
 *
 * Policy decides which calls need approval; `ask` decides whether they get
 * it (prompt the user, check a rule set, call a webhook — up to the host).
 */

import type { BeforeToolCallResult, LoopHooks, ToolCall } from "@puck-agent/core";

export type ApprovalDecision = boolean | "always-allow";

export interface ApprovalCall {
	toolName: string;
	toolCall: ToolCall;
	args: unknown;
}

export interface ApprovalGateOptions {
	/**
	 * Which calls need approval:
	 * - "never"     nothing is gated (default)
	 * - "always"    every tool call is gated
	 * - predicate   gate when it returns true
	 */
	policy?: "never" | "always" | ((call: ApprovalCall) => boolean);
	/**
	 * Return true to allow the call, false to block it.
	 * Default when omitted: block everything that is gated (safe default).
	 */
	ask?: (call: ApprovalCall) => Promise<ApprovalDecision> | ApprovalDecision;
	/** Reason shown to the model when a call is blocked. */
	blockReason?: string;
}

export function createApprovalGate(options: ApprovalGateOptions = {}): NonNullable<LoopHooks["beforeToolCall"]> {
	const policy = options.policy ?? "never";
	const alwaysAllowed = new Set<string>();

	return async (info): Promise<BeforeToolCallResult | undefined> => {
		if (policy === "never") return undefined;
		const call: ApprovalCall = { toolName: info.toolCall.name, toolCall: info.toolCall, args: info.args };
		if (policy !== "always" && !policy(call)) return undefined;
		if (alwaysAllowed.has(info.toolCall.name)) return undefined;

		const decision = options.ask ? await options.ask(call) : false;
		if (decision === "always-allow") alwaysAllowed.add(info.toolCall.name);
		if (decision) return undefined;
		return { block: true, reason: options.blockReason ?? `Tool "${info.toolCall.name}" was not approved by the user` };
	};
}
