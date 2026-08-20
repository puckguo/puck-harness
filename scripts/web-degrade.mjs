/** Graceful degradation: OLD server (no /api/catalog, 404) must still show a usable picker. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const stub = createServer((req, res) => {
	if (req.url === "/api/providers") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify([{ id: "deepseek", name: "DeepSeek", state: "none" }]));
		return;
	}
	if (req.url === "/api/models") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("[]");
		return;
	}
	if (req.url === "/api/catalog") {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" })); // OLD server
		return;
	}
	res.writeHead(404);
	res.end("{}");
});
await new Promise((r) => stub.listen(r));
const port = stub.address().port;

const code = readFileSync("packages/web/public/app.js", "utf8");
class N {
	constructor(t) {
		this.tagName = t;
		this.children = [];
		this.textContent = "";
		this.className = "";
		this.style = {};
		this.listeners = {};
	}
	focus() {}
	appendChild(n) {
		this.children.push(n);
		return n;
	}
	append(...ns) {
		for (const n of ns) this.appendChild(n);
	}
	addEventListener(t, f) {
		(this.listeners[t] ??= []).push(f);
	}
	replaceChildren(...ns) {
		this.children = [];
		for (const n of ns) this.appendChild(n);
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 800, height: 40 };
	}
	get classList() {
		const s = new Set((this.className || "").split(/\s+/).filter(Boolean));
		return {
			add: (...c) => c.forEach((x) => s.add(x)),
			remove: (...c) => c.forEach((x) => s.delete(x)),
			contains: (c) => s.has(c),
		};
	}
}
const ids = {};
for (const id of ["stream", "input", "send", "abort", "modal", "modal-card", "model", "model2", "cwd", "tok", "ctx", "summary", "trail", "new", "resume"]) ids[id] = new N("div");
const doc = {
	title: "",
	body: new N("body"),
	createElement: (t) => new N(t),
	createTextNode: (t) => Object.assign(new N("#t"), { text: t }),
	getElementById: (id) => ids[id] ?? null,
	addEventListener: () => {},
	querySelector: () => null,
};
const fn = new Function("document", "window", "localStorage", "location", "fetch", `${code}\nreturn { showModels };`);
const app = fn(doc, { document: doc }, { getItem: () => null, setItem: () => {} }, { pathname: "/" }, (u, i) => fetch(`http://127.0.0.1:${port}${u}`, i));
await app.showModels();
const card = ids["modal-card"];
function allText(n, o = []) {
	if (n.text !== undefined) o.push(n.text);
	if (n.textContent) o.push(n.textContent);
	for (const c of n.children ?? []) allText(c, o);
	return o;
}
const texts = allText(card);
console.log("[old server] modal has content:", card.children.length > 0);
console.log("[old server] warn note shown:", texts.some((t) => String(t).includes("HTTP 404")));
console.log("[old server] provider still listed:", texts.some((t) => String(t).includes("DeepSeek")));
console.log("[old server] client-side fallback model:", texts.some((t) => String(t).includes("deepseek/deepseek-chat")));
function findAll(node, tag, out = []) {
	if (node.tagName === tag) out.push(node);
	for (const c of node.children ?? []) findAll(c, tag, out);
	return out;
}
console.log("[old server] manual entry present:", findAll(card, "input").length > 0 && findAll(card, "button").length > 0);
stub.close();
const ok =
	card.children.length > 0 &&
	texts.some((t) => String(t).includes("deepseek/deepseek-chat")) &&
	findAll(card, "input").length > 0;
console.log(ok ? "\nDEGRADE OK" : "\nDEGRADE BROKEN");
process.exit(ok ? 0 : 1);
