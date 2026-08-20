/**
 * PTY: /compact against a pre-seeded BIG session (offline: --mock summarizes).
 * Exercises the real path — replaceMessages, recordCompaction, bar update,
 * and a follow-up chat turn after the swap.
 */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const ROWS = 24, COLS = 100;
const DIR = path.join(os.tmpdir(), 'puck-compact-' + Date.now());
fs.mkdirSync(path.join(DIR, '.puck', 'sessions'), { recursive: true });

// seed: header + 12 user/assistant pairs of ~400 tokens each (~9.6k total)
const lines = [JSON.stringify({ type: 'header', id: 'big', createdAt: Date.now(), model: 'mock' })];
for (let i = 0; i < 12; i++) {
	const filler = ('context filler number ' + i + ' ').repeat(30);
	lines.push(JSON.stringify({ type: 'message', seq: lines.length, message: { role: 'user', content: 'question ' + i + ' ' + filler, timestamp: Date.now() } }));
	lines.push(JSON.stringify({ type: 'message', seq: lines.length, message: { role: 'assistant', content: [{ type: 'text', text: 'answer ' + i + ' ' + filler }], model: 'mock', stopReason: 'stop', usage: { input: 100, output: 100, totalTokens: 200 }, timestamp: Date.now() } }));
}
fs.writeFileSync(path.join(DIR, '.puck', 'sessions', 'big.jsonl'), lines.join('\n') + '\n');

const term = pty.spawn(process.execPath, [CLI, '--mock', '--session', 'big'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: DIR,
	env: { ...process.env, PUCK_HOME: path.join(DIR, 'home') },
});
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 90_000);
let settle;
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
let phase = 0, ctxBefore = 0;

function ctxPct() {
	const bar = vt.text()[ROWS - 1];
	const m = bar.match(/(\d+(?:\.\d+)?)%/);
	return m ? Number(m[1]) : -1;
}

function step() {
	if (phase === 99) return;
	const t = vt.text();
	if (phase === 0 && t.some((l) => l.includes('puck · mock'))) {
		phase = 1;
		ctxBefore = ctxPct();
		check('seeded context shows in bar (>0%)', ctxBefore > 0);
		term.write('/compact\r');
		later(2000, step);
		return;
	}
	if (phase === 1 && t.some((l) => l.includes('已压缩'))) {
		phase = 2;
		const after = ctxPct();
		check('compact: 已压缩 message', true);
		check('compact: bar ctx% dropped (' + ctxBefore.toFixed(1) + '→' + after.toFixed(1) + ')', after >= 0 && after < ctxBefore);
		check('compact: summary preview printed', t.some((l) => l.includes('摘要:')));
		// chat after the swap must still work (tail integrity)
		term.write('after compact, still alive?\r');
		later(3000, step);
		return;
	}
	if (phase === 2 && t.filter((l) => l.includes('tokens ·')).length >= 1 && t.some((l) => l.includes('mock model ran the command') || l.includes('puck works'))) {
		phase = 99;
		check('chat works after compaction', true);
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(600, step);
}
term.onData((d) => vt.feed(d));
setTimeout(step, 1500);
