import { CdpSession, pickTarget } from './lib/cdp.js';
const t = await pickTarget(9222);
if (!t) { console.log('无 webview target'); process.exit(1); }
const s = new CdpSession(t.wsUrl);
await s.connect();
await s.send('Page.enable', {}).catch(() => {});
const ev = async (c) => (await s.send('Runtime.evaluate', { expression: c, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('当前 URL:', await ev('location.href'));
console.log('file input 数:', await ev(`document.querySelectorAll('input[type=file]').length`));
console.log('正文首 300:', await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)`));

const CANDIDATES = [
  'https://github.com/hermes-ai-2026/dsh-browser-agent/upload/main',
  'https://github.com/hermes-ai-2026/dsh-browser-agent/upload',
  'https://github.com/hermes-ai-2026/dsh-browser-agent/new/main',
];
for (const u of CANDIDATES) {
  console.log(`\n=== 试 ${u} ===`);
  await s.send('Page.navigate', { url: u }, 25_000).catch(() => {});
  await sleep(5000);
  const st = await ev(`({
    url: location.href,
    nInput: document.querySelectorAll('input[type=file]').length,
    nEditor: document.querySelectorAll('.monaco-editor, textarea[aria-label], [role=textbox]').length,
    title: document.title,
    head: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,180)
  })`);
  console.log('  url    :', st.url);
  console.log('  file输入:', st.nInput, ' 编辑器:', st.nEditor);
  console.log('  首 180 :', st.head);
  if (st.nInput > 0) { console.log('\n  ✅ 这个页面有 file input —— 可以注入文件'); break; }
}
s.close();
process.exit(0);
