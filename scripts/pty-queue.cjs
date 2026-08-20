/** PTY: queue while streaming — typed text stays visible; Enter queues; drained when the run settles. */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const DIR = path.join(os.tmpdir(), 'puck-queue-' + Date.now());
fs.mkdirSync(path.join(DIR, '.puck', 'sessions'), { recursive: true });
const ROWS = 26, COLS = 100;

const term = pty.spawn(process.execPath, [CLI, '--mock'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: DIR,
	env: { ...process.env, PUCK_HOME: path.join(DIR, 'home') },
});
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 90_000);
let settle, phase = 0;

function step() {
	if (phase === 99) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes('puck · mock'))) {
		phase = 1;
		term.write('say hi\r');
		later(1600, step); // mid-run (mock run is ~4.8s)
		return;
	}
	if (phase === 1) {
		phase = 2;
		// stream is running; type a queued message
		term.write('queued follow up\r');
		later(600, step);
		return;
	}
	if (phase === 2 && t.some((l) => l.includes('已排队(1): queued follow up'))) {
		phase = 3;
		check('queue: queued row shown mid-run', true);
		// wait for run 1 to settle + queued run 2 to execute (mock step 2 text)
		later(6000, step);
		return;
	}
	if (phase === 2) { fail('queued row never appeared'); return; }
	if (phase === 3) {
		phase = 99;
		const stats = t.filter((l) => l.includes('tokens ·'));
		check('queue: two runs completed (auto-drained)', stats.length >= 2);
		check('queue: second run executed the queued text', t.some((l) => l.includes('queued follow up')));
		check('queue: prompt back after drain', t.some((l) => l.includes('you ›')));
		if (checks.some(([, ok]) => !ok)) {
			console.log('--- screen ---');
			t.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80)));
		}
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(900, step);
}
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
term.onData((d) => vt.feed(d));
setTimeout(step, 1500);
