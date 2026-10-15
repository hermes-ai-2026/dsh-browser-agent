/**
 * 护栏单元测试（确定性，不依赖真实环境）：
 * 验证 pickTarget 在任何情况下都**不会**返回 DSH 外壳页面。
 *
 * 背景：曾因为没有 webview 而回退到外壳 target，一条 Page.navigate 把 DSH 界面导航成了 example.com。
 *
 * 运行：node verify-guard.mjs
 */
import { pickTarget } from './lib/cdp.js';

// 夹具要用 CDP 原始字段名 webSocketDebuggerUrl —— listTargets 映射后才是 wsUrl
const SHELL = { id: 'SHELL', type: 'page', title: 'DeepSeek Harness', url: 'dsh-app://app/', webSocketDebuggerUrl: 'ws://x/shell' };
const VIEW = { id: 'VIEW', type: 'webview', title: 'Example Domain', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://x/view' };

const realFetch = globalThis.fetch;

/** 用假的 /json/list 结果驱动 pickTarget。 */
async function withTargets(list, fn) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/json/list')) {
      return { ok: true, status: 200, json: async () => list };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const pass = [];
const fail = [];
const check = (name, ok, detail) => (ok ? pass : fail).push(`${name}${detail ? ' — ' + detail : ''}`);

// ① 只有外壳页面时（真实事故场景）：必须返回 null
const onlyShell = await withTargets([SHELL], () => pickTarget(9222));
check('只有外壳页面时返回 null（事故场景）', onlyShell === null, JSON.stringify(onlyShell));

// ② 外壳 + webview：必须选 webview
const both = await withTargets([SHELL, VIEW], () => pickTarget(9222));
check('有 webview 时选 webview', both?.id === 'VIEW', JSON.stringify(both));

// ③ hint 匹配不到时：不得掉到外壳
const noMatch = await withTargets([SHELL, VIEW], () => pickTarget(9222, 'https://nope.invalid/'));
check('hint 不匹配时回退到 webview（不是外壳）', noMatch?.id === 'VIEW', JSON.stringify(noMatch));

// ④ hint 指向外壳时：默认也不得命中
const shellHint = await withTargets([SHELL, VIEW], () => pickTarget(9222, 'dsh-app://app/'));
check('hint 指向外壳时默认不命中外壳', shellHint?.id !== 'SHELL', JSON.stringify(shellHint));

// ⑤ 显式 allowPage:true 时才允许（诊断用途）
const allowed = await withTargets([SHELL], () => pickTarget(9222, null, { allowPage: true }));
check('显式 allowPage:true 才返回外壳', allowed?.id === 'SHELL', JSON.stringify(allowed));

// ⑥ 空列表：返回 null
const empty = await withTargets([], () => pickTarget(9222));
check('没有任何 target 时返回 null', empty === null);

// ⑦ 多个 webview：选最后一个带 http(s) 的
const v1 = { ...VIEW, id: 'V1', url: 'about:blank#lease' };
const v2 = { ...VIEW, id: 'V2', url: 'https://b.example/' };
const multi = await withTargets([SHELL, v1, v2], () => pickTarget(9222));
check('多个 webview 时选最后一个 http(s) 的', multi?.id === 'V2', JSON.stringify(multi));

console.log('护栏测试：');
for (const p of pass) console.log('  ✅', p);
for (const f of fail) console.log('  ❌', f);
console.log(`\n通过 ${pass.length}，失败 ${fail.length}`);
process.exit(fail.length ? 1 : 0);
