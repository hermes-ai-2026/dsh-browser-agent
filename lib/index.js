/**
 * dsh-browser-agent — 宿主半（Host half）
 *
 * 目标：把 DeepSeek Harness 内置的右侧 Sidebar 浏览器从「只能看」变成「agent 能驱动」。
 *
 * 复刻思路（对照 Codex Desktop 的内置浏览器）：
 *   Codex 的做法是一个本地回环桥（命名管道 \\.\pipe\codex-browser-use-*）+ 一个 JS 服务，
 *   把 agent 的工具调用接到 Electron 浏览器 runtime 上。
 *   这里用同样的拓扑，只把命名管道换成 loopback HTTP：
 *
 *     agent ── Tool ──▶ 本文件（宿主，ctx.tools 注册表）
 *                          │  命令队列 / 结果回填
 *                          ▼
 *                 127.0.0.1:8791  (HTTP 长轮询)
 *                          │
 *                          ▼
 *                    客户端半（渲染进程）──▶ <webview>（真正的浏览器）
 *
 * 本文件只依赖 node 内置模块，因此不需要 pnpm 安装、不受 profile 依赖图影响。
 *
 * ── 三条用真实崩溃换来的教训（勿回退）────────────────────────────────────
 * 1) CORS：渲染层 origin 是自定义协议 `dsh-app://app`，属于跨源请求。**每一个**响应
 *    （含 204/403/404/500 与预检）都必须带 CORS 头。先前漏了空闲轮询的 204 分支，
 *    客户端 100% 失败并无限重试，最终把 renderer 刷崩。
 * 2) 热应用只复用 ESM 模块缓存：改了本文件后必须**整进程重启**，否则跑的还是旧版。
 *    `/health` 回报 pluginVersion 就是为了在驱动浏览器之前核对版本。
 * 3) 截图：Electron 44 下对 <webview> 调 capturePage() 会导致渲染进程**原生崩溃**
 *    （崩溃日志无任何 JS error）。故 browser_screenshot 已停用，只返回替代方案。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { CdpSession, listTargets, pickTarget, probeCdp, withTarget } from './cdp.js';

export const name = 'dsh-browser-agent';

/** 需要 ctx.tools（模型可见工具注册表）。systemPrompt 是可选增强，见 apply()。 */
export const inject = ['tools'];

/**
 * 常驻系统提示段 —— 解决「新会话不记得用这个插件」的问题。
 *
 * 只在 tool registry 里注册工具是不够的：新会话面对通用任务（"帮我查一下…"）时，
 * 模型很容易去用 eval / HTTP 抓取，而不是浏览器。把这段写进**系统提示词**，
 * 每次会话都会看到，比依赖模型去翻 skill 目录可靠得多。
 *
 * API 形状（逆向 DSH 得到）：
 *   ctx.systemPrompt.section({ name, order, text })
 *   text 可为字符串或 (context) => string（返回 '' 即隐藏该段）
 * 用 try/catch 包住 —— 该服务缺失时插件照常工作。
 */
const PROMPT_SECTION = `## 内置浏览器（dsh-browser-agent）

DSH 右侧侧边栏的浏览器**已经可以驱动**。任务涉及网页时优先用 \`browser_*\` 工具，
而不是单纯 eval / HTTP 抓取 / 让用户自己去看：

- **读页面** → \`browser_read {mode:"ax"}\`：无障碍语义树，带 role / name / 几何与**稳定 ref**。
  首选通道（比截图省、比 html 结构化）；读完按 ref 操作，不用猜选择器。
- **操作** → \`browser_click {ref}\` / \`browser_type {ref, text}\` / \`browser_scroll\` / \`browser_press\`
  （CDP 真实输入；操作时页面里会出现虚拟鼠标，用户看得见 agent 在点哪里）
- **证据** → \`browser_screenshot\`（\`full\` 整页 / \`clip\` 区域）、\`browser_assets\`（图片是否真的加载出来）
- **网络** → \`browser_network\`；要全量事件用 \`browser_cdp {method:"Network.enable", eventsMs:3000}\`
- **mock / 拦截接口** → \`browser_policy {action:"intercept.enable", rules:[...]}\`
- **保持登录** → \`browser_cookies {action:"export"|"import", name:"…"}\`（侧栏会话是进程级的，cookie 默认不保留）
- **隔离环境** → \`browser_instance {action:"create", url:"…", visible:true}\`（多开，不打扰用户当前页面）
- **任意 CDP** → \`browser_cdp {method, params}\`（完整协议域）

典型节奏：\`browser_status\` → \`browser_open\` → \`browser_read {mode:"ax"}\` → 按 ref 操作 → 再读一次确认。

⚠️ 两条硬护栏：**别给 \`browser_cdp\` 传 \`allowShell:true\`**（会拿 DSH 外壳页面当目标，
曾把界面导航走）；**别裸发 \`Fetch.enable\`**（页面会卡死，用 \`browser_policy\` 代替）。`;

/** 桥接端口与共享令牌：客户端半硬编码同样的值（两半同源，见 client/client.js）。
 *  端口可用 DSH_BROWSER_AGENT_PORT 覆盖——仅供独立测试台使用，正常运行时保持默认。 */
const BRIDGE_PORT = Number(process.env.DSH_BROWSER_AGENT_PORT) || 8791;
const BRIDGE_TOKEN = 'dsh-browser-agent-local-bridge-v1';

/** 插件代码版本；`/health` 回报它，用于驱动前核对跑的是哪一版代码。 */
const PLUGIN_VERSION = '0.9.0';

/** 截图落盘目录（由渲染半回传 PNG 的 base64，宿主写文件）。 */
const SHOT_DIR = path.join(os.tmpdir(), 'dsh-browser-agent-shots');

/**
 * Cookie 保险库目录。
 *
 * 为什么需要它：DSH 侧边栏浏览器跑在**进程级会话**里
 * （`dsh-sidebar-browser-<uuid>`，没有 `persist:` 前缀），所以 **cookie 随应用退出而消失**，
 * 登录态默认留不住。把 cookie（含 httpOnly，JS 读不到、只有 CDP 能拿到）导出成文件，
 * 重启后再写回去，登录就能跨重启保留。
 *
 * 这个思路来自同类的 alesha-pro/dsh-sidebar-browser 插件，在此实现。
 */
const VAULT_DIR = process.env.DSH_BROWSER_VAULT_DIR || path.join(os.homedir(), '.dsh', 'dsh-browser-agent', 'vault');

/**
 * document-start 注入用的**常驻** CDP 会话。
 *
 * 为什么不能每次新建：`Page.addScriptToEvaluateOnNewDocument` 注册的脚本**随会话存活**，
 * 会话一断脚本就没了。所以这里维持一条长连接，并自己记录 identifier 以便移除。
 */
let injectSession = null;
let injectTarget = null;
const injectScripts = new Map();

/**
 * 网络/权限控制用的常驻 CDP 会话 + Fetch 拦截泵。
 *
 * 为什么也需要常驻：`Fetch.enable` / `Network.setBlockedURLs` / `Security.setIgnoreCertificateErrors`
 * 都是**会话级**的，会话一断就失效。
 *
 * 泵的作用：`Fetch.enable` 之后每个请求都会停在 `Fetch.requestPaused` 等指令 ——
 * 如果不响应，页面会**一直卡住**。所以泵会按规则处理，未命中的一律自动放行。
 */
let policySession = null;
let policyTarget = null;
let policyPump = null;
const policyState = { intercept: false, rules: [], blockedUrls: [], extraHeaders: {}, offline: false, ignoreCertErrors: false };

/** 把 "*api*" 这类通配转成正则。 */
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}
function matchRule(rule, url) {
  try { return globToRegExp(rule.match ?? '*').test(url); } catch { return false; }
}

