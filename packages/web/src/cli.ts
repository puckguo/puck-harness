#!/usr/bin/env node
/**
 * puck-web — start the puck web client server.
 *
 *   puck-web [--port 8787] [--host 127.0.0.1] [--mock] [--no-ui]
 *           [--model provider/model] [--cwd <dir>] [--sessions <dir>]
 */

import { createWebServer } from "./server.js";

function arg(name: string): string | undefined {
	const argv = process.argv;
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === name) return argv[i + 1];
		if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
	}
	return undefined;
}

function flag(name: string): boolean {
	return process.argv.includes(name);
}

const port = Number(arg("--port") ?? 8787);
const host = arg("--host") ?? "127.0.0.1";
const server = createWebServer({
	port,
	host,
	mock: flag("--mock"),
	ui: !flag("--no-ui"),
	model: arg("--model"),
	cwd: arg("--cwd"),
	sessionsDir: arg("--sessions"),
});

await server.start();
