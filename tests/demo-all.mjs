/**
 * 全能力演示：把 dsh-browser-agent 的 14 个工具对应的能力在**真实 DSH 内置浏览器**上逐条跑一遍。
 *
 * 说明：宿主侧工具（browser_cdp / browser_click 的 CDP 路径等）无法由本会话直接调用
 *（会话的工具集在开场固定），因此这里通过插件自带的 /debug/exec 调试通道驱动——
 * 走的是**同一条** host → 桥接 → 渲染半 → webview 链路；CDP 部分直接复用 lib/cdp.js（与工具同一份代码）。
 *
 * 运行：node demo-all.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { CdpSession, listTargets, pickTarget, probeCdp } from './lib/cdp.js';

const BRIDGE = 'http://127.0.0.1:8791';
const H = { 'content-type': 'application/json', 'x-dsh-browser-agent': 'dsh-browser-agent-local-bridge-v1' };
const OUT = process.cwd();
let step = 0;
const line = (s = '') => console.log(s);
const head = (t) => { line(); line('═'.repeat(72)); line(`  ${t}`); line('═'.repeat(72)); };
const n = () => String(++step).padStart(2, '0');

async function op(o, args = {}, timeoutMs = 60_000) {
  const res = await fetch(`${BRIDGE}/debug/exec`, { method: 'POST', headers: H, body: JSON.stringify({ op: o, args, timeoutMs }) });
  const b = await res.json().catch(() => null);
  if (!res.ok) throw new Error(b?.error ?? `HTTP ${res.status}`);
  return b.data;
}
const brief = (v, n2 = 130) => { const s = JSON.stringify(v); return s.length > n2 ? s.slice(0, n2) + '…' : s; };

line('╔' + '═'.repeat(70) + '╗');
line('║  dsh-browser-agent 全能力演示 — 在真实的 DSH 内置浏览器上' + ' '.repeat(13) + '║');
line('╚' + '═'.repeat(70) + '╝');

/* ────────────────── 第一部分：基础驱动 ────────────────── */
head('第一部分 · 基础驱动（渲染层桥）');

line(`\n[${n()}] browser_status — 连接与页面状态`);
const st0 = await op('status', {}, 20_000);
line('     ' + brief(st0));

line(`\n[${n()}] browser_open — 打开真实站点（复用优先，不会堆标签）`);
const opened = await op('open', { url: 'https://www.deepseek.com/harness/' }, 90_000);
line('     ' + brief(opened));
await new Promise((r) => setTimeout(r, 1500));

line(`\n[${n()}] browser_read mode=ax — 语义树（核心「看页面」方式，带稳定 ref）`);
const ax = await op('ax', { max: 24 }, 60_000);
line(`     节点 ${ax.count} 个，可交互 ${(ax.nodes || []).filter((x) => x.interactive).length} 个：`);
for (const l of String(ax.text).split('\n').slice(0, 8)) line('       ' + l);

line(`\n[${n()}] browser_read mode=text — 可见正文`);
const txt = await op('read', { mode: 'text', maxChars: 400 }, 60_000);
line(`     ${txt.text.length} 字符：${txt.text.replace(/\n/g, ' ').slice(0, 90)}…`);

line(`\n[${n()}] browser_read mode=links — 链接清单`);
const links = await op('read', { mode: 'links' }, 60_000);
line(`     ${links.count} 条，示例：${brief(links.links?.[0])}`);

line(`\n[${n()}] browser_read mode=dom — 简化 DOM`);
const dom = await op('read', { mode: 'dom', maxChars: 600 }, 60_000);
line(`     ${dom.count} 个节点`);

line(`\n[${n()}] browser_assets — 资源清单 + WebMCP 探测`);
const assets = await op('assets', {}, 60_000);
line(`     counts=${brief(assets.counts, 90)}  webmcp=${brief(assets.webmcp, 60)}`);

line(`\n[${n()}] browser_network — 网络观测（安装 fetch/XHR 钩子）`);
const net = await op('network', { install: true, max: 5 }, 60_000);
line(`     资源 ${net.resourceCount} 个，域名 ${Object.keys(net.byOrigin || {}).length} 个，钩子=${net.hookInstalled}`);

line(`\n[${n()}] browser_viewport — 缩放 / 样式注入 / 还原`);
const vp1 = await op('viewport', { zoom: 1.1 }, 20_000);
line(`     zoom → ${vp1.zoom}   rect=${vp1.rect.w}x${vp1.rect.h}`);
const vp2 = await op('viewport', { css: 'body{outline:3px solid rgba(37,99,235,.55)}' }, 20_000);
line(`     注入 CSS → key=${vp2.cssKey}`);
await op('viewport', { reset: true }, 20_000);
line('     已还原');

