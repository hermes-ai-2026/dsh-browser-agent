/**
 * 修复"空仓库无分支"：用网页编辑器创建 README.md → 建立 main 分支 → 之后就能上传。
 * 全程按页面实际内容决策（先读再动），不再盲导航。
 *
 * 用法：node fix-branch.mjs
 */
import { CdpSession, pickTarget } from './lib/cdp.js';

const OWNER = 'hermes-ai-2026';
const REPO = 'dsh-browser-agent';
const README = `# dsh-browser-agent

**让 DeepSeek Harness 的 agent 真正用上内置浏览器。**

DSH 桌面版右侧侧边栏有一个浏览器，但它只给人用：官方 bundle
\`@deepseek-ai/dsh-client-ui-sidebar-browser\` 只注册了一个 UI 页签，宿主半是一行空 \`apply() {}\`。

本插件以**非侵入式加装**的方式补上 agent 动作面 —— 不改 \`app.asar\`、不动应用签名、无额外安装步骤。

## 亮点

- **19 个 \`browser_*\` 工具**：读 / 点 / 输入 / 滚动 / 按键 / 截图 / 标签页 / 网络 / 设备模拟 / 拦截改写 / 多实例 / 任意 CDP
- **无障碍语义树 + 稳定 ref**：\`browser_read {mode:"ax"}\` 返回 role / name / 几何与 ref，读完按 ref 操作
- **网络拦截与改写**：mock / redirect / block / header 四类规则
- **Cookie 保险库**：导出还原**含 httpOnly** 的 cookie，登录跨重启保留
- **document-start 注入**：在页面脚本之前执行
- **常驻系统提示段**：新会话不会忘记调用
- **独立 CLI**：零依赖，17 个子命令

## 安装

\`\`\`
github:hermes-ai-2026/dsh-browser-agent
\`\`\`

在 DSH 的「插件 → 添加插件」里填这个地址，安装后启用，重启 DSH。

## 已知边界

| 边界 | 原因 |
|---|---|
| 真正的代理服务器 | CDP 无此域 |
| 权限授予 | webview 在 partition 的独立 BrowserContext，CDP 看不到 |
| \`browser_press\` 窗口失焦时 | 无 OS 键盘焦点时 CDP 键盘事件被丢弃 |

MIT License
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`);
const say = (s) => console.log(`  ${s}`);

const t = await pickTarget(9222);
const s = new CdpSession(t.wsUrl);
await s.connect();
await s.send('Page.enable', {}).catch(() => {});
const ev = async (c, aw = false) => {
  const r = await s.send('Runtime.evaluate', { expression: c, returnByValue: true, awaitPromise: aw }, 30_000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

/** 读页面：URL + 可见文本，用于决策（不再靠 len>40 这种粗暴判断）。 */
async function readPage() {
  return ev(`({
    url: location.href,
    title: document.title,
    err: location.href.startsWith('chrome-error'),
    text: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 300)
  })`);
}

step('导航到「新建文件」页');
await s.send('Page.navigate', { url: `https://github.com/${OWNER}/${REPO}/new/main` }, 25_000).catch(() => {});
await sleep(6500);
let p = await readPage();
say(`URL: ${p.url}`);
say(`文本: ${p.text.slice(0, 200)}`);
if (p.err || /Select a branch/i.test(p.text)) {
  // 空仓库可能没有 main，试 /new 不带分支
  say('试不带分支的 /new …');
  await s.send('Page.navigate', { url: `https://github.com/${OWNER}/${REPO}/new` }, 25_000).catch(() => {});
  await sleep(6000);
  p = await readPage();
  say(`URL: ${p.url}`);
  say(`文本: ${p.text.slice(0, 200)}`);
}

step('填文件名');
const fn = await ev(`(() => {
  const el = document.querySelector('#file-name, input[name="filename"], input[aria-label*="File name"]');
  if (!el) return null;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'README.md');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);
fn === 'README.md' ? ok('文件名 = README.md') : bad(`结果: ${fn}`);

step('往编辑器里写内容');
// Monaco 优先用 API；不行就聚焦后 insertText
let wrote = await ev(`(() => {
  if (window.monaco && monaco.editor) {
    const ms = monaco.editor.getModels();
    if (ms.length) { ms[0].setValue(${JSON.stringify(README)}); return 'monaco:' + ms[0].getValue().length; }
  }
  return null;
})()`);
if (!wrote) {
  // 点到编辑器区域再插入文本
  const box = await ev(`(() => {
    const el = document.querySelector('.monaco-editor textarea, .monaco-editor .view-lines, .cm-content, textarea[aria-label*="file"], div[role="textbox"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 20) };
  })()`);
  if (box) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);
    await s.send('Input.insertText', { text: README }, 20_000);
    wrote = 'insertText';
  }
}
say('写入方式: ' + wrote);
await sleep(1500);
say('编辑器内容长度: ' + await ev(`(document.querySelector('.monaco-editor')?.innerText || document.querySelector('.cm-content')?.innerText || '').length`));

step('点 Commit changes');
const commitBox = await ev(`(() => {
  const btns = [...document.querySelectorAll('button')].filter(b => (b.innerText||'').trim().toLowerCase().includes('commit changes'));
  const b = btns.find(x => x.getClientRects().length) || btns[0];
  if (!b) return { err: 'no-button', seen: [...document.querySelectorAll('button')].map(x=>(x.innerText||'').trim()).filter(Boolean).slice(0,15) };
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt: b.innerText.trim() };
})()`);
if (commitBox.err) { bad('没找到 Commit 按钮，页面按钮: ' + JSON.stringify(commitBox.seen)); }
else {
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: commitBox.x, y: commitBox.y, button: 'left', buttons: 1, clickCount: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: commitBox.x, y: commitBox.y, button: 'left', buttons: 0, clickCount: 1 });
  ok(`点击 "${commitBox.txt}"`);
  await sleep(9000);
  p = await readPage();
  say(`URL: ${p.url}`);
  say(`文本: ${p.text.slice(0, 220)}`);
  if (new RegExp(`${REPO}/blob/`).test(p.url) || !/new\/main/.test(p.url)) ok('分支已建立');
}

s.close();
process.exit(0);
