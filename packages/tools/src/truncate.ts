/**
 * Output truncation shared by bash/read. Simplified from pi's truncate:
 * two independent limits — max lines and max bytes — whichever hits first.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncateResult {
	content: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
}

/** Keep the head of the content (file reads). Never cuts a line in half. */
export function truncateHead(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncateResult {
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	const totalBytes = Buffer.byteLength(content, "utf8");

	if (lines.length <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, totalLines: lines.length, totalBytes };
	}

	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
		if (kept.length >= maxLines || bytes + lineBytes > maxBytes) break;
		kept.push(line);
		bytes += lineBytes;
	}
	return { content: kept.join("\n"), truncated: true, totalLines: lines.length, totalBytes };
}

/** Keep the tail of the content (command output: errors live at the end). */
export function truncateTail(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncateResult {
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	const totalBytes = Buffer.byteLength(content, "utf8");

	if (lines.length <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, totalLines: lines.length, totalBytes };
	}

	const kept: string[] = [];
	let bytes = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
		if (kept.length >= maxLines || bytes + lineBytes > maxBytes) {
			// Even the last line alone overflows: hard-cut it from the end.
			if (kept.length === 0) kept.unshift(line.slice(-maxBytes));
			break;
		}
		kept.unshift(line);
		bytes += lineBytes;
	}
	return {
		content: kept.join("\n"),
		truncated: true,
		totalLines: lines.length,
		totalBytes,
	};
}