line(`\n[${n()}] browser_tabs — 标签页管理`);
let tabs = await op('tabs', { action: 'list' }, 20_000);
line(`     ${tabs.count} 个标签：` + tabs.tabs.map((t) => `${t.active ? '●' : '○'}${t.title.slice(0, 22)}`).join('  '));

/* ────────────────── 第二部分：CDP 原生协议 ────────────────── */
head('第二部分 · CDP 原生协议（外部调试端口）');

line(`\n[${n()}] 端口探测`);
const cdp = await probeCdp(9222);
line(`     ${cdp.browser}  protocol=${cdp.protocolVersion}`);

line(`\n[${n()}] target 发现（webview guest 作为独立 target）`);
const targets = await listTargets(9222);
for (const t of targets) line(`     [${t.type.padEnd(8)}] ${(t.title || '').slice(0, 34).padEnd(36)} ${t.url.slice(0, 44)}`);

const target = await pickTarget(9222);
const s = new CdpSession(target.wsUrl);
await s.connect();
line(`     已连接 webview target`);

line(`\n[${n()}] CDP Runtime.evaluate — 原生 JS 求值`);
const ev = await s.send('Runtime.evaluate', { expression: '({title: document.title, links: document.querySelectorAll("a").length, ua: navigator.userAgent.slice(-24)})', returnByValue: true });
line('     ' + brief(ev.result.value));

line(`\n[${n()}] CDP Page.captureScreenshot — 原生截图`);
const shot1 = await s.send('Page.captureScreenshot', { format: 'png' }, 15_000);
const f1 = path.join(OUT, 'demo-cdp-native.png');
fs.writeFileSync(f1, Buffer.from(shot1.data, 'base64'));
line(`     ✅ ${path.basename(f1)}  ${fs.statSync(f1).size} 字节`);

line(`\n[${n()}] CDP Input.dispatchMouseEvent — 真实输入（isTrusted 验证）`);
await s.send('Runtime.evaluate', {
  expression: `window.__t=[]; ['pointerdown','mousedown','mouseup','click'].forEach(t=>document.addEventListener(t,e=>window.__t.push({t:e.type,trusted:e.isTrusted}),true)); 'ok'`,
  returnByValue: true,
});
const pt = (await s.send('Runtime.evaluate', { expression: '({x: 30, y: Math.round(innerHeight/2)})', returnByValue: true })).result.value;
await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 });
await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
await new Promise((r) => setTimeout(r, 400));
const got = (await s.send('Runtime.evaluate', { expression: 'window.__t', returnByValue: true })).result.value ?? [];
line(`     页面收到 ${got.length} 个事件：` + got.map((e) => `${e.t}(trusted=${e.trusted})`).join(' '));

line(`\n[${n()}] CDP Input.insertText — 真实文本输入`);
await s.send('Runtime.evaluate', {
  expression: `(()=>{let i=document.getElementById('__d');if(!i){i=document.createElement('input');i.id='__d';i.style.cssText='position:fixed;left:8px;top:8px;z-index:2147483647';document.body.appendChild(i);}i.value='';i.focus();return true})()`,
  returnByValue: true,
});
await s.send('Input.insertText', { text: 'DSH 真实输入' });
await new Promise((r) => setTimeout(r, 250));
const typed = (await s.send('Runtime.evaluate', { expression: `(document.getElementById('__d')||{}).value`, returnByValue: true })).result.value;
line(`     input.value = ${JSON.stringify(typed)}`);

line(`\n[${n()}] CDP Network.enable — 全量请求事件（有头有体）`);
await s.send('Network.enable', {});
await s.send('Page.navigate', { url: 'https://example.com/' });
await new Promise((r) => setTimeout(r, 2500));
const ne = s.takeEvents('Network.');
const reqs = ne.filter((e) => e.method === 'Network.requestWillBeSent');
line(`     ${ne.length} 个 Network.* 事件，请求 ${reqs.length} 个：`);
for (const e of reqs.slice(0, 3)) line(`       ${e.params?.request?.method} ${String(e.params?.request?.url).slice(0, 60)}`);

