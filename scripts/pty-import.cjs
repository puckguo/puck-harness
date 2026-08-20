const pty = require('node-pty');
const fs = require('fs');
const cwd = __dirname + '/import-e2e';
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd + '/.puck/sessions', { recursive: true });
fs.mkdirSync(cwd + '/.puckhome', { recursive: true });
// a local session so the resume picker is non-empty
const t = Date.now();
fs.writeFileSync(cwd + '/.puck/sessions/local-1.jsonl',
	JSON.stringify({ type: 'header', id: 'local-1', createdAt: t, model: 'mock' }) + '\n' +
	JSON.stringify({ type: 'message', seq: 1, message: { role: 'user', content: '本地会话', timestamp: t } }) + '\n' +
	JSON.stringify({ type: 'message', seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'mock', stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: t } }) + '\n');
const term = pty.spawn(process.execPath, ['C:/guo/SoftwareDevelopment/research/puck-agent/puck/packages/cli/dist/index.js', '--mock'], {
	cols: 110, rows: 32, cwd, env: Object.assign({}, process.env, { PUCK_HOME: cwd + '/.puckhome' }),
});
const vt = new (require('C:/guo/SoftwareDevelopment/research/puck-agent/puck/scripts/vt.cjs').VT)(32, 110);
let out = '', phase = 0, done = false;
const checks = [];
function check(n, ok) { checks.push([n, ok]); if (!ok) fail(n); }
function fail(msg) {
	if (done) return; done = true;
	console.log('FAIL:', msg);
	for (const l of vt.text().slice(-16)) console.log('|' + l.trimEnd());
	term.kill(); process.exit(1);
}
const wd = setTimeout(() => fail('stall phase ' + phase), 60000);
let settle;
const later = () => { clearTimeout(settle); settle = setTimeout(step, 350); };
function step() {
	if (done) return;
	const t = vt.text();
	if (phase === 0 && t.some(l => l.includes('you ›'))) { phase = 1; term.write('/resume\r'); later(); return; }
	if (phase === 1 && t.some(l => l.includes('历史会话'))) { phase = 2; term.write('i\r'); later(); return; }
	if (phase === 2 && t.some(l => l.includes('轮 ·')) && t.filter(l => l.includes('轮 ·')).length >= 15) {
		phase = 3;
		check('scan: three sources listed', /pi/.test(out) && /claude/.test(out) && /codex/.test(out));
		check('scan: source title+turns shown', t.some(l => l.includes('轮 ·')));
		term.write('1\r'); later(); return;
	}
	if (phase === 3 && t.some(l => l.includes('已恢复会话'))) {
		phase = 4;
		check('import: resumed confirmation', t.some(l => l.includes('已恢复会话')));
		term.write('exit\r');
		setTimeout(() => {
			done = true; clearTimeout(wd);
			console.log('=== PASS ===');
			for (const [n] of checks) console.log('  ✓', n);
			term.kill(); process.exit(0);
		}, 1000);
	}
	later();
}
term.onData(d => { out += d; vt.feed(d); step(); });
setTimeout(step, 1000);
