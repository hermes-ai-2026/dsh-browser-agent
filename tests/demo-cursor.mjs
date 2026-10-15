/**
 * 虚拟鼠标"巡游"：只悬停（hoverOnly），不点击。
 * 依次把指针移到页面上几个不同元素，最后停在一个显眼位置。
 *
 * 运行：node demo-cursor.mjs
 */
const BRIDGE = 'http://127.0.0.1:8791';
const H = { 'content-type': 'application/json', 'x-dsh-browser-agent': 'dsh-browser-agent-local-bridge-v1' };

async function op(o, args = {}, timeoutMs = 60_000) {
  const res = await fetch(`${BRIDGE}/debug/exec`, { method: 'POST', headers: H, body: JSON.stringify({ op: o, args, timeoutMs }) });
  const b = await res.json().catch(() => null);
  if (!res.ok) throw new Error(b?.error ?? `HTTP ${res.status}`);
  return b.data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('① 准备页面（打开一个元素多的站点）');
console.log('   ', JSON.stringify(await op('open', { url: 'https://cn.bing.com/' }, 90_000)));
await sleep(2500);

console.log('\n② 把浏览器标签切到最前（并激活）');
const tabs = await op('tabs', { action: 'list' }, 20_000);
tabs.tabs.forEach((t) => console.log(`   [${t.index}] ${t.active ? '●' : '○'} ${t.title.slice(0, 30)}`));
const browserTab = tabs.tabs.find((t) => !t.title.includes('.md')) ?? tabs.tabs[0];
await op('tabs', { action: 'activate', index: browserTab.index }, 20_000);
await sleep(800);

console.log('\n③ AX 快照，挑几个显眼元素做巡游目标');
const ax = await op('ax', { max: 80 }, 60_000);
const picks = [];
const want = ['searchbox', 'link', 'button', 'menuitem'];
for (const role of want) {
  const hit = (ax.nodes || []).find((x) => x.role === role && x.box && x.box[2] > 20);
  if (hit) picks.push(hit);
}
if (picks.length === 0) { console.log('   没找到合适目标'); process.exit(1); }
picks.forEach((p) => console.log(`   ref=${p.ref.padEnd(5)} ${p.role.padEnd(10)} "${String(p.name).slice(0, 28)}" @${p.box[0]},${p.box[1]} ${p.box[2]}x${p.box[3]}`));

console.log('\n④ 开始巡游（只悬停，不点击）');
for (const [i, p] of picks.entries()) {
  const r = await op('click', { ref: p.ref, hoverOnly: true }, 40_000);
  const pos = await op('eval', { code: `const c=document.getElementById('__dsh_cursor'); const g=document.getElementById('__dsh_cursor_ring'); return {cursor: c?c.style.transform:null, ring: g?g.style.transform:null};` }, 20_000);
  console.log(`   ${i + 1}/${picks.length} → ${p.role} "${String(p.name).slice(0, 26)}"  指针 ${pos.result.cursor}  光环 ${pos.result.ring}  事件数=${r.pointerEvents}`);
  await sleep(1500); // 留时间让你看见
}

console.log('\n⑤ 停在搜索框上（保持可见，不点击）');
const box = picks.find((p) => p.role === 'searchbox') ?? picks[0];
await op('click', { ref: box.ref, hoverOnly: true }, 40_000);
const fin = await op('eval', { code: `const c=document.getElementById('__dsh_cursor'); const g=document.getElementById('__dsh_cursor_ring'); return {cursorId: !!c, ringId: !!g, cursor: c?c.style.transform:null, ring: g?g.style.transform:null, pointerNone: c?getComputedStyle(c).pointerEvents:null};` }, 20_000);
console.log('   ', JSON.stringify(fin.result));
console.log('\n✅ 指针已停在该元素上 —— 请看 DSH 右侧浏览器面板');
