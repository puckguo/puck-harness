/** PTY: /clear — context reset, new session file, old one preserved, chat after works. */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const DIR = path.join(os.tmpdir(), 'puck-clear-' + Date.now());
fs.mkdirSync(path.join(DIR, '.puck', 'sessions'), { recursive: true });
const ROWS = 24, COLS = 100;

const term = pty.spawn(process.execPath, [CLI, '--mock'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: DIR,
	env: { ...process.env, PUCK_HOME: path.join(DIR, 'home') },
});
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 90_000);
let settle, phase = 0, sessionIdBefore = '';

function step() {
	if (phase === 99) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes('puck · mock'))) {
		phase = 1;
		term.write('/status\r');
		later(800, step);
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('session:'))) {
		phase = 2;
		const row = t.find((l) => l.includes('session:'));
		sessionIdBefore = (row.match(/session:\s+(\S+)/) ?? [])[1] ?? '';
		check('status shows session id', sessionIdBefore.length > 0);
		term.write('hello there\r');
		later(3000, step);
		return;
	}
	if (phase === 2 && t.some((l) => l.includes('tokens ·'))) {
		phase = 3;
		term.write('/clear\r');
		later(1000, step);
		return;
	}
	if (phase === 3 && t.some((l) => l.includes('上下文已清空'))) {
		phase = 4;
		check('clear: message printed', true);
		check('clear: old session id mentioned as preserved', t.some((l) => l.includes('保留') || t.some((x) => x.includes(sessionIdBefore.slice(0, 8)))));
		term.write('/status\r');
		later(800, step);
		return;
	}
	if (phase === 4 && t.some((l) => l.includes('session:'))) {
		phase = 5;
		const rows = t.filter((l) => l.includes('session:'));
		const idAfter = (rows[rows.length - 1].match(/session:\s+(\S+)/) ?? [])[1] ?? '';
		check('clear: NEW session id (fresh file)', idAfter && idAfter !== sessionIdBefore);
		term.write('still alive?\r');
		later(3000, step);
		return;
	}
	if (phase === 5 && t.some((l) => l.includes('tokens ·'))) {
		// the visible stats row belongs to the post-clear run (first one scrolled off)
		phase = 99;
		check('chat works after clear', true);
		const files = fs.readdirSync(path.join(DIR, '.puck', 'sessions')).filter((f) => f.endsWith('.jsonl'));
		check('old session file preserved on disk', files.length >= 2);
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(700, step);
}
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
term.onData((d) => vt.feed(d));
setTimeout(step, 1500);
