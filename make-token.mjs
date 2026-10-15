/**
 * 用内置浏览器创建 GitHub Personal Access Token，并把 token 从页面上读回来。
 * 全程可见。用途：之后用 git push 走代理上传（网页版上传无法保留目录结构）。
 *
 * 用法：node make-token.mjs
 */
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
async function readPage() {
  return ev(`({url: location.href, title: document.title, err: location.href.startsWith('chrome-error'),
    text: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 260)})`);
}
async function clickText(re) {
  const box = await ev(`(() => {
    const rx = new RegExp(${JSON.stringify(re)}, 'i');
    const b = [...document.querySelectorAll('button, input[type=submit], a')]
      .filter(x => x.getClientRects().length && !x.disabled)
      .find(x => rx.test((x.innerText || x.value || x.getAttribute('aria-label') || '').trim()));
    if (!b) return { err: 'not-found', seen: [...document.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean).slice(0,18) };
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt: (b.innerText||b.value||'').trim().slice(0,40) };
  })()`);
  if (box.err) return box;
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(180);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  return box;
}

step('打开「新建 fine-grained token」页');
for (const u of ['https://github.com/settings/personal-access-tokens/new', 'https://github.com/settings/tokens/new']) {
  await s.send('Page.navigate', { url: u }, 25_000).catch(() => {});
  await sleep(6000);
  const p = await readPage();
  say(`${u}\n    → ${p.title}  ${p.url}`);
  if (!p.err && /token/i.test(p.title + p.text)) { ok('页面就绪'); break; }
}

let p = await readPage();
say('页面文本: ' + p.text.slice(0, 200));

// 经典 token 页（/settings/tokens/new）结构更简单：note + scopes
step('填 Token 名称');
const noteSet = await ev(`(() => {
  const el = document.querySelector('#oauth_access_description, input[name="oauth_access[description]"], #pat_description, input[id*="description"], input[name*="name"]');
  if (!el) return null;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'dsh-publish');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);
noteSet ? ok(`名称 = ${noteSet}`) : say('（没找到名称输入框，可能已是新版界面）');

step('勾选 repo 权限');
const scope = await ev(`(() => {
  const boxes = [...document.querySelectorAll('input[type=checkbox]')];
  const repo = boxes.find(b => (b.id||b.name||'').toLowerCase().includes('repo'));
  if (!repo) return { err: 'no-repo-checkbox', ids: boxes.map(b => b.id || b.name).slice(0, 12) };
  if (!repo.checked) repo.click();
  return { checked: repo.checked, id: repo.id || repo.name };
})()`);
scope.err ? say('权限勾选: ' + JSON.stringify(scope)) : ok(`repo 权限已勾选 (${scope.id})`);

step('点 Generate token');
const gen = await clickText('generate token|生成令牌');
if (gen.err) { bad('没找到生成按钮: ' + JSON.stringify(gen.seen)); }
else {
  ok(`点击 "${gen.txt}"`);
  await sleep(8000);
  p = await readPage();
  say(`URL: ${p.url}`);
  // token 只在生成后出现一次，从页面上读回来
  const tok = await ev(`(() => {
    const cands = [...document.querySelectorAll('code, input, [data-testid*="token"], .token, pre')]
      .map(e => (e.value || e.innerText || '').trim())
      .filter(v => /^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(v));
    return cands[0] || null;
  })()`);
  if (tok) {
    console.log('\n\x1b[32m╔══════════════════════════════════════════════════╗');
    console.log('║  TOKEN 已生成（从内置浏览器页面上读回）           ║');
    console.log('╚══════════════════════════════════════════════════╝\x1b[0m');
    console.log(tok);
    console.log('\n（这份 token 只显示一次，我已读回，可用于 git push）');
  } else {
    bad('页面上没读到 token —— 看一下页面文本');
    say(p.text.slice(0, 250));
  }
}

s.close();
process.exit(0);