line(`\n[${n()}] CDP Emulation — UA 覆盖`);
await s.send('Emulation.setUserAgentOverride', { userAgent: 'DSH-Demo/1.0' });
await new Promise((r) => setTimeout(r, 300));
const ua = (await s.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.value;
line(`     UA → ${ua}`);
await s.send('Emulation.setUserAgentOverride', { userAgent: '' });

line(`\n[${n()}] CDP Page.getNavigationHistory — 历史读取`);
const hist = await s.send('Page.getNavigationHistory', {}, 10_000);
line(`     currentIndex=${hist.currentIndex} total=${hist.entries.length}`);
for (const [i, e] of hist.entries.entries()) line(`       [${i}]${i === hist.currentIndex ? '●' : '○'} ${e.title.slice(0, 28)} — ${e.url.slice(0, 46)}`);
s.close();

/* ────────────────── 第三部分：多实例 + 虚拟鼠标 ────────────────── */
head('第三部分 · 多浏览器实例（租约 API）+ 虚拟鼠标');

line(`\n[${n()}] browser_instance create（visible=true → 右下角浮层）`);
const inst = await op('instance', { action: 'create', url: 'https://example.com/', visible: true }, 90_000);
line(`     实例 ${inst.id.slice(0, 8)}…  当前实例数=${inst.count}  已自动切到它`);
await new Promise((r) => setTimeout(r, 1200));
const stInst = await op('status', {}, 20_000);
line(`     status 显示（应指向新实例）: ${brief(stInst)}`);

line(`\n[${n()}] 在实例上按 ref 点击（带虚拟鼠标）`);
const ax2 = await op('ax', { max: 30 }, 40_000);
const linkRef = (ax2.nodes || []).find((x) => x.role === 'link');
line(`     目标 ref=${linkRef.ref} "${linkRef.name}"`);
const clk = await op('click', { ref: linkRef.ref, hoverOnly: true }, 40_000);
line(`     悬停 → ${brief(clk)}`);
const cursor = (await op('eval', { code: `const c=document.getElementById('__dsh_cursor'); return {present: !!c, pos: c ? c.style.transform : null};` })).result;
line(`     虚拟鼠标: ${brief(cursor)}`);

line(`\n[${n()}] 截图：包含虚拟鼠标的浮层实例`);
{
  const tl = await listTargets(9222);
  const vt = tl.filter((t) => t.type === 'webview').pop();
  const s2 = new CdpSession(vt.wsUrl);
  await s2.connect();
  try {
    const sh = await s2.send('Page.captureScreenshot', { format: 'png' }, 12_000);
    const f2 = path.join(OUT, 'demo-instance.png');
    fs.writeFileSync(f2, Buffer.from(sh.data, 'base64'));
    line(`     ✅ ${path.basename(f2)}  ${fs.statSync(f2).size} 字节`);
  } catch (e) {
    line(`     ❌ ${e.message}`);
  }
  s2.close();
}

line(`\n[${n()}] browser_instance select(null) → 切回侧边栏，然后 close`);
await op('instance', { action: 'select', id: null }, 20_000);
const back = await op('status', {}, 20_000);
line(`     切回后 status: ${brief(back)}`);
const closed = await op('instance', { action: 'close', id: inst.id }, 40_000);
line(`     已关闭，剩余实例 ${closed.count}`);

/* ────────────────── 第四部分：完整任务闭环 ────────────────── */
head('第四部分 · 完整任务闭环：搜一个关键词并读结果');

line(`\n[${n()}] open 必应`);
await op('open', { url: 'https://cn.bing.com/' }, 90_000);
await new Promise((r) => setTimeout(r, 2000));

line(`\n[${n()}] AX 快照找搜索框`);
const ax3 = await op('ax', { max: 80 }, 60_000);
const box = (ax3.nodes || []).find((x) => x.role === 'searchbox' || x.role === 'textbox');
line(`     ref=${box.ref} role=${box.role} "${box.name}"`);

line(`\n[${n()}] 按 ref 输入关键词并回车提交`);
const typ = await op('type', { ref: box.ref, text: 'DeepSeek Harness', submit: true }, 90_000);
line(`     ${brief(typ)}`);
await new Promise((r) => setTimeout(r, 3500));

line(`\n[${n()}] 读取结果页（URL + 标题 + 首条结果）`);
const st3 = await op('status', {}, 20_000);
line(`     url=${st3.url.slice(0, 70)}`);
line(`     title=${st3.title}`);
const res = await op('read', { mode: 'dom', selector: '#b_results h2', maxChars: 2000 }, 60_000);
if (res.nodes?.length) line(`     首条结果：${res.nodes[0].text.replace(/\n/g, ' ').slice(0, 70)}`);

line(`\n[${n()}] CDP 截图收尾`);
{
  const tl = await listTargets(9222);
  const vt = tl.filter((t) => t.type === 'webview').pop();
  const s3 = new CdpSession(vt.wsUrl);
  await s3.connect();
  try {
    const sh = await s3.send('Page.captureScreenshot', { format: 'png' }, 12_000);
    const f3 = path.join(OUT, 'demo-final.png');
    fs.writeFileSync(f3, Buffer.from(sh.data, 'base64'));
    line(`     ✅ ${path.basename(f3)}  ${fs.statSync(f3).size} 字节`);
  } catch (e) {
    line(`     ❌ ${e.message}`);
  }
  s3.close();
}

head('演示结束');
line(`  截图产物：demo-cdp-native.png / demo-instance.png / demo-final.png`);
line(`  共演示 ${step} 个能力点`);
