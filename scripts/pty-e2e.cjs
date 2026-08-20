/**
 * Real-PTY end-to-end test: spawn the puck CLI in a true terminal, drive the
 * first-run wizard by keystrokes, and verify the full login → model pick →
 * chat flow never stalls.
 *
 * API key is read from the MINIMAX_API_KEY env var. Set it in a local .env
 * (see .env.example) or in your shell before running. The script aborts with
 * a helpful message if the key is missing — never hardcode a real key.
 */
const pty = require("node-pty");
const os = require("os");
const { join } = require("node:path");
const { readFileSync, existsSync } = require("node:fs");

// load .env if present (one level up, e.g. puck/.env)
const envFile = join(__dirname, "..", ".env");
if (existsSync(envFile)) {
	for (const line of readFileSync(envFile, "utf8").split("\n")) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
	}
}

const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) {
	console.error("pty-e2e: MINIMAX_API_KEY is not set. Add it to puck/.env (see .env.example) or export it before running.");
	process.exit(2);
}

const CLI = "C:/guo/SoftwareDevelopment/research/puck-agent/puck/packages/cli/dist/index.js";

const term = pty.spawn(process.execPath, [CLI], {
	name: "xterm-color",
	cols: 100,
	rows: 30,
	cwd: process.env.PTY_CWD || os.tmpdir(),
	// self-contained: fresh PUCK_HOME + no inherited provider keys, so the
	// first-run wizard (provider selector) always runs regardless of the shell
	env: { ...process.env, PUCK_HOME: join(os.tmpdir(), "puck-pty-e2e-" + Date.now()), MINIMAX_API_KEY: "", MINIMAX_CN_API_KEY: "" },
});

let output = "";
let phase = 0; // 0: waiting provider list, 1: waiting key prompt, 2: waiting model pick, 3: waiting REPL, 4: chat sent
const t0 = Date.now();
let chatSent = false;
let done = false;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");

function fail(msg) {
	if (done) return;
	done = true;
	console.log("\n=== FAIL ===");
	console.log("at:", msg);
	console.log("--- last 800 chars of terminal ---");
	console.log(stripAnsi(output).slice(-800));
	term.kill();
	process.exit(1);
}

const watchdog = setTimeout(() => fail(`stalled ${Date.now() - t0}ms at phase ${phase}`), 120_000);

function step() {
	const plain = stripAnsi(output);
	if (phase === 0 && plain.includes("选择 provider")) {
		phase = 1;
		term.write("\x1b[B".repeat(11) + "\r"); // ↓×11 → MiniMax CN → Enter
		return;
	}
	if (phase === 1 && plain.includes("paste the key")) {
		phase = 2;
		// key prompt visible = the old "swallowed prompt" hang is fixed
		term.write(KEY + "\r");
		return;
	}
	if (phase === 2 && plain.includes("可用模型")) {
		phase = 3;
		term.write("\x1b[B".repeat(7) + "\r"); // ↓×7 → MiniMax-M3 → Enter
		return;
	}
	if (phase === 3 && plain.includes("puck ·") && !chatSent) {
		chatSent = true;
		phase = 4;
		term.write("1+1=?只回答数字\r");
		return;
	}
	if (phase === 4 && /\b2\b/.test(plain.slice(plain.indexOf("puck ·")))) {
		phase = 5;
		done = true;
		clearTimeout(watchdog);
		console.log("=== PASS ===");
		console.log("full wizard → key → model → chat completed in", Date.now() - t0, "ms");
		const seg = plain.slice(plain.indexOf("paste the key"));
		console.log("--- key prompt onwards ---");
		console.log(seg.slice(0, 600));
		term.write("exit\r");
		setTimeout(() => { term.kill(); process.exit(0); }, 2000);
		return;
	}
}

term.onData((data) => {
	output += data;
	step();
});

setTimeout(step, 1000);
