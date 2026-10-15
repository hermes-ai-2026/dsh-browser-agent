/** 通过 sudo 确认页（输密码 → Confirm），然后建 token。用法：node sudo-confirm.mjs */
import { CdpSession, pickTarget } from './lib/cdp.js';

const OWNER = 'hermes-ai-2026';
const REPO = 'dsh-browser-agent';
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

let p = await readPage();
step('当前页面');
say(`${p.title}  ${p.url}`);
if (!/Confirm access/i.test(p.text)) { say('不在 sudo 页，文本: ' + p.text.slice(0, 160)); }

step('填密码');
const pwSet = await ev(`(() => {
  const el = document.querySelector('input[type=password], #sudo_password, input[name="sudo_password"]');
  if (!el) return null;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(process.env.GH_PASS ?? '')});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value.length;
})()`);
pwSet ? ok(`密码已填（${pwSet} 位）`) : bad('没找到密码框');

step('点 Confirm');
const c = await clickText('^confirm$|^确认$');
c.err ? bad('没找到: ' + JSON.stringify(c.seen)) : ok(`点击 "${c.txt}"`);
await sleep(8000);
p = await readPage();
say(`${p.title}  ${p.url}`);
say('文本: ' + p.text.slice(0, 220));

// 到了 token 页就继续建
if (/token/i.test(p.title + p.url)) {
  step('建 classic token（note + repo scope）');
  const note = await ev(`(() => {
    const el = document.querySelector('#oauth_access_description, input[name="oauth_access[description]"]');
    if (!el) return null;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'dsh-publish');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  note ? ok(`名称 = ${note}`) : say('（无 note 框，可能是 fine-grained 页）');

  const sc = await ev(`(() => {
    const b = [...document.querySelectorAll('input[type=checkbox]')].find(x => (x.id||x.name||'').toLowerCase().includes('repo'));
    if (!b) return { err: 'no-repo' };
    if (!b.checked) b.click();
    return { checked: b.checked, id: b.id || b.name };
  })()`);
  sc.err ? say('scope: ' + JSON.stringify(sc)) : ok(`repo scope 勾选 (${sc.id})`);

  const gen = await clickText('generate token|生成令牌');
  gen.err ? bad('没找到生成按钮: ' + JSON.stringify(gen.seen)) : ok(`点击 "${gen.txt}"`);
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
    console.log('\n\x1b[32m  TOKEN（从内置浏览器页面上读回）：\x1b[0m');
    console.log('  ' + tok);
    console.log('\n  下一步：用 git push 经代理上传（保留目录结构）');
  } else {
    bad('没读到 token，页面文本:');
    say(p.text.slice(0, 300));
  }
}

s.close();
process.exit(0);
