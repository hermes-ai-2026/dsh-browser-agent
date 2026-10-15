/**
 * 上传文件到 GitHub 网页版：进上传页 → DOM.setFileInputFiles 注入 → 报告。
 * 用重试应对概率性重置；一旦页面就绪立刻干活。
 *
 * 用法：node do-upload.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { CdpSession, pickTarget } from './lib/cdp.js';

const REPO = 'dsh-browser-agent';
const OWNER = 'hermes-ai-2026';
const ROOT = process.cwd();
const URL_UPLOAD = `https://github.com/${OWNER}/${REPO}/upload/main`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`);
const say = (s) => console.log(`  ${s}`);

function collect(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) collect(f, base, out);
    else if (!/\.(png|log|tmp)$/i.test(e.name) && !/\.mjs$/.test(e.name)) out.push(path.resolve(f));
  }
  return out;
}

const t = await pickTarget(9222);
if (!t) { console.log('无 webview target'); process.exit(1); }
const s = new CdpSession(t.wsUrl);
await s.connect();
await s.send('Page.enable', {}).catch(() => {});
const ev = async (c, aw = false) => {
  const r = await s.send('Runtime.evaluate', { expression: c, returnByValue: true, awaitPromise: aw }, 30_000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

step('确保在上传页（github.com 是概率性重置，会重试）');
let okPage = false;
for (let i = 1; i <= 40; i++) {
  const cur = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`).catch(() => null);
  if (cur && !cur.url.startsWith('chrome-error') && /\/upload\//.test(cur.url) && cur.len > 40) { okPage = true; ok(`已在上传页（第 ${i} 次检查）`); break; }
  await s.send('Page.navigate', { url: i === 1 ? URL_UPLOAD : `${URL_UPLOAD}?_r=${i}` }, 20_000).catch(() => {});
  await sleep(3200);
  const st = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`).catch(() => null);
  if (st && !st.url.startsWith('chrome-error') && /\/upload\//.test(st.url) && st.len > 40) { okPage = true; ok(`第 ${i} 次尝试加载成功`); break; }
  process.stdout.write(`\r  ⏳ ${i}/40 …   `);
}
console.log('');
if (!okPage) { bad('上传页打不开'); s.close(); process.exit(1); }
say(JSON.stringify(await ev(`({url: location.href, title: document.title})`)));

step('找 <input type=file> 并注入文件');
const files = collect(ROOT);
say(`准备上传 ${files.length} 个文件：`);
for (const f of files.slice(0, 6)) say('  · ' + path.relative(ROOT, f));
say('  · …');

await s.send('DOM.enable', {});
const doc = await s.send('DOM.getDocument', { depth: -1, pierce: true }, 25_000);
let inp = await s.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, 20_000);
if (!inp?.nodeId) {
  // 有些上传页的 input 是隐藏的，用 querySelectorAll 兜底
  const all = await s.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, 20_000);
  if (all?.nodeIds?.length) inp = { nodeId: all.nodeIds[0] };
}
if (!inp?.nodeId) { bad('页面上没有 file input'); s.close(); process.exit(1); }
ok(`file input nodeId=${inp.nodeId}`);

await s.send('DOM.setFileInputFiles', { files, nodeId: inp.nodeId }, 60_000);
ok(`${files.length} 个文件已注入，等待页面列出`);

for (let i = 1; i <= 8; i++) {
  await sleep(3000);
  const n = await ev(`document.querySelectorAll('[role="row"], li, .file, [data-testid*="file"]').length`).catch(() => 0);
  const txt = await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 200)`).catch(() => '');
  process.stdout.write(`\r  第 ${i}/8 次检查：元素 ${n} 个   `);
  if (/commit changes|uploading|files?$/i.test(txt) || n > files.length) { console.log(''); break; }
}
console.log('');
step('页面当前内容');
say(await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 500)`));

s.close();
process.exit(0);