/** 启动拦截泵：处理 Fetch.requestPaused，未命中规则的自动放行。 */
function startPolicyPump() {
  if (policyPump) return;
  policyPump = setInterval(async () => {
    const s = policySession;
    if (!s || !s.ws || s.ws.readyState !== 1) return;
    let events = [];
    try { events = s.takeEvents('Fetch.'); } catch { return; }
    for (const e of events) {
      if (e.method !== 'Fetch.requestPaused') continue;
      const requestId = e.params?.requestId;
      const url = e.params?.request?.url ?? '';
      if (!requestId) continue;
      const rule = policyState.rules.find((r) => matchRule(r, url));
      try {
        if (!rule) { await s.send('Fetch.continueRequest', { requestId }, 8000); continue; }
        const kind = String(rule.action || 'continue');
        if (kind === 'block') { await s.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, 8000); continue; }
        if (kind === 'mock') {
          const body = Buffer.from(String(rule.body ?? '{}'), 'utf8').toString('base64');
          await s.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: Number(rule.status || 200),
            responseHeaders: [
              { name: 'Content-Type', value: String(rule.contentType || 'application/json') },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body,
          }, 8000);
          continue;
        }
        const opts = { requestId };
        if (kind === 'redirect' && rule.to) opts.url = String(rule.to);
        if (kind === 'header' && rule.headers && typeof rule.headers === 'object') {
          opts.headers = Object.entries(rule.headers).map(([name, value]) => ({ name, value: String(value) }));
        }
        await s.send('Fetch.continueRequest', opts, 8000);
      } catch {
        /* 单条失败不影响其它请求 */
      }
    }
  }, 150);
  policyPump.unref?.();
}
function stopPolicyPump() {
  if (policyPump) { clearInterval(policyPump); policyPump = null; }
}

/**
 * CDP 调试端口。DSH 以 `--remote-debugging-port=<n>` 启动时才会有。
 * 可用 DSH_CDP_PORT 覆盖；探测结果缓存 5 秒，避免每次工具调用都打一次 HTTP。
 */
const CDP_PORT = Number(process.env.DSH_CDP_PORT) || 9222;
let cdpCache = { at: 0, info: undefined };

/**
 * 配置面。
 *
 * 关于 `defineTool` + schemastery Config（官方惯用法）：本机实测
 * `@deepseek-ai/dsh-tools` **无法从插件位置解析**（ERR_MODULE_NOT_FOUND）——
 * 它只存在于 DSH 自己的 bundle 里，第三方插件拿不到。alesha-pro 那个插件能用，
 * 是因为它的依赖由宿主注入。
 *
 * 本插件刻意保持**零运行时依赖**（只用 node 内置模块），不管 profile 的依赖图怎么变都不会坏。
 * 因此配置走环境变量：
 *   DSH_BROWSER_AGENT_PORT  桥接端口（默认 8791）
 *   DSH_CDP_PORT            CDP 调试端口（默认 9222）
 *   DSH_BROWSER_VAULT_DIR   cookie 保险库目录
 *   DSH_BROWSER_VISUAL      '0' 时默认关闭虚拟鼠标
 */
const CFG = {
  bridgePort: BRIDGE_PORT,
  cdpPort: CDP_PORT,
  vaultDir: VAULT_DIR,
  visualByDefault: process.env.DSH_BROWSER_VISUAL !== '0',
};

/** 探测 CDP 是否可用（带缓存）。返回 null 表示不可用 → 调用方回退到渲染层桥。 */
async function cdpInfo(force = false) {
  if (!force && Date.now() - cdpCache.at < 5000) return cdpCache.info;
  const info = await probeCdp(CDP_PORT);
  cdpCache = { at: Date.now(), info };
  return info;
}

/** 取当前 webview 的 CDP target；拿不到返回 null。 */
async function currentCdpTarget(exec) {
  const info = await cdpInfo();
  if (!info) return null;
  const status = await bridge.send('status', {}, exec?.signal, 15_000).catch(() => null);
  return pickTarget(CDP_PORT, status?.url);
}

/**
 * 用 CDP **真实输入**完成一次点击（`isTrusted: true`）。
 * 返回 null 表示条件不具备 → 调用方回退到渲染层的合成事件路径。
 *
 * 相比合成事件的好处：真实指针序列会触发 hover 展开、CSS :active、以及依赖
 * `isTrusted` 的站点逻辑；合成 DOM 事件做不到这些。
 */
async function cdpClick(args, exec) {
  const target = await currentCdpTarget(exec);
  if (!target) return null;
  const loc = await bridge.send('highlight', { ...args, focus: false }, exec?.signal, 30_000);
  if (!loc?.ok || !Array.isArray(loc.at)) return null;
  const [x, y] = loc.at;
  await withTarget(CDP_PORT, target, async (s) => {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await new Promise((r) => setTimeout(r, 120));
    if (args.hoverOnly) return;
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  });
  return {
    ok: true,
    engine: 'cdp-input',
    trusted: true,
    clicked: { tag: loc.tag, text: loc.text, href: loc.href },
    at: loc.at,
    hoverOnly: !!args.hoverOnly,
  };
}

/**
 * 用 CDP **真实输入**完成一次文本输入（点击聚焦 → 必要时全选 → insertText → 回车）。
 * 返回 null 表示应回退到渲染层路径。
 */
async function cdpType(args, exec) {
  const target = await currentCdpTarget(exec);
  if (!target) return null;
  const loc = await bridge.send('highlight', { ...args, focus: true }, exec?.signal, 30_000);
  if (!loc?.ok || !Array.isArray(loc.at)) return null;
  const [x, y] = loc.at;
  await withTarget(CDP_PORT, target, async (s) => {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    if (args.clear !== false) {
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    }
    await s.send('Input.insertText', { text: String(args.text ?? '') });
    if (args.submit) {
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
    }
  });
  // 回读：输入后焦点元素的值（证明真的写进去了）
  const back = await bridge
    .send(
      'eval',
      { code: 'const a = document.activeElement; return { tag: a ? a.tagName.toLowerCase() : null, value: a && a.value != null ? String(a.value) : null };' },
      exec?.signal,
      20_000,
    )
    .catch(() => null);
  const got = back?.result?.value ?? null;
  const want = String(args.text ?? '');
  // ⚠️ 实测：当 DSH 窗口没有 OS 级键盘焦点时，CDP 的键盘事件（insertText / dispatchKeyEvent）
  //    会被丢弃 —— 鼠标事件仍能送达，页面自己也报 hasFocus:true，但值不会变。
  //    因此这里**回读校验**：没写进去就抛错，让调用方回退到渲染层的原生 setter 路径。
  if (got === null || (want && !got.includes(want))) {
    throw new Error(`CDP 输入未生效（回读 value=${JSON.stringify(got)}，期望包含 ${JSON.stringify(want)}）—— 多半是 DSH 窗口没有键盘焦点；已回退渲染层路径`);
  }
  return {
    ok: true,
    engine: 'cdp-input',
    trusted: true,
    tag: back?.result?.tag ?? loc.tag,
    value: got,
    submitted: !!args.submit,
    at: loc.at,
  };
}

/** 把 base64 PNG 写到临时目录，返回绝对路径。 */
function saveShot(base64) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `shot-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(String(base64), 'base64'));
  return file;
}

/** 单个命令的默认超时；工具可用 timeoutMs 覆盖。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 客户端长轮询等待上限。 */
const POLL_WAIT_MS = 25_000;

/** 桥接状态：命令入队后由渲染半取走，结果回填。 */
class Bridge {
  constructor() {
    this.queue = [];
    this.inflight = new Map();
    this.seq = 0;
    this.lastPollAt = 0;
    this.clientId = null;
    /** 渲染半上报的版本，用于确认两半是否都已更新。 */
    this.clientVersion = null;
    this.pollWaiter = null;
  }

  /** 客户端是否在线（最近一次长轮询未超时太久）。 */
  get clientOnline() {
    return this.lastPollAt !== 0 && Date.now() - this.lastPollAt < POLL_WAIT_MS * 2;
  }

  /**
   * 投递一条命令并等待其结果。
   * @param {string} op 操作名
   * @param {object} args 参数
   * @param {AbortSignal} [signal] 协作式取消
   * @param {number} [timeoutMs]
   */
  send(op, args, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.clientOnline) {
      return Promise.reject(
        new Error(
          '浏览器客户端未连接：请确认 DSH 正在运行，并且右侧侧边栏用过「浏览器」标签页（本插件的渲染半需要它承载 <webview>）。',
        ),
      );
    }
    const id = `cmd-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const entry = { id, op, args: args ?? {}, resolve, reject, settled: false };
      const cleanup = () => {
        clearTimeout(entry.timer);
        this.inflight.delete(id);
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      };
      if (signal) {
        if (signal.aborted) {
          reject(new Error('browser tool call aborted'));
          return;
        }
        entry.onAbort = () => {
          entry.settled = true;
          cleanup();
          reject(new Error('browser tool call aborted'));
        };
        entry.signal = signal;
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      entry.timer = setTimeout(() => {
        entry.settled = true;
        cleanup();
        reject(new Error(`browser tool timed out after ${timeoutMs}ms (op=${op})`));
      }, Math.min(timeoutMs, 2_147_483_647));
      this.inflight.set(id, entry);
      this.queue.push(entry);
      this.wake();
    });
  }

  /** 唤醒正在长轮询的客户端。 */
  wake() {
    if (this.pollWaiter) {
      const w = this.pollWaiter;
      this.pollWaiter = null;
      w();
    }
  }

  /** 取队首命令（客户端长轮询调用）。 */
  take() {
    return this.queue.shift() ?? null;
  }

  /** 回填结果（客户端 POST /result 调用）。 */
  settle(id, ok, data, error) {
    const entry = this.inflight.get(id);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    this.inflight.delete(id);
    if (entry.settled) return true;
    entry.settled = true;
    if (ok) entry.resolve(data);
    else entry.reject(new Error(String(error ?? 'browser operation failed')));
    return true;
  }
}

