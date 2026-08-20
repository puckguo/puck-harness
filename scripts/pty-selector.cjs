/**
 * Real-PTY test for the arrow-key /login flow:
 *   provider list → ↓×11 + Enter (MiniMax CN) → paste key → model list →
 *   ↓×7 + Enter (MiniMax-M3) → REPL → chat → exit.
 * Verifies selectFromList TTY mode end to end.
 */
const pty = require("node-pty");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { VT } = require("./vt.cjs");

// load .env if present (one level up, e.g. puck/.env)
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
	for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
	}
}

const CLI = path.resolve(__dirname, "../packages/cli/dist/index.js");
const HOME = path.join(os.tmpdir(), "puck-sel-" + Date.now());
const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) {
	console.error("pty-selector: MINIMAX_API_KEY is not set. Add it to puck/.env (see .env.example) or export it before running.");
	process.exit(2);
}
const ROWS = 32, COLS = 100;

const term = pty.spawn(process.execPath, [CLI], {
	name: "xterm-color", cols: COLS, rows: ROWS, cwd: os.tmpdir(),
	env: { ...process.env, PUCK_HOME: HOME, MINIMAX_API_KEY: "", MINIMAX_CN_API_KEY: "" },
});
const vt = new VT(ROWS, COLS);
let raw = "", phase = 0, done = false;
const checks = [];
function check(n, ok) { checks.push([n, ok]); if (!ok) fail(n); }
function fail(msg) {
	if (done) return; done = true;
	console.log("=== FAIL ===", msg);
	for (const l of vt.text()) console.log("|" + l.trimEnd());
	console.log("--- raw ---\n" + JSON.stringify(raw.slice(-1200)));
	term.kill(); process.exit(1);
}
const wd = setTimeout(() => fail("stall phase " + phase), 120_000);
let settle;
const later = () => { clearTimeout(settle); settle = setTimeout(step, 400); };

function step() {
	if (done) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes("接入 API")) && t.some((l) => l.includes("→"))) {
		phase = 1;
		check("selector: provider list with → cursor", true);
		check("selector: cursor starts at first item", t.some(l => l.trim().startsWith("→ Alibaba DashScope")));
		term.write("\x1b[B".repeat(11)); // ↓ to MiniMax CN (#12)
		later();
		return;
	}
	if (phase === 1 && t.some((l) => l.includes("→ MiniMax CN"))) {
		phase = 4;
		term.write("\r"); // submit directly
		later();
		return;
	}
	if (false) {
		phase = 2;
		check("selector: ↓ moves cursor to #12", true);
		// wrap-around: ↑ from #12 → #11 then ↑ back
		term.write("\x1b[A"); later();
		return;
	}
	if (phase === 2 && t.some((l) => l.trim().startsWith("→ MiniMax") && !l.includes("CN"))) {
		phase = 3;
		check("selector: ↑ moves back", true);
		term.write("\x1b[B"); // back to MiniMax CN
		later();
		return;
	}
	if (phase === 3 && t.some(l => l.includes("→ MiniMax CN"))) {
		phase = 4;
		term.write("\r");
		later();
		return;
	}
	if (phase === 4 && raw.includes("paste the key")) {
		phase = 5;
		check("selector: Enter submits provider", true);
		term.write(KEY + "\r");
		later();
		return;
	}
	if (phase === 5 && t.some(l => l.includes("可用模型")) && t.some(l => l.includes("→ MiniMax-M2"))) {
		phase = 6;
		check("model selector: cursor at first model", true);
		term.write("\x1b[B".repeat(7)); // ↓×7 → M3 (Enter split into its own write)
		later();
		return;
	}
	if (phase === 6 && t.some(l => l.trim().startsWith("→ MiniMax-M3"))) {
		phase = 7;
		term.write("\r"); // separate Enter — submits the model
		later();
		return;
	}
	if (phase === 7 && t[t.length - 1].includes("MiniMax-M3") && t.some(l => l.includes("you ›"))) {
		phase = 8;
		check("model selector: ↓×7 + Enter picks MiniMax-M3 (bar row)", true);
		term.write("exit\r");
		setTimeout(finish, 1200);
		return;
	}
	later();
}

function finish() {
	if (done) return;
	done = true;
	clearTimeout(wd);
	console.log("=== PASS ===");
	for (const [n] of checks) console.log("  ✓", n);
	term.kill(); process.exit(0);
}

term.onData((d) => { raw += d; vt.feed(d); step(); });
setTimeout(step, 1000);
