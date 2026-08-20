const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const cwd = __dirname + '/resume-e2e';
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd + '/.puck/sessions', { recursive: true });
// two prior sessions
const mk = (id, first) => {
  const t = Date.now() - 3600e3;
  fs.writeFileSync(path.join(cwd, '.puck/sessions', id + '.jsonl'),
    JSON.stringify({ type: 'header', id, createdAt: t, model: 'mock' }) + '\n' +
    JSON.stringify({ type: 'message', seq: 1, message: { role: 'user', content: first, timestamp: t } }) + '\n' +
    JSON.stringify({ type: 'message', seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'mock', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, timestamp: t + 1 } }) + '\n' +
    JSON.stringify({ type: 'compaction', seq: 3, at: t + 2, prefixMessages: 2 }) + '\n');
};
mk('sess-alpha', '帮我优化数据库查询');
mk('sess-beta', '写一个解析器');
const term = pty.spawn(process.execPath, ['C:/guo/SoftwareDevelopment/research/puck-agent/puck/packages/cli/dist/index.js', '--mock'], {
  cols: 100, rows: 30, cwd, env: Object.assign({}, process.env, { PUCK_HOME: cwd + '/.puckhome' }),
});
fs.mkdirSync(cwd + '/.puckhome', { recursive: true });
let out = '';
const vt = new (require('C:/guo/SoftwareDevelopment/research/puck-agent/puck/scripts/vt.cjs').VT)(30, 100);
term.onData(d => { out += d; vt.feed(d); step(); });
let phase = 0, done = false;
const checks = [];
function check(n, ok) { checks.push([n, ok]); if (!ok) { dump(n); } }
function dump(failed) {
  if (done) return; done = true;
  console.log('FAIL:', failed);
  for (const l of vt.text().slice(-14)) console.log('|' + l.trimEnd());
  term.kill(); process.exit(1);
}
const wd = setTimeout(() => dump('stall phase ' + phase), 40000);
function step() {
  if (done) return;
  const t = vt.text();
  if (phase === 0 && t.some(l => l.includes('you ›'))) { phase = 1; term.write('/resume\r'); return; }
  if (phase === 1 && t.some(l => l.includes('历史会话'))) {
    phase = 2;
    check('list: shows titles', t.some(l => l.includes('帮我优化数据库查询')) && t.some(l => l.includes('写一个解析器')));
    check('list: shows turns', t.some(l => l.includes('1 轮')));
    check('list: shows compact ×1', t.some(l => l.includes('compact ×1')));
    check('list: relative time', t.some(l => l.includes('小时前')));
    term.write('2\r');
    return;
  }
  if (phase === 2 && t.some(l => l.includes('已恢复会话'))) {
    phase = 3;
    check('resume: confirmation with title+turns', t.some((l) => l.includes('「写一个解析器」') && l.includes('1 轮')));
    term.write('exit\r');
    setTimeout(() => {
      done = true; clearTimeout(wd);
      console.log('=== PASS ===');
      for (const [n] of checks) console.log('  ✓', n);
      term.kill(); process.exit(0);
    }, 1200);
  }
}
setTimeout(step, 1000);
