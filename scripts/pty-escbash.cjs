/**
 * PTY repro: ESC pressed WHILE the bash tool runs a long command.
 *
 * Variant A (PUCK_MOCK_BASH unset → ping loop): plain long-running child.
 * Variant B: restart-server-like script (detached spawn, polls, exits).
 *
 * Sequence: chat line → wait for "⏳ bash" → ESC → watch for:
 *   - "⏹ 已停止（Esc）" marker (abort dispatch)
 *   - "✅ bash" + "[command aborted]" (tool settled)
 *   - prompt back / follow-up works
 */
const pty = require("node-pty");
const os = require("os");
const path = require("node:path");
const fs = require("fs");

const CLI = path.join(__dirname, "..", "packages", "cli", "dist", "index.js");
const HOME = path.join(os.tmpdir(), "puck-pty-escbash-" + Date.now());
const CWD = path.join(os.tmpdir(), "puck-pty-escbash-proj-" + Date.now());
fs.mkdirSync(CWD, { recursive: true });

// mirror the user's restart-server.cjs: detached spawn + poll + exit
fs.writeFileSync(path.join(CWD, "server.cjs"), `
const { spawn } = require('node:child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('server spawned, pid', child.pid);
  for (let i = 0; i < 40; i++) { await sleep(500); }
  process.exit(0);
})();
`);

const variant = process.argv[2] || "long";
const BASH =
	variant === "restart"
		? { command: `node server.cjs 2>&1`, timeout: 60 }
		: { command: `node -e "setInterval(()=>{},1000)" 2>&1`, timeout: 60 };

const term = pty.spawn(process.execPath, [CLI, "--mock"], {
	name: "xterm-color", cols: 100, rows: 30, cwd: CWD,
	env: { ...process.env, PUCK_HOME: HOME, PUCK_MOCK_BASH: JSON.stringify(BASH) },
});

let buf = "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
const find = (re) => re.test(strip(buf));

(async () => {
	term.onData((d) => { buf += d; });
	await wait(1200); // banner
	term.write("hello mock\r");
	// wait for the bash tool line to appear
	let started = false;
	for (let i = 0; i < 40 && !started; i++) {
		await wait(250);
		started = find(/bash \$/);
	}
	console.log("bash tool started:", started, "(t+~" + (1.2 + 0.25 * 40) + "s window)");
	await wait(1000); // mid-execution
	term.write("\x1b"); // ESC — exactly what the user pressed
	console.log("ESC sent");
	await wait(2500); // abort settle window

	const stopMarker = find(/已停止|已中止/);
	const toolSettled = find(/bash.*aborted|aborted/) && find(/✅ bash|❌ bash/);
	const promptBack = /you ›/.test(strip(buf).slice(-2000));
	console.log("stop marker shown:", stopMarker);
	console.log("tool settled (aborted):", toolSettled);
	console.log("prompt returned:", promptBack);

	// follow-up run must still work
	buf = "";
	term.write("second question\r");
	await wait(3000);
	const secondRan = /mock model ran|puck works|second/i.test(strip(buf));
	console.log("follow-up run works:", secondRan);

	term.write("exit\r");
	await wait(400);
	term.kill();
	fs.rmSync(HOME, { recursive: true, force: true });
	fs.rmSync(CWD, { recursive: true, force: true });
	const ok = stopMarker && toolSettled && promptBack;
	console.log(ok ? "\nPTY ESC-during-bash (" + variant + "): PASS" : "\nPTY ESC-during-bash (" + variant + "): FAIL");
	process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e); term.kill(); process.exit(1); });
