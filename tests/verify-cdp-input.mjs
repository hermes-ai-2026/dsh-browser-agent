/**
 * 验证"CDP 真实输入"这条新路径：
 *   渲染层 highlight（定位 + 显示虚拟鼠标）→ CDP Input.* 派发真实鼠标 → 页面收到 isTrusted 事件
 * 这正是 browser_click / browser_type 现在优先走的路。
 *
 * 运行：node verify-cdp-input.mjs
 */
import { CdpSession, pickTarget } from './lib/cdp.js';

const BRIDGE = 'http://127.0.0.1:8791';
const H = { 'content-type': 'application/json', 'x-dsh-browser-agent': 'dsh-browser-agent-local-bridge-v1' };

async function op(o, args = {}, timeoutMs = 60_000) {
  const res = await fetch(`${BRIDGE}/debug/exec`, { method: 'POST', headers: H, body: JSON.stringify({ op: o, args, timeoutMs }) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body.data;
}

const pass = [], fail = [];
const check = (n, ok, d) => (ok ? pass : fail).push(`${n}${d ? ' — ' + d : ''}`);

console.log('① 准备页面');
await op('open', { url: 'https://example.com/' }, 90_000);
await new Promise((r) => setTimeout(r, 1800));

console.log('\n② 在页面里注入一个可点击目标并挂事件探针');
await op('eval', {
  code: `(() => {
    let b = document.getElementById('__cdp_btn');
    if (!b) { b = document.createElement('button'); b.id='__cdp_btn'; b.textContent='CDP-点击我';
      b.style.cssText='position:fixed;left:40px;top:200px;z-index:2147483647;padding:8px 14px'; document.body.appendChild(b); }
    window.__hits = 0; window.__ev = [];
    b.onclick = () => { window.__hits++; };
    ['pointerover','mousedown','mouseup','click'].forEach(t => b.addEventListener(t, e => window.__ev.push({ t: e.type, trusted: e.isTrusted }), true));
    return { ok: true, rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(b.getBoundingClientRect()) };
  })()`,
  returnByValue: true,
});
const rect = (await op('eval', { code: `const b=document.getElementById('__cdp_btn'); const r=b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }` })).result;
console.log('   按钮矩形:', JSON.stringify(rect));

console.log('\n③ 渲染层 highlight（真实 browser_click 的第一步）');
const loc = await op('highlight', { selector: '#__cdp_btn' }, 30_000);
console.log('   ', JSON.stringify({ ok: loc.ok, tag: loc.tag, text: loc.text, at: loc.at, viewport: loc.viewport }));
check('highlight 返回视口中心坐标', loc?.ok === true && Array.isArray(loc.at) && loc.at.length === 2, JSON.stringify(loc?.at));
check('highlight 自动滚入视口', typeof loc?.viewport?.[0] === 'number');
// 顺带证明虚拟鼠标被插入了
const cursor = (await op('eval', { code: `return { present: !!document.getElementById('__dsh_cursor') }` })).result;
check('highlight 显示了虚拟鼠标', cursor?.present === true, JSON.stringify(cursor));

console.log('\n④ CDP Input 在 highlight 给出的坐标上派发真实鼠标');
const target = await pickTarget(9222);
if (!target) { console.log('   ❌ 无 webview target'); process.exit(1); }
const s = new CdpSession(target.wsUrl);
await s.connect();
const [x, y] = loc.at;
await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
await new Promise((r) => setTimeout(r, 120));
await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
await new Promise((r) => setTimeout(r, 400));

const res = (await op('eval', { code: `return { hits: window.__hits, events: window.__ev }` })).result;
console.log('   按钮 onclick 触发次数 =', res.hits);
console.log('   事件:', JSON.stringify(res.events));
check('真实点击命中了目标按钮', res?.hits === 1, `hits=${res?.hits}`);
check('事件全部 isTrusted', Array.isArray(res?.events) && res.events.length > 0 && res.events.every((e) => e.trusted === true), JSON.stringify(res?.events?.map((e) => e.trusted)));

console.log('\n⑤ CDP 真实文本输入（browser_type 现在优先走的路径）');
await op('eval', {
  code: `(() => { let i=document.getElementById('__cdp_in'); if(!i){ i=document.createElement('input'); i.id='__cdp_in';
    i.style.cssText='position:fixed;left:40px;top:260px;z-index:2147483647'; document.body.appendChild(i);} i.value=''; return { ok:true }; })()`,
  returnByValue: true,
});
const loc2 = await op('highlight', { selector: '#__cdp_in', focus: true }, 30_000);
const [x2, y2] = loc2.at;
await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x2, y: y2, button: 'none', buttons: 0 });
await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x2, y: y2, button: 'left', buttons: 1, clickCount: 1 });
await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
await s.send('Input.insertText', { text: 'CDP-真实输入' });
await new Promise((r) => setTimeout(r, 300));
const typed = (await op('eval', { code: `const a=document.activeElement; return { tag: a&&a.tagName, value: a&&a.value, focused: !!a && a.id==='__cdp_in' }` })).result;
console.log('   焦点元素:', JSON.stringify(typed));
check('CDP 真实文本输入写入成功', typed?.value === 'CDP-真实输入', JSON.stringify(typed?.value));
check('highlight focus:true 让目标获得焦点', typed?.focused === true);

s.close();
console.log('\n================ 汇总 ================');
for (const p of pass) console.log('  ✅', p);
for (const f of fail) console.log('  ❌', f);
console.log(`通过 ${pass.length}，失败 ${fail.length}`);
process.exit(fail.length ? 1 : 0);
