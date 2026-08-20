/**
 * bash tool — run a shell command, capture combined output, truncate the tail.
 */

import type { Tool, ToolResult } from "@puck-agent/core";
import { spawn } from "node:child_process";
import { truncateTail } from "./truncate.js";

export interface BashToolOptions {
	/** Working directory for the command (default: tool context cwd). */
	cwd?: string;
	/** Default timeout in seconds when the call doesn't specify one. */
	defaultTimeoutSeconds?: number;
	maxLines?: number;
	maxBytes?: number;
	env?: Record<string, string>;
}

export interface BashExecutionResult {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
}

const parameters = {
	type: "object",
	properties: {
		command: { type: "string", description: "Shell command to execute" },
		timeout: { type: "number", description: "Timeout in seconds (optional)" },
	},
	required: ["command"],
} as const;

/** Run a shell command and capture its output. Exposed for reuse/tests. */
export function runShellCommand(
	command: string,
	cwd: string,
	options: { timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<BashExecutionResult> {
	return new Promise((resolveRun) => {
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		let exitCode: number | null = null;
		let timedOut = false;
		let aborted = false;

		const child = spawn(command, {
			shell: true,
			cwd,
			env: process.env,
			windowsHide: true,
		});

		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			options.signal?.removeEventListener("abort", onAbort);
			let output = stdout;
			if (stderr) output += (output ? "\n" : "") + "[stderr]\n" + stderr;
			if (timedOut) output += `\n[command timed out after ${options.timeoutSeconds}s]`;
			if (aborted) output += "\n[command aborted]";
			resolveRun({ output, exitCode, timedOut, aborted, durationMs: Date.now() - started });
		};

		/** Kill the process tree: on Windows child.kill() only kills cmd.exe, orphaning grandchildren. */
		const killTree = (): void => {
			if (process.platform === "win32") {
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
			} else {
				child.kill("SIGKILL");
			}
		};

		const timeoutTimer =
			options.timeoutSeconds !== undefined
				? setTimeout(() => {
						timedOut = true;
						killTree();
					}, options.timeoutSeconds * 1000)
				: undefined;

		const onAbort = (): void => {
			aborted = true;
			killTree();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			stderr += String(error);
			exitCode = null;
			finish();
		});
		child.on("close", (code) => {
			exitCode = code;
			finish();
		});
	});
}

export function createBashTool(options: BashToolOptions = {}): Tool {
	return {
		name: "bash",
		description:
			"Execute a shell command in the working directory and return its output. " +
			"Output is truncated to the last 2000 lines / 50KB. Use for builds, tests, grep, find, git.",
		parameters,
		async execute(args, ctx): Promise<ToolResult> {
			const command = (args as { command: string }).command;
			const timeoutSeconds = (args as { timeout?: number }).timeout ?? options.defaultTimeoutSeconds;
			const cwd = options.cwd ?? ctx.cwd;

			const result = await runShellCommand(command, cwd, { timeoutSeconds, signal: ctx.signal });

			const truncated = truncateTail(result.output, options.maxLines, options.maxBytes);
			let text = truncated.content;
			if (truncated.truncated) {
				text = `[output truncated: ${truncated.totalLines} lines / ${truncated.totalBytes} bytes total]\n${text}`;
			}
			if (result.exitCode !== 0) {
				text += `\n[exit code: ${result.exitCode ?? "none"}]`;
			}

			return {
				content: [{ type: "text", text }],
				...(result.exitCode !== null && result.exitCode !== 0 && !result.aborted ? { isError: true } : {}),
			};
		},
	};
}
