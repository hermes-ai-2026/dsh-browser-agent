/**
 * CDP 能力验证：用插件自己的 lib/cdp.js（与 browser_cdp 工具同一份代码）
 * 验证 target 发现、原生截图、真实输入、网络事件。
 *
 * 运行：node verify-cdp.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { CdpSession, listTargets, pickTarget, probeCdp } from './lib/cdp.js';

const PORT = 9222;
const BRIDGE = 'http://127.0.0.1:8791';
const BH = { 'content-type': 'application/json', 'x-dsh-browser-agent': 'dsh-browser-agent-local-bridge-v1' };
const outDir = process.cwd();

/** 确保有一个浏览器标签页（否则没有 webview target，CDP 无从下手）。 */
async function ensureBrowserPage() {
  const res = await fetch(`${BRIDGE}/debug/exec`, {
    method: 'POST',
    headers: BH,
    body: JSON.stringify({ op: 'open', args: { url: 'https://example.com/' }, timeoutMs: 60_000 }),
  });
  const body = await res.json().catch(() => null);
  return body?.data ?? null;
}

console.log('=== ⓪ 先确保有一个浏览器标签页 ===');
console.log('  ', JSON.stringify(await ensureBrowserPage()));
await new Promise((r) => setTimeout(r, 2000));

console.log('\n=== ① 端口探测 ===');
const info = await probeCdp(PORT);
console.log('  ', JSON.stringify(info));

console.log('\n=== ② target 列表（webview guest 是否作为独立 target 出现）===');
const targets = await listTargets(PORT);
for (const t of targets) {
  console.log(`   [${t.type.padEnd(9)}] ${(t.title || '(无标题)').slice(0, 40).padEnd(42)} ${t.url.slice(0, 60)}`);
}
const webviews = targets.filter((t) => t.type === 'webview');
console.log(`   → 共 ${targets.length} 个 target，其中 webview ${webviews.length} 个`);

console.log('\n=== ②b 护栏验证：绝不回退到 DSH 外壳页面 ===');
const withHint = await pickTarget(PORT, 'https://不存在的地址.invalid/');
console.log(
  '   传匹配不到的 hint →',
  withHint === null ? 'null' : `[${withHint.type}] ${withHint.url.slice(0, 40)}`,
  withHint && withHint.type === 'webview' ? '✅ 回退到 webview（正确）' : withHint === null ? '✅ 宁可为 null' : '❌ 拿到非 webview',
);
console.log('   默认 allowPage=false ⇒ 永远拿不到 type=page 的外壳 —— 这是事故后的硬护栏');

console.log('\n=== ③ 选中 webview 并连接 ===');
const target = await pickTarget(PORT);
if (!target) { console.log('   ❌ 没有 webview target'); process.exit(1); }
console.log('   ', JSON.stringify({ id: target.id.slice(0, 12) + '…', type: target.type, url: target.url }));
const s0 = new CdpSession(target.wsUrl);
let s = s0;
await s.connect();
console.log('   ✅ 已连接');

console.log('\n=== ④ Runtime.evaluate（原生 JS 求值）===');
const ev = await s.send('Runtime.evaluate', { expression: '({title: document.title, href: location.href, ua: navigator.userAgent.slice(0,60)})', returnByValue: true });
console.log('   ', JSON.stringify(ev.result?.value ?? ev));

