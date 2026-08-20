/**
 * Real-model PTY check: after one real turn the bar shows ↑/↓ token stats;
 * /model switch updates the bar's model name.
 */
const pty = require("node-pty");
const path = require("path");
const { VT } = require("./vt.cjs");

const CLI = path.resolve(__dirname, "../packages/cli/dist/index.js");
const ROWS = 30, COLS = 100;
const term = pty.spawn(process.execPath, [CLI], {
	name: "xterm-color", cols: COLS, rows: ROWS, cwd: os_tmp(), env: { ...process.env },
});

function os_tmp() { return require("os").tmpdir(); }

const vt = new VT(ROWS, COLS);
let raw = "", phase = 0, done = false;
const checks = [];
function check(n, ok) { checks.push([n, ok]); if (!ok) fail("check: " + n); }
function fail(msg) {
	if (done) return;
	done = true;
	console.log("=== FAIL ===", msg);
	for (const l of vt.text().slice(-8)) console.log("|" + l.trimEnd());
	term.kill(); process.exit(1);
}
const wd = setTimeout(() => fail("stall phase " + phase + " | " + JSON.stringify(raw.slice(-200))), 120_000);
let settle;
const later = () => { clearTimeout(settle); settle = setTimeout(step, 400); };

function barRow() { return vt.line(ROWS - 1); }
function findRow(s) {
	const t = vt.text();
	for (let r = t.length - 1; r >= 0; r--) if (t[r].includes(s)) return r;
	return -1;
}

function step() {
	if (done) return;
	if (phase === 0 && findRow("you ›") >= 0) {
		phase = 1;
		check("bar: model before chat", /MiniMax-M3|mock/.test(barRow()) || barRow().includes("MiniMax"));
		term.write("1+1=?只回答数字\r");
		later();
		return;
	}
	if (phase === 1 && findRow("— ") >= 0 && /首字|tokens/.test(vt.text().find((l) => l.includes("— ")) || "")) {
		phase = 2;
		const bar = barRow();
		check("bar: ↑/↓ after real turn", bar.includes("↑") && bar.includes("↓"));
		check("bar: ctx% shown", /\d+(\.\d+)?%\/\d+k/.test(bar));
		term.write("/model minimax-cn/MiniMax-M2\r");
		later();
		return;
	}
	if (phase === 2 && findRow("Switched to") >= 0) {
		phase = 3;
		check("bar: model updated on /model", barRow().includes("MiniMax-M2"));
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
	for (const [n, ok] of checks) console.log("  ✓", n);
	console.log("final bar:", JSON.stringify(barRow()));
	term.kill(); process.exit(0);
}

term.onData((d) => { raw += d; vt.feed(d); step(); });
setTimeout(step, 1000);
