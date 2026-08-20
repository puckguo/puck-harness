/**
 * Path resolution for file tools: relative to a working directory,
 * optionally confined inside it (the default) so the model cannot
 * escape the project tree.
 */

import { isAbsolute, join, resolve, sep } from "node:path";

export function resolveToolPath(cwd: string, path: string, confine: boolean): string {
	const absolute = isAbsolute(path) ? path : join(cwd, path);
	if (!confine) return resolve(absolute);

	const normalized = resolve(absolute);
	const base = resolve(cwd);
	if (normalized !== base && !normalized.startsWith(base + sep)) {
		throw new Error(`Path escapes the working directory (${base}): ${path}`);
	}
	return normalized;
}