/** 读取请求体（限制大小，防止意外灌爆内存）。 */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 启动回环桥接服务器。 */
function startBridge(bridge, logger) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${BRIDGE_PORT}`);

    // 渲染层访问本端口一律是跨源请求：桌面版 origin 是自定义协议 `dsh-app://app`，
    // Web 版是 `http://127.0.0.1:<port>`。**每个**响应都必须带 CORS 头，包括 204/4xx/5xx。
    // 教训：先前只在部分分支加头，空闲轮询的 204 被浏览器拦掉，客户端因此无限重试并刷爆控制台。
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-dsh-browser-agent',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
    };
    const json = (code, obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(body);
    };
    /** 无内容响应也必须带 CORS 头（204 同样受跨源策略约束）。 */
    const noContent = (code = 204) => {
      res.writeHead(code, cors);
      res.end();
    };

    if (req.method === 'OPTIONS') {
      noContent(204);
      return;
    }

    // 只接受本机回环来源，并要求共享令牌。
    const token = req.headers['x-dsh-browser-agent'];
    const host = String(req.headers.host ?? '');
    const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

    if (url.pathname === '/health') {
      const cdp = await cdpInfo();
      json(200, {
        ok: true,
        pluginVersion: PLUGIN_VERSION,
        bridgePort: BRIDGE_PORT,
        clientOnline: bridge.clientOnline,
        clientId: bridge.clientId,
        clientVersion: bridge.clientVersion,
        queued: bridge.queue.length,
        inflight: bridge.inflight.size,
        cdp: cdp ? { available: true, port: cdp.port, browser: cdp.browser, protocolVersion: cdp.protocolVersion } : { available: false, port: CDP_PORT },
      });
      return;
    }
    if (token !== BRIDGE_TOKEN || !loopbackHost) {
      json(403, { ok: false, error: 'forbidden' });
      return;
    }

    try {
      if (url.pathname === '/hello' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        bridge.clientId = body.clientId ?? 'unknown';
        bridge.clientVersion = body.clientVersion ?? null;
        bridge.lastPollAt = Date.now();
        logger?.info?.(`browser-agent 客户端已接入: ${bridge.clientId}`);
        json(200, { ok: true, port: BRIDGE_PORT, pluginVersion: PLUGIN_VERSION });
        return;
      }

      if (url.pathname === '/poll') {
        bridge.lastPollAt = Date.now();
        const entry = bridge.take();
        if (entry !== null) {
          json(200, { id: entry.id, op: entry.op, args: entry.args });
          return;
        }
        const wait = Math.min(Number(url.searchParams.get('wait') ?? POLL_WAIT_MS) || POLL_WAIT_MS, POLL_WAIT_MS);
        const woke = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (bridge.pollWaiter === resolve) bridge.pollWaiter = null;
            resolve(false);
          }, wait);
          bridge.pollWaiter = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        bridge.lastPollAt = Date.now();
        const next = woke ? bridge.take() : null;
        if (next === null) {
          noContent(204);
          return;
        }
        json(200, { id: next.id, op: next.op, args: next.args });
        return;
      }

      if (url.pathname === '/result' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        bridge.lastPollAt = Date.now();
        const found = bridge.settle(body.id, body.ok !== false, body.data, body.error);
        json(200, { ok: found });
        return;
      }

      // 调试通道：绕过模型工具直接下发一次命令，便于在 DSH 之外、或本会话无法发起工具调用时验证整条链路。
      // 与 /poll、/result 同级鉴权（回环 + 共享令牌）。
      if (url.pathname === '/debug/exec' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const data = await bridge.send(String(body.op), body.args ?? {}, undefined, Number(body.timeoutMs ?? 60_000));
        json(200, { ok: true, data });
        return;
      }

      json(404, { ok: false, error: 'not found' });
    } catch (error) {
      json(500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BRIDGE_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 统一的工具返回值渲染：文本块。 */
const textRender = (text) => [{ type: 'text', text }];

/**
 * 注册全部浏览器工具。
 * @param {any} ctx Cordis 上下文
 * @param {Bridge} bridge
 */
function registerTools(ctx, bridge) {
  const tools = ctx.tools;
  const disposers = [];
  const reg = (def) => disposers.push(tools.register(def));
  const jsonOut = { schema: { type: 'object' }, render: (_a, v) => textRender(JSON.stringify(v, null, 2)) };

  reg({
    name: 'browser_status',
    description:
      '检查 DSH 内置浏览器的连接状态：渲染进程客户端是否在线、当前页面 URL/标题、是否可驱动。其它 browser_* 工具返回“未连接”时先调用它。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: jsonOut,
    timeoutMs: 30_000,
    async execute(_args, exec) {
      const local = {
        bridgePort: BRIDGE_PORT,
        pluginVersion: PLUGIN_VERSION,
        clientOnline: bridge.clientOnline,
        clientId: bridge.clientId,
        queued: bridge.queue.length,
        config: CFG,
      };
      // CDP 能力上报：可用时说明"原生协议域"已打开
      const info = await cdpInfo();
      local.cdp = info
        ? { available: true, port: info.port, browser: info.browser, protocolVersion: info.protocolVersion }
        : { available: false, port: CDP_PORT, hint: `用 --remote-debugging-port=${CDP_PORT} 启动 DSH 可启用原生 CDP` };

      // 能力矩阵：逐项说明每类能力走哪条实现路径、当前是否可用。
      // 这是"能力探测层"的显式形态 —— 调用方据此知道自己拿到了什么、缺了什么，而不是猜。
      const cdpUp = !!info;
      const webviewUp = bridge.clientOnline;
      local.capabilities = [
        { cap: 'dom.read', path: 'renderer-bridge', ok: webviewUp, note: 'AX 语义树 / text / html / links / dom' },
        { cap: 'page.eval', path: 'renderer-bridge', ok: webviewUp },
        { cap: 'input.pointer', path: cdpUp ? 'cdp-input(trusted)' : 'renderer-synthetic', ok: webviewUp, note: cdpUp ? 'CDP 真实鼠标事件' : '合成事件（hover 不可靠）' },
        { cap: 'input.text', path: cdpUp ? 'cdp-input(verify+fallback)' : 'renderer-setter', ok: webviewUp, note: 'CDP 输入后回读校验，未生效则自动回退' },
        { cap: 'input.key', path: 'cdp-input', ok: cdpUp, note: cdpUp ? '' : '需要 CDP；且窗口无键盘焦点时会静默失效' },
        { cap: 'scroll', path: cdpUp ? 'cdp-mouseWheel' : 'renderer-scrollBy', ok: webviewUp },
        { cap: 'screenshot', path: cdpUp ? 'cdp-captureScreenshot' : 'svg-foreignobject', ok: webviewUp, note: '支持 full / clip；guest 降级时自动回退' },
        { cap: 'tabs.manage', path: 'host-ui-dom', ok: webviewUp, note: 'list / activate / close' },
        { cap: 'cookies.read', path: 'cdp-network', ok: cdpUp, note: '含 httpOnly' },
        { cap: 'cookies.write', path: 'cdp-network', ok: cdpUp },
        { cap: 'cookies.clear', path: 'cdp-network', ok: cdpUp },
        { cap: 'cookies.vault', path: 'file+cdp', ok: cdpUp, note: VAULT_DIR },
        { cap: 'network.observe', path: cdpUp ? 'cdp-network-events' : 'renderer-hooks', ok: webviewUp, note: cdpUp ? '全量事件（含头体）' : '仅 Performance + fetch/XHR 钩子' },
        { cap: 'network.intercept', path: 'cdp-fetch-domain', ok: cdpUp, note: '经 browser_cdp 发 Fetch.* 命令' },
        { cap: 'emulation.device', path: 'cdp-emulation', ok: cdpUp },
        { cap: 'inject.documentStart', path: 'cdp-pagedomain(persistent)', ok: cdpUp, note: '需常驻会话；会话断则失效' },
        { cap: 'instance.multi', path: 'preload-lease-api', ok: webviewUp, note: 'dshDesktop.browser.acquire' },
        { cap: 'downloads', path: 'cdp-browser-domain', ok: cdpUp, note: '经 browser_cdp 发 Browser.setDownloadBehavior' },
        { cap: 'session.cookieStore', path: '—', ok: false, note: '主进程 session 对象，renderer 拿不到（真边界）' },
        { cap: 'session.proxyCert', path: '—', ok: false, note: '同上（真边界）' },
      ];

      if (!bridge.clientOnline) return { ...local, page: null };
      const page = await bridge.send('status', {}, exec?.signal, 20_000);
      return { ...local, page };
    },
  });

  reg({
    name: 'browser_open',
    description:
      '在 DSH 右侧侧边栏的「浏览器」标签页中打开一个 HTTP(S) URL（会自动打开/复用该标签页）。返回最终 URL 与页面标题。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的绝对 HTTP(S) URL。' } },
      required: ['url'],
    },
    output: jsonOut,
    timeoutMs: 90_000,
    async execute(args, exec) {
      return bridge.send('open', { url: args.url }, exec?.signal, 80_000);
    },
  });

  reg({
    name: 'browser_read',
    description:
      '读取当前浏览器页面。mode=ax 返回**结构化语义树 + 稳定 ref**（首选；对标 Codex 的 AXAPI：先读它、再按 ref 操作）；mode=text 可见文本；mode=html 整页 HTML；mode=links 链接列表；mode=dom 简化 DOM。可用 selector 缩小范围。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'ax | text | html | links | dom（默认 text；推荐 ax）' },
        selector: { type: 'string', description: '可选 CSS 选择器，只读该子树。' },
        maxChars: { type: 'number', description: 'mode=ax 时是节点上限（默认 150，最大 400）；其它模式是文本字符上限（默认 20000，上限 500000）。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const a = args ?? {};
      if (String(a.mode || '').toLowerCase() === 'ax') {
        return bridge.send('ax', { max: a.maxChars }, exec?.signal, 50_000);
      }
      return bridge.send('read', a, exec?.signal, 50_000);
    },
  });

  reg({
    name: 'browser_tabs',
    description:
      '管理 DSH 侧边栏的浏览器标签页：action=list 列出（含标题、是否当前激活）；action=close 关闭第 index 个；action=activate 切到第 index 个。用来清理重复标签。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | close | activate（默认 list）' },
        index: { type: 'number', description: 'close / activate 时的标签序号（来自 list 的 index，从 0 开始）。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 30_000,
    async execute(args, exec) {
      return bridge.send('tabs', args ?? {}, exec?.signal, 20_000);
    },
  });

  reg({
    name: 'browser_cdp',
    description:
      '直连 Chrome DevTools Protocol（**仅在 DSH 以 --remote-debugging-port 启动时可用**）。method 为 CDP 方法名，params 为其参数，例如 Page.captureScreenshot / Network.enable / Emulation.setUserAgentOverride / Runtime.evaluate / Input.dispatchMouseEvent。默认作用于当前页面所在的 target（webview guest 会作为独立 target 出现）。eventsMs>0 时会在等待该时长后一并返回期间收到的 CDP 事件（配合 Network.enable 可观测全量请求）。用 listTargets=true 可只列出所有 target。',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'CDP 方法名，如 Page.captureScreenshot、Network.enable、Emulation.setUserAgentOverride。' },
        params: { type: 'object', description: '该方法对应的参数对象。' },
        targetId: { type: 'string', description: '可选：直接指定 target id（来自 listTargets）。' },
        targetHint: { type: 'string', description: '可选：按 URL 子串挑选 target。' },
        eventsMs: { type: 'number', description: '可选：等待这么多毫秒并返回期间收到的 CDP 事件（上限 20000）。' },
        timeoutMs: { type: 'number', description: '可选：单条命令超时，默认 30000。' },
        allowShell: { type: 'boolean', description: '危险：允许在 DSH 外壳页面（非 webview target）上执行 Page.navigate 等破坏性方法。默认 false。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 120_000,
    async execute(args, exec) {
      const a = args ?? {};
      const info = await cdpInfo(true);
      if (!info) {
        throw new Error(
          `CDP 不可用：127.0.0.1:${CDP_PORT} 无响应。请用带 --remote-debugging-port=${CDP_PORT} 的方式启动 DSH（本插件的 CDP 能力全部依赖它）。`,
        );
      }
      const targets = await listTargets(CDP_PORT);
      if (a.listTargets) {
        return { ok: true, cdp: info, count: targets.length, targets };
      }
      if (!a.method) throw new Error('缺少 method（或传 listTargets:true 只列 target）');

      let target = null;
      if (a.targetId) target = targets.find((t) => t.id === a.targetId) ?? null;
      else if (a.targetHint) target = targets.find((t) => t.url.includes(String(a.targetHint))) ?? null;
      else {
        const status = await bridge.send('status', {}, exec?.signal, 15_000).catch(() => null);
        target = await pickTarget(CDP_PORT, status?.url);
        if (!target) {
          throw new Error(
            '没有可用的 webview target（当前没有打开的浏览器标签页）。请先用 browser_open 打开页面，或传 targetId / targetHint 明确指定。',
          );
        }
      }
      if (!target) throw new Error('没有可用的 CDP target');

      // ⚠️ 护栏：非 webview target（DSH 外壳页面）上禁止“破坏性”方法，除非显式 allowShell。
      // 事故教训：曾因没有 webview 而回退到外壳 target，一条 Page.navigate 把 DSH 界面导航走了。
      const DESTRUCTIVE = new Set([
        'Page.navigate',
        'Page.reload',
        'Page.navigateToHistoryEntry',
        'Page.close',
        'Page.crash',
        'Target.closeTarget',
      ]);
      if (target.type !== 'webview' && DESTRUCTIVE.has(String(a.method)) && a.allowShell !== true) {
        throw new Error(
          `拒绝在非 webview target（DSH 外壳页面，type=${target.type}）上执行 ${a.method}：` +
            '这会把 DSH 自己的界面导航走，需要时请显式传 allowShell:true。',
        );
      }

      const session = new CdpSession(target.wsUrl);
      await session.connect();
      try {
        const result = await session.send(String(a.method), a.params ?? {}, Number(a.timeoutMs ?? 30_000));
        let events = null;
        const eventsMs = Number(a.eventsMs ?? 0);
        if (eventsMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(eventsMs, 20_000)));
          const got = session.takeEvents();
          events = { count: got.length, sample: got.slice(0, 50) };
        }
        return {
          ok: true,
          cdp: info,
          method: a.method,
          target: { id: target.id, type: target.type, url: target.url, title: target.title },
          targetCount: targets.length,
          result,
          events,
        };
      } finally {
        session.close();
      }
    },
  });

  reg({
    name: 'browser_instance',
    description:
      '自建浏览器实例（对标 Codex 的 Browsers 多实例管理）。action=list 列出；create 新建（可选 url、visible=true 时挂成右下角浮层让人能看见）；select 把后续所有浏览器操作切到该实例（id 传 null 切回侧边栏浏览器）；close 关闭并释放租约。仅 DSH Desktop 可用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | create | close | select（默认 list）' },
        url: { type: 'string', description: 'create 时可选：新实例要打开的地址。' },
        visible: { type: 'boolean', description: 'create 时是否挂成右下角浮层（默认 false = 离屏，不打扰用户）。' },
        select: { type: 'boolean', description: 'create 后是否自动切到新实例（默认 true）。' },
        id: { type: 'string', description: 'close / select 时的实例 id（来自 list）。select 传 null 表示切回侧边栏。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      return bridge.send('instance', args ?? {}, exec?.signal, 50_000);
    },
  });

  reg({
    name: 'browser_viewport',
    description:
      '视口 / 缩放 / 可见性 / 样式注入（对标 Codex 的 browser/viewport 与 browser/visibility）。可设 zoom（页面缩放）、width/height（webview 元素尺寸）、hidden（视觉隐藏）、css（注入样式）、reset（还原）。不带任何参数时只回报当前状态。',
    parameters: {
      type: 'object',
      properties: {
        zoom: { type: 'number', description: '页面缩放倍数，如 0.8 / 1 / 1.25。' },
        width: { type: 'number', description: 'webview 元素宽度（px）。会影响用户看到的面板大小，谨慎用。' },
        height: { type: 'number', description: 'webview 元素高度（px）。' },
        hidden: { type: 'boolean', description: '是否视觉隐藏（visibility）。与“让用户看见”相悖，谨慎用。' },
        css: { type: 'string', description: '注入到页面的 CSS（走 webview.insertCSS）。' },
        reset: { type: 'boolean', description: '清除上面所有覆盖设置并还原缩放为 1。' },
        device: { type: 'string', description: '设备预设（走 CDP Emulation.setDeviceMetricsOverride）：iphone-se | iphone-15-pro | iphone-15-pro-max | pixel-8 | galaxy-s23 | ipad-mini | ipad-air | ipad-pro-11。传 "reset" 清除。' },
        landscape: { type: 'boolean', description: '配合 device：是否横屏。' },
        mobile: { type: 'boolean', description: '配合 device：是否 mobile 模式（默认按预设）。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const a = args ?? {};
      // 设备预设：走 CDP Emulation（渲染层改不了真实视口）
      if (a.device !== undefined) {
        const target = await currentCdpTarget(exec).catch(() => null);
        if (!target) throw new Error('device 预设需要 CDP（Emulation.setDeviceMetricsOverride）；请用 --remote-debugging-port 启动 DSH。');
        const PRESETS = {
          'iphone-se': { width: 375, height: 667, dpr: 2, mobile: true },
          'iphone-15-pro': { width: 393, height: 852, dpr: 3, mobile: true },
          'iphone-15-pro-max': { width: 430, height: 932, dpr: 3, mobile: true },
          'pixel-8': { width: 412, height: 915, dpr: 2.625, mobile: true },
          'galaxy-s23': { width: 360, height: 780, dpr: 3, mobile: true },
          'ipad-mini': { width: 744, height: 1133, dpr: 2, mobile: true },
          'ipad-air': { width: 820, height: 1180, dpr: 2, mobile: true },
          'ipad-pro-11': { width: 834, height: 1194, dpr: 2, mobile: true },
        };
        const want = String(a.device).toLowerCase();
        if (want === 'reset' || want === '') {
          await withTarget(CDP_PORT, target, (s) => s.send('Emulation.clearDeviceMetricsOverride', {}, 10_000));
          return { ok: true, engine: 'cdp-emulation', device: null, note: '已清除设备覆盖' };
        }
        const p = PRESETS[want];
        if (!p) throw new Error(`未知设备预设：${a.device}（可用：${Object.keys(PRESETS).join(' | ')} | reset）`);
        const landscape = a.landscape === true;
        const metrics = {
          width: landscape ? p.height : p.width,
          height: landscape ? p.width : p.height,
          deviceScaleFactor: p.dpr,
          mobile: a.mobile === undefined ? p.mobile : a.mobile === true,
        };
        await withTarget(CDP_PORT, target, (s) => s.send('Emulation.setDeviceMetricsOverride', metrics, 10_000));
        return { ok: true, engine: 'cdp-emulation', device: want, landscape, metrics };
      }
      return bridge.send('viewport', a, exec?.signal, 20_000);
    },
  });

  reg({
    name: 'browser_network',
    description:
      '观测页面网络活动（CDP Network 域的近似替代）。默认回报已发生的资源请求（URL/类型/耗时/传输字节 + 按域名汇总）；传 install=true 会挂钩 fetch 与 XMLHttpRequest，记录之后的请求。局限：看不到请求头/响应体、不能拦截改写、看不到 WebSocket 帧。',
    parameters: {
      type: 'object',
      properties: {
        install: { type: 'boolean', description: '是否安装 fetch/XHR 钩子以捕获之后的请求（默认 false）。' },
        max: { type: 'number', description: '返回条数上限，默认 100，最大 500。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      return bridge.send('network', args ?? {}, exec?.signal, 50_000);
    },
  });

  reg({
    name: 'browser_assets',
    description:
      '列出当前页面的资源清单（对标 Codex 的 pageAssets）：images（含是否真的加载成功、原始尺寸）、scripts、stylesheets（含可读规则数）、links，以及 webmcp（页面通过 navigator.modelContext 声明的工具，若有）。做资源审计或排查“图没显示出来”时用它。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(_args, exec) {
      return bridge.send('assets', {}, exec?.signal, 50_000);
    },
  });

  reg({
    name: 'browser_click',
    description:
      '在当前浏览器页面里点击一个元素。推荐用 ref（来自 browser_read mode=ax 的 [eN]，最稳）；也可用 selector（CSS）或 text（按可见文本匹配）。' +
      '操作时会在页面里显示**虚拟鼠标**（指针移动到目标 + 点击涟漪），便于用户看到 agent 在做什么。返回点击到的元素信息。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'browser_read mode=ax 返回的 ref，如 e12。最推荐。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', description: '按可见文本匹配元素（与 selector 二选一）。' },
        index: { type: 'number', description: '多个匹配时选择第几个（从 0 开始，默认 0）。' },
        visual: { type: 'boolean', description: '是否显示虚拟鼠标（默认 true；批量操作时可设 false 跳过动画等待）。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const a = args ?? {};
      // 优先：CDP 真实输入（isTrusted），会触发 hover 展开与站点自身逻辑
      if (a.forceRenderer !== true) {
        try {
          const viaCdp = await cdpClick(a, exec);
          if (viaCdp) return viaCdp;
        } catch (error) {
          const fallback = await bridge.send('click', a, exec?.signal, 50_000);
          return { ...fallback, engine: 'renderer-dom', cdpError: String(error?.message ?? error) };
        }
      }
      const r = await bridge.send('click', a, exec?.signal, 50_000);
      return { ...r, engine: 'renderer-dom' };
    },
  });

  reg({
    name: 'browser_type',
    description:
      '在当前浏览器页面向输入框/文本域输入文本（派发 input/change 事件，兼容 React 受控组件）。推荐用 ref（来自 browser_read mode=ax）；submit=true 时随后回车提交。' +
      '操作时会显示**虚拟鼠标**并给目标描边，便于用户看到 agent 在做什么。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'browser_read mode=ax 返回的 ref，如 e5。最推荐。' },
        selector: { type: 'string', description: '目标输入元素的 CSS 选择器（与 ref 二选一）。' },
        text: { type: 'string', description: '要输入的文本。' },
        submit: { type: 'boolean', description: '输入后是否按回车提交。' },
        clear: { type: 'boolean', description: '是否先清空原值（默认 true）。' },
        visual: { type: 'boolean', description: '是否显示虚拟鼠标（默认 true）。' },
      },
      required: ['text'],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const a = args ?? {};
      // 优先：CDP 真实输入（点击聚焦 + Ctrl+A + insertText + 可选回车）
      if (a.forceRenderer !== true) {
        try {
          const viaCdp = await cdpType(a, exec);
          if (viaCdp) return viaCdp;
        } catch (error) {
          const fallback = await bridge.send('type', a, exec?.signal, 50_000);
          return { ...fallback, engine: 'renderer-dom', cdpError: String(error?.message ?? error) };
        }
      }
      const r = await bridge.send('type', a, exec?.signal, 50_000);
      return { ...r, engine: 'renderer-dom' };
    },
  });

  reg({
    name: 'browser_scroll',
    description:
      '在当前页面滚动。优先用 CDP Input.dispatchMouseEvent(mouseWheel) 产生**真实滚轮事件**；无 CDP 时回退页面内 window.scrollBy。传 selector/ref 则滚动到该元素。',
    parameters: {
      type: 'object',
      properties: {
        dy: { type: 'number', description: '纵向像素，正数向下（默认 600）。' },
        dx: { type: 'number', description: '横向像素，正数向右（默认 0）。' },
        selector: { type: 'string', description: '可选：滚动到该元素（优先于 dx/dy）。' },
        ref: { type: 'string', description: '可选：滚动到该 ref 指向的元素。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 40_000,
    async execute(args, exec) {
      const a = args ?? {};
      if (a.selector || a.ref) {
        const loc = await bridge.send('highlight', { ...a, visual: a.visual !== false }, exec?.signal, 30_000);
        return { ok: true, engine: 'renderer-scrollIntoView', target: { tag: loc.tag, text: loc.text }, box: loc.box };
      }
      const dy = Number(a.dy ?? 600);
      const dx = Number(a.dx ?? 0);
      const readPos = () =>
        bridge
          .send('eval', { code: 'return { y: Math.round(window.scrollY), x: Math.round(window.scrollX), docH: document.documentElement.scrollHeight, vh: innerHeight };' }, exec?.signal, 20_000)
          .then((r) => r?.result)
          .catch(() => null);
      const target = await currentCdpTarget(exec).catch(() => null);
      if (target) {
        try {
          const before = await readPos();
          await withTarget(CDP_PORT, target, async (s) => {
            await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 300, button: 'none' });
            await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 300, deltaX: dx, deltaY: dy });
          });
          await new Promise((r) => setTimeout(r, 450));
          const after = await readPos();
          return { ok: true, engine: 'cdp-mouseWheel', from: before, to: after };
        } catch (error) {
          const fb = await bridge.send('scroll', { dx, dy }, exec?.signal, 30_000);
          return { ...fb, engine: 'renderer-scrollBy', cdpError: String(error?.message ?? error) };
        }
      }
      const fb = await bridge.send('scroll', { dx, dy }, exec?.signal, 30_000);
      return { ...fb, engine: 'renderer-scrollBy' };
    },
  });

  reg({
    name: 'browser_press',
    description:
      '按下一个按键（CDP Input.dispatchKeyEvent，**真实键盘事件**）。支持 Enter/Tab/Escape/Backspace/Delete/ArrowUp/Down/Left/Right/PageUp/PageDown/Home/End/Space，或单个字符。可先用 click/type 让目标获得焦点。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '按键名或单个字符。' },
        times: { type: 'number', description: '重复次数（默认 1，最大 20）。' },
      },
      required: ['key'],
    },
    output: jsonOut,
    timeoutMs: 40_000,
    async execute(args, exec) {
      const name = String(args?.key ?? '').trim();
      if (!name) throw new Error('缺少 key');
      const times = Math.max(1, Math.min(Number(args?.times || 1), 20));
      const KEYS = {
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
        Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
        PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
        Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
        End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
        Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
      };
      const def = KEYS[name] ?? { key: name, code: null, windowsVirtualKeyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0 };
      const target = await currentCdpTarget(exec).catch(() => null);
      if (!target) throw new Error('browser_press 需要 CDP（Input.dispatchKeyEvent）；请用 --remote-debugging-port 启动 DSH。');
      await withTarget(CDP_PORT, target, async (s) => {
        for (let i = 0; i < times; i += 1) {
          await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...def });
          await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def });
          await new Promise((r) => setTimeout(r, 60));
        }
      });
      return { ok: true, engine: 'cdp-input', key: name, times };
    },
  });

  reg({
    name: 'browser_cookies',
    description:
      '浏览器 Cookie 保险库。DSH 侧边栏浏览器的会话是**进程级**的（cookie 随应用退出消失），登录态默认不保留。action=export 把当前 cookie（**含 httpOnly**，只有 CDP 拿得到）导出到 ~/.dsh/dsh-browser-agent/vault/<name>.json；重启后 action=import 还原即可保住登录。action=list 列出已有保险库。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'export | import | list（默认 list）' },
        name: { type: 'string', description: '保险库名（默认 default）' },
        url: { type: 'string', description: '可选：只处理该 URL 作用域内的 cookie。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const a = args ?? {};
      const action = String(a.action || 'list');
      const name = String(a.name || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');

      if (action === 'list') {
        const files = fs.existsSync(VAULT_DIR) ? fs.readdirSync(VAULT_DIR).filter((f) => f.endsWith('.json')) : [];
        return {
          ok: true,
          action,
          vaultDir: VAULT_DIR,
          count: files.length,
          vaults: files.map((f) => {
            const full = path.join(VAULT_DIR, f);
            let cookies = null;
            let savedAt = null;
            try {
              const j = JSON.parse(fs.readFileSync(full, 'utf8'));
              cookies = Array.isArray(j.cookies) ? j.cookies.length : null;
              savedAt = j.savedAt ?? null;
            } catch {}
            return { name: f.replace(/\.json$/, ''), cookies, savedAt, bytes: fs.statSync(full).size };
          }),
        };
      }

      const target = await currentCdpTarget(exec).catch(() => null);

      if (action === 'import') {
        // 先查文件再查 CDP —— "保险库不存在"比"需要 CDP"更能说明问题，且不依赖 CDP 就能判断
        const file = path.join(VAULT_DIR, `${name}.json`);
        if (!fs.existsSync(file)) throw new Error(`保险库不存在：${file}（先用 action=export，或 action=list 查看已有的）`);
        if (!target) throw new Error('browser_cookies 需要 CDP（Network.getCookies / setCookie）；请用 --remote-debugging-port 启动 DSH。');
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const cookies = Array.isArray(j.cookies) ? j.cookies : [];
        let restored = 0;
        const failed = [];
        await withTarget(CDP_PORT, target, async (s) => {
          for (const c of cookies) {
            try {
              const params = { name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
              if (typeof c.expires === 'number' && c.expires > 0) params.expires = c.expires;
              if (c.sameSite && c.sameSite !== 'None') params.sameSite = c.sameSite;
              const r = await s.send('Network.setCookie', params, 10_000);
              if (r?.success === false) failed.push(c.name);
              else restored += 1;
            } catch (e) {
              failed.push(`${c.name}: ${String(e?.message ?? e)}`);
            }
          }
        });
        return { ok: true, action, name, restored, total: cookies.length, failed: failed.slice(0, 10), savedAt: j.savedAt ?? null };
      }

      if (action === 'clear') {
        if (!target) throw new Error('browser_cookies 需要 CDP（clearBrowserCookies）；请用 --remote-debugging-port 启动 DSH。');
        await withTarget(CDP_PORT, target, (s) => s.send('Network.clearBrowserCookies', {}, 15_000));
        return { ok: true, action, note: '已清空该浏览器 profile 的全部 cookie' };
      }

      if (!target) throw new Error('browser_cookies 需要 CDP（Network.getCookies / setCookie）；请用 --remote-debugging-port 启动 DSH。');

      if (action === 'export') {
        const got = await withTarget(CDP_PORT, target, (s) => s.send('Network.getCookies', a.url ? { urls: [String(a.url)] } : {}, 20_000));
        const cookies = got?.cookies ?? [];
        fs.mkdirSync(VAULT_DIR, { recursive: true });
        const file = path.join(VAULT_DIR, `${name}.json`);
        fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), source: target.url, cookies }, null, 2));
        return {
          ok: true,
          action,
          name,
          path: file,
          total: cookies.length,
          httpOnly: cookies.filter((c) => c.httpOnly).length,
          domains: [...new Set(cookies.map((c) => c.domain))].slice(0, 20),
        };
      }

      throw new Error(`未知 action：${action}（可用 export | import | list）`);
    },
  });

  reg({
    name: 'browser_policy',
    description:
      '网络与权限控制（走已有的 CDP 通道，无需主进程桥）。action=status 看当前状态；permissions.grant / permissions.reset（Browser.grantPermissions）；cert.ignore / cert.reset（Security.setIgnoreCertificateErrors）；net.offline / net.online（Network.emulateNetworkConditions）；net.block / net.unblock（Network.setBlockedURLs）；net.headers / net.headers.clear；net.cache.clear；downloads.set（Browser.setDownloadBehavior）；intercept.enable（Fetch 域，可配 mock/redirect/block/header 规则）/ intercept.disable。⚠️ 注意：只有"真正的代理服务器（改出口 IP）"CDP 做不到，那才需要主进程。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status | permissions.grant | permissions.reset | cert.ignore | cert.reset | net.offline | net.online | net.block | net.unblock | net.headers | net.headers.clear | net.cache.clear | downloads.set | intercept.enable | intercept.disable' },
        origin: { type: 'string', description: 'permissions.grant 的源，如 https://example.com' },
        permissions: { type: 'array', description: 'permissions.grant 的权限列表，如 ["geolocation","notifications","camera"]', items: { type: 'string' } },
        urls: { type: 'array', description: 'net.block 的 URL 通配列表，如 ["*doubleclick.net*"]', items: { type: 'string' } },
        headers: { type: 'object', description: 'net.headers 的附加请求头对象。' },
        downloadPath: { type: 'string', description: 'downloads.set 的下载目录。' },
        rules: { type: 'array', description: 'intercept.enable 的规则：{match:"*api*", action:"mock"|"redirect"|"block"|"header", status?, body?, to?, headers?}', items: { type: 'object' } },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const a = args ?? {};
      const action = String(a.action || 'status');
      const ensure = async () => {
        if (policySession && policySession.ws && policySession.ws.readyState === 1) return policySession;
        const target = await currentCdpTarget(exec);
        if (!target) throw new Error('browser_policy 需要 CDP 且有 webview target；请用 --remote-debugging-port 启动 DSH 并打开页面。');
        const s = new CdpSession(target.wsUrl);
        await s.connect();
        await s.send('Network.enable').catch(() => {});
        policySession = s;
        policyTarget = { id: target.id, url: target.url };
        return s;
      };

      if (action === 'status') {
        return {
          ok: true,
          action,
          sessionAlive: !!(policySession && policySession.ws && policySession.ws.readyState === 1),
          target: policyTarget,
          intercept: policyState.intercept,
          rules: policyState.rules,
          blockedUrls: policyState.blockedUrls,
          extraHeaders: policyState.extraHeaders,
          offline: policyState.offline,
          ignoreCertErrors: policyState.ignoreCertErrors,
          note: '只有"真正的代理服务器（改出口 IP）"CDP 不支持；其余均已覆盖',
        };
      }

      const s = await ensure();

      if (action === 'permissions.grant') {
        const origin = String(a.origin || '');
        if (!origin) throw new Error('permissions.grant 需要 origin');
        const perms = Array.isArray(a.permissions) ? a.permissions.map(String) : ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'clipboard-write'];
        // ⚠️ 实测结论（2026-10-15）：对 DSH 的 webview **无效**。
        //    原因不是"需要主进程"，而是：DSH 的 webview 跑在 `partition="dsh-sidebar-browser-<uuid>"`
        //    对应的**独立 BrowserContext** 里，而该上下文**没有暴露给 CDP** ——
        //    浏览器级端点 `Target.getBrowserContexts` 返回 `[]`，
        //    带着 target 上报的 browserContextId 去授予会报 "Failed to find browser context"。
        //    不带 contextId 只能作用于默认上下文，webview 不受影响。
        //    因此这里如实上报，而不是假装成功。
        let ctxId = null;
        try {
          const ti = await s.send('Target.getTargetInfo', { targetId: policyTarget?.id }, 5000);
          ctxId = ti?.targetInfo?.browserContextId ?? null;
        } catch {}
        let granted = false;
        let detail = null;
        try {
          if (ctxId) {
            await s.send('Browser.grantPermissions', { origin, permissions: perms, browserContextId: ctxId }, 10_000);
            granted = true;
          } else {
            await s.send('Browser.grantPermissions', { origin, permissions: perms }, 10_000);
            granted = true;
          }
        } catch (e) {
          detail = String(e?.message ?? e);
        }
        return {
          ok: true,
          action,
          origin,
          permissions: perms,
          browserContextId: ctxId,
          granted,
          supported: false,
          detail,
          reason:
            'DSH 的 webview 位于 partition 对应的独立 BrowserContext，而该上下文未暴露给 CDP' +
            '（浏览器级 Target.getBrowserContexts 返回空数组），因此 Browser.grantPermissions 对内置浏览器无效。' +
            '这是"权限授予"这条能力在本环境下的真实边界 —— 与主进程无关，是 CDP 看不到那个上下文。',
          workaround: '需要权限的页面可先用 browser_click 点掉站点的权限弹窗；或改用 browser_cdp 让页面自己处理（navigator.permissions 无法被外部提升）',
        };
      }
      if (action === 'permissions.reset') {
        await s.send('Browser.resetPermissions', {}, 15_000);
        return { ok: true, action, note: '已重置全部权限覆盖' };
      }

      if (action === 'cert.ignore') {
        await s.send('Security.setIgnoreCertificateErrors', { ignore: true }, 15_000);
        policyState.ignoreCertErrors = true;
        return { ok: true, action, note: '已忽略证书错误（仅限本 CDP 会话）' };
      }
      if (action === 'cert.reset') {
        await s.send('Security.setIgnoreCertificateErrors', { ignore: false }, 15_000);
        policyState.ignoreCertErrors = false;
        return { ok: true, action };
      }

      if (action === 'net.offline' || action === 'net.online') {
        const offline = action === 'net.offline';
        await s.send('Network.emulateNetworkConditions', {
          offline, latency: 0,
          downloadThroughput: offline ? 0 : -1,
          uploadThroughput: offline ? 0 : -1,
        }, 15_000);
        policyState.offline = offline;
        return { ok: true, action, offline };
      }

      if (action === 'net.block' || action === 'net.unblock') {
        const urls = action === 'net.block' ? (Array.isArray(a.urls) ? a.urls.map(String) : []) : [];
        await s.send('Network.setBlockedURLs', { urls }, 15_000);
        policyState.blockedUrls = urls;
        return { ok: true, action, urls };
      }

      if (action === 'net.headers' || action === 'net.headers.clear') {
        const headers = action === 'net.headers' ? (a.headers ?? {}) : {};
        await s.send('Network.setExtraHTTPHeaders', { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])) }, 15_000);
        policyState.extraHeaders = headers;
        return { ok: true, action, headers };
      }

      if (action === 'net.cache.clear') {
        await s.send('Network.clearBrowserCache', {}, 15_000);
        return { ok: true, action };
      }

      if (action === 'downloads.set') {
        const downloadPath = String(a.downloadPath || path.join(os.homedir(), 'Downloads'));
        await s.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath }, 15_000);
        return { ok: true, action, downloadPath };
      }

      if (action === 'intercept.enable') {
        const rules = Array.isArray(a.rules) ? a.rules : policyState.rules;
        policyState.rules = rules;
        if (!policyState.intercept) {
          await s.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, 15_000);
          policyState.intercept = true;
          startPolicyPump();
        }
        return { ok: true, action, rules, note: '已开启请求拦截；未命中规则的请求会自动放行' };
      }
      if (action === 'intercept.disable') {
        if (policyState.intercept) await s.send('Fetch.disable', {}, 15_000).catch(() => {});
        policyState.intercept = false;
        policyState.rules = [];
        stopPolicyPump();
        return { ok: true, action };
      }

      throw new Error(`未知 action：${action}`);
    },
  });

  reg({
    name: 'browser_inject',
    description:
      '在**文档开始执行之前**注入脚本（CDP Page.addScriptToEvaluateOnNewDocument）。这是 browser_eval 做不到的：eval 只能操作「已经加载完」的页面，本工具能在页面脚本之前跑，用于 hook fetch/XHR、改 window 属性、埋点、绕过检测。action=add（需 code）/ list / remove（需 identifier）/ clear。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add | list | remove | clear（默认 list）' },
        code: { type: 'string', description: 'action=add 时要注入的 JS 源码。' },
        identifier: { type: 'string', description: 'action=remove 时的脚本 id（来自 add 或 list）。' },
        worldName: { type: 'string', description: '可选：注入到隔离世界（不污染页面全局）。' },
        reload: { type: 'boolean', description: 'add 后是否立即刷新页面使脚本生效（默认 true）。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const a = args ?? {};
      const action = String(a.action || 'list');

      /** 取/建常驻注入会话 —— 脚本随会话存在，会话断了脚本就没了，所以不能每次新建。 */
      const ensureSession = async () => {
        if (injectSession && injectSession.ws && injectSession.ws.readyState === 1) return injectSession;
        const target = await currentCdpTarget(exec);
        if (!target) throw new Error('browser_inject 需要 CDP 且需要有 webview target；请用 --remote-debugging-port 启动 DSH 并打开一个页面。');
        const s = new CdpSession(target.wsUrl);
        await s.connect();
        await s.send('Page.enable').catch(() => {});
        injectSession = s;
        injectTarget = { id: target.id, url: target.url };
        return s;
      };

      if (action === 'list') {
        return {
          ok: true,
          action,
          sessionAlive: !!(injectSession && injectSession.ws && injectSession.ws.readyState === 1),
          target: injectTarget,
          count: injectScripts.size,
          scripts: [...injectScripts.entries()].map(([id, v]) => ({ identifier: id, chars: v.chars, head: v.head })),
        };
      }

      if (action === 'add') {
        const code = String(a.code ?? '');
        if (!code.trim()) throw new Error('action=add 需要 code');
        const s = await ensureSession();
        const params = { source: code };
        if (a.worldName) params.worldName = String(a.worldName);
        const r = await s.send('Page.addScriptToEvaluateOnNewDocument', params, 15_000);
        const id = r?.identifier ?? '(unknown)';
        injectScripts.set(id, { chars: code.length, head: code.replace(/\s+/g, ' ').slice(0, 120) });
        let reloaded = false;
        if (a.reload !== false) {
          await s.send('Page.reload', {}, 10_000).catch(() => {});
          reloaded = true;
          await new Promise((r2) => setTimeout(r2, 1200));
        }
        return { ok: true, action, identifier: id, chars: code.length, reloaded, total: injectScripts.size, note: '脚本将在该 target 的每次新文档创建时执行；会话断开即失效' };
      }

      if (action === 'remove') {
        const id = String(a.identifier ?? '');
        if (!id) throw new Error('action=remove 需要 identifier');
        const s = await ensureSession();
        await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, 15_000);
        injectScripts.delete(id);
        return { ok: true, action, removed: id, total: injectScripts.size };
      }

      if (action === 'clear') {
        const s = await ensureSession();
        const removed = [];
        for (const id of injectScripts.keys()) {
          try { await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, 10_000); removed.push(id); } catch {}
        }
        injectScripts.clear();
        return { ok: true, action, removed: removed.length, total: 0 };
      }

      throw new Error(`未知 action：${action}（可用 add | list | remove | clear）`);
    },
  });

  reg({
    name: 'browser_screenshot',
    description:
      '截图当前浏览器页面并保存为 PNG，返回文件绝对路径（可用文件读取工具查看）。**优先走 CDP 原生截图**（Page.captureScreenshot，保真度最好）；CDP 不可用时自动回退到纯 Web 平台的 SVG foreignObject 方案，并在返回值 engine 里标注实际用了哪一种。可传 selector 只截某个元素（仅回退方案支持）。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '可选：只截该元素（CSS 选择器，仅 SVG 回退方案支持），默认截整个可视区域。' },
        full: { type: 'boolean', description: 'CDP 路径：整页截图（captureBeyondViewport），不受视口高度限制。' },
        clip: { type: 'string', description: 'CDP 路径：只截区域，"x,y,width,height"。' },
      },
      required: [],
    },
    output: jsonOut,
    timeoutMs: 90_000,
    async execute(args, exec) {
      const status = await bridge.send('status', {}, exec?.signal, 15_000).catch(() => null);
      // ① 优先：CDP 原生截图。
      // ⚠️ 实测：对 DSH 的 webview guest，Page.captureScreenshot **不稳定** ——
      //    刚打开页面时可用，但 guest 经历多次导航/注入后会**挂起**；
      //    同一时刻对 DSH 外壳页面（type:page）截图始终正常（522KB/326ms）。
      //    因此这里把 CDP 尝试的超时收得很短（8s），失败就立刻回退到 SVG 方案。
      const info = await cdpInfo();
      if (info) {
        try {
          const target = await pickTarget(CDP_PORT, status?.url);
          if (target) {
            const params = { format: 'png', captureBeyondViewport: !!args?.full };
            if (args?.clip) {
              const [x, y, width, height] = String(args.clip).split(',').map(Number);
              if ([x, y, width, height].every((v) => Number.isFinite(v))) {
                params.clip = { x, y, width, height, scale: 1 };
                params.captureBeyondViewport = true;
              }
            }
            const shot = await withTarget(CDP_PORT, target, (s) => s.send('Page.captureScreenshot', params, 8_000));
            if (shot?.data) {
              return {
                path: saveShot(shot.data),
                engine: 'cdp-page-captureScreenshot',
                mode: params.clip ? 'clip' : params.captureBeyondViewport ? 'full' : 'viewport',
                target: { id: target.id, type: target.type, url: target.url },
                url: status?.url ?? target.url,
                title: status?.title ?? target.title,
              };
            }
          }
        } catch (error) {
          // 落回渲染层方案，但把失败原因带回去
          const data = await bridge.send('screenshot', args ?? {}, exec?.signal, 70_000).catch(() => null);
          if (data?.base64) {
            return { path: saveShot(data.base64), width: data.width, height: data.height, engine: data.engine, url: data.url, title: data.title, cdpError: String(error?.message ?? error) };
          }
          throw error;
        }
      }
      // ② 回退：渲染层 SVG 方案
      const data = await bridge.send('screenshot', args ?? {}, exec?.signal, 70_000);
      return {
        path: saveShot(data.base64),
        width: data.width,
        height: data.height,
        engine: data.engine,
        url: data.url,
        title: data.title,
      };
    },
  });

  reg({
    name: 'browser_eval',
    description:
      '在当前浏览器页面里执行一段 JavaScript 表达式/函数体并返回结果（等价于开发者工具控制台）。这是兜底手段：能用 browser_read/browser_click/browser_type 表达时优先用它们。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JS。作为 async 函数体执行，可用 return 返回结果。' },
        awaitPromise: { type: 'boolean', description: '是否等待返回值中的 Promise（默认 true）。' },
      },
      required: ['code'],
    },
    output: jsonOut,
    timeoutMs: 90_000,
    async execute(args, exec) {
      return bridge.send('eval', args, exec?.signal, 80_000);
    },
  });

  reg({
    name: 'browser_history',
    description:
      '浏览器导航控制与历史读取。action=back / forward / reload 执行导航并返回结果；action=list **读取访问历史列表**（优先走 CDP Page.getNavigationHistory，无 CDP 时回退到页面内的条数）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'back | forward | reload | list' },
        max: { type: 'number', description: 'action=list 时最多返回多少条（默认 30）。' },
      },
      required: ['action'],
    },
    output: jsonOut,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const a = args ?? {};
      if (String(a.action).toLowerCase() !== 'list') {
        return bridge.send('history', { action: a.action }, exec?.signal, 50_000);
      }
      const max = Math.max(1, Math.min(Number(a.max || 30), 200));
      // ① 优先：CDP 的原生历史（有完整标题与 URL）
      const target = await currentCdpTarget(exec).catch(() => null);
      if (target) {
        try {
          const h = await withTarget(CDP_PORT, target, (s) => s.send('Page.getNavigationHistory', {}, 15_000));
          const entries = (h?.entries ?? []).map((e, i) => ({ index: i, id: e.id, url: e.url, title: e.title, transition: e.transitionType }));
          return {
            ok: true,
            engine: 'cdp-getNavigationHistory',
            currentIndex: h?.currentIndex ?? null,
            total: entries.length,
            history: entries.slice(-max),
          };
        } catch (error) {
          const fallback = await bridge
            .send('eval', { code: 'return { length: history.length, url: location.href, title: document.title };' }, exec?.signal, 20_000)
            .catch(() => null);
          return {
            ok: true,
            engine: 'renderer-length-only',
            note: 'CDP 读取失败，仅能给出条数（渲染层拿不到历史条目明细）',
            cdpError: String(error?.message ?? error),
            length: fallback?.result?.length ?? null,
            url: fallback?.result?.url ?? null,
            title: fallback?.result?.title ?? null,
          };
        }
      }
      const fallback = await bridge
        .send('eval', { code: 'return { length: history.length, url: location.href, title: document.title };' }, exec?.signal, 20_000);
      return { ok: true, engine: 'renderer-length-only', length: fallback?.result?.length ?? null, url: fallback?.result?.url ?? null, title: fallback?.result?.title ?? null };
    },
  });

  return disposers;
}

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文
 */
