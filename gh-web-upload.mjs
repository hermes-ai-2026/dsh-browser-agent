/**
 * 用 **DSH 内置浏览器** 驱动 GitHub 网页版完成：登录 → 建仓库 → 上传文件。
 * 全程可视化（虚拟鼠标 + 截图），不需要 token（网页登录用账号密码）。
 *
 * 用法：
 *   node gh-web-upload.mjs login           # 第 1 步：打开登录页并填表
 *   node gh-web-upload.mjs submit          # 第 2 步：提交登录（可能要验证码）
 *   node gh-web-upload.mjs code <验证码>    # 第 3 步：需要时填验证码
 *   node gh-web-upload.mjs create          # 建仓库
 *   node gh-web-upload.mjs upload          # 上传全部文件
 *   node gh-web-upload.mjs status          # 看当前页面状态
 */
import fs from 'node:fs';
import path from 'node:path';
import { CdpSession, pickTarget } from './lib/cdp.js';

const BRIDGE = 'http://127.0.0.1:8791';
const H = { 'content-type': 'application/json', 'x-dsh-browser-agent': 'dsh-browser-agent-local-bridge-v1' };
const REPO = 'dsh-browser-agent';
const ROOT = process.cwd();

async function op(o, args = {}, timeoutMs = 90_000) {
  const res = await fetch(`${BRIDGE}/debug/exec`, { method: 'POST', headers: H, body: JSON.stringify({ op: o, args, timeoutMs }) });
  const b = await res.json().catch(() => null);
  if (!res.ok) throw new Error(b?.error ?? `HTTP ${res.status}`);
  return b.data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

/** 读页面状态。 */
async function pageState() {
  const r = await op('eval', {
    code: `return {
      url: location.href, title: document.title,
      bodyLen: (document.body && document.body.innerText || '').length,
      err: location.href.startsWith('chrome-error'),
      text: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 220),
    };`,
  });
  return r.result;
}

/**
 * 打开 URL 并**重试到成功**。
 *
 * 为什么需要：本机对 github.com 是**概率性 TLS 重置**（实测 4 次里成功 1 次），
 * 而 api.github.com 是 100% 通。靠重试把页面拿到手；登录后的 cookie 会保留，
 * 后续导航成功率大幅提升。
 */
async function openRetry(url, maxTries = 14, label = '') {
  for (let i = 1; i <= maxTries; i++) {
    const target = i === 1 ? url : `${url}${url.includes('?') ? '&' : '?'}_r=${i}`;
    await op('open', { url: target }, 90_000);
    await sleep(3200);
    const st = await pageState();
    if (!st.err && st.bodyLen > 40) {
      if (i > 1) ok(`${label || url} 第 ${i} 次尝试成功`);
      return st;
    }
    process.stdout.write(`\r  ⏳ ${label || url} 第 ${i}/${maxTries} 次被重置…   `);
    await sleep(500);
  }
  console.log('');
  return null;
}

/** 用语义树找元素，返回 ref。 */
async function findRef(matchers) {
  const ax = await op('ax', { max: 220 });
  for (const n of ax.nodes || []) {
    const hay = `${n.name ?? ''} ${n.tag ?? ''}`.toLowerCase();
    if (matchers.some((m) => hay.includes(String(m).toLowerCase()))) return n;
  }
  return null;
}

function collect(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.github'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, base, out);
    else if (!/\.(png|log|tmp)$/i.test(e.name) && !/^(visual-upload|gh-web-upload|publish-github)\.mjs$/.test(e.name)) {
      out.push(path.resolve(full));
    }
  }
  return out;
}

const cmd = process.argv[2] ?? 'status';

// ── status ────────────────────────────────────────────────────────────────
if (cmd === 'status') {
  const s = await pageState();
  console.log(JSON.stringify(s, null, 2));
}

// ── login：打开登录页并填表 ────────────────────────────────────────────────
if (cmd === 'login') {
  step('打开 GitHub 登录页（github.com 是概率性阻断，会自动重试）');
  let s = await openRetry('https://github.com/login', 16, 'github.com/login');
  if (!s) { bad('重试 16 次仍被重置 —— 稍后再试'); process.exit(1); }
  ok(`已加载：${s.title}`);
  console.log('  页面首行:', s.text.slice(0, 120));

  step('在语义树里找输入框');
  const ax = await op('ax', { max: 220 });
  const userField = (ax.nodes || []).find((n) => /login|username|email|用户名/i.test(`${n.name} ${n.tag}`) && /input|textbox/.test(n.role + n.tag));
  const passField = (ax.nodes || []).find((n) => /password|密码/i.test(`${n.name} ${n.tag}`) && /input|textbox/.test(n.role + n.tag));
  const btn = (ax.nodes || []).find((n) => n.role === 'button' && /sign in|登录/i.test(n.name));
  console.log(`   用户名框: ${userField ? userField.ref + ' "' + userField.name + '"' : '未找到'}`);
  console.log(`   密码框  : ${passField ? passField.ref + ' "' + passField.name + '"' : '未找到'}`);
  console.log(`   登录按钮: ${btn ? btn.ref + ' "' + btn.name + '"' : '未找到'}`);
  if (!userField || !passField) { bad('登录表单未识别'); process.exit(1); }

  step('填入用户名与密码（浏览器里能看到虚拟鼠标在动）');
  await op('type', { ref: userField.ref, text: process.env.GH_USER ?? 'hermes-ai-2026' }, 60_000);
  ok('用户名已填');
  await op('type', { ref: passField.ref, text: process.env.GH_PASS ?? '' }, 60_000);
  ok('密码已填');

  step('点击 Sign in');
  if (btn) await op('click', { ref: btn.ref }, 60_000);
  else await op('press', { key: 'Enter' }, 30_000).catch(() => {});
  await sleep(5000);
  s = await pageState();
  console.log('  当前：', JSON.stringify(s, null, 2).slice(0, 500));
}

