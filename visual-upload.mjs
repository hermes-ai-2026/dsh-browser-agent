/**
 * 可视化上传台 —— 在 **DSH 内置浏览器** 里实时显示把仓库上传到 GitHub 的全过程。
 *
 * 为什么需要它：本机 `github.com` 连接层被封（TCP/TLS 都不通），
 * 无法用浏览器登录 GitHub 网页上传。但 `api.github.com` 可达，
 * 于是做一个本地页面，在浏览器里**可视化**地跑真实上传。
 *
 * 用法：
 *   $env:GITHUB_TOKEN="ghp_xxx"; node visual-upload.mjs
 *   然后在内置浏览器打开 http://127.0.0.1:8799/
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.VISUAL_UPLOAD_PORT) || 8799;
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const OWNER = process.env.GITHUB_OWNER ?? 'hermes-ai-2026';
const REPO = process.env.GITHUB_REPO ?? 'dsh-browser-agent';
const ROOT = process.cwd();
const API = 'https://api.github.com';

const DESC =
  'Give DeepSeek Harness agents a real browser: 19 browser_* tools driving the built-in sidebar browser — accessibility-tree refs, real CDP input, screenshots, network interception, device emulation, cookie vault, document-start injection, multi-instance, raw CDP passthrough. Zero runtime deps.';

function collect(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.github'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, base, out);
    else if (!/\.(png|log|tmp)$/i.test(e.name) && e.name !== 'visual-upload.mjs') out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

const gh = async (method, route, body) => {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      'User-Agent': 'dsh-visual-upload',
      Accept: 'application/vnd.github+json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, json };
};

const PAGE = (files) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>dsh-browser-agent → GitHub 上传台</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 ui-sans-serif,"Segoe UI","Microsoft YaHei",sans-serif;
         background:#0d1117; color:#e6edf3; }
  header { padding:20px 26px; border-bottom:1px solid #21262d; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  h1 { font-size:17px; margin:0; font-weight:600; }
  .badge { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid #30363d; color:#8b949e; }
  .badge.ok { border-color:#238636; color:#3fb950; background:#0f2a17; }
  .badge.warn { border-color:#9e6a03; color:#d29922; background:#2b2200; }
  main { padding:22px 26px 40px; max-width:1080px; }
  #bar { height:8px; background:#21262d; border-radius:999px; overflow:hidden; margin:14px 0 6px; }
  #fill { height:100%; width:0%; background:linear-gradient(90deg,#238636,#3fb950); transition:width .25s; }
  #stat { color:#8b949e; font-size:13px; }
  ul { list-style:none; padding:0; margin:18px 0 0; }
  li { display:flex; align-items:center; gap:10px; padding:7px 10px; border-bottom:1px solid #161b22; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  li .ico { width:18px; text-align:center; }
  li .sz { margin-left:auto; color:#6e7681; font-size:11.5px; }
  li.done { color:#3fb950; } li.fail { color:#f85149; } li.run { color:#d29922; }
  #log { margin-top:20px; background:#010409; border:1px solid #21262d; border-radius:8px; padding:12px 14px;
         font-family:ui-monospace,Consolas,monospace; font-size:12px; white-space:pre-wrap; max-height:230px; overflow:auto; color:#8b949e; }
  button { background:#238636; color:#fff; border:0; padding:9px 18px; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
  button:disabled { background:#21262d; color:#6e7681; cursor:default; }
  .row { display:flex; align-items:center; gap:14px; margin-top:6px; }
  code { background:#161b22; padding:2px 6px; border-radius:4px; font-size:12.5px; }
</style></head><body>
<header>
  <h1>dsh-browser-agent <span style="color:#6e7681">→</span> GitHub</h1>
  <span class="badge" id="auth">检测中…</span>
  <span class="badge">${OWNER}/${REPO}</span>
  <span class="badge">${files.length} 个文件</span>
</header>
<main>
  <div class="row">
    <button id="go" disabled>开始上传</button>
    <span id="stat">等待检测 token…</span>
  </div>
  <div id="bar"><div id="fill"></div></div>
  <ul id="list"></ul>
  <div id="log"></div>
</main>
<script>
const FILES = ${JSON.stringify(files.map((f) => ({ p: f, s: fs.statSync(path.join(ROOT, f)).size })))};
const list = document.getElementById('list');
const logEl = document.getElementById('log');
const fill = document.getElementById('fill');
const stat = document.getElementById('stat');
const go = document.getElementById('go');
const auth = document.getElementById('auth');

const rows = {};
for (const f of FILES) {
  const li = document.createElement('li');
  li.innerHTML = '<span class="ico">•</span><span>' + f.p + '</span><span class="sz">' + (f.s/1024).toFixed(1) + ' KB</span>';
  list.appendChild(li);
  rows[f.p] = li;
  li.scrollIntoView;
}
const log = (m) => { logEl.textContent += m + '\\n'; logEl.scrollTop = logEl.scrollHeight; };

(async () => {
  const h = await (await fetch('/status')).json();
  if (h.authed) {
    auth.textContent = '✅ token 有效 · ' + h.login;
    auth.className = 'badge ok';
    go.disabled = false;
    stat.textContent = '就绪，可以开始上传';
    log('认证成功：' + h.login);
  } else {
    auth.textContent = h.token ? '❌ token 无效' : '⚠️ 未提供 token';
    auth.className = 'badge warn';
    stat.textContent = h.token ? ('token 被拒绝：' + (h.error || '')) : '需要设置 GITHUB_TOKEN 环境变量后重启本脚本';
    log('未认证：' + (h.error || '缺少 GITHUB_TOKEN'));
  }
})();

go.onclick = async () => {
  go.disabled = true;
  let done = 0, failed = 0;
  log('--- 创建/复用仓库 ' + h_owner() + '/' + h_repo() + ' ---');
  const prep = await (await fetch('/prepare', { method: 'POST' })).json();
  log(prep.message);
  if (!prep.ok) { go.disabled = false; return; }

  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i].p;
    rows[f].className = 'run';
    rows[f].querySelector('.ico').textContent = '⏳';
    try {
      const r = await (await fetch('/upload', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ path: f }) })).json();
      if (r.ok) { rows[f].className = 'done'; rows[f].querySelector('.ico').textContent = '✅'; done++; }
      else { rows[f].className = 'fail'; rows[f].querySelector('.ico').textContent = '❌'; failed++; log('  ✗ ' + f + '  HTTP ' + r.status + ' ' + (r.error || '')); }
    } catch (e) { rows[f].className = 'fail'; rows[f].querySelector('.ico').textContent = '❌'; failed++; log('  ✗ ' + f + '  ' + e.message); }
    const pct = Math.round(((i + 1) / FILES.length) * 100);
    fill.style.width = pct + '%';
    stat.textContent = pct + '%  ·  成功 ' + done + ' / 失败 ' + failed + '  ·  ' + f;
  }
  stat.textContent = '完成：成功 ' + done + '，失败 ' + failed;
  log('--- 完成 ---');
  log('仓库：https://github.com/' + h_owner() + '/' + h_repo());
  log('安装：dsh plugin --profile desktop add github:' + h_owner() + '/' + h_repo());
  if (failed === 0) { fill.style.background = 'linear-gradient(90deg,#238636,#3fb950)'; }
};
function h_owner(){ return ${JSON.stringify(OWNER)}; }
function h_repo(){ return ${JSON.stringify(REPO)}; }
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE(collect(ROOT)), 'text/html; charset=utf-8');

  if (req.method === 'GET' && url.pathname === '/status') {
    if (!TOKEN) return send(200, { authed: false, token: false });
    const me = await gh('GET', '/user');
    return send(200, me.ok ? { authed: true, login: me.json.login } : { authed: false, token: true, error: `HTTP ${me.status}` });
  }

  if (req.method === 'POST' && url.pathname === '/prepare') {
    if (!TOKEN) return send(200, { ok: false, message: '缺少 token' });
    const r = await gh('POST', '/user/repos', {
      name: REPO, description: DESC, homepage: `https://github.com/${OWNER}/${REPO}`,
      private: false, has_issues: true, has_wiki: false, has_projects: false, auto_init: false,
    });
    if (r.ok) return send(200, { ok: true, message: '✅ 已创建 ' + r.json.full_name });
    if (r.status === 422) return send(200, { ok: true, message: 'ℹ️ 仓库已存在，继续上传' });
    return send(200, { ok: false, message: `❌ 建仓库失败 HTTP ${r.status}：${JSON.stringify(r.json).slice(0, 200)}` });
  }

  if (req.method === 'POST' && url.pathname === '/upload') {
    let body = '';
    for await (const c of req) body += c;
    const rel = JSON.parse(body || '{}').path;
    if (!rel || !fs.existsSync(path.join(ROOT, rel))) return send(200, { ok: false, status: 400, error: '文件不存在' });
    const content = fs.readFileSync(path.join(ROOT, rel)).toString('base64');
    let sha = null;
    const cur = await gh('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}`);
    if (cur.ok && cur.json?.sha) sha = cur.json.sha;
    const r = await gh('PUT', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}`, {
      message: (sha ? 'update: ' : 'add: ') + rel, content, ...(sha ? { sha } : {}),
    });
    return send(200, { ok: r.ok, status: r.status, error: r.ok ? null : JSON.stringify(r.json).slice(0, 160) });
  }

  send(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`可视化上传台已启动：http://127.0.0.1:${PORT}/`);
  console.log(`  仓库：${OWNER}/${REPO}`);
  console.log(`  文件：${collect(ROOT).length} 个`);
  console.log(`  token：${TOKEN ? '已提供' : '❌ 未提供（页面会提示）'}`);
});