export async function apply(ctx) {
  const logger = ctx?.logger?.('dsh-browser-agent');
  const bridge = new Bridge();
  let server = null;
  try {
    server = await startBridge(bridge, logger);
    logger?.info?.(`browser-agent 桥接已监听 127.0.0.1:${BRIDGE_PORT} (v${PLUGIN_VERSION})`);
  } catch (error) {
    logger?.warn?.(`browser-agent 桥接启动失败: ${String(error?.message ?? error)}`);
  }

  const disposers = registerTools(ctx, bridge);

  // 常驻系统提示段：让每个新会话都知道这些工具存在、以及该怎么用。
  // 缺失 systemPrompt 服务时静默跳过（插件其余功能不受影响）。
  let promptDisposer = null;
  try {
    const sp = ctx.systemPrompt;
    if (sp && typeof sp.section === 'function') {
      promptDisposer = sp.section({
        name: 'tools:dsh-browser-agent',
        order: typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('TOOLS') : 100,
        text: () => PROMPT_SECTION,
      });
      logger?.info?.('browser-agent 已注册系统提示段（新会话会自动看到工具用法）');
    } else {
      logger?.warn?.('browser-agent 未找到 ctx.systemPrompt.section —— 跳过提示段（工具仍可用）');
    }
  } catch (error) {
    logger?.warn?.(`browser-agent 注册提示段失败（忽略）: ${String(error?.message ?? error)}`);
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d?.();
      } catch {
        /* 忽略重复 dispose */
      }
    }
    try {
      server?.close();
    } catch {
      /* 忽略 */
    }
  });
}
