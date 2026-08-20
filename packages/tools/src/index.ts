/**
 * @puck-agent/tools — built-in tools, each deletable via its subpath export.
 */

import type { Tool } from "@puck-agent/core";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { createBashTool, runShellCommand, type BashExecutionResult, type BashToolOptions } from "./bash.js";
export { createReadTool, type ReadToolOptions } from "./read.js";
export { createWriteTool, type WriteToolOptions } from "./write.js";
export { createEditTool, type EditOperation, type EditToolOptions } from "./edit.js";
export { truncateHead, truncateTail } from "./truncate.js";

export interface CodingToolsOptions {
	cwd?: string;
	confine?: boolean;
	/** Pick a subset, e.g. ["read", "edit"] for a read-mostly agent. */
	only?: Array<"bash" | "read" | "write" | "edit">;
}

/** The standard coding toolset: bash + read + write + edit (or a subset). */
export function createCodingTools(options: CodingToolsOptions = {}): Tool[] {
	const only = options.only ?? ["bash", "read", "write", "edit"];
	const tools: Tool[] = [];
	if (only.includes("bash")) tools.push(createBashTool({ cwd: options.cwd }));
	if (only.includes("read")) tools.push(createReadTool({ cwd: options.cwd, confine: options.confine }));
	if (only.includes("write")) tools.push(createWriteTool({ cwd: options.cwd, confine: options.confine }));
	if (only.includes("edit")) tools.push(createEditTool({ cwd: options.cwd, confine: options.confine }));
	return tools;
}
