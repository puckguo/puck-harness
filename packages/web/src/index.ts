/**
 * @puck-agent/web — the puck web client.
 *
 *   server:   createWebServer({ port, mock })        → HTTP + SSE
 *   cli:      puck-web [--port 8787] [--mock]
 *   ui:       served from public/ (zero-build vanilla JS)
 *
 * The browser never talks to an LLM directly: every run goes through
 * createPuck() in this Node process, so tools (bash/read/write/edit) execute
 * with the permissions of the server process. Bind to 127.0.0.1 by default.
 */

export { createWebServer, type WebServerOptions } from "./server.js";
export { serveStatic } from "./static.js";
export { encodeSse, type RunRequestBody, type WebEvent, type WebSnapshot } from "./protocol.js";