// ── code：验证码 ──────────────────────────────────────────────────────────
if (cmd === 'code') {
  const code = process.argv[3];
  if (!code) { bad('用法：node gh-web-upload.mjs code 123456'); process.exit(1); }
  step('在验证码输入框里填入');
  const f = await findRef(['verification', 'code', 'otp', '验证码', 'device']);
  if (!f) { bad('没找到验证码输入框（可能已经登录成功）'); process.exit(1); }
  await op('type', { ref: f.ref, text: code }, 60_000);
  const btn = await findRef(['verify', 'submit', 'continue', 'confirm', '验证']);
  if (btn && btn.role === 'button') await op('click', { ref: btn.ref }, 60_000);
  else await op('press', { key: 'Enter' }, 30_000).catch(() => {});
  await sleep(5000);
  console.log('  当前：', JSON.stringify(await pageState(), null, 2).slice(0, 400));
}

// ── create：建仓库 ────────────────────────────────────────────────────────
if (cmd === 'create') {
  step('打开新建仓库页');
  await op('open', { url: 'https://github.com/new' }, 90_000);
  await sleep(4500);
  const s = await pageState();
  if (s.err) { bad('打不开'); process.exit(1); }
  ok(s.title);

  step('填仓库名');
  const nameField = await findRef(['repository name', '仓库名称', 'repo name']);
  if (!nameField) { bad('没找到仓库名输入框'); process.exit(1); }
  await op('type', { ref: nameField.ref, text: REPO }, 60_000);
  ok(`仓库名 = ${REPO}`);

  step('填描述（可选）');
  const descField = await findRef(['description', '描述']);
  if (descField && /textbox|input/.test(descField.role + descField.tag)) {
    await op('type', { ref: descField.ref, text: process.env.GH_DESC ?? 'DSH browser agent plugin', clear: false }, 60_000);
    ok('描述已填');
  }

  step('点 Create repository');
  const btn = await findRef(['create repository', '创建仓库']);
  if (!btn) { bad('没找到创建按钮'); process.exit(1); }
  await op('click', { ref: btn.ref }, 60_000);
  await sleep(6000);
  console.log('  当前：', JSON.stringify(await pageState(), null, 2).slice(0, 400));
}

// ── upload：用 CDP 给 file input 塞文件 ───────────────────────────────────
if (cmd === 'upload') {
  const files = collect(ROOT);
  step(`准备上传 ${files.length} 个文件`);
  for (const f of files.slice(0, 5)) console.log('   ', path.relative(ROOT, f));
  console.log('    …');

  let s = await pageState();
  if (!/upload/i.test(s.url)) {
    step('跳到上传页');
    await op('open', { url: `https://github.com/hermes-ai-2026/${REPO}/upload/main` }, 90_000);
    await sleep(5000);
    s = await pageState();
  }
  console.log('  当前页面:', s.url);

  step('通过 CDP 把文件塞进 <input type=file>');
  const target = await pickTarget(9222);
  if (!target) { bad('没有 webview target'); process.exit(1); }
  const cdp = new CdpSession(target.wsUrl);
  await cdp.connect();
  await cdp.send('DOM.enable', {});
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, 20_000);
  const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, 15_000);
  if (!input?.nodeId) { bad('页面上没有 file input（可能没进到上传页）'); cdp.close(); process.exit(1); }
  ok(`找到 file input (nodeId=${input.nodeId})`);
  await cdp.send('DOM.setFileInputFiles', { files, nodeId: input.nodeId }, 30_000);
  ok('文件已注入，页面正在加载文件列表');
  await sleep(9000);

  s = await pageState();
  console.log('  页面反馈:', s.text.slice(0, 300));
  cdp.close();

  step('下一步：点 Commit changes 提交');
  console.log('   请确认文件列表正确后运行：node gh-web-upload.mjs commit');
}

// ── commit ────────────────────────────────────────────────────────────────
if (cmd === 'commit') {
  const btn = await findRef(['commit changes', '提交更改']);
  if (!btn) { bad('没找到 Commit 按钮'); process.exit(1); }
  step('点击 Commit changes');
  await op('click', { ref: btn.ref }, 60_000);
  await sleep(8000);
  console.log('  当前：', JSON.stringify(await pageState(), null, 2).slice(0, 400));
}
