/**
 * dsh-browser-agent — 客户端半（Client half，运行在渲染进程）
 *
 * 职责：找到 DSH 右侧 Sidebar 的浏览器 <webview>，执行宿主半下发的命令，把结果回填。
 *
 * 为什么可行（逆向 DSH 得到的结论）：
 *   - `@deepseek-ai/dsh-client-ui-sidebar-browser` 在 Desktop 上用 `document.createElement("webview")`
 *     创建真正的 Electron <webview>，并打上 `data-sidebar-browser-frame="webview"` 标记；
 *   - preload 只通过 `globalThis.dshDesktop.browser` 暴露租约（acquire/release/onOpenRequested），
 *     导航与页面操作本来就在渲染层用标准 <webview> API 完成；
 *   - 因此同一渲染进程里的另一个客户端插件只要拿到该元素，就能用 loadURL / executeJavaScript /
 *     capturePage 完整驱动它 —— 这正是把「只能看」变成「可驱动」的突破口。
 */

window.__ModuleLoader__.load({
  id: 'dsh-browser-agent',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // 与宿主半保持一致（两半同源，见 lib/index.js）。
    // window.DSH_BROWSER_AGENT_PORT 仅用于独立测试台，真实运行时不设置，走默认 8791。
    const BRIDGE_PORT = Number(window.DSH_BROWSER_AGENT_PORT) || 8791;
    const BRIDGE_TOKEN = 'dsh-browser-agent-local-bridge-v1';
    const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
    const CLIENT_ID = `renderer-${Math.random().toString(36).slice(2, 10)}`;
    /** 客户端半版本：随 /hello 上报，宿主在 /health 里回报，便于确认渲染半是否也已更新。 */
    const CLIENT_VERSION = '0.4.0';
    const FRAME_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]';

    /** 需要 sidebarRight 才能在没有标签页时打开一个浏览器页。 */
    const inject = ['sidebarRight'];

    /**
     * 自建浏览器实例（对标 Codex 的 `Browsers` 多实例管理）。
     *
     * 可行性来自 preload 暴露的租约 API（已实证）：
     *   `dshDesktop.browser.acquire(workspace)` → `{ lease, partition }`
     *   用 `partition` + `src="about:blank#<lease>"` 创建一个 `<webview>`，
     *   主进程在 `did-attach-webview` → `dom-ready` 时校验租约：
     *     `lease.owner !== owner || lease.guest !== void 0` → 静默 `guest.close()`（**安全失败，不崩溃**）
     *   因为本插件的渲染半与 DSH 的 UI 在**同一个渲染进程**，`owner` 天然匹配。
     *
     * `activeInstanceId` 为 null 时，所有操作照旧作用于侧边栏那个浏览器；
     * 选定某个实例后，`findWebview()` 会改而返回该实例 —— 于是**全部工具自动支持多实例**。
     */
    const instances = new Map();
    let activeInstanceId = null;

    /** 递归穿透 shadow root 查询（DSH 的 UI 大量使用自定义元素 + shadow DOM）。 */
    function deepQuery(selector, root = document) {
      const direct = root.querySelector?.(selector);
      if (direct) return direct;
      const all = root.querySelectorAll?.('*') ?? [];
      for (const el of all) {
        if (el.shadowRoot) {
          const hit = deepQuery(selector, el.shadowRoot);
          if (hit) return hit;
        }
      }
      return null;
    }

    /** 元素是否真的可见（用于在一个标签页组里挑"当前那个"）。 */
    function isVisible(el) {
      try {
        const r = el.getBoundingClientRect?.();
        return !r || (r.width > 0 && r.height > 0);
      } catch {
        return false;
      }
    }

    /**
     * 列出所有已挂载的浏览器 <webview>。
     *
     * 为什么需要"所有"：DSH 的浏览器标签页声明了 keepMounted，切标签也不会卸载 DOM，
     * 所以同一时刻可能存在多个 webview。旧实现只取第一个并且**每次都新建标签页**，
     * 结果侧边栏里堆出一排重复标签（用户实测反馈），既不好用也徒增内存压力。
     */
    function findAllWebviews() {
      const out = [];
      const push = (el) => {
        if (el && el.isConnected && !out.includes(el)) out.push(el);
      };
      const direct = document.querySelectorAll?.(FRAME_SELECTOR);
      if (direct) for (const el of direct) push(el);
      if (out.length === 0) {
        // 兜底：逐个 shadow root 找
        const walk = (root) => {
          const hits = root.querySelectorAll?.(FRAME_SELECTOR);
          if (hits) for (const el of hits) push(el);
          const all = root.querySelectorAll?.('*') ?? [];
          for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
        };
        walk(document);
      }
      if (out.length === 0) push(deepQuery('webview'));
      return out;
    }

    /**
     * 选一个承载浏览器页的 webview：优先可见的那个，否则取最后一个（最近创建的）。
     * **不新建标签页**——新建只在确实一个都没有时发生。
     */
    function findWebview() {
      // 选定自建实例时优先返回它 —— 这样所有工具都自动支持多实例。
      if (activeInstanceId && instances.has(activeInstanceId)) {
        const inst = instances.get(activeInstanceId);
        if (inst.wv && inst.wv.isConnected) return inst.wv;
      }
      const all = findAllWebviews();
      if (all.length === 0) return null;
      const visible = all.filter(isVisible);
      if (visible.length > 0) return visible[visible.length - 1];
      return all[all.length - 1];
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** 等待 webview 出现（打开标签页之后需要一点时间）。 */
    async function waitForWebview(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const wv = findWebview();
        if (wv) return wv;
        if (Date.now() > deadline) return null;
        await sleep(150);
      }
    }

    /** 等待页面加载完成（尽力而为：事件 + 轮询双保险）。 */
    function waitForLoad(wv, timeoutMs = 30_000) {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          wv.removeEventListener('did-stop-loading', finish);
          wv.removeEventListener('did-fail-load', finish);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        wv.addEventListener('did-stop-loading', finish, { once: true });
        wv.addEventListener('did-fail-load', finish, { once: true });
        // 有些情况下事件早于监听器注册，轮询兜底
        const poll = setInterval(() => {
          try {
            if (!wv.isLoading()) {
              clearInterval(poll);
              finish();
            }
          } catch {
            clearInterval(poll);
            finish();
          }
        }, 250);
        timer.addEventListener?.('unref', () => {});
        setTimeout(() => clearInterval(poll), timeoutMs + 50);
      });
    }

    /** 在 guest 页面里执行 JS，返回结构化结果。 */
    async function runInPage(wv, body, timeoutMs = 30_000) {
      const code = `(async () => { ${body} })()`;
      const raw = await Promise.race([
        wv.executeJavaScript(code, true),
        sleep(timeoutMs).then(() => {
          throw new Error('page evaluation timed out');
        }),
      ]);
      return raw;
    }

    /** guest 页面内通用的辅助代码（元素查找 / 可见性 / 原生 setter）。 */
    const HELPERS = `
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const byText = (text) => {
        const all = Array.from(document.querySelectorAll('a,button,[role=button],input[type=submit],label,li,span,div,p,h1,h2,h3'));
        return all.filter((el) => vis(el) && (el.innerText || el.textContent || '').trim().toLowerCase().includes(text.toLowerCase()));
      };
      const pick = (args) => {
        let el = null;
        // ref 优先：AX 快照给出的稳定寻址方式（对标 Codex 的 AXAPI）
        if (args && args.ref) {
          const r = String(args.ref).replace(/[^\\w-]/g, '');
          el = document.querySelector('[data-dsh-ref="' + r + '"]');
          if (!el) throw new Error('ref ' + r + ' 已失效（页面可能已变化），请重新 browser_read mode=ax 获取最新 ref');
          return el;
        }
        if (args && args.selector) {
          const list = Array.from(document.querySelectorAll(args.selector));
          el = list[args.index || 0] || null;
        } else if (args && args.text) {
          const list = byText(args.text);
          el = list[args.index || 0] || null;
        }
        return el;
      };
      const setValue = (el, value) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
                    : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
    `;

      /**
       * 页面内**虚拟鼠标**（对标 Codex 内置浏览器的可视光标）。
       *
       * Codex 的浏览器里有一个内置虚拟指针，让用户能看见 agent 正在操作哪里 ——
       * 它不是桌面级鼠标，而是画在页面里的覆盖层。这里照做：
       *   - SVG 指针带缓动地移动到目标元素中心
       *   - 点击时扩散一圈涟漪
       *   - 输入时给目标描边
       * 覆盖层为 pointer-events:none，不干扰页面自身交互。
       * 可用 `visual:false` 关闭。
       */
      const CURSOR = `
        const showCursor = (el, kind) => {
          try {
            // 指针本体：白色箭头 + 深色描边 + 投影
            let cur = document.getElementById('__dsh_cursor');
            if (!cur) {
              cur = document.createElement('div');
              cur.id = '__dsh_cursor';
              cur.setAttribute('aria-hidden', 'true');
              cur.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647;'
                + 'pointer-events:none;will-change:transform;'
                + 'transition:transform .26s cubic-bezier(.22,.61,.36,1);'
                + 'filter:drop-shadow(0 2px 5px rgba(0,0,0,.6))';
              cur.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24">'
                + '<path d="M4.5 1.6 L4.5 19.4 L9.3 14.7 L12.4 21.8 L15.6 20.3 L12.4 13.3 L19.1 13.3 Z" '
                + 'fill="#ffffff" stroke="#111827" stroke-width="1.6" stroke-linejoin="round"/></svg>';
              document.documentElement.appendChild(cur);
            }
            // 定位光环：让指针在复杂/浅色页面上也一眼可见
            let ring = document.getElementById('__dsh_cursor_ring');
            if (!ring) {
              ring = document.createElement('div');
              ring.id = '__dsh_cursor_ring';
              ring.setAttribute('aria-hidden', 'true');
              ring.style.cssText = 'position:fixed;left:0;top:0;width:48px;height:48px;margin:-24px 0 0 -24px;'
                + 'border-radius:50%;pointer-events:none;z-index:2147483646;'
                + 'border:3px solid rgba(37,99,235,.95);'
                + 'box-shadow:0 0 0 2px rgba(255,255,255,.9), 0 0 14px rgba(37,99,235,.65);'
                + 'background:radial-gradient(circle, rgba(37,99,235,.25) 0%, rgba(37,99,235,0) 70%);'
                + 'transition:transform .26s cubic-bezier(.22,.61,.36,1)';
              document.documentElement.appendChild(ring);
            }
            const r = el.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            cur.style.transform = 'translate(' + (cx - 4) + 'px,' + (cy - 3) + 'px)';
            ring.style.transform = 'translate(' + cx + 'px,' + cy + 'px)';

            const rip = document.createElement('div');
            rip.style.cssText = 'position:fixed;left:' + cx + 'px;top:' + cy + 'px;'
              + 'width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;'
              + 'background:rgba(37,99,235,.4);border:2.5px solid rgba(37,99,235,.95);'
              + 'z-index:2147483647;pointer-events:none;'
              + 'transition:transform .6s ease-out,opacity .6s ease-out';
            document.documentElement.appendChild(rip);
            requestAnimationFrame(() => { rip.style.transform = 'scale(4.5)'; rip.style.opacity = '0'; });
            setTimeout(() => rip.remove(), 680);

            // 目标元素描边：让人看清"要点哪里"
            const prevOutline = el.style.outline;
            const prevOffset = el.style.outlineOffset;
            el.style.outline = kind === 'type' ? '3px solid rgba(37,99,235,.95)' : '2px solid rgba(37,99,235,.8)';
            el.style.outlineOffset = '2px';
            setTimeout(() => { el.style.outline = prevOutline; el.style.outlineOffset = prevOffset; }, kind === 'type' ? 1600 : 1200);
            return el;
          } catch (e) { return el; }
        };
        const dwell = (ms) => new Promise((r) => setTimeout(r, ms));

        /**
         * 派发完整的指针/鼠标事件序列（不只是 el.click()）。
         * 很多富组件依赖 pointerover/mouseover 展开、pointerdown 序列判定拖拽，
         * 只发一个 click 是点不动的。这里补齐：
         *   hover  → pointerover, mouseover, pointerenter, mouseenter, pointermove, mousemove
         *   按下   → pointerdown, mousedown
         *   抬起   → pointerup, mouseup
         * 最后仍调用 el.click() 以触发**默认动作**（链接跳转、表单提交等）。
         */
        const firePointer = (el, opts) => {
          const o = opts || {};
          const r = el.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2);
          const y = Math.round(r.top + r.height / 2);
          const base = { bubbles: true, cancelable: true, composed: true, view: window,
            clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
          const send = (type, extra) => {
            try {
              const isPointer = type.indexOf('pointer') === 0;
              const Ctor = isPointer ? (typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent) : MouseEvent;
              const init = Object.assign({}, base, extra);
              if (isPointer) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
              el.dispatchEvent(new Ctor(type, init));
              return true;
            } catch (e) { return false; }
          };
          const hoverSeq = ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove'];
          let fired = 0;
          for (const t of hoverSeq) { if (send(t, { buttons: 0 })) fired++; }
          if (o.hoverOnly) return { hovered: true, events: fired, at: [x, y] };
          if (send('pointerdown', { buttons: 1 })) fired++;
          if (send('mousedown', { buttons: 1 })) fired++;
          if (send('pointerup', { buttons: 0 })) fired++;
          if (send('mouseup', { buttons: 0 })) fired++;
          return { events: fired, at: [x, y] };
        };
      `;

      // 统一的可操作引导：缺页时告诉调用方下一步该做什么，而不是只报错。
      const NO_PAGE =
        '当前没有可驱动的浏览器页面。请在右侧侧边栏打开「浏览器」标签页，或直接用 browser_open 让本插件打开一个 URL。';

      /**
       * AX 快照构建器（对标 Codex 内置浏览器的 AXAPI）。
       *
       * Codex 给 agent 的页面视图不是像素，而是**结构化 + 可稳定寻址**的语义树；
       * agent 先读它，再按 ref 精确操作。这里照做：
       *   - 计算 role（显式 role 优先，否则按标签/输入类型推断）
       *   - 计算 accessible name（aria-label > alt > placeholder > title > name > value > 文本）
       *   - 记录交互态（disabled/checked/required/expanded）与几何位置
       *   - 给每个保留节点打上 data-dsh-ref="eN"，后续 click/type 可直接用 ref 寻址
       */
      const AX_BUILDER = `
        const __roleOf = (el) => {
          const explicit = (el.getAttribute && el.getAttribute('role')) || '';
          if (explicit) return explicit;
          const t = el.tagName.toLowerCase();
          const type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
          const map = {
            a: (el.hasAttribute && el.hasAttribute('href')) ? 'link' : 'generic',
            button: 'button', select: 'combobox', textarea: 'textbox', option: 'option',
            h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
            img: 'img', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
            form: 'form', table: 'table', ul: 'list', ol: 'list', li: 'listitem', label: 'label',
            input: type === 'checkbox' ? 'checkbox'
                 : type === 'radio' ? 'radio'
                 : (type === 'submit' || type === 'button') ? 'button'
                 : type === 'search' ? 'searchbox'
                 : type === 'range' ? 'slider'
                 : 'textbox'
          };
          return map[t] || 'generic';
        };
        const __nameOf = (el) => {
          const a = (k) => (el.getAttribute && el.getAttribute(k)) || '';
          const cand = [
            a('aria-label'), a('alt'), a('placeholder'), a('title'), a('name'),
            (el.tagName === 'INPUT' && el.value) ? el.value : '',
            el.innerText || el.textContent || ''
          ];
          for (const c of cand) {
            const s = String(c).replace(/\\s+/g, ' ').trim();
            if (s) return s.slice(0, 120);
          }
          return '';
        };
        const __stateOf = (el) => {
          const s = [];
          if (el.disabled) s.push('disabled');
          if (el.checked) s.push('checked');
          if (el.required) s.push('required');
          if (el.readOnly) s.push('readonly');
          const exp = el.getAttribute && el.getAttribute('aria-expanded');
          if (exp != null) s.push('expanded=' + exp);
          return s;
        };
        const buildAx = (max) => {
          const HOT = new Set(['link','button','textbox','searchbox','checkbox','radio','combobox','option','slider','menuitem','tab','switch']);
          const SEM = new Set(['heading','img','list','listitem','table','form','navigation','main','banner','contentinfo','label']);
          const nodes = [];
          let i = 0;
          const walk = (el) => {
            if (nodes.length >= max || !el || !el.tagName) return;
            const tag = el.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
            if (!vis(el)) return;
            const role = __roleOf(el);
            const name = __nameOf(el);
            const hot = HOT.has(role);
            const leafText = role === 'generic' && name && (!el.children || el.children.length === 0);
            if (hot || SEM.has(role) || leafText) {
              const ref = 'e' + (++i);
              try { el.setAttribute('data-dsh-ref', ref); } catch {}
              const r = el.getBoundingClientRect();
              const node = { ref, role, tag, name };
              if (hot) node.interactive = true;
              const val = el.value == null ? '' : String(el.value);
              if (val && (role === 'textbox' || role === 'searchbox' || role === 'combobox')) node.value = val.slice(0, 200);
              const st = __stateOf(el);
              if (st.length) node.state = st;
              if (role === 'heading') node.level = Number(tag[1]) || null;
              if (role === 'img') { node.alt = (el.getAttribute && el.getAttribute('alt')) || ''; node.src = String(el.currentSrc || el.src || '').slice(0, 200); }
              node.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
              nodes.push(node);
            }
            for (const c of Array.from(el.children || [])) walk(c);
          };
          walk(document.body || document.documentElement);
          return nodes;
        };
        const axToText = (nodes) => nodes.map((n) => {
          const box = n.box ? ' @' + n.box[0] + ',' + n.box[1] + ' ' + n.box[2] + 'x' + n.box[3] : '';
          const st = n.state ? ' [' + n.state.join(',') + ']' : '';
          const val = n.value ? ' value="' + n.value + '"' : '';
          const lvl = n.level ? ' h' + n.level : '';
          return '[' + n.ref + '] ' + n.role + lvl + ' "' + n.name + '"' + val + st + box;
        }).join('\\n');
      `;
    const OPS = {
      /**
       * 自建浏览器实例（对标 Codex 的 `Browsers`）。
       *
       * action:
       *   list   列出实例（含当前选中的）
       *   create 新建一个实例（可选 url、visible=true 时会挂成右下角浮层供人观看）
       *   close  关闭实例（拆 webview + 释放租约）
       *   select 把后续所有浏览器操作切到该实例（`id:null` 表示切回侧边栏浏览器）
       */
      async instance(ctx, args) {
        const a = args || {};
        const action = String(a.action || 'list');
        const carrier = globalThis.dshDesktop;
        const desktop = carrier && carrier.protocolVersion === 1 ? carrier.browser : undefined;
        if (!desktop) throw new Error('当前环境没有 dshDesktop 浏览器租约 API（只有 DSH Desktop 才有；Web 版不可用）');

        const describe = (id, inst) => ({
          id,
          lease: inst.lease,
          partition: inst.partition,
          visible: !!inst.visible,
          createdAt: inst.createdAt,
          url: safe(() => inst.wv.getURL()),
          title: safe(() => inst.wv.getTitle()),
          destroyed: !inst.wv || !inst.wv.isConnected,
        });
        const list = () => Array.from(instances.entries()).map(([id, inst]) => describe(id, inst));

        if (action === 'list') {
          return { ok: true, action, active: activeInstanceId, count: instances.size, instances: list() };
        }

        if (action === 'create') {
          const acquired = await desktop.acquire('dsh-browser-agent');
          if (!acquired || !acquired.lease) throw new Error('acquire 未返回租约');
          const id = acquired.lease;

          // 浮层（可选）：让用户能看见这个实例。离屏时完全不可见、不影响布局。
          const host = document.createElement('div');
          host.id = '__dsh_agent_instance_' + id;
          const visible = a.visible === true;
          host.style.cssText = visible
            ? 'position:fixed;right:16px;bottom:16px;width:420px;height:640px;z-index:2147483646;'
              + 'border-radius:10px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.45);'
              + 'border:1px solid rgba(255,255,255,.18);background:#111'
            : 'position:fixed;left:-12000px;top:0;width:1024px;height:768px;visibility:hidden';

          const wv = document.createElement('webview');
          wv.setAttribute('partition', acquired.partition);
          wv.setAttribute('allowpopups', '');
          wv.setAttribute('src', 'about:blank#' + acquired.lease);
          wv.style.cssText = visible ? 'width:100%;height:100%' : 'width:1024px;height:768px';

          // 主进程若拒绝租约会静默关闭 guest —— 用 dom-ready 判定是否真的挂上了。
          let attached = false;
          await new Promise((resolve) => {
            const done = () => resolve();
            wv.addEventListener('dom-ready', () => { attached = true; done(); });
            wv.addEventListener('destroyed', done);
            setTimeout(done, 4000);
            host.appendChild(wv);
            document.body.appendChild(host);
          });

          if (!attached) {
            try { wv.remove(); host.remove(); } catch {}
            try { await desktop.release(acquired.lease); } catch {}
            throw new Error('租约未被主进程接受（guest 未挂载），已回滚。');
          }

          instances.set(id, { lease: acquired.lease, partition: acquired.partition, wv, host, visible, createdAt: Date.now() });
          if (a.select !== false) activeInstanceId = id;
          if (a.url) {
            wv.loadURL(String(a.url));
            await new Promise((r) => setTimeout(r, 1200));
          }
          return { ok: true, action, id, active: activeInstanceId, count: instances.size, instances: list() };
        }

        if (action === 'select') {
          const id = a.id == null ? null : String(a.id);
          if (id && !instances.has(id)) throw new Error('实例不存在：' + id + '（先用 action=list 查看）');
          activeInstanceId = id;
          return { ok: true, action, active: activeInstanceId, count: instances.size, instances: list() };
        }

        if (action === 'close') {
          const id = a.id ? String(a.id) : activeInstanceId;
          if (!id || !instances.has(id)) throw new Error('实例不存在：' + (id ?? '(未指定且无选中)'));
          const inst = instances.get(id);
          try { inst.wv.remove(); } catch {}
          try { inst.host.remove(); } catch {}
          instances.delete(id);
          if (activeInstanceId === id) activeInstanceId = null;
          try { await desktop.release(inst.lease); } catch {}
          return { ok: true, action, closed: id, active: activeInstanceId, count: instances.size, instances: list() };
        }

        throw new Error(`未知 action：${action}（可用 list | create | close | select）`);
      },

      /**
       * 标签页管理：列出 / 关闭 / 激活 DSH 侧边栏里的浏览器标签。
       *
       * 实现方式：直接操作 **DSH 自己的 UI DOM**（本插件的渲染半和 DSH 的 UI 在同一个渲染进程）。
       * 实证：每个浏览器标签是 `[role="tab"]`，其关闭按钮是 `button[aria-label="关闭"]`，
       * 位于 `[role="tablist"]`（对话/轨迹那两个 tablist 没有关闭按钮，据此排除）。
       *
       * 这个方法**在当前客户端里就能跑，不需要重启 DSH**（用的是本进程的 document）。
       */
      async tabs(ctx, args) {
        const action = String((args && args.action) || 'list');
        const collect = () => {
          const out = [];
          for (const list of Array.from(document.querySelectorAll('[role="tablist"]'))) {
            for (const t of Array.from(list.querySelectorAll('[role="tab"]'))) {
              if (t.querySelector('button[aria-label="关闭"]')) out.push(t);
            }
          }
          return out;
        };
        const snapshot = (list) =>
          list.map((t, i) => ({
            index: i,
            title: String(t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
            active: t.getAttribute('aria-selected') === 'true',
          }));

        const tabs = collect();
        if (action === 'list') return { ok: true, action, count: tabs.length, tabs: snapshot(tabs) };

        if (action === 'close' || action === 'activate') {
          const idx = Number(args.index);
          if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.length) {
            throw new Error(`标签序号不存在：${args.index}（当前共 ${tabs.length} 个）`);
          }
          const title = String(tabs[idx].innerText || '').trim().slice(0, 60);
          if (action === 'close') {
            const btn = tabs[idx].querySelector('button[aria-label="关闭"]');
            if (!btn) throw new Error('该标签没有关闭按钮');
            btn.click();
          } else {
            tabs[idx].click();
          }
          await new Promise((r) => setTimeout(r, 350));
          const after = collect();
          return { ok: true, action, target: { index: idx, title }, count: after.length, tabs: snapshot(after) };
        }
        throw new Error(`未知 action：${action}（可用 list | close | activate）`);
      },

      /**
       * 【诊断用】在 **DSH 渲染进程**（不是 guest 页面）里执行代码。
       *
       * 与 `eval` 的区别很关键：`eval` 跑在网页里，这个是跑在 DSH 自己的渲染上下文里，
       * 因此能检查 `globalThis.dshDesktop`（preload 暴露的租约 API）、webview 元素本身、
       * 以及 DSH 自己的 UI DOM（标签条等）。
       *
       * 只用于探查"到底哪些能力是真的拿不到"，不经由模型工具暴露。
       */
      async rendererEval(ctx, args) {
        const code = String((args && args.code) || '');
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction('ctx', 'doc', 'win', code);
        const result = await fn(ctx, document, window);
        return { ok: true, result: result === undefined ? null : result };
      },

      /**
       * AX 快照（对标 Codex 的 AXAPI）：返回结构化语义树 + 紧凑文本视图。
       * 这是**首选的"看页面"方式**——比截图更省、比 mode=dom 更有信息量，且天然可寻址。
       */
      async ax(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const max = Math.max(20, Math.min(Number((args && args.max) || 150), 400));
        const body = `
          ${HELPERS}
          ${AX_BUILDER}
          const nodes = buildAx(${max});
          return {
            ok: true,
            url: location.href,
            title: document.title,
            count: nodes.length,
            text: axToText(nodes),
            nodes: nodes,
          };
        `;
        return runInPage(wv, body, 40_000);
      },

      /** 页面资源清单（对标 Codex 的 pageAssets）。 */
      async assets() {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const body = `
          const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
          const images = Array.from(document.images).map((im) => ({
            src: abs(im.currentSrc || im.src || ''), alt: im.alt || '',
            w: im.naturalWidth || 0, h: im.naturalHeight || 0,
            loaded: !!(im.complete && im.naturalWidth > 0),
          })).slice(0, 200);
          const scripts = Array.from(document.scripts).map((s) => ({
            src: s.src ? abs(s.src) : null, inline: !s.src,
            chars: s.src ? null : String(s.textContent || '').length,
          })).slice(0, 120);
          const stylesheets = Array.from(document.styleSheets).map((s) => ({
            href: s.href ? abs(s.href) : null,
            rules: (() => { try { return s.cssRules.length; } catch { return null; } })(),
          })).slice(0, 60);
          const links = Array.from(document.links).map((a) => ({
            text: String(a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), href: abs(a.href || ''),
          })).slice(0, 200);

          // WebMCP：页面通过 navigator.modelContext 声明的工具（对标 Codex 的 tab/webmcp）
          let webmcp = { present: false };
          try {
            const mc = navigator.modelContext;
            if (mc) {
              let tools = null;
              try {
                tools = typeof mc.getTools === 'function' ? await mc.getTools() : (mc.tools || null);
              } catch (e) { tools = { error: String((e && e.message) || e) }; }
              webmcp = { present: true, keys: Object.keys(mc), tools: tools };
            }
          } catch (e) { webmcp = { present: false, error: String((e && e.message) || e) }; }

          return {
            ok: true, url: location.href, title: document.title,
            counts: { images: images.length, scripts: scripts.length, stylesheets: stylesheets.length, links: links.length },
            images, scripts, stylesheets, links, webmcp,
          };
        `;
        return runInPage(wv, body, 40_000);
      },

      /**
       * 视口 / 缩放 / 可见性 / 样式注入（对标 Codex 的 `browser/viewport`、`browser/visibility`）。
       *
       * 关键认识：`<webview>` 就是渲染层的一个普通元素，因此**尺寸由我们可控**，
       * 而且元素本身自带 `setZoomFactor()` / `insertCSS()` —— 这两点不需要任何主进程 API。
       *
       * 注意：改尺寸会影响用户看到的面板大小；`hidden` 只是视觉隐藏（与"让用户看见"相悖，谨慎用）。
       */
      async viewport(ctx, args) {
        const a = args || {};
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const out = { ok: true, actions: [] };
        try {
          if (a.reset) {
            wv.style.width = '';
            wv.style.height = '';
            wv.style.visibility = '';
            try { wv.setZoomFactor(1); } catch {}
            out.actions.push('reset');
          }
          if (a.zoom != null) {
            try { wv.setZoomFactor(Number(a.zoom)); out.actions.push('zoom=' + a.zoom); }
            catch (e) { out.zoomError = String((e && e.message) || e); }
          }
          if (a.width != null) { wv.style.width = Number(a.width) + 'px'; out.actions.push('width=' + a.width); }
          if (a.height != null) { wv.style.height = Number(a.height) + 'px'; out.actions.push('height=' + a.height); }
          if (a.hidden != null) { wv.style.visibility = a.hidden ? 'hidden' : ''; out.actions.push('hidden=' + !!a.hidden); }
          if (a.css != null) { out.cssKey = await wv.insertCSS(String(a.css)); out.actions.push('css-injected'); }
        } catch (e) {
          out.error = String((e && e.message) || e);
        }
        out.zoom = safe(() => wv.getZoomFactor());
        const r = safe(() => wv.getBoundingClientRect());
        if (r) out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        out.inlineStyle = {
          width: wv.style.width || null,
          height: wv.style.height || null,
          visibility: wv.style.visibility || null,
        };
        return out;
      },

      /**
       * 网络观测（CDP Network 域的近似替代）。
       *
       * 两条通道：
       *   1. 回顾：`performance.getEntriesByType('resource')` —— 已发生的请求（含耗时与传输字节）。
       *   2. 实时：`install:true` 时挂钩 `fetch` 与 `XMLHttpRequest`，记录**之后**的请求。
       *
       * 局限（相对 CDP 差在哪）：拿不到请求/响应头与 body、无法拦截或改写、无法看 WebSocket 帧。
       */
      async network(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const max = Math.max(10, Math.min(Number((args && args.max) || 100), 500));
        const install = (args && args.install) === true;
        const body = `
          if (${install} && !window.__dsh_net) {
            const rec = [];
            window.__dsh_net = rec;
            const of = window.fetch;
            if (typeof of === 'function') {
              window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const t0 = Date.now();
                return of.apply(this, arguments).then(
                  (res) => { rec.push({ via: 'fetch', url: String(url), status: res.status, ms: Date.now() - t0 }); return res; },
                  (err) => { rec.push({ via: 'fetch', url: String(url), error: String((err && err.message) || err) }); throw err; }
                );
              };
            }
            const oo = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (m, u) {
              const t0 = Date.now();
              this.addEventListener('loadend', () => rec.push({ via: 'xhr', method: String(m), url: String(u), status: this.status, ms: Date.now() - t0 }));
              return oo.apply(this, arguments);
            };
          }
          const res = performance.getEntriesByType('resource').map((e) => ({
            name: e.name, type: e.initiatorType, ms: Math.round(e.duration),
            bytes: e.transferSize || 0, start: Math.round(e.startTime),
          }));
          const byOrigin = {};
          for (const r of res) { try { const o = new URL(r.name).origin; byOrigin[o] = (byOrigin[o] || 0) + 1; } catch (e) {} }
          return {
            ok: true, url: location.href,
            hookInstalled: !!window.__dsh_net,
            resourceCount: res.length,
            byOrigin: byOrigin,
            resources: res.slice(-${max}),
            hooked: (window.__dsh_net || []).slice(-${max}),
          };
        `;
        return runInPage(wv, body, 40_000);
      },

      /** 页面内滚动（CDP 不可用时的回退路径）。 */
      async scroll(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const dx = Number((args && args.dx) || 0);
        const dy = Number((args && args.dy) || 600);
        const body = `
          const before = { y: Math.round(window.scrollY), x: Math.round(window.scrollX) };
          window.scrollBy(${dx}, ${dy});
          await new Promise((r) => setTimeout(r, 250));
          return {
            ok: true,
            from: before,
            to: { y: Math.round(window.scrollY), x: Math.round(window.scrollX) },
            docH: document.documentElement.scrollHeight,
            vh: innerHeight,
          };
        `;
        return runInPage(wv, body, 20_000);
      },

      /**
       * 定位并高亮目标元素，返回其视口中心坐标 —— 供 **CDP 真实输入**定位使用。
       *
       * 为什么需要它：CDP 的 `Input.dispatchMouseEvent` 要的是坐标，而 agent 给的是 ref/selector。
       * 这个方法在 guest 里把元素滚入视口、算出中心点，并顺带显示虚拟鼠标（保持"看得见"）。
       */
      async highlight(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const body = `
          ${HELPERS}
          ${CURSOR}
          const args = ${JSON.stringify(args ?? {})};
          const el = pick(args);
          if (!el) return { ok: false, error: 'element not found' };
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          if (args.focus) { try { el.focus(); } catch (e) {} }
          if (args.visual !== false) { showCursor(el, args.focus ? 'type' : 'click'); await dwell(260); }
          const r = el.getBoundingClientRect();
          return {
            ok: true,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || '').trim().slice(0, 160),
            href: el.href || null,
            at: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)],
            box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            viewport: [innerWidth, innerHeight],
            focused: !!(document.activeElement && document.activeElement === el),
          };
        `;
        return runInPage(wv, body, 30_000);
      },

      async status() {
        const all = findAllWebviews();
        const wv = findWebview();
        if (!wv) return { present: false, webviewCount: 0 };
        return {
          present: true,
          // >1 说明侧边栏里堆了重复的浏览器标签（旧版 open 每次新建导致的），可手动关掉多余的。
          webviewCount: all.length,
          url: safe(() => wv.getURL()),
          title: safe(() => wv.getTitle()),
          loading: safe(() => wv.isLoading()),
          canGoBack: safe(() => wv.canGoBack()),
          canGoForward: safe(() => wv.canGoForward()),
        };
      },

      async open(ctx, args) {
        let wv = findWebview();
        if (!wv) {
          // 没有浏览器标签页：请 sidebarRight 打开一个。
          const url = String(args.url);
          try {
            ctx.sidebarRight.openTab('browser', { params: { url }, revealIfOpened: true });
          } catch (e) {
            try {
              ctx.sidebarRight.openTabs?.('browser', { params: { url } });
            } catch {
              /* 下面的等待会给出明确失败 */
            }
          }
          wv = await waitForWebview(20_000);
          if (!wv) throw new Error('未能打开侧边栏浏览器标签页（找不到 <webview>）');
          await waitForLoad(wv, 30_000);
          // 标签页可能已经按 url 打开；若不同则显式导航。
          if (safe(() => wv.getURL()) !== String(args.url)) {
            wv.loadURL(String(args.url));
            await waitForLoad(wv, 30_000);
          }
        } else {
          const before = safe(() => wv.getURL());
          if (before !== String(args.url)) {
            wv.loadURL(String(args.url));
            await waitForLoad(wv, 30_000);
          }
        }
        return {
          url: safe(() => wv.getURL()),
          title: safe(() => wv.getTitle()),
        };
      },

      async read(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const mode = String(args.mode || 'text');
        const selector = args.selector ? JSON.stringify(String(args.selector)) : 'null';
        // 硬上限：避免超大页面把渲染进程内存拖爆（崩溃事故后的加固）。
        const maxChars = Math.max(1000, Math.min(Number(args.maxChars || 20_000), 500_000));
        const body = `
          ${HELPERS}
          const sel = ${selector};
          const root = sel ? document.querySelector(sel) : document.body;
          if (!root) return { ok: false, error: 'selector not found: ' + sel };
          const mode = ${JSON.stringify(mode)};
          if (mode === 'html') return { ok: true, mode, html: root.innerHTML.slice(0, ${maxChars}) };
          if (mode === 'links') {
            const links = Array.from(root.querySelectorAll('a[href]')).slice(0, 300)
              .map((a) => ({ text: (a.innerText || '').trim().slice(0, 120), href: a.href }));
            return { ok: true, mode, count: links.length, links };
          }
          if (mode === 'dom') {
            const nodes = Array.from(root.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]'))
              .filter(vis).slice(0, 400)
              .map((el) => ({
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 120),
                id: el.id || undefined,
                name: el.getAttribute('name') || undefined,
                type: el.getAttribute('type') || undefined,
                href: el.href || undefined,
              }));
            return { ok: true, mode, count: nodes.length, nodes };
          }
          const text = (root.innerText || root.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
          return { ok: true, mode: 'text', truncated: text.length > ${maxChars}, text: text.slice(0, ${maxChars}) };
        `;
        return runInPage(wv, body);
      },

      async click(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const body = `
          ${HELPERS}
          ${CURSOR}
          const args = ${JSON.stringify(args ?? {})};
          const el = pick(args);
          if (!el) return { ok: false, error: 'element not found' };
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          if (args.visual !== false) { showCursor(el, 'click'); await dwell(360); }
          const info = { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 160), href: el.href || undefined };
          el.focus?.();
          const fired = firePointer(el, { hoverOnly: !!args.hoverOnly });
          if (!args.hoverOnly) el.click();
          return { ok: true, clicked: info, pointerEvents: fired.events, hoverOnly: !!args.hoverOnly, visual: args.visual !== false };
        `;
        return runInPage(wv, body);
      },

      async type(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const body = `
          ${HELPERS}
          ${CURSOR}
          const args = ${JSON.stringify(args ?? {})};
          const el = pick(args);
          if (!el) return { ok: false, error: 'input element not found' };
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          if (args.visual !== false) { showCursor(el, 'type'); await dwell(300); }
          el.focus?.();
          if (args.clear !== false) setValue(el, '');
          setValue(el, String(args.text ?? ''));
          if (args.submit) {
            const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent('keydown', opts));
            el.dispatchEvent(new KeyboardEvent('keypress', opts));
            el.dispatchEvent(new KeyboardEvent('keyup', opts));
            const form = el.form || el.closest('form');
            if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch {} }
          }
          return { ok: true, tag: el.tagName.toLowerCase(), value: String(el.value ?? '').slice(0, 200) };
        `;
        return runInPage(wv, body);
      },

      async eval(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const code = String(args.code ?? '');
        const body = `
          const __r = await (async () => { ${code} })();
          let out = __r;
          try { JSON.stringify(out); } catch { out = String(out); }
          return { ok: true, result: out === undefined ? null : out };
        `;
        return runInPage(wv, body, 50_000);
      },

      /**
       * 截图 —— **纯 Web 平台实现，不碰 Electron API**。
       *
       * 为什么不用 `webview.capturePage()`：实测（DSH Desktop / Electron 44 / Windows）
       * 对 DSH 的 <webview> 调它会让渲染进程**原生崩溃**，崩溃日志里没有任何 JS error。
       * 连续复现，因此彻底弃用那条路径。
       *
       * 这里改用标准的 SVG `foreignObject` → `<canvas>` → PNG 流程，全部发生在 **guest 页面内部**，
       * 只用到 DOM/Canvas 这些普通 Web API，因此不存在原生崩溃风险。
       *
       * 局限（会在返回值里标注 engine，让调用方知道保真度）：
       *   - 只内联**同源**样式表；跨域 CSS 拿不到 cssRules，会近似渲染；
       *   - 页面里的跨域图片会让 canvas 被污染，此时 toDataURL 会抛 SecurityError，
       *     这里会捕获并给出可操作建议；
       *   - 只截可视区域（viewport），不做整页拼接。
       */
      async screenshot(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const selector = args && args.selector ? JSON.stringify(String(args.selector)) : 'null';
        const body = `
          const scope = ${selector};
          const root = scope ? document.querySelector(scope) : document.documentElement;
          if (!root) return { ok: false, reason: 'selector-not-found' };
          const rect = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
          const w = Math.max(1, Math.round(rect && rect.width ? rect.width : (document.documentElement.clientWidth || window.innerWidth)));
          const h = Math.max(1, Math.round(rect && rect.height ? rect.height : (document.documentElement.clientHeight || window.innerHeight)));

          // 内联同源样式（跨域样式表访问 cssRules 会抛，忽略即可）
          let css = '';
          for (const sheet of Array.from(document.styleSheets)) {
            try { for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\\n'; } catch {}
          }

          // ── 图片内联 ──────────────────────────────────────────────────
          // SVG 里的 <img src> / CSS url() 指向的是网络地址，在 data: SVG 里**加载不出来**
          // （图多的站点会截出一片黑）。这里把能取到的图片抓成 data: URL 再写回去。
          // 注意：data: URL 是同源的，因此**不会**污染 canvas（blob: 才会，见 README）。
          const toDataUrl = async (u) => {
            try {
              if (!u || u.startsWith('data:')) return null;
              const abs = new URL(u, location.href).href;
              if (abs.startsWith('data:')) return null;
              const res = await fetch(abs, { mode: 'cors', credentials: 'omit' });
              if (!res.ok) return null;
              const blob = await res.blob();
              if (blob.size > 4 * 1024 * 1024) return null;   // 单张上限 4MB，避免拖垮
              return await new Promise((r) => {
                const fr = new FileReader();
                fr.onload = () => r(fr.result);
                fr.onerror = () => r(null);
                fr.readAsDataURL(blob);
              });
            } catch { return null; }
          };

          // CSS 里的 url(...)
          const cssUrls = Array.from(new Set(
            Array.from(css.matchAll(/url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/g)).map((m) => m[1]).filter((u) => !u.startsWith('data:')),
          )).slice(0, 40);
          const cssMap = new Map();
          await Promise.all(cssUrls.map(async (u) => { const d = await toDataUrl(u); if (d) cssMap.set(u, d); }));
          for (const [u, d] of cssMap) css = css.split(u).join(d);

          const clone = root.cloneNode(true);
          for (const s of Array.from(clone.querySelectorAll ? clone.querySelectorAll('script') : [])) s.remove();

          // <img>
          const imgs = Array.from(clone.querySelectorAll ? clone.querySelectorAll('img') : []).slice(0, 60);
          await Promise.all(imgs.map(async (im) => {
            const src = im.getAttribute && im.getAttribute('src');
            const d = await toDataUrl(src);
            if (d) im.setAttribute('src', d);
          }));
          // <img srcset> 会让浏览器优先选 srcset 的远程地址，去掉以避免覆盖内联结果
          for (const im of imgs) { try { im.removeAttribute('srcset'); } catch {} }

          if (clone.querySelector && clone.querySelector('head')) {
            const styleEl = document.createElement('style');
            styleEl.textContent = css;
            clone.querySelector('head').appendChild(styleEl);
          }

          const xml = new XMLSerializer().serializeToString(clone);
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
            '<foreignObject width="100%" height="100%">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px">' +
            xml + '</div></foreignObject></svg>';

          const img = new Image();
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          try { await img.decode(); } catch (e) { return { ok: false, reason: 'decode-failed', message: String(e && e.message || e) }; }

          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const g = canvas.getContext('2d');
          g.fillStyle = '#ffffff';
          g.fillRect(0, 0, w, h);
          g.drawImage(img, 0, 0, w, h);

          let url;
          try { url = canvas.toDataURL('image/png'); }
          catch (e) { return { ok: false, reason: 'tainted-canvas', message: String(e && e.message || e) }; }
          return { ok: true, engine: 'svg-foreignobject', base64: String(url).split(',')[1] || '', width: w, height: h };
        `;
        const r = await runInPage(wv, body, 60_000);
        if (!r || r.ok !== true) {
          const why = r && r.reason ? r.reason : 'unknown';
          const hint =
            why === 'tainted-canvas'
              ? '页面含跨域图片导致 canvas 被污染，无法导出 PNG。'
              : why === 'decode-failed'
                ? 'SVG 渲染失败（页面结构过于复杂）。'
                : why === 'selector-not-found'
                  ? 'selector 没匹配到元素。'
                  : '';
          throw new Error(
            `截图失败（${why}）：${hint}替代方案：① browser_read mode=dom；② 用 REA 的 capture_web_screenshot；③ 桌面截图工具截 DSH 窗口。`,
          );
        }
        return {
          base64: r.base64,
          width: r.width,
          height: r.height,
          engine: r.engine,
          url: safe(() => wv.getURL()),
          title: safe(() => wv.getTitle()),
        };
      },

      async history(ctx, args) {
        const wv = findWebview();
        if (!wv) throw new Error(NO_PAGE);
        const action = String(args.action || 'reload');
        if (action === 'back' && wv.canGoBack()) wv.goBack();
        else if (action === 'forward' && wv.canGoForward()) wv.goForward();
        else wv.reload();
        await waitForLoad(wv, 25_000);
        return { url: safe(() => wv.getURL()), title: safe(() => wv.getTitle()), action };
      },
    };

    function safe(fn) {
      try {
        return fn();
      } catch {
        return null;
      }
    }

    // ── 与宿主半的桥接：长轮询取命令 + POST 回结果 ───────────────────────────
    const HEADERS = { 'content-type': 'application/json', 'x-dsh-browser-agent': BRIDGE_TOKEN };

    async function post(path, payload) {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      return res.ok ? res.json().catch(() => ({})) : null;
    }

    /** 插件启用期间为 true；dispose 后循环退出，不再占用渲染进程。 */
    let running = false;

    async function loop(ctx) {
      // 先打招呼，让宿主知道渲染半就绪。
      try {
        await post('/hello', { clientId: CLIENT_ID, clientVersion: CLIENT_VERSION });
      } catch {
        /* 宿主可能还没起来，下一轮再试 */
      }

      // 失败退避 + 熔断：宿主没起/被拦时绝不能疯狂重试。
      // 教训：曾因 CORS 被拦而无限重试并刷控制台，把 renderer 拖崩。
      // 现在连续失败到上限就**彻底停止轮询**，且全程只提示一次。
      const MAX_FAILURES = 6;
      let failures = 0;
      let reported = false;
      const backoff = () => {
        failures += 1;
        const ms = Math.min(1000 * 2 ** Math.min(failures, 5), 30_000);
        if (!reported) {
          reported = true;
          try {
            console.info(`[dsh-browser-agent] 桥接暂不可达，进入退避重试（上限 ${MAX_FAILURES} 次，只提示一次）`);
          } catch {
            /* 忽略 */
          }
        }
        if (failures >= MAX_FAILURES) {
          running = false;
          try {
            console.info('[dsh-browser-agent] 连续失败达上限，已停止轮询；重新启用插件即可恢复');
          } catch {
            /* 忽略 */
          }
        }
        return sleep(ms);
      };

      while (running) {
        try {
          const res = await fetch(`${BASE}/poll?wait=25000`, { headers: HEADERS, cache: 'no-store' });
          if (res.status === 204) {
            failures = 0; reported = false;
            continue;
          }
          if (!res.ok) {
            await backoff();
            continue;
          }
          failures = 0;
          reported = false;
          const cmd = await res.json();
          if (!cmd || !cmd.id) continue;
          let ok = true;
          let data = null;
          let error = null;
          try {
            const op = OPS[cmd.op];
            if (typeof op !== 'function') throw new Error(`unknown op: ${cmd.op}`);
            data = await op(ctx, cmd.args ?? {});
          } catch (e) {
            ok = false;
            error = String(e?.message ?? e);
          }
          try {
            await post('/result', { id: cmd.id, ok, data, error });
          } catch (e) {
            // 结果回不去：只记一次，不影响循环。
            try {
              console.warn('[dsh-browser-agent] 结果回填失败:', String(e?.message ?? e));
            } catch {
              /* 忽略 */
            }
          }
        } catch {
          await backoff();
        }
      }
    }

    function apply(ctx) {
      // 渲染进程里常驻一个长轮询循环；不阻塞既有 UI，也绝不向外抛异常。
      running = true;
      loop(ctx).catch(() => {
        running = false;
      });
      // 插件被禁用/卸载时退出循环，不在渲染进程里留下常驻活动。
      try {
        ctx.effect?.(() => () => {
          running = false;
        });
      } catch {
        /* 没有 effect 能力时忽略 */
      }
      try {
        console.info('[dsh-browser-agent] 渲染半已启动，桥接端口', BRIDGE_PORT);
      } catch {
        /* 忽略 */
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
