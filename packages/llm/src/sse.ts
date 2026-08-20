/**
 * Server-sent events parsing for streaming HTTP responses.
 * Node's fetch response bodies are byte streams; this splits them into
 * `data:` payload strings, transparently handling multi-line payloads.
 */

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				buffer = buffer.slice(newlineIndex + 1);
				const payload = sseDataPayload(line);
				if (payload !== undefined) yield payload;
			}
		}
		const rest = buffer.trim();
		const payload = sseDataPayload(rest);
		if (payload !== undefined) yield payload;
	} finally {
		reader.releaseLock();
	}
}

/** Returns the `data:` payload of an SSE line, or undefined for other lines. */
function sseDataPayload(line: string): string | undefined {
	if (line.startsWith("data:")) {
		const payload = line.slice(5).replace(/^ /, "");
		return payload.length > 0 ? payload : undefined;
	}
	return undefined;
}
