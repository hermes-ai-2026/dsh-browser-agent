/**
 * 零依赖 CDP（Chrome DevTools Protocol）客户端。
 *
 * 为什么可以是零依赖：Node 24 自带全局 `WebSocket`（已在本机确认），因此不需要 ws / puppeteer。
 *
 * 这是"补上 CDP 原生协议域"的底座：
 *   - `Page.captureScreenshot`   → 原生截图（不再依赖 SVG foreignObject 那套近似方案）
 *   - `Input.dispatchMouseEvent` → **isTrusted: true** 的真实输入（hover 菜单终于点得动）
 *   - `Network.*` / `Fetch.*`    → 全量请求头/体，且可拦截改写
 *   - `Emulation.*`              → UA / 设备尺寸覆盖
 *   - 其余全部域                 → 通过 browser_cdp 工具直接透传
 *
 * 前提：DSH 必须以 `--remote-debugging-port=<port>` 启动。未开时这里会**优雅失败**，
 * 调用方应回退到渲染层桥（能力分级，诚实上报）。
 */

/** 探测调试端口是否可用。 */
export async function probeCdp(port = 9222, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const info = await res.json();
    return {
      port,
      browser: info.Browser ?? null,
      protocolVersion: info['Protocol-Version'] ?? null,
      userAgent: info['User-Agent'] ?? null,
    };
  } catch {
    return null;
  }
}

/** 列出所有 target（含 `<webview>` guest —— 它们会作为独立 target 出现）。 */
export async function listTargets(port = 9222, timeoutMs = 3000) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  const list = await res.json();
  return (Array.isArray(list) ? list : []).map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title ?? '',
    url: t.url ?? '',
    wsUrl: t.webSocketDebuggerUrl ?? null,
    attached: !!t.attached,
  }));
}

/**
 * 挑选默认 target。
 *
 * ⚠️ 安全护栏（用真实事故换来）：**默认只返回 `<webview>` target，绝不返回 DSH 外壳页面**。
 * 曾因为没有 webview 而回退到 `type:"page"` 的外壳 target，一条 `Page.navigate`
 * 就把 DSH 自己的界面导航成了 example.com。因此：
 *   - 默认 `allowPage:false` → 没有 webview 时返回 null，由调用方明确报错；
 *   - 只有显式 `allowPage:true`（诊断用）才可能拿到外壳页面。
 */
export async function pickTarget(port = 9222, hintUrl, options = {}) {
  const allowPage = options.allowPage === true;
  const targets = await listTargets(port);
  if (hintUrl) {
    const exact = targets.find((t) => t.url === hintUrl && t.wsUrl && (allowPage || t.type === 'webview'));
    if (exact) return exact;
  }
  const webviews = targets.filter((t) => t.type === 'webview' && t.wsUrl);
  if (webviews.length > 0) {
    const http = webviews.filter((t) => /^https?:/i.test(t.url));
    return http[http.length - 1] ?? webviews[webviews.length - 1];
  }
  if (!allowPage) return null; // ← 关键护栏
  return targets.find((t) => t.type === 'page' && t.wsUrl) ?? null;
}

/** 一条 CDP 会话（一次 WebSocket 连接）。 */
export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    /** 未被请求订阅的事件（method 不含 id）会进这里。 */
    this.events = [];
    this.maxEvents = 500;
  }

  connect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error(`CDP 连接超时（${timeoutMs}ms）: ${this.wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败: ${String(e?.message ?? 'websocket error')}`));
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer: t } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(t);
          if (msg.error) reject(new Error(`CDP ${msg.error.message ?? 'error'}${msg.error.code ? ` (code ${msg.error.code})` : ''}`));
          else resolve(msg.result);
          return;
        }
        if (msg.method) {
          this.events.push({ method: msg.method, params: msg.params ?? null, sessionId: msg.sessionId ?? null, at: Date.now() });
          if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
        }
      });
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('CDP 连接已关闭'));
        }
        this.pending.clear();
      });
    });
  }

  /** 发一条 CDP 命令并等待结果。 */
  send(method, params = {}, timeoutMs = 30_000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP 发送失败: ${String(e?.message ?? e)}`));
      }
    });
  }

  /** 取走（并清空）已收集的事件。 */
  takeEvents(filter) {
    const out = filter ? this.events.filter((e) => String(e.method).startsWith(filter)) : this.events.slice();
    this.events.length = 0;
    return out;
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

/** 便捷：连上某个 target 并执行一段回调，结束后自动关闭。 */
export async function withTarget(port, target, fn) {
  if (!target || !target.wsUrl) throw new Error('没有可用的 CDP target');
  const session = new CdpSession(target.wsUrl);
  await session.connect();
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}
