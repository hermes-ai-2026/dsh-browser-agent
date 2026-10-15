/**
 * 第 2 步：用内置浏览器建仓库（带重试，因为 github.com 是概率性阻断）。
 * 用法：node step2-create.mjs
 */
const BRIDGE = 'http://127.0.0.1:8791';
const H = { 'content-type': 'application/json', 'x-dsh-browser-agent': 'dsh-browser-agent-local-bridge-v1' };
const REPO = 'dsh-browser-agent';
const DESC = 'Give DeepSeek Harness agents a real browser: 19 browser_* tools driving the built-in sidebar browser. Zero runtime deps.';

async function op(o, args = {}, timeoutMs = 90_000) {
  const res = await fetch(`${BRIDGE}/debug/exec`, { method: 'POST', headers: H, body: JSON.stringify({ op: o, args, timeoutMs }) });
  const b = await res.json().catch(() => null);
  if (!res.ok) throw new Error(b?.error ?? `HTTP ${res.status}`);
  return b.data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

async function state() {
  const r = await op('eval', {
    code: `return {url: location.href, title: document.title, err: location.href.startsWith('chrome-error'),
      len: (document.body && document.body.innerText || '').length,
      text: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0,260)};`,
  });
  return r.result;
}

async function openRetry(url, tries = 16, label = '') {
  for (let i = 1; i <= tries; i++) {
    await op('open', { url: i === 1 ? url : `${url}${url.includes('?') ? '&' : '?'}_r=${i}` }, 90_000);
    await sleep(3400);
    const s = await state();
    if (!s.err && s.len > 40) { if (i > 1) ok(`${label} 第 ${i} 次成功`); return s; }
    process.stdout.write(`\r  ⏳ ${label} ${i}/${tries} 被重置…   `);
    await sleep(400);
  }
  console.log('');
  return null;
}

async function ax() {
  const r = await op('ax', { max: 260 });
  return r.nodes || [];
}

console.log('\x1b[36m▶ 打开「新建仓库」页\x1b[0m');
const s = await openRetry('https://github.com/new', 18, 'github.com/new');
if (!s) { bad('重试耗尽'); process.exit(1); }
ok(s.title);
console.log('  页面首行:', s.text.slice(0, 150));

console.log('\n\x1b[36m▶ 定位表单\x1b[0m');
const nodes = await ax();
const nameNode = nodes.find((n) => /repository name|仓库名称/i.test(`${n.name} ${n.tag}`));
const descNode = nodes.find((n) => /description|描述/i.test(`${n.name} ${n.tag}`) && /textbox|textarea|input/.test(n.role + n.tag));
const createBtn = nodes.find((n) => n.role === 'button' && /create repository|创建仓库/i.test(n.name));
console.log(`  仓库名输入框: ${nameNode ? nameNode.ref + ' "' + nameNode.name + '"' : '未找到'}`);
console.log(`  描述输入框  : ${descNode ? descNode.ref + ' "' + descNode.name + '"' : '未找到'}`);
console.log(`  创建按钮    : ${createBtn ? createBtn.ref + ' "' + createBtn.name + '"' : '未找到'}`);
if (!nameNode) { bad('没找到仓库名输入框'); process.exit(1); }

console.log('\n\x1b[36m▶ 填仓库名（浏览器里能看到虚拟鼠标）\x1b[0m');
await op('type', { ref: nameNode.ref, text: REPO }, 60_000);
ok(`仓库名 = ${REPO}`);

if (descNode) {
  console.log('\n\x1b[36m▶ 填描述\x1b[0m');
  await op('type', { ref: descNode.ref, text: DESC, clear: false }, 60_000);
  ok('描述已填');
}

console.log('\n\x1b[36m▶ 点 Create repository\x1b[0m');
if (!createBtn) { bad('没找到创建按钮，手动确认后继续'); process.exit(1); }
await op('click', { ref: createBtn.ref }, 60_000);
await sleep(9000);
const after = await state();
console.log('  结果:', JSON.stringify({ url: after.url, title: after.title, err: after.err }, null, 2));
console.log('  页面首行:', after.text.slice(0, 200));
if (/\/hermes-ai-2026\/dsh-browser-agent/.test(after.url) || /Quick setup|quick setup/i.test(after.text)) {
  ok('仓库创建成功');
} else if (after.err) {
  bad('页面被重置，重试一次');
  const retry = await openRetry(`https://github.com/hermes-ai-2026/${REPO}`, 12, '仓库页');
  if (retry && /dsh-browser-agent/.test(retry.url)) ok('仓库已存在（创建其实成功了）');
} else {
  console.log('  ⚠️ 状态不确定，请看上面 URL');
}
