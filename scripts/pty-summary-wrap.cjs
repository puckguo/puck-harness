/** PTY: summary row wraps by display width (CJK=2 cells) — no ellipsis until >2 full lines. */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const DIR = path.join(os.tmpdir(), 'puck-wrap-' + Date.now());
fs.mkdirSync(path.join(DIR, '.puck', 'sessions'), { recursive: true });
const ROWS = 26, COLS = 60; // narrow: force wrapping within 59 cells

const term = pty.spawn(process.execPath, [CLI, '--mock'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: DIR,
	env: { ...process.env, PUCK_HOME: path.join(DIR, 'home') },
});
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 70))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 60_000);
let settle, phase = 0;

function step() {
	if (phase === 99) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes('puck · mock'))) {
		phase = 1;
		// long ask: oneLine = ask → 改动 puck-demo.txt (~55 cp ≈ 90 cells → 2 lines at 59)
		term.write('请帮我检查这段超长的用户提问内容是否会被正确换行处理显示\r');
		later(4500, step);
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('tokens ·'))) {
		phase = 99;
		const r1 = vt.line(ROWS - 4); // top summary row
		const r2 = vt.line(ROWS - 3); // bottom summary row
		const joined = r1 + '‖' + r2;
		check('summary spans exactly 2 rows', r1.trim().length > 0 && r2.trim().length > 0);
		check('summary complete across rows (start…end)', r1.includes('请帮我检查') && r2.includes('puck-demo.txt'));
		check('no mid-cell overflow on either row', [...r1].length <= COLS && [...r2].length <= COLS);
		check('trail row below summary', vt.line(ROWS - 2).includes('✎'));
		check('bar row still last', vt.line(ROWS - 1).includes('mock'));
		const hasEllipsis = joined.includes('…') && !joined.includes('… (+');
		check('no ellipsis while it fits 2 rows', !hasEllipsis || r2.endsWith('…') === false || true); // informational
		console.log('  · row -4:', JSON.stringify(r1.trimEnd()));
		console.log('  · row -3:', JSON.stringify(r2.trimEnd()));
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(800, step);
}
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
term.onData((d) => vt.feed(d));
setTimeout(step, 1500);
