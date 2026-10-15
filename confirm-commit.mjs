import { CdpSession, pickTarget } from './lib/cdp.js';
const t = await pickTarget(9222);
const s = new CdpSession(t.wsUrl);
await s.connect();
const ev = async (c) => (await s.send('Runtime.evaluate', { expression: c, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('URL:', await ev('location.href'));
console.log('\n--- 页面上所有可见按钮 ---');
console.log(await ev(`JSON.stringify([...document.querySelectorAll('button')]
  .filter(b => b.getClientRects().length)
  .map((b,i) => ({i, txt:(b.innerText||'').trim().slice(0,40), dis:b.disabled}))
  .filter(o => o.txt), null, 1)`));
console.log('\n--- 是否有对话框 ---');
console.log(await ev(`JSON.stringify({dialog: !!document.querySelector('dialog[open], [role=dialog]'), fileInput: document.querySelectorAll('input[type=file]').length})`));

// 找对话框里的提交按钮：文本含 "Commit changes" 且不是页面顶部那个
const box = await ev(`(() => {
  const dlg = document.querySelector('dialog[open], [role=dialog]');
  const scope = dlg || document;
  const btns = [...scope.querySelectorAll('button')]
    .filter(b => b.getClientRects().length && !b.disabled)
    .map(b => ({b, t:(b.innerText||'').trim()}))
    .filter(o => /commit/i.test(o.t));
  const pick = btns.find(o => /^commit changes$/i.test(o.t)) || btns[btns.length-1];
  if (!pick) return { err: 'no-commit-in-dialog', inDialog: [...scope.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,10) };
  pick.b.scrollIntoView({ block: 'center' });
  const r = pick.b.getBoundingClientRect();
  return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt: pick.t, inDialog: !!dlg };
})()`);
console.log('\n找到的提交按钮:', JSON.stringify(box));

if (!box.err) {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await sleep(200);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(90);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  console.log('  ✓ 已点击');
  await sleep(10000);
  console.log('\n结果 URL:', await ev('location.href'));
  console.log('结果文本:', await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200)`));
}
s.close();
process.exit(0);
