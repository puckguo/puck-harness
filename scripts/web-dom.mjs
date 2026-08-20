/**
 * Run app.js in a stubbed DOM against the real server + real SSE frames.
 * Reproduces the browser exactly — reveals rendering bugs without a browser.
 */
import { createWebServer } from "@puckguo123/web";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- minimal DOM shim --------------------------------------------------------
class Node_ {
	constructor(tag) {
		this.tagName = tag;
		this.children = [];
		this.childNodes = this.children;
		this.textContent = "";
		this.className = "";
		this.style = {};
		this.attrs = {};
		this.parentNode = null;
		this.listeners = {};
	}
	get firstChild() {
		return this.children[0] ?? null;
	}
	get lastChild() {
		return this.children[this.children.length - 1] ?? null;
	}
	get childNodesLength() {
		return this.children.length;
	}
	appendChild(n) {
		this.children.push(n);
		n.parentNode = this;
		return n;
	}
	append(...ns) {
		for (const n of ns) this.appendChild(n);
	}
	remove() {
		if (!this.parentNode) return;
		const i = this.parentNode.children.indexOf(this);
		if (i >= 0) this.parentNode.children.splice(i, 1);
	}
	replaceChildren(...ns) {
		this.children = [];
		for (const n of ns) this.appendChild(n);
	}
	addEventListener(type, fn) {
		(this.listeners[type] ??= []).push(fn);
	}
	setAttribute(k, v) {
		this.attrs[k] = v;
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 800, height: 40 };
	}
	click() {
		for (const fn of this.listeners.click ?? []) fn({ target: this });
	}
	focus() {}
}
const doc = {
	title: "",
	documentElement: new Node_("html"),
	body: new Node_("body"),
	createElement: (t) => new Node_(t),
	createTextNode: (t) => Object.assign(new Node_("#text"), { text: t }),
	getElementById: (id) => ids[id] ?? null,
	addEventListener: () => {},
	querySelector: () => null,
};
const ids = {};
for (const id of ["stream", "input", "send", "abort", "modal", "modal-card", "model", "model2", "cwd", "tok", "ctx", "summary", "trail", "new", "resume"]) {
	ids[id] = new Node_("div");
}
ids.input.value = "";
ids.input.scrollHeight = 40;
ids.stream.scrollHeight = 1000;
ids.stream.scrollTop = 0;
ids.stream.clientHeight = 900;
ids.send.disabled = false;

const g = {
	document: doc,
	window: { innerHeight: 900, innerWidth: 1200 },
	localStorage: { getItem: () => null, setItem: () => {} },
	location: { pathname: "/" },
	alert: () => {},
};
g.window.document = doc;

// expose app.js's send()/handleEvent via a hook: we append them to globalThis
const code = readFileSync("packages/web/public/app.js", "utf8");
const harness = `
${code}
globalThis.__app = { send, handleEvent, setRunning, sessionId: () => sessionId, bar: () => bar, state: () => ({ sessionId }) };
`;

// fetch must hit the real server (absolute URL — the shim has no base)
const realFetch = globalThis.fetch;
const fetchAbs = (url, init) => realFetch(`http://127.0.0.1:${port}${url}`, init);

const fn = new Function("document", "window", "localStorage", "location", "fetch", "setInterval", "clearInterval", "setTimeout", "prompt", `${harness}
return globalThis.__app;`);

// fetch must hit the real server
const dir = mkdtempSync(join(tmpdir(), "puck-dom-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const port = server.server.address().port;

// timers: run callbacks synchronously-ish (no real waiting needed)
const timers = new Map();
let timerId = 0;
const setInterval_ = (fn2, ms) => {
	const id = ++timerId;
	timers.set(id, { fn: fn2, ms });
	return id;
};
const clearInterval_ = (id) => {
	timers.delete(id);
};
const setTimeout_ = (fn2) => {
	fn2();
	return 0;
};

const app = fn(doc, g.window, g.localStorage, g.location, fetchAbs, setInterval_, clearInterval_, setTimeout_, () => null);

// simulate typing "hi" and pressing Enter (send)
ids.input.value = "hi";
await app.send();

// give pending microtasks a beat
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));

// --- inspect the rendered stream --------------------------------------------
function dump(node, depth = 0, out = []) {
	const cls = node.className ? `.${node.className}` : "";
	let own = "";
	if (node.tagName === "#text") own = JSON.stringify(node.text);
	else if (node.children.length === 0 && node.textContent) own = JSON.stringify(node.textContent.slice(0, 80));
	out.push("  ".repeat(depth) + `<${node.tagName}${cls}> ${own}`);
	for (const c of node.children) dump(c, depth + 1, out);
	return out;
}
const lines = [];
for (const child of ids.stream.children) lines.push(...dump(child));
console.log("=== rendered stream ===");
console.log(lines.join("\n"));

// assertions: user echo once + assistant text visible
const flat = lines.join("\n");
const userCount = (flat.match(/you/g) ?? []).length;
const hasThink = flat.includes("The user wants a demo");
const hasText1 = flat.includes("先看看当前目录");
const hasText2 = flat.includes("mock 模型跑完了命令");
const hasToolBash = flat.includes("bash");
const hasOk = flat.includes("✅");
console.log("\n=== checks ===");
console.log("user 'hi' echoes:", userCount, "(want 1)");
console.log("thinking visible:", hasThink);
console.log("assistant text #1 visible:", hasText1);
console.log("assistant text #2 visible:", hasText2);
console.log("bash tool line:", hasToolBash, "| ✅ marks:", hasOk);
console.log("sessionId captured:", Boolean(app.sessionId()));

await server.stop();
rmSync(dir, { recursive: true, force: true });
const failed = userCount !== 1 || !hasText1 || !hasText2;
console.log(failed ? "\nRENDER BUG REPRODUCED" : "\nRENDER OK");
process.exit(failed ? 1 : 0);
