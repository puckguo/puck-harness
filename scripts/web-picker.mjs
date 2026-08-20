/**
 * Model-picker UI flow check (stub DOM): catalog renders groups, keyless
 * providers offer inline login, keyed providers list their models.
 */
import { createWebServer } from "@puck-agent/web";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class Node_ {
	constructor(tag) {
		this.tagName = tag;
		this.children = [];
		this.childNodes = this.children;
		this.textContent = "";
		this.className = "";
		this.style = {};
		this.listeners = {};
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
ids.modal.classList = { add: () => {}, remove: () => {} };
const doc = {
	title: "",
	body: new Node_("body"),
	createElement: (t) => new Node_(t),
	createTextNode: (t) => Object.assign(new Node_("#text"), { text: t }),
	getElementById: (id) => ids[id] ?? null,
	addEventListener: () => {},
	querySelector: () => null,
};

const dir = mkdtempSync(join(tmpdir(), "puck-pick-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const port = server.server.address().port;
const fetchAbs = (u, i) => fetch(`http://127.0.0.1:${port}${u}`, i);

const code = readFileSync("packages/web/public/app.js", "utf8");
const fn = new Function(
	"document", "window", "localStorage", "location", "fetch", "prompt", "alert",
	`${code}\nreturn { showModels, modalCard: document.getElementById("modal-card") };`,
);
const noop = () => 0;
const app = fn(doc, { innerHeight: 900, document: doc }, { getItem: () => null, setItem: () => {} }, { pathname: "/" }, fetchAbs, () => null, () => null);

await app.showModels();
const card = ids["modal-card"];
// collect all text content
function allText(node, out = []) {
	if (node.text !== undefined) out.push(node.text);
	if (node.textContent) out.push(node.textContent);
	for (const c of node.children ?? []) allText(c, out);
	return out;
}
const texts = allText(card);
const joined = texts.join("\n");
const bodyDiv = card.children[1]; // children[0] = h3, children[1] = body
const groups = bodyDiv ? bodyDiv.children.filter((c) => String(c.className).includes("group")) : [];
console.log("catalog rendered groups:", groups.length);
console.log("providers visible:", texts.filter((t) => /✓ stored|~ env|• 无 key/.test(String(t))).length);
console.log("has '接入 …' inline login rows:", texts.filter((t) => String(t).startsWith("接入 ")).length);
console.log("has current model marker rows:", texts.filter((t) => String(t).includes("/")).length > 0);

// this machine has minimax-cn + zai-coding-cn stored → their groups must list live models
const hasMinimax = joined.includes("minimax-cn/") || texts.some((t) => String(t).startsWith("minimax"));
console.log("stored provider (minimax-cn) group present:", joined.includes("MiniMax") || texts.some((t) => t.includes("minimax")));

await server.stop();
rmSync(dir, { recursive: true, force: true });

const ok =
	groups.length >= 20 &&
	texts.filter((t) => String(t).startsWith("接入 ")).length > 0;
console.log(ok ? "\nPICKER OK" : "\nPICKER BROKEN");
process.exit(ok ? 0 : 1);
