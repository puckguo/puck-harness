/** PTY: /think and /compact in the mock REPL (offline, summarize via mock stream). */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const ROWS = 24, COLS = 100;
const HOME = path.join(os.tmpdir(), 'puck-think-' + Date.now());

const term = pty.spawn(process.execPath, [CLI, '--mock'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: os.tmpdir(),
	env: { ...process.env, PUCK_HOME: HOME },
});
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 90_000);
let settle;
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
let phase = 0;

function step() {
	if (phase === 99) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes('puck · mock'))) {
		phase = 1;
		term.write('first turn here\r');
		later(2500, step);
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('tokens ·'))) {
		phase = 2;
		term.write('second turn\rand third turn\r'); // two lines queued
		later(3000, step);
		return;
	}
	if (phase === 2 && t.filter((l) => l.includes('tokens ·')).length >= 2) {
		phase = 3;
		// compact prompt fires when the context is big enough; the mock's tool
		// results pad it. If "无需压缩" appears we still check /think.
		term.write('/compact\r');
		later(1500, step);
		return;
	}
	if (phase === 3) {
		const compacted = t.some((l) => l.includes('已压缩') || l.includes('无需压缩'));
		check('compact: responded (已压缩 or 无需压缩)', compacted);
		phase = 4;
		term.write('/think high\r');
		later(700, step);
		return;
	}
	if (phase === 4 && t.some((l) => l.includes('thinking 等级已设为 high'))) {
		phase = 5;
		check('think: level set message', true);
		term.write('/status\r');
		later(700, step);
		return;
	}
	if (phase === 5 && t.some((l) => l.includes('thinking:'))) {
		phase = 99;
		check('status: shows thinking level', t.some((l) => l.includes('thinking: high')));
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(600, step);
}
term.onData((d) => vt.feed(d));
setTimeout(step, 1500);