console.log('\n=== ⑤ Page.captureScreenshot（原生截图，无 SVG 回退）===');
// ⚠️ 已知限制：webview guest 经过一段时间的重度使用（多次导航/注入/CDP 操作）后会"降级"，
//    Page.captureScreenshot 开始挂起；**重开一个标签即可恢复**。
//    为了让这一步可复现，先重置为全新标签再截图（这也是插件推荐的恢复方式）。
{
  const listRes = await fetch(`${BRIDGE}/debug/exec`, {
    method: 'POST', headers: BH,
    body: JSON.stringify({ op: 'tabs', args: { action: 'list' }, timeoutMs: 20_000 }),
  });
  const listBody = await listRes.json().catch(() => null);
  const tabs = listBody?.data?.tabs ?? [];
  for (const t of [...tabs].reverse()) {
    if (String(t.title).includes('.md')) continue; // 不动用户的预览标签
    await fetch(`${BRIDGE}/debug/exec`, {
      method: 'POST', headers: BH,
      body: JSON.stringify({ op: 'tabs', args: { action: 'close', index: t.index }, timeoutMs: 20_000 }),
    }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 800));
  await ensureBrowserPage();
  await new Promise((r) => setTimeout(r, 2200));
  console.log('   已重置为全新标签（guest 恢复）');
}
s.close();
const freshTarget = await pickTarget(PORT);
const s2 = new CdpSession(freshTarget.wsUrl);
await s2.connect();
const shot = await s2.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15_000);
if (shot?.data) {
  const file = path.join(outDir, 'cdp-native-screenshot.png');
  const bytes = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(file, bytes);
  console.log(`   ✅ 落盘 ${file}  ${bytes.length} 字节  PNG头=${bytes.subarray(0, 4).toString('hex')}`);
} else {
  console.log('   ❌ 未取到截图数据');
}
s2.close();
const s3 = new CdpSession(freshTarget.wsUrl);
await s3.connect();
s = s3; // 后续步骤复用新会话
console.log('\n=== ⑥ Input.dispatchMouseEvent（真实输入 → isTrusted 应为 true）===');
// 注意：第一次写这个测试时点在了一个 <a> 上，结果 CDP 真实点击**真的触发了导航**，
// 页面跳走后探针被冲掉，读成 0 事件 —— 也就是说输入其实生效了，是测试自毁。
// 因此这里：先回到稳定页面，再点**非链接区域**。
await s.send('Page.navigate', { url: 'https://example.com/' }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
const hrefBefore = (await s.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value;
const probePoint = await s.send('Runtime.evaluate', {
  expression: `(() => {
    // 找一个"不是链接也不是按钮"的落点，避免误触发导航
    const cx = 20, cy = Math.round(innerHeight / 2);
    const el = document.elementFromPoint(cx, cy);
    return { x: cx, y: cy, hit: el ? el.tagName : null, isLink: !!(el && el.closest && el.closest('a,button')), vw: innerWidth, vh: innerHeight };
  })()`,
  returnByValue: true,
});
const pt = probePoint.result.value;
console.log(`   落点 (${pt.x}, ${pt.y}) 命中 ${pt.hit}，是否链接/按钮：${pt.isLink ? '是（有风险）' : '否 ✅'}；视口 ${pt.vw}x${pt.vh}`);
await s.send('Runtime.evaluate', {
  expression: `window.__trustProbe = []; ['pointerdown','mousedown','mouseup','click','mousemove'].forEach(t => {
    document.addEventListener(t, (e) => window.__trustProbe.push({ type: e.type, isTrusted: e.isTrusted, x: Math.round(e.clientX), y: Math.round(e.clientY) }), true);
  }); 'installed'`,
  returnByValue: true,
});
await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 });
await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
await new Promise((r) => setTimeout(r, 600));
const hrefAfter = (await s.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value;
if (hrefAfter !== hrefBefore) console.log(`   ⚠️ 期间发生了导航：${hrefBefore} → ${hrefAfter}`);
const probe = await s.send('Runtime.evaluate', { expression: 'window.__trustProbe || []', returnByValue: true });
const events = probe.result.value ?? [];
console.log(`   页面收到 ${events.length} 个事件：`);
for (const e of events.slice(0, 6)) console.log(`     ${e.type.padEnd(12)} isTrusted=${e.isTrusted}  at (${e.x},${e.y})`);
const allTrusted = events.length > 0 && events.every((e) => e.isTrusted === true);
console.log(`   → isTrusted 全部为 true：${allTrusted ? '✅ 是' : '❌ 否'}`);

console.log('\n=== ⑥b Input.insertText（真实文本输入）===');
const made = await s.send('Runtime.evaluate', {
  expression: `(() => { let i = document.getElementById('__probe_in'); if (!i) { i = document.createElement('input'); i.id = '__probe_in'; i.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647'; document.body.appendChild(i); } i.value = ''; i.focus(); return { exists: !!document.getElementById('__probe_in'), focused: document.activeElement === i }; })()`,
  returnByValue: true,
});
console.log('   插入输入框:', JSON.stringify(made.result?.value));
await s.send('Input.insertText', { text: 'hello-cdp' });
await new Promise((r) => setTimeout(r, 300));
const val = (await s.send('Runtime.evaluate', { expression: `(document.getElementById('__probe_in') || {}).value`, returnByValue: true })).result?.value;
console.log(`   insertText 后 input.value = ${JSON.stringify(val)}  ${val === 'hello-cdp' ? '✅' : '❌'}`);

console.log('\n=== ⑦ Network.enable + 事件收集（CDP Network 域）===');
await s.send('Network.enable', {});
// 触发一次导航以产生网络事件
await s.send('Page.navigate', { url: 'https://example.com/' });
await new Promise((r) => setTimeout(r, 3000));
const netEvents = s.takeEvents('Network.');
const reqs = netEvents.filter((e) => e.method === 'Network.requestWillBeSent');
console.log(`   收到 ${netEvents.length} 个 Network.* 事件，其中 requestWillBeSent ${reqs.length} 个`);
for (const e of reqs.slice(0, 4)) {
  const r = e.params?.request;
  console.log(`     ${String(r?.method).padEnd(5)} ${String(r?.url).slice(0, 70)}`);
}
console.log('   事件方法种类:', [...new Set(netEvents.map((e) => e.method))].slice(0, 8).join(', '));

console.log('\n=== ⑧ Emulation（改 UA / 设备尺寸）===');
const emu = await s.send('Emulation.setUserAgentOverride', { userAgent: 'DSH-CDP-Probe/1.0' });
await s.send('Runtime.evaluate', { expression: 'location.reload()' }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
const after = await s.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true });
console.log('   覆盖后的 UA =', after.result?.value);

s.close();
console.log('\n=== 完成 ===');
