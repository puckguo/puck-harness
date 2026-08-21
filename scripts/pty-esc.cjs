/**
 * PTY end-to-end: ESC stops a streaming mock run — in a REAL terminal.
 * Drives the actual CLI in --mock mode, sends a chat line, waits for the
 * spinner/stream to be live, then presses ESC, and asserts:
 *   1. the "⏹ 已停止" stop marker appears,
 *   2. the REPL prompt comes back (input usable after the stop),
 *   3. a follow-up message still runs (no stuck state).
 * No API key needed — mock stream only. Run: node scripts/pty-esc.cjs
 */
const pty = require("node-pty");
const os = require("os");
const { join } = require("node:path");

const CLI = join(__dirname, "..", "packages", "cli", "dist", "index.js");

const term = pty.spawn(process.execPath, [CLI, "--mock"], {
	name: "xterm-color",
	cols: 100,
	rows: 30,
	cwd: process.env.PTY_CWD || os.tmpdir(),
	env: { ...process.env, PUCK_HOME: join(os.tmpdir(), "puck-pty-esc-" + Date.now()) },
});

let buf = "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (re) => re.test(buf.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")); // strip ANSI

(async () => {
	term.onData((d) => {
		buf += d;
	});
	await wait(1500); // banner
	term.write("hello mock\r"); // start a run (mock has 700ms thinking delay)
	await wait(400); // mid-stream: spinner active
	term.write("\x1b"); // ESC
	await wait(1200); // abort settle + prompt repaint

	const stopped = find(/已停止|⏹/);
	const promptBack = /puck ›|you ›/.test(buf);
	console.log("stop marker shown:", stopped);
	console.log("prompt returned:", promptBack);

	// follow-up run must still work after the abort
	buf = "";
	term.write("second question\r");
	await wait(2500);
	const secondRan = /mock model ran the command|puck works/.test(buf.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ""));
	console.log("follow-up run works:", secondRan);

	term.write("exit\r");
	await wait(500);
	term.kill();
	const ok = stopped && promptBack && secondRan;
	console.log(ok ? "\nPTY ESC e2e: PASS" : "\nPTY ESC e2e: FAIL");
	process.exit(ok ? 0 : 1);
})().catch((e) => {
	console.error("ERR", e);
	term.kill();
	process.exit(1);
});
