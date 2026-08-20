/**
 * read tool — read a text file (line ranges supported) or return an image
 * as base64 for multimodal models.
 */

import type { Tool, ToolResult } from "@puckguo123/core";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { resolveToolPath } from "./paths.js";
import { truncateHead } from "./truncate.js";

export interface ReadToolOptions {
	cwd?: string;
	/** Keep paths inside cwd (default true). */
	confine?: boolean;
	maxLines?: number;
	maxBytes?: number;
	/** Long lines are cut to this length. */
	maxLineLength?: number;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const parameters = {
	type: "object",
	properties: {
		path: { type: "string", description: "File path to read (relative to the working directory)" },
		offset: { type: "number", description: "Line number to start reading from (1-based, optional)" },
		limit: { type: "number", description: "Maximum number of lines to read (optional)" },
	},
	required: ["path"],
} as const;

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export function createReadTool(options: ReadToolOptions = {}): Tool {
	const maxLineLength = options.maxLineLength ?? 2000;
	return {
		name: "read",
		description:
			"Read the contents of a file. Supports text files (with optional offset/limit line ranges) " +
			"and images (png/jpg/gif/webp/bmp, returned as image content). Output is truncated to " +
			"2000 lines / 50KB; use offset and limit for large files.",
		parameters,
		async execute(args, ctx): Promise<ToolResult> {
			const pathArg = (args as { path: string }).path;
			let path: string;
			try {
				path = resolveToolPath(options.cwd ?? ctx.cwd, pathArg, options.confine ?? true);
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}

			const info = await stat(path).catch(() => null);
			if (!info?.isFile()) {
				return { content: [{ type: "text", text: `File not found: ${pathArg}` }], isError: true };
			}

			const extension = extname(path).toLowerCase();
			if (IMAGE_EXTENSIONS.has(extension)) {
				if (info.size > MAX_IMAGE_BYTES) {
					return {
						content: [{ type: "text", text: `Image too large (${info.size} bytes, max ${MAX_IMAGE_BYTES})` }],
						isError: true,
					};
				}
				const data = await readFile(path);
				return {
					content: [{ type: "image", data: data.toString("base64"), mimeType: MIME_BY_EXTENSION[extension] }],
				};
			}

			const raw = await readFile(path, "utf8");
			const allLines = raw.split("\n");
			if (raw.endsWith("\n")) allLines.pop();

			const offset = Math.max(1, Math.floor((args as { offset?: number }).offset ?? 1));
			const limit = (args as { limit?: number }).limit ?? undefined;
			const slice = allLines.slice(offset - 1, limit !== undefined ? offset - 1 + limit : undefined);

			let text = slice
				.map((line) => (line.length > maxLineLength ? `${line.slice(0, maxLineLength)}… [line truncated]` : line))
				.join("\n");

			const truncated = truncateHead(text, options.maxLines, options.maxBytes);
			text = truncated.content;
			if (truncated.truncated) {
				text += `\n… [showing lines ${offset}-${offset + slice.length - 1} of ${allLines.length}; use offset/limit to read more]`;
			}

			return { content: [{ type: "text", text }] };
		},
	};
}
