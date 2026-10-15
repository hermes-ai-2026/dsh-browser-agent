import { CdpSession, pickTarget } from './lib/cdp.js';
const t = await pickTarget(9222);
const s = new CdpSession(t.wsUrl);
await s.connect();
const ev = async (c, aw = false) => {
  const r = await s.send('Runtime.evaluate', { expression: c, returnByValue: true, awaitPromise: aw }, 30_000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('当前:', await ev(`JSON.stringify({url: location.href, title: document.title})`));
console.log('仓库名框的值:', await ev(`(document.querySelector('#repository-name-input')||{}).value ?? '(无)'`));

// 列出所有含 "Create repository" 的按钮及其可见性/禁用状态
console.log('\n所有 "Create repository" 候选:');
console.log(await ev(`JSON.stringify([...document.querySelectorAll('button,input[type=submit]')]
  .map((e,i) => ({i, txt:(e.innerText||e.value||'').trim(), dis:e.disabled, vis:e.offsetParent!==null, type:e.type, form:e.form?e.form.id||e.form.action:'-', rect:e.getBoundingClientRect().toJSON()}))
  .filter(o => o.txt.toLowerCase().includes('create')), null, 1)`));

console.log('\n尝试 1：JS 原生 click()');
const r1 = await ev(`(() => {
  const btns = [...document.querySelectorAll('button,input[type=submit]')].filter(e => (e.innerText||e.value||'').toLowerCase().includes('create repository'));
  const vis = btns.filter(b => b.offsetParent !== null || b.getClientRects().length);
  const b = vis[0] || btns[0];
  if (!b) return 'no-button';
  b.focus(); b.click();
  return 'clicked:' + (b.innerText||b.value||'').trim() + ' disabled=' + b.disabled;
})()`);
console.log('  →', r1);
await sleep(9000);
console.log('  URL:', await ev(`location.href`));

// 如果还在 /new，试表单 submit
const stillNew = await ev(`location.href.includes('/new')`);
if (stillNew) {
  console.log('\n尝试 2：form.requestSubmit()');
  const r2 = await ev(`(() => {
    const f = document.querySelector('form');
    if (!f) return 'no-form';
    if (f.requestSubmit) { f.requestSubmit(); return 'requestSubmit on ' + (f.id||f.action); }
    f.submit(); return 'submit()';
  })()`);
  console.log('  →', r2);
  await sleep(9000);
  console.log('  URL:', await ev(`location.href`));
}

const stillNew2 = await ev(`location.href.includes('/new')`);
if (stillNew2) {
  console.log('\n尝试 3：真实鼠标点击可见按钮的中心');
  const box = await ev(`(() => {
    const b = [...document.querySelectorAll('button,input[type=submit]')]
      .filter(e => (e.innerText||e.value||'').toLowerCase().includes('create repository'))
      .filter(e => e.getClientRects().length && !e.disabled)[0];
    if (!b) return null;
    b.scrollIntoView({block:'center'});
    const r = b.getBoundingClientRect();
    return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt:b.innerText||b.value};
  })()`);
  console.log('  目标:', JSON.stringify(box));
  if (box) {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
    await sleep(150);
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(90);
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(10000);
    console.log('  URL:', await ev(`location.href`));
  }
}

console.log('\n最终页面:');
console.log(await ev(`JSON.stringify({url: location.href, title: document.title, head: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200)})`));

s.close();
process.exit(0);
