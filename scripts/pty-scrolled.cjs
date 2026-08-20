/**
 * PTY regression: terminal scrolled FULL when puck starts (the user's layout
 * bug — cursor below the scroll region). The chrome must clamp the cursor
 * inside the region (via startup CPR) or the prompt lands on the bar row and
 * AI output never scrolls.
 */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const wrapper = path.join(os.tmpdir(), 'puck-scrolled-wrapper.cjs');
fs.writeFileSync(wrapper, `for (let i = 0; i < 30; i++) console.log('filler line ' + i);\nrequire(${JSON.stringify(CLI)});`);
// pin the model — the ambient default may have been changed by other tests
fs.writeFileSync(wrapper, `process.argv.push('--model', 'glm-5.3');\nfor (let i = 0; i < 30; i++) console.log('filler line ' + i);\nrequire(${JSON.stringify(CLI)});`);

const ROWS = 24, COLS = 100;
const term = pty.spawn(process.execPath, [wrapper], { name: 'xterm-color', cols: COLS, rows: ROWS, cwd: os.tmpdir(), env: { ...process.env } });
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall'), 60_000);
let settle;
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
let phase = 0;

function step() {
	if (phase === 99) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes('puck ·'))) {
		phase = 1;
		const bannerRow = t.findIndex((l) => l.includes('puck ·'));
		const promptRow = t.findIndex((l) => l.includes('you ›'));
		check('banner inside region (above bar/trail rows)', bannerRow >= 0 && bannerRow <= ROWS - 3);
		check('prompt row is NOT the bar row', promptRow >= 0 && promptRow <= ROWS - 3);
		check('bar intact at last row', t[ROWS - 1].includes('glm-5.3'));
		term.write('hi\r');
		later(2000, step);
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('tokens ·'))) {
		phase = 2;
		check('AI reply visible above the bar', t.slice(0, ROWS - 2).some((l) => l.length > 5));
		term.write('     '); // spaces — must not eat the bar
		later(800, step);
		return;
	}
	if (phase === 2) {
		phase = 99;
		check('spaces did not overwrite the bar', vt.text()[ROWS - 1].trim().endsWith('glm-5.3'));
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(600, step);
}
term.onData((d) => vt.feed(d));
setTimeout(step, 3000);
