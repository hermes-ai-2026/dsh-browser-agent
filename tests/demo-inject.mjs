/**
 * 实测本轮新增的 CDP 能力：
 *   ① document-start 注入（Page.addScriptToEvaluateOnNewDocument，需常驻会话）
 *   ② 全页 / 区域截图（captureBeyondViewport / clip）
 *   ③ 清除 cookie（Network.clearBrowserCookies）
 *
 * 运行：node demo-inject.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { CdpSession, pickTarget } from './lib/cdp.js';

const t = await pickTarget(9222);
if (!t) { console.log('无 webview target'); process.exit(1); }
const s = new CdpSession(t.wsUrl);
await s.connect();
await s.send('Page.enable').catch(() => {});
const ev = async (e) => (await s.send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

console.log('① document-start 注入（常驻会话）');
const HOOK = `
  window.__dsh_injected = { at: 'document-start', url: location.href, t: Date.now() };
  // hook fetch：证明可以在页面脚本之前动手
  const _f = window.fetch;
  window.fetch = function (...a) { window.__dsh_hooked = (window.__dsh_hooked || 0) + 1; return _f.apply(this, a); };
`;
const add = await s.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }, 15_000);
console.log('   已注册 identifier =', add.identifier);

console.log('\n② 注入后导航到一个新文档');
await s.send('Page.navigate', { url: `https://example.com/?inject=${Date.now()}` });
await new Promise((r) => setTimeout(r, 2500));
const flag = await ev('window.__dsh_injected');
console.log('   新文档里读到:', JSON.stringify(flag));
console.log('   ', flag && flag.at === 'document-start' ? '✅ document-start 注入生效' : '❌ 未生效');

console.log('\n③ 证明 hook 真的在页面脚本之前就位');
const hooked = await ev(`(async () => { try { await fetch(location.href, {method:'HEAD'}); } catch(e){} return window.__dsh_hooked ?? 0; })()`);
console.log(`   fetch 被 hook 计数 = ${hooked}`, hooked > 0 ? '✅' : '⚠️');

console.log('\n④ 移除注入脚本并验证下一次导航不再有标记');
await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: add.identifier }, 15_000);
await s.send('Page.navigate', { url: `https://example.com/?removed=${Date.now()}` });
await new Promise((r) => setTimeout(r, 2200));
const after = await ev('window.__dsh_injected ?? null');
console.log('   移除后新文档:', JSON.stringify(after), after === null ? '✅ 已不再注入' : '❌ 仍在注入');

console.log('\n⑤ 全页截图 vs 视口截图');
const vp = await ev('({vh: innerHeight, docH: document.documentElement.scrollHeight})');
console.log('   视口高', vp.vh, ' 文档高', vp.docH);
const shotView = await s.send('Page.captureScreenshot', { format: 'png' }, 12_000);
const shotFull = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, 20_000);
const bView = Buffer.from(shotView.data, 'base64');
const bFull = Buffer.from(shotFull.data, 'base64');
const fView = path.join(process.cwd(), 'shot-viewport.png');
const fFull = path.join(process.cwd(), 'shot-fullpage.png');
fs.writeFileSync(fView, bView);
fs.writeFileSync(fFull, bFull);
// 从 PNG IHDR 读尺寸（偏移 16 起 8 字节：宽高各 4 字节大端）
const dim = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
console.log(`   视口截图 → ${dim(bView).w}x${dim(bView).h}  ${bView.length} 字节`);
console.log(`   全页截图 → ${dim(bFull).w}x${dim(bFull).h}  ${bFull.length} 字节`, dim(bFull).h >= dim(bView).h ? '✅ 更高' : '⚠️');

console.log('\n⑥ 区域截图（clip）');
const clipShot = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 300, height: 150, scale: 1 } }, 12_000);
const bClip = Buffer.from(clipShot.data, 'base64');
console.log(`   clip 0,0,300,150 → ${dim(bClip).w}x${dim(bClip).h}  ${bClip.length} 字节`, dim(bClip).w === 300 && dim(bClip).h === 150 ? '✅' : '⚠️');

console.log('\n⑦ 清除 cookie（Network.clearBrowserCookies）');
await s.send('Network.enable', {});
const before = await s.send('Network.getCookies', {}, 15_000);
console.log('   清除前 cookie 数 =', before.cookies.length);
await s.send('Network.clearBrowserCookies', {}, 15_000);
const afterClear = await s.send('Network.getCookies', {}, 15_000);
console.log('   清除后 cookie 数 =', afterClear.cookies.length, afterClear.cookies.length < before.cookies.length ? '✅' : '⚠️（本来就少或不可清）');

s.close();
console.log('\n完成');
