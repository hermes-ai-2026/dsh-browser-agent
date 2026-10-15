/**
 * 通过 GitHub REST API 发布仓库（无需 git push、无需浏览器登录）。
 *
 * 为什么走 API：本机 `github.com` 与 `codeload.github.com` **网络层不通**，
 * 但 `api.github.com` 可达。所以用 Contents API 逐文件上传。
 *
 * 用法：
 *   $env:GITHUB_TOKEN="ghp_xxx"; node publish-github.mjs            # 真发布
 *   $env:GITHUB_TOKEN="ghp_xxx"; node publish-github.mjs --dry-run  # 只演练
 */
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GITHUB_OWNER ?? 'hermes-ai-2026';
const REPO = process.env.GITHUB_REPO ?? 'dsh-browser-agent';
const DRY = process.argv.includes('--dry-run');
const DESC =
  'Give DeepSeek Harness agents a real browser: 19 browser_* tools driving the built-in sidebar browser — accessibility-tree refs, real CDP input, screenshots, network interception, device emulation, cookie vault, document-start injection, multi-instance, raw CDP passthrough. Zero runtime deps.';
const API = 'https://api.github.com';

if (!TOKEN && !DRY) {
  console.error('缺少 GITHUB_TOKEN。用法：$env:GITHUB_TOKEN="ghp_xxx"; node publish-github.mjs');
  process.exit(1);
}
const H = {
  'User-Agent': 'dsh-publish',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { ...H, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, json };
}

/** 收集要上传的文件（排除 .git / node_modules / 演示产物）。 */
function collect(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.github'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, base, out);
    else if (!/\.(png|log|tmp)$/i.test(entry.name)) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

console.log('① 校验 token 与身份');
if (TOKEN) {
  const me = await api('GET', '/user');
  if (!me.ok) {
    console.error(`   ❌ token 无效（HTTP ${me.status}）：${JSON.stringify(me.json).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`   ✅ 已认证：${me.json.login}`);
  const scopes = me.json.login ? '（scope 见响应头，classic token 需 repo 权限）' : '';
  console.log(`   ${scopes}`);
} else {
  console.log('   （dry-run，跳过认证）');
}

console.log('\n② 创建或复用仓库');
let created = false;
if (DRY) {
  console.log(`   （dry-run）将创建 ${OWNER}/${REPO}`);
} else {
  const r = await api('POST', '/user/repos', {
    name: REPO,
    description: DESC,
    homepage: `https://github.com/${OWNER}/${REPO}`,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  });
  if (r.ok) { created = true; console.log(`   ✅ 已创建 ${r.json.full_name}`); }
  else if (r.status === 422) {
    console.log(`   ℹ️ 仓库已存在，继续上传`);
    const ex = await api('GET', `/repos/${OWNER}/${REPO}`);
    if (!ex.ok) { console.error(`   ❌ 读不到仓库：HTTP ${ex.status}`); process.exit(1); }
  } else {
    console.error(`   ❌ 创建失败 HTTP ${r.status}：${JSON.stringify(r.json).slice(0, 300)}`);
    console.error('   提示：classic token 需要 repo 权限；fine-grained 需要 Administration: Read and write。');
    process.exit(1);
  }
}

console.log('\n③ 上传文件');
const files = collect(process.cwd());
console.log(`   共 ${files.length} 个文件`);
let okCount = 0, skipCount = 0, failCount = 0;
for (const rel of files) {
  const content = fs.readFileSync(path.join(process.cwd(), rel));
  const b64 = content.toString('base64');
  if (DRY) {
    console.log(`   [dry] ${rel.padEnd(52)} ${content.length} B`);
    okCount += 1;
    continue;
  }
  // 已存在则需带 sha 才能更新
  let sha = null;
  const cur = await api('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}`);
  if (cur.ok && cur.json?.sha) sha = cur.json.sha;

  const r = await api('PUT', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}`, {
    message: sha ? `update: ${rel}` : `add: ${rel}`,
    content: b64,
    ...(sha ? { sha } : {}),
  });
  if (r.ok) { okCount += 1; console.log(`   ✅ ${rel}`); }
  else { failCount += 1; console.log(`   ❌ ${rel}  HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`); }
  await new Promise((r2) => setTimeout(r2, 250));
}

console.log('\n④ 结果');
console.log(`   成功 ${okCount} / 跳过 ${skipCount} / 失败 ${failCount}`);
if (!DRY && failCount === 0) {
  console.log(`\n🎉 https://github.com/${OWNER}/${REPO}`);
  console.log(`   安装：dsh plugin --profile desktop add github:${OWNER}/${REPO}`);
}
