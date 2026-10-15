/** 重新生成带 repo scope 的 classic token。用法：node make-token2.mjs */
import { CdpSession, pickTarget } from './lib/cdp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`);
const say = (s) => console.log(`  ${s}`);

const t = await pickTarget(9222);
const s = new CdpSession(t.wsUrl);
await s.connect();
await s.send('Page.enable', {}).catch(() => {});
const ev = async (c, aw = false) => {
  const r = await s.send('Runtime.evaluate', { expression: c, returnByValue: true, awaitPromise: aw }, 30_000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};
const readPage = () => ev(`({url: location.href, title: document.title, err: location.href.startsWith('chrome-error'),
  text: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 300)})`);
const setVal = (sel, v) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`;

step('打开 classic token 新建页');
for (let i = 1; i <= 12; i++) {
  await s.send('Page.navigate', { url: i === 1 ? 'https://github.com/settings/tokens/new' : `https://github.com/settings/tokens/new?_r=${i}` }, 25_000).catch(() => {});
  await sleep(5000);
  const p = await readPage();
  if (!p.err && /New Personal Access Token|Confirm access/i.test(p.text + p.title)) { say(`${p.title}  ${p.url}`); break; }
  process.stdout.write(`\r  ⏳ ${i}/12 …   `);
}
console.log('');
let p = await readPage();

// 可能需要 sudo 确认
if (/Confirm access/i.test(p.text)) {
  step('sudo 确认');
  await ev(setVal('input[type=password], #sudo_password', process.env.GH_PASS ?? ''));
  const box = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].filter(x=>x.getClientRects().length).find(x=>/^confirm$/i.test((x.innerText||'').trim()));
    if (!b) return null; const r = b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  if (box) { await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',buttons:1,clickCount:1}); await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',buttons:0,clickCount:1}); }
  await sleep(7000);
  p = await readPage();
  say(p.title + '  ' + p.url);
}

step('填 note');
say('note: ' + (await ev(setVal('#oauth_access_description', 'dsh-publish-write')) ?? '（没找到）'));

step('勾 repo scope（尝试多个选择器）');
const sc = await ev(`(() => {
  const tries = ['#scopes_repo', 'input[value="repo"]', 'input[id*="scopes_repo"]'];
  for (const sel of tries) {
    const el = document.querySelector(sel);
    if (el) { if (!el.checked) el.click(); return { sel, checked: el.checked, id: el.id }; }
  }
  // 兜底：按 label 文本找
  const lbl = [...document.querySelectorAll('label, li')].find(e => /^\\s*repo\\s*$/i.test((e.innerText||'').trim().split('\\n')[0]));
  if (lbl) { const cb = lbl.querySelector('input[type=checkbox]'); if (cb) { if (!cb.checked) cb.click(); return { sel: 'label', checked: cb.checked, id: cb.id }; } }
  return { err: 'not-found', boxes: [...document.querySelectorAll('input[type=checkbox]')].map(b=>b.id).filter(Boolean).slice(0,20) };
})()`);
sc.err ? bad('勾选失败: ' + JSON.stringify(sc)) : ok(`已勾选 (${sc.sel} → ${sc.id})`);

step('验证勾选状态');
say('repo 复选框现在: ' + await ev(`(() => { const e = document.querySelector('#scopes_repo'); return e ? e.checked : 'no-el'; })()`));

step('点 Generate token');
const box = await ev(`(() => {
  const b = [...document.querySelectorAll('button, input[type=submit]')].filter(x=>x.getClientRects().length && !x.disabled)
    .find(x => /generate token/i.test((x.innerText||x.value||'').trim()));
  if (!b) return null; const r = b.getBoundingClientRect();
  return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), txt:(b.innerText||b.value||'').trim()};
})()`);
if (box) {
  await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',buttons:1,clickCount:1});
  await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',buttons:0,clickCount:1});
  ok(`点击 "${box.txt}"`);
} else bad('没找到 Generate token 按钮');
await sleep(8000);
p = await readPage();
say(`${p.url}`);

const tok = await ev(`(() => {
  const v = [...document.querySelectorAll('code, input, pre, [data-testid*="token"]')]
    .map(e => (e.value || e.innerText || '').trim())
    .filter(x => /^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(x));
  return v[0] || null;
})()`);
if (tok) {
  console.log('\n\x1b[32m  ★ 新 TOKEN（含 repo scope）:\x1b[0m');
  console.log('  ' + tok);
} else { bad('没读到 token'); say(p.text.slice(0, 260)); }

s.close();
process.exit(0);
