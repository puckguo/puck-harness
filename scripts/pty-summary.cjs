/** PTY: last-turn summary — title carries a few words, bottom bar a one-liner; /clear resets both. */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const DIR = path.join(os.tmpdir(), 'puck-summary-' + Date.now());
fs.mkdirSync(path.join(DIR, '.puck', 'sessions'), { recursive: true });
const ROWS = 24, COLS = 100;

const term = pty.spawn(process.execPath, [CLI, '--mock'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: DIR,
	env: { ...process.env, PUCK_HOME: path.join(DIR, 'home') },
});
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); console.log('--- last titles:', raw.match(/\x1b\]0;[^\x07]*\x07/g)?.slice(-4)); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 90_000);
let settle, phase = 0, raw = '';

const lastTitle = () => {
	const titles = raw.match(/\x1b\]0;([^\x07]*)\x07/g) ?? [];
	return titles.length ? titles[titles.length - 1].slice(4, -1) : '';
};

function step() {
	if (phase === 99) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes('puck · mock'))) {
		phase = 1;
		term.write('say hi\r');
		later(4000, step);
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('tokens ·'))) {
		phase = 2;
		check('title: idle after run = "puck · say hi"', lastTitle() === 'puck · say hi');
		const bar = vt.line(ROWS - 1);
		check('summary row (say hi → 改动 puck-demo.txt), above trail', vt.line(ROWS - 3).includes('say hi → 改动 puck-demo.txt'));
		check('bar: model still survives', bar.includes('mock'));
		term.write('/clear\r');
		later(1200, step);
		return;
	}
	if (phase === 2 && t.some((l) => l.includes('上下文已清空'))) {
		phase = 99;
		check('clear: title back to plain puck', lastTitle() === 'puck');
		check('clear: summary row cleared', !vt.line(ROWS - 3).includes('say hi'));
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(700, step);
}
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
term.onData((d) => { raw += d; vt.feed(d); });
setTimeout(step, 1500);
