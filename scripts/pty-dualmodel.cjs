/** Real-PTY dual-model test: GLM (zai-coding-cn) + MiniMax — user's actual auth/config. */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const ROWS = 24, COLS = 100;

const term = pty.spawn(process.execPath, [CLI, '--model', 'glm-5.3'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: os.tmpdir(),
	env: { ...process.env }, // real ~/.puck: auth (minimax-cn + zai-coding-cn), default glm-5.3
});
const vt = new VT(ROWS, COLS);
let raw = '', phase = 0;
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 150_000);
let settle;
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };

function step() {
	if (phase === 99) return;
	const t = vt.text();
	const lastRows = t.slice(-3).join(' ');
	if (phase === 0 && t.some((l) => l.includes('puck · glm-5.3'))) {
		phase = 1;
		check('boot: default model glm-5.3', true);
		check('bar: ctx window /1M for glm-5.3', t.some((l) => l.includes('/1M')));
		term.write('hi\r');
		later(500, step);
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('thinking'))) {
		later(400, step); // GLM thinks in gray; wait for the answer
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('tokens ·'))) {
		phase = 2;
		check('GLM chat: answered (stats line)', true);
		check('GLM thinking rendered gray, not in body', !t.some((l) => l.trim().startsWith('The user')));
		term.write('/model minimax-cn/MiniMax-M3\r');
		later(600, step);
		return;
	}
	if (phase === 2 && t.some((l) => l.includes('Switched to minimax-cn/MiniMax-M3'))) {
		phase = 3;
		check('switch: to MiniMax-M3', true);
		const bar = t[t.length - 1] + ' ' + t[t.length - 2];
		check('bar: MiniMax-M3 with /1M', /MiniMax-M3/.test(bar) && /\/1M/.test(bar));
		term.write('一句话自我介绍\r');
		later(500, step);
		return;
	}
	if (phase === 3 && t.some((l) => l.includes('tokens ·'))) {
		phase = 99;
		check('MiniMax chat: answered (stats line)', true);
		term.write('exit\r');
		setTimeout(() => {
			clearTimeout(wd);
			console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
			process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
		}, 1500);
		return;
	}
	later(500, step);
}
term.onData((d) => { raw += d; vt.feed(d); });
setTimeout(step, 1500);
