/** PTY: /resume replays the hydrated transcript into the terminal (scrollback, trail, title, bar summary). */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const DIR = path.join(os.tmpdir(), 'puck-resume-replay-' + Date.now());
fs.mkdirSync(path.join(DIR, '.puck', 'sessions'), { recursive: true });
const ROWS = 26, COLS = 100;

function boot() {
	const term = pty.spawn(process.execPath, [CLI, '--mock'], {
		name: 'xterm-color', cols: COLS, rows: ROWS, cwd: DIR,
		env: { ...process.env, PUCK_HOME: path.join(DIR, 'home') },
	});
	const vt = new VT(ROWS, COLS);
	const state = { term, vt, raw: '' };
	term.onData((d) => { state.raw += d; vt.feed(d); });
	return state;
}

const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); (s2ref ?? s1).vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); console.log('titles:', s2.raw.match(/\x1b\]0;[^\x07]*\x07/g)?.slice(-3)); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 120_000);
let settle, phase = 0;
const later = (ms, fn) => { clearTimeout(settle); settle = setTimeout(fn, ms); };
const lastTitle = (s) => {
	const titles = s.raw.match(/\x1b\]0;([^\x07]*)\x07/g) ?? [];
	return titles.length ? titles[titles.length - 1].slice(4, -1) : '';
};

const s1 = boot();
let s2ref;
function step() {
	if (phase === 99) return;
	const t = (s2ref ?? s1).vt.text();
	if (phase === 0 && s1.vt.text().some((l) => l.includes('you ›'))) {
		phase = 1;
		s1.term.write('say hi\r');
		later(4500, step);
		return;
	}
	if (phase === 1 && s1.vt.text().some((l) => l.includes('tokens ·'))) {
		phase = 2;
		s1.term.write('exit\r');
		later(1200, () => {
			phase = 3;
			s2ref = boot();
			later(1200, step);
		});
		return;
	}
	if (phase === 3 && t.some((l) => l.includes('you ›'))) {
		phase = 4;
		s2ref.term.write('/resume\r');
		later(900, step);
		return;
	}
	if (phase === 4 && t.some((l) => l.includes('↑/↓ 选择'))) {
		phase = 5;
		s2ref.term.write('\r'); // first item = the previous session
		later(2500, step);
		return;
	}
	if (phase === 5 && t.some((l) => l.includes('历史回放'))) {
		phase = 99;
		const screen = t.join('\n');
		check('replay: user echo restored', screen.includes('you › say hi'));
		check('replay: thinking restored (gray)', /\x1b\[90m/.test(s2ref.raw.slice(s2ref.raw.indexOf('历史回放'))));
		check('replay: tool lines restored (write/bash)', /write .*puck-demo\.txt/.test(screen) && screen.includes('bash $ echo'));
		check('replay: answer text restored', screen.includes('The mock model ran the command'));
		check('replay: tool result fold (│)', /│/.test(screen));
		check('trail: rehydrated from history', t.some((l) => l.includes('puck-demo.txt') && l.includes('✎')));
		check('title: last-turn summary restored', lastTitle(s2ref) === 'puck · say hi');
		check('summary row restored above trail', t.slice(ROWS - 5).some((l) => l.includes('say hi') && l.includes('→')));
		clearTimeout(wd);
		s2ref.term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	later(800, step);
}
setTimeout(step, 1500);
