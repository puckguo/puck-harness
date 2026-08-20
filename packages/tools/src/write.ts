/**
 * write tool — create or overwrite a file (parent directories are created).
 */

import type { Tool, ToolResult } from "@puck-agent/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveToolPath } from "./paths.js";

export interface WriteToolOptions {
	cwd?: string;
	confine?: boolean;
}

const parameters = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path to write (relative to the working directory)" },
		content: { type: "string", description: "Full file content to write" },
	},
	required: ["path", "content"],
} as const;

export function createWriteTool(options: WriteToolOptions = {}): Tool {
	return {
		name: "write",
		description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
		parameters,
		async execute(args, ctx): Promise<ToolResult> {
			const pathArg = (args as { path: string }).path;
			let path: string;
			try {
				path = resolveToolPath(options.cwd ?? ctx.cwd, pathArg, options.confine ?? true);
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
			const content = (args as { content: string }).content;

			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");

			return { content: [{ type: "text", text: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${(args as { path: string }).path}` }] };
		},
	};
}
