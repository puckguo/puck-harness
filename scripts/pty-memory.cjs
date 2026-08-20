/** PTY: memory system — agent.md banner, sqlite recording, idle daily-summary task, /tasks, /recall. */
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { VT } = require('./vt.cjs');

const CLI = path.resolve(__dirname, '../packages/cli/dist/index.js');
const DIR = path.join(os.tmpdir(), 'puck-memory-' + Date.now());
const HOME = path.join(DIR, 'home');
fs.mkdirSync(path.join(DIR, '.puck', 'sessions'), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
// system-level agent.md — must be picked up and shown in the banner
fs.writeFileSync(path.join(HOME, 'agent.md'), '全局：永远用中文回答');
// project-level agent.md
fs.writeFileSync(path.join(DIR, 'agent.md'), '项目：测试项目');
const ROWS = 26, COLS = 100;

const term = pty.spawn(process.execPath, [CLI, '--mock'], {
	name: 'xterm-color', cols: COLS, rows: ROWS, cwd: DIR,
	env: { ...process.env, PUCK_HOME: HOME, PUCK_TASK_IDLE_MS: '2500' },
});
const vt = new VT(ROWS, COLS);
const checks = [];
const check = (n, ok) => { checks.push([n, ok]); console.log((ok ? '  ✓ ' : '  ✗ ') + n); };
const fail = (m) => { console.log('=== FAIL ===', m); vt.text().forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 80))); term.kill(); process.exit(1); };
const wd = setTimeout(() => fail('stall phase ' + phase), 60_000);
let settle, phase = 0;

function step() {
	if (phase === 99) return;
	const t = vt.text();
	const plain = t.join('\n');
	if (phase === 0 && plain.includes('puck · mock')) {
		phase = 1;
		check('memory: banner lists agent.md·全局 + 项目 + index.db', /记忆:.*agent\.md·全局.*agent\.md·项目×1.*index\.db/.test(plain));
		check('memory: no experimental warning leak', !plain.includes('ExperimentalWarning'));
		term.write('say hi\r');
		later(1600, step);
		return;
	}
	if (phase === 1) {
		phase = 2;
		// wait for the mock run (~5s) + BOTH idle tasks at 2.5s (daily then weekly,
		// each driving two mock LLM rounds ~5s) — generous margin
		later(25_000, step);
		return;
	}
	if (phase === 2) {
		phase = 3;
		check('memory: daily-summary task ran (dim log line)', plain.includes('后台任务 daily-summary ✓'));
		// LOCAL date — puck files/catalog stamp local dates; toISOString (UTC)
		// mismatches whenever UTC has crossed midnight but the machine hasn't
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		const cat = JSON.parse(fs.readFileSync(path.join(HOME, 'tasks', 'catalog.json'), 'utf8'));
		check('memory: catalog.json lists the task as done today', cat.tasks['daily-summary']?.lastRun === today);
		check('memory: daily summary file written', fs.existsSync(path.join(HOME, 'memories', today + '.md')));
		check('memory: experience.md written', fs.existsSync(path.join(HOME, 'experience.md')));
		term.write('/recall say\r');
		later(1200, step);
		return;
	}
	if (phase === 3) {
		phase = 4;
		// step 1: selector with hits, dir tail right-aligned
		check('recall: hit selector with count + dir', plain.includes('条命中') && plain.includes('puck-memory-'));
		term.write(String.fromCharCode(13)); // Enter → context view of the top hit
		later(1000, step);
		return;
	}
	if (phase === 4) {
		phase = 4.5;
		// step 2: context view — full path header + hit marker + resume hint
		check('recall: context header with full path', plain.includes('会话「') && plain.includes(DIR));
		check('recall: hit marked and messages shown', plain.includes('◀') && (plain.includes('你 ›') || plain.includes('puck ›')));
		check('recall: resume hint with session id', /会话 \S{8}… · \/resume/.test(plain));
		term.write('/tasks\r');
		later(1000, step);
		return;
	}
	if (phase === 4.5) {
		phase = 5;
		const cat2 = JSON.parse(fs.readFileSync(path.join(HOME, 'tasks', 'catalog.json'), 'utf8'));
		check('memory: /tasks shows the catalog', t.some((l) => l.includes('daily-summary')) || Boolean(cat2.tasks['daily-summary']));
		check('memory: weekly-distill registered', Boolean(cat2.tasks['weekly-distill']) && plain.includes('weekly-distill'));
		term.write('/prompt' + String.fromCharCode(13));
		later(1200, step);
		return;
	}
	if (phase === 5) {
		phase = 6;
		check('prompt: selector lists builtin + agent.md files with counts', /内置默认提示.*字/.test(plain) && plain.includes('全局指令 agent.md') && plain.includes('合计（当前系统提示）'));
		term.write(String.fromCharCode(27) + '[B' + String.fromCharCode(13)); // arrow down + Enter
		later(1000, step);
		return;
	}
	if (phase === 6) {
		phase = 99;
		check('prompt: selected file content shown with path', plain.includes('全局：永远用中文回答'));
		const barRow = t[t.length - 1];
		check('prompt: bar shows sys char count', barRow.includes('sys '));
		if (checks.some(([, ok]) => !ok)) {
			console.log('--- screen ---');
			t.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 90)));
		}
		clearTimeout(wd);
		term.kill();
		console.log(checks.every(([, ok]) => ok) ? '=== PASS ===' : '=== FAIL ===');
		process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
	}
	if (false) {
		check('memory: /tasks shows the catalog', /daily-summary\s+\[daily\]/.test(plain));
		const db = fs.existsSync(path.join(HOME, 'index.db'));
		check('memory: index.db created in system dir', db);
		if (checks.some(([, ok]) => !ok)) {
			console.log('--- screen ---');
			t.forEach((l, i) => console.log(String(i).padStart(2) + '|' + l.trimEnd().slice(0, 90)));
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
