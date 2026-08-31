/**
 * Real-PTY smoke test for the @-file mention popup (mock model, no API key):
 *
 *   1. type "@alp"          → popup opens, alpha.ts highlighted (→ marker)
 *   2. ↓ ×2                 → selection moves (marker leaves row 1)
 *   3. Tab                  → "@alpha.ts " (or the selected path) lands in the line
 *   4. ctrl+u, "@zzz"       → "无匹配文件" state
 *   5. Esc                  → popup closes, line kept
 *   6. "@src/be" + Enter    → accepts beta.md → submit → mock run starts with
 *                             the attached-file echo (📎 已附加 @引用文件)
 *
 * Asserts on the VT-rendered screen (ConPTY re-encodes bytes; only the
 * rendered grid is meaningful — same rationale as pty-selector.cjs).
 */
const pty = require("node-pty");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { VT } = require("./vt.cjs");

const CLI = path.resolve(__dirname, "../packages/cli/dist/index.js");
const HOME = path.join(os.tmpdir(), "puck-mention-" + Date.now());
const CWD = path.join(os.tmpdir(), "puck-mention-proj-" + Date.now());
fs.mkdirSync(path.join(CWD, "src"), { recursive: true });
fs.writeFileSync(path.join(CWD, "alpha.ts"), "export const alpha = 1;\n");
fs.writeFileSync(path.join(CWD, "src", "beta.md"), "# beta\n");
fs.writeFileSync(path.join(CWD, "src", "gamma.ts"), "export const gamma = 3;\n");

const ROWS = 30, COLS = 100;
const term = pty.spawn(process.execPath, [CLI, "--mock"], {
	name: "xterm-color", cols: COLS, rows: ROWS, cwd: CWD,
	env: { ...process.env, PUCK_HOME: HOME },
});
const vt = new VT(ROWS, COLS);
let raw = "";
let phase = 0;
let done = false;
const checks = [];
function check(n, ok) {
	checks.push([n, ok]);
	console.log((ok ? "  ✓ " : "  ✗ ") + n);
	if (!ok) fail(n);
}
function fail(msg) {
	if (done) return;
	done = true;
	console.log("=== FAIL ===", msg, "(phase " + phase + ")");
	for (const l of vt.text()) console.log("|" + l.trimEnd());
	console.log("--- raw tail ---\n" + JSON.stringify(raw.slice(-1500)));
	term.kill();
	process.exit(1);
}
const wd = setTimeout(() => fail("stall at phase " + phase), 60_000);
let settle;
let escDeadline = 0;
const later = (ms = 350) => {
	clearTimeout(settle);
	settle = setTimeout(step, ms);
};

function step() {
	if (done) return;
	const t = vt.text();
	const has = (s) => t.some((l) => l.includes(s));

	if (phase === 0 && has("you ›")) {
		phase = 1;
		check("REPL prompt ready (mock)", true);
		term.write("@a"); // matches alpha.ts AND src/gamma.ts
		later();
		return;
	}
	if (phase === 1) {
		phase = 2;
		check("popup lists alpha.ts", has("alpha.ts"));
		check("selected row has → marker", t.some((l) => l.trim().startsWith("→") && l.includes("alpha.ts")));
		check("hint row present", has("Tab/Enter"));
		term.write("\x1b[B"); // ↓ to the next match
		later();
		return;
	}
	if (phase === 2) {
		phase = 3;
		check("↓ moved the marker off alpha.ts", !t.some((l) => l.trim().startsWith("→") && l.includes("alpha.ts")));
		term.write("\x1b[A"); // ↑ back
		later();
		return;
	}
	if (phase === 3) {
		phase = 4;
		check("↑ moved the marker back onto alpha.ts", t.some((l) => l.trim().startsWith("→") && l.includes("alpha.ts")));
		term.write("\t"); // Tab → accept
		later();
		return;
	}
	if (phase === 4) {
		phase = 5;
		check("Tab inserted @alpha.ts into the line", t.some((l) => l.includes("you ›") && l.includes("@alpha.ts")));
		check("popup closed after accept", !has("Tab/Enter"));
		term.write("\x15"); // ctrl+u clear line
		later(200);
		term.write("@zzz");
		later();
		return;
	}
	if (phase === 5) {
		phase = 6;
		check("no-match state shows", has("无匹配文件"));
		term.write("\x1b"); // Esc → close popup, keep text
		escDeadline = Date.now() + 2500; // lone ESC waits out node's 500ms keypress escape timeout
		later(1000);
		return;
	}
	if (phase === 6) {
		// poll: incoming-data later(120) keeps re-firing step() before node's
		// keypress parser dispatches the lone ESC — wait until it's really closed
		if (Date.now() < escDeadline && has("无匹配文件")) {
			later(400);
			return;
		}
		phase = 7;
		check("Esc closed the popup (@zzz kept in line)", !has("无匹配文件") && t.some((l) => l.includes("@zzz")));
		term.write("\x15"); // ctrl+u
		later(200);
		term.write("@src/be"); // query matching src/beta.md
		later();
		return;
	}
	if (phase === 7) {
		phase = 8;
		check("nested path match lists beta.md", has("beta.md"));
		term.write("\r"); // Enter → accept selection
		later();
		return;
	}
	if (phase === 8) {
		phase = 9;
		check("Enter accepted @src/beta.md into the line", t.some((l) => l.includes("@src/beta.md")));
		term.write("\r"); // Enter → submit (popup closed → normal submit)
		later(1500);
		return;
	}
	if (phase === 9) {
		phase = 10;
		check("mention attachment echo (📎)", has("已附加"));
		check("mock run started (puck ›)", has("puck ›"));
		term.write("exit\r");
		later();
		return;
	}
	if (phase === 10) {
		phase = 11;
		check("clean exit", true);
		clearTimeout(wd);
		clearTimeout(settle);
		const failed = checks.filter(([, ok]) => !ok);
		console.log(failed.length === 0 ? "ALL PASS (" + checks.length + " checks)" : "FAILURES: " + failed.length);
		term.kill();
		process.exit(failed.length === 0 ? 0 : 1);
	}
}

term.onData((d) => {
	raw += d;
	try {
		vt.feed(d);
	} catch {
		/* unknown sequence — ignore */
	}
	later(120);
});
process.on("exit", () => {
	try {
		fs.rmSync(HOME, { recursive: true, force: true });
		fs.rmSync(CWD, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});
