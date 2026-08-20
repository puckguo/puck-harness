/**
 * PTY regression for the audit fixes:
 *  A) mid-REPL /login: selector must NOT auto-complete from the submitting
 *     Enter (the P0 instant-select bug); arrows navigate; q cancels cleanly.
 *  B) input history is loaded → ↑/↓ must NOT leak history echo over the list.
 *  C) 29 providers on a 24-row terminal: windowed list, ↓ scrolls the window.
 *  D) one-shot `puck --mock "hi"` on a TTY exits promptly (no hang).
 */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

// load .env if present (one level up, e.g. puck/.env)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
	for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
	}
}

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) {
	console.error("pty-fixregress: MINIMAX_API_KEY is not set. Add it to puck/.env (see .env.example) or export it before running.");
	process.exit(2);
}
const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + name); };
const failAll = (msg) => { console.log('=== FAIL ===', msg); for (const [n] of results) console.log('  ✗(aborted) ' + n); process.exit(1); };

function home(name) {
	const h = path.join(os.tmpdir(), 'puck-fix-' + name + '-' + Date.now());
	fs.mkdirSync(h, { recursive: true });
	return h;
}
function spawnPty(args, h, rows = 24) {
	return pty.spawn(process.execPath, [CLI].concat(args), {
		cols: 100, rows, cwd: os.tmpdir(),
		env: Object.assign({}, process.env, { PUCK_HOME: h, MINIMAX_API_KEY: '', MINIMAX_CN_API_KEY: '' }),
	});
}

// --- A+B+C: REPL with a stored key → /login mid-session (history loaded) ----
const H = home('repl');
fs.writeFileSync(path.join(H, 'auth.json'), JSON.stringify({ 'minimax-cn': KEY }));
fs.writeFileSync(path.join(H, 'history'), JSON.stringify(['/status', 'hello world from history']));

const term = spawnPty([], H, 24);
const vt = new VT(24, 100);
let raw = '';
let phase = 0;
const wd = setTimeout(() => failAll('stall at phase ' + phase), 60_000);
let settle;
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };

function step() {
	const t = vt.text();
	if (phase === 0 && t.some(l => l.includes('puck ·'))) { phase = 1; term.write('/login\r'); later(600, step); return; }
	if (phase === 1) {
		// A) selector is up and has NOT auto-completed (no key prompt yet)
		const markers = t.map((l, i) => l.includes('→') ? i : -1).filter(i => i >= 0);
		check('A: selector stays open (no auto-submit)', t.some((l) => l.includes('Alibaba DashScope')) && !t.some((l) => l.includes('paste the key')));
		check('A: cursor marker visible', markers.length === 1);
		// C) windowed: 29 items on 24 rows → ≤ screenRows-4 rows + ↓更多 hint
		check('C: windowed (marker row fits upper screen)', markers[0] >= 0 && markers[0] <= 19);
		check('C: more-below hint', t.some(l => l.includes('↓更多')));
		if (!t.some(l => l.includes('→'))) { console.log('--- screen ---'); t.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 70))); };
		// C) ↓ scrolls the window
		// 25 downs: cursor crosses maxVisible (20) even if ConPTY drops rapid repeats,
		// so the window MUST scroll past the first providers
		term.write('\x1b[B'.repeat(25));
		phase = 2;
		later(1200, step);
		return;
	}
	if (phase === 2) {
		const t2 = vt.text();
		check('C: window scrolled (first row is not first provider)', !t2.some((l, i) => l.trim().startsWith('Anthropic') && i < 3));
		if (t2.some((l, i) => l.trim().startsWith('Anthropic') && i < 3)) { console.log('--- phase2 screen ---'); t2.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 60))); }
		// B) no history echo leaked over the list
		check('B: no history echo on screen', !t2.some(l => l.includes('hello world from history')));
		// B) no stray prompt echo line inside the list
		check('B: no prompt-echo rows in list area', !t2.slice(0, 20).some(l => l.includes('you ›')));
		term.write('\x1b[A'); // ↑ once
		phase = 3;
		later(400, step);
		return;
	}
	if (phase === 3) {
		term.write('q');
		phase = 4;
		later(600, step);
		return;
	}
	if (phase === 4) {
		const t3 = vt.text();
		check('A: q cancels back to the REPL', t3.some(l => l.includes('you ›')));
		// after cancel: type a chat line — readline key handling restored?
		term.write('1+1=?\r');
		phase = 5;
		later(2500, step);
		return;
	}
	if (phase === 5) {
		const t4 = vt.text();
		check('A: readline restored after selector (chat works)', t4.some((l) => l.includes('mock') || l.includes('puck ›') || l.includes('—')));
		clearTimeout(wd);
		term.kill();
		partD();
		return;
	}
	later(400, step);
}
term.onData((d) => { raw += d; vt.feed(d); });
setTimeout(step, 1200);

// --- D: one-shot exits -------------------------------------------------------
function partD() {
	const t0 = Date.now();
	const one = spawnPty(['--mock', 'say hi'], home('oneshot'), 24);
	let done = false;
	one.onExit(() => {
		if (done) return; done = true;
		check('D: one-shot exits within 10s on a TTY', Date.now() - t0 < 10000);
		const failed = results.filter(([, ok]) => !ok);
		console.log(failed.length === 0 ? '=== PASS ===' : '=== FAIL ===');
		process.exit(failed.length === 0 ? 0 : 1);
	});
	setTimeout(() => {
		if (!done) { done = true; check('D: one-shot exits within 6s on a TTY', false); console.log('=== FAIL ==='); one.kill(); process.exit(1); }
	}, 10000);
}
