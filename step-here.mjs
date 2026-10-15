/**
 * 直接在**当前已加载**的 github.com/new 页面上填表建仓库（不导航，避开概率性重置）。
 * 用法：node step-here.mjs [create|upload|commit|status]
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
const say = (s) => console.log(`  ${s}`);

const t = await pickTarget(9222);
if (!t) { console.log('无 webview target'); process.exit(1); }
const s = new CdpSession(t.wsUrl);
await s.connect();
await s.send('Page.enable', {}).catch(() => {});

async function ev(code, awaitPromise = false) {
  const r = await s.send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise }, 30_000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}
const setValue = (sel, val) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`;
async function clickEl(sel) {
  const box = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName, text: (el.innerText||el.value||'').trim().slice(0,30) };
  })()`);
  if (!box) throw new Error('元素未找到: ' + sel);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(200);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  return box;
}

/** 按可见文本找按钮并点击（GitHub 新版是 React 应用，class 名是哈希，只能按文本找）。 */
async function clickByText(text) {
  const box = await ev(`(() => {
    const want = ${JSON.stringify(text)}.toLowerCase();
    const cands = [...document.querySelectorAll('button, input[type=submit], a[role=button]')]
      .filter(el => el.offsetParent !== null || el.getClientRects().length)
      .map(el => ({ el, t: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim() }))
      .filter(o => o.t.toLowerCase().includes(want));
    if (!cands.length) return { err: 'no-match', seen: [...document.querySelectorAll('button')].map(b => (b.innerText||b.value||'').trim()).filter(Boolean).slice(0, 20) };
    const el = cands[0].el;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName, text: cands[0].t.slice(0, 40) };
  })()`);
  if (box?.err) throw new Error('未找到按钮: ' + text + ' 候选: ' + JSON.stringify(box.seen));
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(200);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  return box;
}

const cmd = process.argv[2] ?? 'status';

/**
 * 重试导航直到页面可用，然后**立刻**在同一轮里干活 ——
 * 不给"概率性重置"留出把页面打死的窗口。
 */
async function ensurePage(url, tries = 40) {
  for (let i = 1; i <= tries; i++) {
    const cur = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`).catch(() => null);
    if (cur && !cur.url.startsWith('chrome-error') && cur.len > 40) {
      // 已经在目标页
      if (!url || cur.url.includes(url.replace(/^https:\/\//, '').split('?')[0])) { ok(`页面已就绪（第 ${i} 次检查）`); return cur; }
    }
    await s.send('Page.navigate', { url: i === 1 ? url : `${url}${url.includes('?') ? '&' : '?'}_r=${i}` }, 20_000).catch(() => {});
    await sleep(3000);
    const st = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`).catch(() => null);
    if (st && !st.url.startsWith('chrome-error') && st.len > 40) { ok(`第 ${i} 次尝试加载成功：${st.title}`); return st; }
    process.stdout.write(`\r  ⏳ ${i}/${tries} …   `);
  }
  console.log('');
  return null;
}

if (cmd === 'doit') {
  step('重试加载「新建仓库」页');
  const got = await ensurePage('https://github.com/new');
  if (!got) { bad('重试耗尽'); s.close(); process.exit(1); }
  say(`${got.title}  ${got.url}`);

  step('填仓库名');
  const nv = await ev(setValue('#repository-name-input', REPO));
  nv === REPO ? ok(`仓库名 = ${nv}`) : bad(`结果: ${nv}`);

  step('填描述');
  const dv = await ev(setValue('input[name="Description"]', DESC));
  say(`描述长度 ${String(dv).length}`);

  step('点 Create repository');
  const c = await clickByText('Create repository');
  ok(`点击 ${c.tag} "${c.text}"`);
  await sleep(11000);
  const after = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`);
  say(JSON.stringify(after));
  if (/hermes-ai-2026\/dsh-browser-agent/.test(after.url)) ok('🎉 仓库创建成功');
  else if (after.url.startsWith('chrome-error')) { bad('提交被重置'); say('再跑一次 node step-here.mjs doit 即可（GitHub 可能已创建成功，先看仓库页）'); }
  else say('首行: ' + (await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,220)`)));
  s.close(); process.exit(0);
}

if (cmd === 'checkrepo') {
  step('检查仓库是否已存在');
  const repoIsThere = await ev(`fetch('/hermes-ai-2026/${REPO}', {method:'HEAD'}).then(r => r.status).catch(e => 'ERR ' + e.message)`, true);
  say(`HEAD /hermes-ai-2026/${REPO} → ${repoIsThere}`);
  s.close(); process.exit(0);
}

const st0 = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`);
step('当前页面');
say(JSON.stringify(st0));
if (st0.url.startsWith('chrome-error') || st0.len < 40) { bad('页面不可用，需要先重新打开'); s.close(); process.exit(1); }
if (cmd === 'status') { s.close(); process.exit(0); }

if (cmd === 'create') {
  step('填仓库名');
  const nv = await ev(setValue('input[name="repository[name]"], #repository_name', REPO));
  nv === REPO ? ok(`仓库名 = ${nv}`) : bad(`结果: ${nv}`);

  step('填描述');
  const dv = await ev(setValue('input[name="repository[description]"], #repository_description', DESC));
  say(`描述长度 ${String(dv).length}`);

  step('勾选 Add a README');
  const cb = await ev(`(() => { const c = document.querySelector('#repository_auto_init'); if (!c) return 'no-checkbox'; if (!c.checked) c.click(); return c.checked; })()`);
  say('README: ' + cb);

  step('点 Create repository');
  const c = await clickEl('button[type="submit"][name="commit"], #new_repository button[type="submit"], form[action*="repos"] button[type="submit"]');
  ok(`点击 ${c.tag} "${c.text}"`);
  await sleep(10000);
  const after = await ev(`({url: location.href, title: document.title, len: (document.body&&document.body.innerText||'').length})`);
  say(JSON.stringify(after));
  if (/hermes-ai-2026\/dsh-browser-agent/.test(after.url)) ok('🎉 仓库创建成功');
  else if (after.url.startsWith('chrome-error')) bad('提交时被重置了 —— 再点一次即可（表单数据已填）');
  else say('页面首行: ' + (await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200)`)));
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
  step(`注入 ${files.length} 个文件`);
  await s.send('DOM.enable', {});
  const doc = await s.send('DOM.getDocument', { depth: -1, pierce: true }, 20_000);
  const inp = await s.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, 15_000);
  if (!inp?.nodeId) { bad('没找到 file input'); s.close(); process.exit(1); }
  ok(`file input nodeId=${inp.nodeId}`);
  await s.send('DOM.setFileInputFiles', { files, nodeId: inp.nodeId }, 40_000);
  ok('文件已注入，等待页面列出文件');
  await sleep(14000);
  say('页面反馈: ' + (await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,400)`)));
}

if (cmd === 'commit') {
  step('点 Commit changes');
  const c = await clickEl('button[type="submit"][name="commit"], #submit-file-changes');
  ok(`点击 ${c.tag} "${c.text}"`);
  await sleep(10000);
  say(JSON.stringify(await ev(`({url: location.href, title: document.title})`)));
}

s.close();
process.exit(0);
