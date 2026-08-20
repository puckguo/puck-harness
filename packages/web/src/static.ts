/**
 * Static file server with the exact semantics we need (zero deps):
 *
 *   - root-relative safe path resolution (no `..` escape)
 *   - a small extension→mime map
 *   - directory requests resolve to index.html (SPA-friendly)
 *
 * Not a general-purpose file server: it only ever serves one fixed root
 * (the package's `public/` directory), which is part of the published files.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".woff2": "font/woff2",
};

export interface StaticResult {
	status: number;
}

/**
 * Serve one request from `root`. Returns true when the request was handled
 * (caller must not continue routing).
 */
export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): boolean {
	if (!req.url) return false;
	const url = new URL(req.url, "http://local");
	// SPA-style: any extension-less path falls back to index.html
	let rel = decodeURIComponent(url.pathname);
	if (rel.endsWith("/")) rel += "index.html";
	const target = resolve(root, "." + normalize("/" + rel));
	if (target !== root && !target.startsWith(root + "/") && !target.startsWith(root + "\\")) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
		return true;
	}
	let file = target;
	if (!existsSync(file) || statSync(file).isDirectory()) {
		// fall back to the SPA entry for clean URLs
		const index = join(root, "index.html");
		if (!existsSync(index)) return false;
		file = index;
	}
	const mime = MIME[extname(file)] ?? "application/octet-stream";
	res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
	createReadStream(file).pipe(res);
	return true;
}
