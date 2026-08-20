/**
 * Click-through check: header model label click → modal opens with catalog.
 * Uses classList with real semantics (add/remove/contains).
 */
import { createWebServer } from "@puckguo123/web";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class ClassList {
	constructor(node) {
		this.node = node;
		this.set = new Set();
	}
	add(...cs) {
		for (const c of cs) this.set.add(c);
	}
	remove(...cs) {
		for (const c of cs) this.set.delete(c);
	}
	toggle(c) {
		this.set.has(c) ? this.set.delete(c) : this.set.add(c);
	}
	contains(c) {
		return this.set.has(c);
	}
	toString() {
		return [...this.set].join(" ");
	}
}
class Node_ {
	constructor(tag) {
		this.tagName = tag;
		this.children = [];
		this.childNodes = this.children;
		this.textContent = "";
		this._class = new ClassList(this);
		this.style = {};
		this.listeners = {};
	}
	get className() {
		return this._class.toString();
	}
	set className(v) {
		this._class = new ClassList(this);
		for (const c of String(v).split(/\s+/).filter(Boolean)) this._class.add(c);
	}
	get classList() {
		return this._class;
	}
	get firstChild() {
		return this.children[0] ?? null;
	}
	appendChild(n) {
		this.children.push(n);
		n.parentNode = this;
		return n;
	}
	append(...ns) {
		for (const n of ns) this.appendChild(n);
	}
	remove() {}
	replaceChildren(...ns) {
		this.children = [];
		for (const n of ns) this.appendChild(n);
	}
	addEventListener(t, f) {
		(this.listeners[t] ??= []).push(f);
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 800, height: 40 };
	}
	click() {
		for (const f of this.listeners.click ?? []) f({ target: this });
	}
	focus() {}
}
const ids = {};
for (const id of ["stream", "input", "send", "abort", "modal", "modal-card", "model", "model2", "cwd", "tok", "ctx", "summary", "trail", "new", "resume"]) ids[id] = new Node_("div");
ids.input.value = "";
const doc = {
	title: "",
	body: new Node_("body"),
	createElement: (t) => new Node_(t),
	createTextNode: (t) => Object.assign(new Node_("#text"), { text: t }),
	getElementById: (id) => ids[id] ?? null,
	addEventListener: () => {},
	querySelector: () => null,
};

const dir = mkdtempSync(join(tmpdir(), "puck-click-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const port = server.server.address().port;
const fetchAbs = (u, i) => fetch(`http://127.0.0.1:${port}${u}`, i);

const code = readFileSync("packages/web/public/app.js", "utf8");
const fn = new Function(
	"document", "window", "localStorage", "location", "fetch", "prompt", "alert",
	`${code}\nreturn { showModels, openModal, closeModal };`,
);
const app = fn(doc, { innerHeight: 900, document: doc }, { getItem: () => null, setItem: () => {} }, { pathname: "/" }, fetchAbs, () => null, () => null);

// --- THE user flow: click the header model label ---------------------------
console.log("modal open before click:", ids.modal.classList.contains("open"));
ids.model.click(); // wired at app.js line: $("model").onclick = () => void showModels()
try {
	await app.showModels();
} catch (error) {
	console.log("showModels THREW:", error.stack ?? error.message ?? error);
}
console.log("modal open after click:", ids.modal.classList.contains("open"));
const card = ids["modal-card"];
function allText(node, out = []) {
	if (node.text !== undefined) out.push(node.text);
	if (node.textContent) out.push(node.textContent);
	for (const c of node.children ?? []) allText(c, out);
	return out;
}
const texts = allText(card);
console.log("card children:", card.children.length, "| h3 title:", card.children[0]?.textContent);
console.log("provider groups:", card.children[1]?.children.filter((c) => c.className.includes("group")).length);
console.log("sample rows:", texts.filter((t) => String(t).includes("/")).slice(0, 5));

await server.stop();
rmSync(dir, { recursive: true, force: true });
const ok = ids.modal.classList.contains("open") && (card.children[1]?.children.filter((c) => c.className.includes("group")).length ?? 0) >= 20;
console.log(ok ? "\nCLICK-THROUGH OK" : "\nCLICK-THROUGH BROKEN");
process.exit(ok ? 0 : 1);
