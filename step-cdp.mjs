/**
 * 全程走 **裸 CDP** 完成：建仓库 → 上传文件 → 提交。
 * 绕开渲染层桥接（guest 用久了会降级），CDP 一直稳定。
 *
 * 用法：node step-cdp.mjs create | upload | commit | shot
 */
import fs from 'node:fs';
import path from 'node:path';
import { CdpSession, pickTarget } from './lib/cdp.js';

const REPO = 'dsh-browser-agent';
const DESC = 'Give DeepSeek Harness agents a real browser: 19 browser_* tools driving the built-in sidebar browser. Zero runtime deps.';
const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`);

let _s = null;
async function session() {
  if (_s && _s.ws && _s.ws.readyState === 1) return _s;
  const t = await pickTarget(9222);
  if (!t) throw new Error('没有 webview target');
  _s = new CdpSession(t.wsUrl);
  await _s.connect();
  await _s.send('Page.enable', {}).catch(() => {});
  return _s;
}
async function ev(code, awaitPromise = false) {
  const s = await session();
  const r = await s.send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise }, 30_000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result?.value;
}
async function navigate(url) {
  const s = await session();
  await s.send('Page.navigate', { url }, 20_000);
  await sleep(4500);
  return ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`);
}
/** 用原生 setter 设值 + 派发事件（React 受控组件也能生效）。 */
const setValue = (sel, val) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'not-found:' + ${JSON.stringify(sel)};
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`;
/** 用真实鼠标事件点击（先滚动到可见）。 */
async function clickEl(sel) {
  const box = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName, text: (el.innerText||el.value||'').trim().slice(0,30) };
  })()`);
  if (!box) throw new Error('元素未找到: ' + sel);
  const s = await session();
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(180);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(70);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  return box;
}
async function openRetry(url, tries = 18) {
  for (let i = 1; i <= tries; i++) {
    const t = i === 1 ? url : `${url}${url.includes('?') ? '&' : '?'}_r=${i}`;
    try {
      const st = await navigate(t);
      if (st && st.len > 40 && !String(st.url).startsWith('chrome-error')) return st;
    } catch (e) { /* 连接被重置 */ }
    process.stdout.write(`\r  ⏳ ${i}/${tries} 被重置…   `);
    await sleep(500);
  }
  console.log('');
  return null;
}

const cmd = process.argv[2] ?? 'status';

if (cmd === 'create') {
  step('打开「新建仓库」页');
  const st = await openRetry('https://github.com/new');
  if (!st) { bad('重试耗尽'); process.exit(1); }
  ok(`${st.title}  ${st.url}`);

  step('填仓库名');
  const nv = await ev(setValue('input[name="repository[name]"], #repository_name', REPO));
  nv === REPO ? ok(`仓库名 = ${nv}`) : bad(`填入结果: ${nv}`);

  step('填描述');
  const dv = await ev(setValue('input[name="repository[description]"], #repository_description', DESC));
  ok(`描述长度 ${String(dv).length}`);

  step('勾选 Add a README（让仓库有初始提交，便于网页上传）');
  const cb = await ev(`(() => { const c = document.querySelector('#repository_auto_init'); if (!c) return 'no-checkbox'; if (!c.checked) c.click(); return c.checked; })()`);
  console.log('   README 勾选状态:', cb);

  step('点 Create repository');
  const clicked = await clickEl('button[type="submit"][name="commit"], form[action*="repos"] button[type="submit"], #new_repository button[type="submit"]');
  ok(`点击了 ${clicked.tag} "${clicked.text}"`);
  await sleep(9000);
  const after = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`);
  console.log('  结果:', JSON.stringify(after));
  if (/hermes-ai-2026\/dsh-browser-agent/.test(after.url)) ok('🎉 仓库创建成功');
  else bad('URL 未变化，检查页面');
}

if (cmd === 'upload') {
  const files = [];
  (function walk(d, base = d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, base);
      else if (!/\.(png|log|tmp)$/i.test(e.name) && !/^step.*\.mjs$/.test(e.name) && !/^(visual-upload|gh-web-upload|publish-github)\.mjs$/.test(e.name)) files.push(path.resolve(f));
    }
  })(ROOT);
  step(`上传 ${files.length} 个文件到 GitHub 网页版`);
  const st = await openRetry(`https://github.com/hermes-ai-2026/${REPO}/upload/main`, 18);
  if (!st) { bad('上传页打不开'); process.exit(1); }
  ok(`${st.title}  ${st.url}`);

  step('DOM.setFileInputFiles 注入文件');
  const s = await session();
  await s.send('DOM.enable', {});
  const doc = await s.send('DOM.getDocument', { depth: -1, pierce: true }, 20_000);
  const inp = await s.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, 15_000);
  if (!inp?.nodeId) { bad('没找到 file input'); process.exit(1); }
  ok(`找到 file input (nodeId=${inp.nodeId})`);
  await s.send('DOM.setFileInputFiles', { files, nodeId: inp.nodeId }, 40_000);
  ok('文件已注入');
  await sleep(12000);
  const n = await ev(`document.querySelectorAll('[class*="file"], li, tr').length`);
  console.log('  页面元素数:', n);
  const txt = await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,400)`);
  console.log('  页面反馈:', txt);
}

if (cmd === 'commit') {
  step('点 Commit changes');
  const clicked = await clickEl('button[type="submit"][name="commit"], #submit-file-changes, button:has-text("Commit changes")');
  ok(`点击了 ${clicked.tag} "${clicked.text}"`);
  await sleep(9000);
  const after = await ev(`({url: location.href, title: document.title})`);
  console.log('  结果:', JSON.stringify(after));
}

if (cmd === 'shot') {
  const s = await session();
  const out = path.resolve(process.argv[3] ?? 'shot.png');
  const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15_000);
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  const b = fs.readFileSync(out);
  ok(`${out}  ${b.readUInt32BE(16)}x${b.readUInt32BE(20)}  ${b.length} 字节`);
}

if (cmd === 'status') {
  console.log(JSON.stringify(await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`), null, 2));
}

// CDP 的 WebSocket 会一直持有事件循环，必须显式退出，否则脚本"跑完了却不结束"。
try { _s?.close(); } catch {}
process.exit(0);
