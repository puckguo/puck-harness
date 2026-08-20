/**
 * edit tool — precise string-replacement edits with uniqueness checks.
 *
 * Each edit's oldText must match exactly once in the file and edits must
 * not overlap. Replacements are applied by index, back to front, so the
 * remaining offsets stay valid.
 */

import type { Tool, ToolResult } from "@puckguo123/core";
import { readFile, writeFile } from "node:fs/promises";
import { resolveToolPath } from "./paths.js";

export interface EditToolOptions {
	cwd?: string;
	confine?: boolean;
}

export interface EditOperation {
	oldText: string;
	newText: string;
}

interface AppliedRange {
	start: number;
	end: number;
}

const parameters = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path to edit (relative to the working directory)" },
		edits: {
			type: "array",
			description: "List of edits to apply in order",
			items: {
				type: "object",
				properties: {
					oldText: { type: "string", description: "Exact text to find (must be unique in the file)" },
					newText: { type: "string", description: "Replacement text" },
				},
				required: ["oldText", "newText"],
			},
		},
	},
	required: ["path", "edits"],
} as const;

export function createEditTool(options: EditToolOptions = {}): Tool {
	return {
		name: "edit",
		description:
			"Edit a file through exact string replacement. Each edit's oldText must match the file content " +
			"exactly once and edits must not overlap; keep oldText as small as possible while staying unique.",
		parameters,
		async execute(args, ctx): Promise<ToolResult> {
			const pathArg = (args as { path: string }).path;
			let path: string;
			try {
				path = resolveToolPath(options.cwd ?? ctx.cwd, pathArg, options.confine ?? true);
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
			const edits = ((args as { edits?: EditOperation[] }).edits) ?? [];
			if (edits.length === 0) {
				return { content: [{ type: "text", text: "No edits provided" }], isError: true };
			}

			const original = await readFile(path, "utf8").catch(() => null);
			if (original === null) {
				return { content: [{ type: "text", text: `File not found: ${pathArg}` }], isError: true };
			}

			// Validate every edit against the original content first.
			const ranges: AppliedRange[] = [];
			for (const edit of edits) {
				if (!edit.oldText) {
					return { content: [{ type: "text", text: "oldText must not be empty" }], isError: true };
				}
				const first = original.indexOf(edit.oldText);
				if (first === -1) {
					return {
						content: [{ type: "text", text: `oldText not found in ${pathArg}:\n${edit.oldText.slice(0, 200)}` }],
						isError: true,
					};
				}
				if (original.indexOf(edit.oldText, first + 1) !== -1) {
					return {
						content: [
							{
								type: "text",
								text: `oldText is not unique in ${pathArg} (matches more than once). Include more surrounding context:\n${edit.oldText.slice(0, 200)}`,
							},
						],
						isError: true,
					};
				}
				const range = { start: first, end: first + edit.oldText.length };
				if (ranges.some((r) => range.start < r.end && r.start < range.end)) {
					return { content: [{ type: "text", text: "Edits overlap; merge them into one edit" }], isError: true };
				}
				ranges.push(range);
			}

			// Apply back to front so earlier offsets remain valid.
			let content = original;
			for (let i = edits.length - 1; i >= 0; i--) {
				const { start, end } = ranges[i];
				content = content.slice(0, start) + edits[i].newText + content.slice(end);
			}

			await writeFile(path, content, "utf8");
			return {
				content: [{ type: "text", text: `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${pathArg}` }],
			};
		},
	};
}
