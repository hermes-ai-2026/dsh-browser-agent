/**
 * 验证"优先级建议"里那四项是否真的已实现（文档那一节是旧的）。
 * 运行：node verify-priority4.mjs
 */
const BASE = 'http://127.0.0.1:8791';
const H = { 'content-type': 'application/json', 'x-dsh-browser-agent': 'dsh-browser-agent-local-bridge-v1' };

async function op(o, args = {}, timeoutMs = 60_000) {
  const res = await fetch(`${BASE}/debug/exec`, {
    method: 'POST', headers: H, body: JSON.stringify({ op: o, args, timeoutMs }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { __error: body?.error ?? `HTTP ${res.status}` };
  return body.data;
}

const pass = [], fail = [];
const check = (n, ok, d) => (ok ? pass : fail).push(`${n}${d ? ' — ' + d : ''}`);

// 准备：确保有页面
await op('open', { url: 'https://example.com/' }, 90_000);
await new Promise((r) => setTimeout(r, 1500));

console.log('① 完整指针事件序列 + hoverOnly');
const ax = await op('ax', { max: 40 });
const link = (ax.nodes || []).find((n) => n.role === 'link');
console.log('   目标 link ref =', link?.ref, JSON.stringify(link?.name));
// 在页面里挂探针记录指针事件
await op('eval', {
  code: `window.__pe = []; ['pointerover','mouseover','pointerenter','mouseenter','pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => document.addEventListener(t, e => window.__pe.push({t:e.type, trusted:e.isTrusted}), true)); return 'ok'`,
});
const hov = await op('click', { ref: link.ref, hoverOnly: true });
console.log('   click hoverOnly →', JSON.stringify(hov));
const afterHover = await op('eval', { code: `return window.__pe.map(e => e.t)` });
console.log('   页面收到:', JSON.stringify(afterHover.result));
check('hoverOnly 只发悬停序列（不发 click）',
  Array.isArray(afterHover.result) && afterHover.result.includes('pointerover') && !afterHover.result.includes('mousedown'),
  JSON.stringify(afterHover.result));

// ② 标签页 list / activate
console.log('\n② 标签页 list / activate');
const tabs = await op('tabs', { action: 'list' });
console.log('   list →', JSON.stringify(tabs.tabs));
check('tabs list 返回条目', Array.isArray(tabs.tabs) && tabs.tabs.length >= 1, `count=${tabs.count}`);
const act = await op('tabs', { action: 'activate', index: 0 });
check('tabs activate 可用', act?.ok === true && act?.target?.index === 0, JSON.stringify(act?.target));

// ③ 网络观测（Performance 回顾 + fetch/XHR 钩子）
console.log('\n③ 网络观测');
const netBefore = await op('network', { install: true });
check('network 安装 fetch/XHR 钩子', netBefore?.hookInstalled === true, `hook=${netBefore?.hookInstalled}`);
await op('eval', { code: `await fetch('https://example.com/favicon.ico', {mode:'no-cors'}).catch(()=>{}); return 'fired'`, }, 30_000);
await new Promise((r) => setTimeout(r, 800));
const netAfter = await op('network', {});
console.log('   资源总数 =', netAfter.resourceCount, ' 钩子捕获 =', netAfter.hooked?.length);
console.log('   钩子样本:', JSON.stringify((netAfter.hooked || []).slice(0, 2)));
check('network 回顾到资源条目', (netAfter?.resourceCount ?? 0) > 0, `count=${netAfter?.resourceCount}`);
check('network 钩子捕获到 fetch', (netAfter?.hooked?.length ?? 0) > 0, `hooked=${netAfter?.hooked?.length}`);
check('network 按域名汇总', Object.keys(netAfter?.byOrigin ?? {}).length > 0);

// ④ WebMCP 探测
console.log('\n④ WebMCP 探测（并入 assets）');
const assets = await op('assets', {});
console.log('   webmcp =', JSON.stringify(assets.webmcp));
check('assets 带 webmcp 字段', assets?.webmcp !== undefined && typeof assets.webmcp.present === 'boolean', JSON.stringify(assets?.webmcp));
console.log('   counts =', JSON.stringify(assets.counts));

console.log('\n================ 汇总 ================');
for (const p of pass) console.log('  ✅', p);
for (const f of fail) console.log('  ❌', f);
console.log(`通过 ${pass.length}，失败 ${fail.length}`);
