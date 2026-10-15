/**
 * dsh-browser-agent 端到端验证台（不依赖 DSH）
 *
 * 加载**真实的两半代码**：
 *   - 宿主半：lib/index.js（真桥接服务器 + 真工具定义）
 *   - 客户端半：client/client.js（真分发逻辑），跑在 node:vm 沙箱里，用假 DOM/假 <webview>
 * 中间走**真的 HTTP 长轮询桥接**，因此验证的是真实协议与真实代码路径。
 *
 * 唯一的桩是 <webview> 与 guest 页面的执行结果（真实环境里由 Electron 提供）。
 *
 * 运行：node verify-e2e.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8792;
process.env.DSH_BROWSER_AGENT_PORT = String(PORT);
// 保持测试台**隔离**：把 CDP 端口指向一个必定无响应的端口。
// 否则在已用 --remote-debugging-port 启动的机器上，browser_screenshot 会走真实 CDP 路径，
// 测试就不再确定（CDP 路径由 verify-cdp.mjs 单独覆盖）。
process.env.DSH_CDP_PORT = '9';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'dsh-browser-agent-local-bridge-v1';
const HEADERS = { 'content-type': 'application/json', 'x-dsh-browser-agent': TOKEN };
const here = path.dirname(fileURLToPath(import.meta.url));

const pass = [];
const fail = [];
const check = (name, ok, detail) => (ok ? pass : fail).push(`${name}${detail ? ' — ' + detail : ''}`);

// ── 1) 启动真实宿主半 ────────────────────────────────────────────────────
const plugin = await import(new URL('./lib/index.js', import.meta.url).href + `?t=${Date.now()}`);
const tools = new Map();
const fakeCtx = {
  tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
  effect: (fn) => { fn(); },
  logger: () => ({ info: () => {}, warn: () => {} }),
};
await plugin.apply(fakeCtx);
console.log(`宿主半已启动：name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`);
console.log(`已注册工具 ${tools.size} 个：${[...tools.keys()].join(', ')}`);
check('宿主半注册 19 个工具', tools.size === 19, `实际 ${tools.size}`);

// ── 2) 假 DOM / 假 <webview>，加载真实客户端半 ───────────────────────────
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const guestScripts = [];
let clicked = null;

function makeWebview() {
  const state = { url: 'about:blank', title: 'Example Domain' };
  return {
    isConnected: true,
    dataset: { sidebarBrowserFrame: 'webview' },
    getURL: () => state.url,
    getTitle: () => state.title,
    isLoading: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    loadURL(u) { state.url = u; state.title = 'Loaded: ' + u; this.__loaded = (this.__loaded ?? 0) + 1; },
    reload() {}, goBack() {}, goForward() {},
    style: {},
    setZoomFactor(z) { this.__zoom = z; },
    getZoomFactor() { return this.__zoom ?? 1; },
    insertCSS(css) { this.__css = css; return 'css-key-1'; },
    addEventListener() {}, removeEventListener() {},
    async executeJavaScript(code) {
      guestScripts.push(code);
      // 桩要求：按脚本里**实际请求的 mode** 分派（脚本本身包含全部分支，不能用子串是否出现来判断）
      const requestedMode = (code.match(/const mode = "([a-z]+)"/) ?? [])[1] ?? 'text';
      if (code.includes('clicked:')) { clicked = 'a.More information...'; return { ok: true, clicked: { tag: 'a', text: 'More information...', href: 'https://www.iana.org/domains/example' }, pointerEvents: 11, hoverOnly: false }; }
      if (code.includes('value: String(el.value')) return { ok: true, tag: 'input', value: 'hello world' };
      // AX 快照（对标 Codex AXAPI）
      if (code.includes('buildAx(')) {
        return {
          ok: true,
          url: 'https://example.com/',
          title: 'Example Domain',
          count: 2,
          text: '[e1] link "More information..." @0,0 100x20\n[e2] heading h1 "Example Domain" @0,0 200x30',
          nodes: [
            { ref: 'e1', role: 'link', tag: 'a', name: 'More information...', interactive: true, box: [0, 0, 100, 20] },
            { ref: 'e2', role: 'heading', tag: 'h1', name: 'Example Domain', level: 1, box: [0, 0, 200, 30] },
          ],
        };
      }
      // 页面资源清单（对标 Codex pageAssets）
      if (code.includes('naturalWidth > 0')) {
        return {
          ok: true,
          url: 'https://example.com/',
          title: 'Example Domain',
          counts: { images: 1, scripts: 0, stylesheets: 1, links: 1 },
          images: [{ src: 'https://example.com/a.png', alt: '', w: 100, h: 50, loaded: true }],
          scripts: [],
          stylesheets: [{ href: null, rules: 3 }],
          links: [{ text: 'More information...', href: 'https://www.iana.org/domains/example' }],
          webmcp: { present: false },
        };
      }
      // 网络观测（CDP Network 的近似替代）
      if (code.includes('getEntriesByType')) {
        return {
          ok: true,
          url: 'https://example.com/',
          hookInstalled: false,
          resourceCount: 2,
          byOrigin: { 'https://example.com': 2 },
          resources: [
            { name: 'https://example.com/', type: 'navigation', ms: 12, bytes: 1000, start: 0 },
            { name: 'https://example.com/a.css', type: 'link', ms: 3, bytes: 200, start: 5 },
          ],
          hooked: [],
        };
      }
      // 截图走 SVG foreignObject→canvas（纯 Web 平台，不碰 capturePage）
      if (code.includes('foreignObject')) {
        return { ok: true, engine: 'svg-foreignobject', base64: Buffer.from(PNG).toString('base64'), width: 1280, height: 720 };
      }
      if (code.includes('__r')) return { ok: true, result: 'Example Domain' };
      if (requestedMode === 'links') return { ok: true, mode: 'links', count: 1, links: [{ text: 'More information...', href: 'https://www.iana.org/domains/example' }] };
      if (requestedMode === 'dom') return { ok: true, mode: 'dom', count: 2, nodes: [{ tag: 'a', text: 'More information...' }, { tag: 'input', text: '', type: 'text' }] };
      if (requestedMode === 'html') return { ok: true, mode: 'html', html: '<html><body>Example Domain</body></html>' };
      return { ok: true, mode: 'text', truncated: false, text: 'Example Domain\n\nThis domain is for use in illustrative examples.' };
    },
    async capturePage() {
      return { toPNG: () => PNG, getSize: () => ({ width: 1280, height: 720 }) };
    },
  };
}
const webview = makeWebview();
const documentStub = {
  querySelector: (sel) => (String(sel).includes('webview') ? webview : null),
  querySelectorAll: () => [],
  body: {},
};

let loaded = null;
const sandbox = {
  window: {
    DSH_BROWSER_AGENT_PORT: PORT,
    __ModuleLoader__: {
      // 模拟 DSH 客户端加载器：调用 factory 并接住其 module.exports
      load: (m) => {
        loaded = m;
        loaded.exports = m.factory((name) => {
          throw new Error('客户端半不应 require 任何模块，却请求了: ' + name);
        });
      },
    },
  },
  document: documentStub,
  fetch,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Math, JSON, Date, Promise, Object, Array, String, Number, Boolean, Error,
  Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(here, 'client', 'client.js'), 'utf8'), sandbox, { filename: 'client.js' });

check('客户端半被加载器接管', loaded !== null && loaded.id === 'dsh-browser-agent');
check('客户端半导出 apply/inject', typeof loaded?.exports?.apply === 'function' && Array.isArray(loaded?.exports?.inject), JSON.stringify(loaded?.exports?.inject));

const sidebarCalls = [];
loaded.exports.apply({ sidebarRight: { openTab: (...a) => sidebarCalls.push(a) } });

// ── 3) 等客户端接入桥接 ──────────────────────────────────────────────────
let online = false;
for (let i = 0; i < 60; i += 1) {
  const h = await (await fetch(`${BASE}/health`)).json();
  if (h.clientOnline) { online = true; console.log('渲染半已接入:', h.clientId); break; }
  await new Promise((r) => setTimeout(r, 100));
}
check('渲染半经真实桥接接入', online);

// ── 4) 逐个调用真实工具定义 ──────────────────────────────────────────────
async function call(name, args) {
  const def = tools.get(name);
  const value = await def.execute(args ?? {}, {});
  return { value, rendered: def.output?.render?.(args ?? {}, value) };
}

console.log('\n──────── 工具实测 ────────');
const st = await call('browser_status');
console.log('browser_status  :', JSON.stringify(st.value));
check('browser_status 看到页面', st.value?.page?.present === true && st.value.page.url === 'about:blank');

const op = await call('browser_open', { url: 'https://example.com/' });
console.log('browser_open    :', JSON.stringify(op.value));
check('browser_open 打开并回报 URL', op.value?.url === 'https://example.com/', op.value?.url);

const rd = await call('browser_read', { mode: 'text' });
console.log('browser_read    :', JSON.stringify(rd.value).slice(0, 150));
check('browser_read 返回文本', rd.value?.ok === true && /Example Domain/.test(rd.value?.text ?? ''));

const lk = await call('browser_read', { mode: 'links' });
check('browser_read links 模式', lk.value?.count === 1 && lk.value.links[0].href.includes('iana.org'));

const dm = await call('browser_read', { mode: 'dom' });
check('browser_read dom 模式', dm.value?.count === 2);

// ── AX 快照 + ref 寻址（对标 Codex 的 AXAPI；这是"读页面"的首选通道）──
const ax = await call('browser_read', { mode: 'ax' });
console.log('browser_read ax :', JSON.stringify({ count: ax.value?.count, first: ax.value?.nodes?.[0]?.ref }));
check('browser_read mode=ax 返回语义树', ax.value?.ok === true && ax.value?.count === 2);
check('AX 文本视图带 ref 与 role', /\[e1\] link "More information/.test(ax.value?.text ?? ''));
check('AX 节点带 role/name/box', ax.value?.nodes?.[0]?.role === 'link' && Array.isArray(ax.value?.nodes?.[0]?.box));
check('mode=ax 走的是 ax op（不是 read）', ax.value?.nodes?.[0]?.ref === 'e1');

const clickRef = await call('browser_click', { ref: 'e1' });
check('browser_click 支持 ref 寻址', clickRef.value?.ok === true);
check('browser_click 派发完整指针事件序列', (clickRef.value?.pointerEvents ?? 0) >= 8, `events=${clickRef.value?.pointerEvents}`);

const assets = await call('browser_assets', {});
console.log('browser_assets  :', JSON.stringify(assets.value?.counts));
check('browser_assets 返回资源清单', assets.value?.counts?.images === 1 && assets.value?.counts?.links === 1);
check('assets 标注图片是否真的加载成功', assets.value?.images?.[0]?.loaded === true);

// 标签页管理：操作的是 DSH 自己的 UI DOM（在测试台里 document 桩没有 tablist → 0 个）
const tb = await call('browser_tabs', { action: 'list' });
check('browser_tabs 可列举（桩环境下为 0）', tb.value?.ok === true && tb.value?.count === 0, JSON.stringify(tb.value));
let tabsErr = null;
try { await call('browser_tabs', { action: 'close', index: 5 }); } catch (e) { tabsErr = String(e?.message ?? e); }
check('browser_tabs 越界序号会明确报错', typeof tabsErr === 'string' && tabsErr.includes('序号不存在'), tabsErr);

// 视口 / 缩放 / 样式注入（操作的是渲染层的 webview 元素本身）
const vp = await call('browser_viewport', { zoom: 1.25, width: 800, css: 'body{outline:1px solid red}' });
console.log('browser_viewport:', JSON.stringify(vp.value));
check('browser_viewport 设置缩放', vp.value?.zoom === 1.25, String(vp.value?.zoom));
check('browser_viewport 改元素宽度', vp.value?.inlineStyle?.width === '800px', vp.value?.inlineStyle?.width);
check('browser_viewport 注入 CSS', typeof vp.value?.cssKey === 'string');
const vpReset = await call('browser_viewport', { reset: true });
check('browser_viewport 可还原', vpReset.value?.zoom === 1 && vpReset.value?.inlineStyle?.width === null);

// CDP：端口未开时必须明确报错（并提示开启方法），而不是静默失败
let cdpErr = null;
try { await call('browser_cdp', { method: 'Browser.getVersion' }); } catch (e) { cdpErr = String(e?.message ?? e); }
check('browser_cdp 在端口未开时明确报错', typeof cdpErr === 'string' && cdpErr.includes('CDP 不可用'), cdpErr);
check('报错信息含开启方法', typeof cdpErr === 'string' && cdpErr.includes('remote-debugging-port'));

// 多实例：桩环境没有 dshDesktop 租约 API，必须明确报错而不是静默失败
let instErr = null;
try { await call('browser_instance', { action: 'list' }); } catch (e) { instErr = String(e?.message ?? e); }
check('browser_instance 在无租约 API 时明确报错', typeof instErr === 'string' && instErr.includes('dshDesktop'), instErr);

// 网络观测（CDP Network 的近似替代）
const net = await call('browser_network', {});
console.log('browser_network :', JSON.stringify(net.value?.byOrigin));
check('browser_network 回报资源与域名汇总', net.value?.resourceCount === 2 && net.value?.byOrigin?.['https://example.com'] === 2);

const ck = await call('browser_click', { text: 'More information' });
console.log('browser_click   :', JSON.stringify(ck.value));
check('browser_click 命中元素', ck.value?.ok === true && clicked !== null);

const ty = await call('browser_type', { selector: '#q', text: 'hello world', submit: true });
console.log('browser_type    :', JSON.stringify(ty.value));
check('browser_type 写入并回读', ty.value?.value === 'hello world');

const ev = await call('browser_eval', { code: 'return document.title' });
console.log('browser_eval    :', JSON.stringify(ev.value));
check('browser_eval 返回结果', ev.value?.ok === true && ev.value.result === 'Example Domain');

const hs = await call('browser_history', { action: 'reload' });
check('browser_history 可用', typeof hs.value?.url === 'string');

// 截图：走 SVG foreignObject→canvas（纯 Web 平台），不再调用会原生崩溃的 capturePage。
const sc = await call('browser_screenshot', {});
console.log('browser_screenshot:', JSON.stringify({ ...sc.value, base64: undefined }));
check('browser_screenshot 落盘 PNG', !!sc.value?.path && fs.existsSync(sc.value.path) && fs.statSync(sc.value.path).size === PNG.length, sc.value?.path);
check('截图引擎标注为 svg-foreignobject', sc.value?.engine === 'svg-foreignobject', sc.value?.engine);
check('截图渲染为文本块', Array.isArray(sc.rendered) && sc.rendered[0]?.type === 'text');

// ── 5) 鉴权与降级 ────────────────────────────────────────────────────────
const badToken = await fetch(`${BASE}/hello`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-browser-agent': 'wrong' }, body: '{}' });
check('错误令牌被拒（403）', badToken.status === 403, `status=${badToken.status}`);

// ── 5b) CORS 回归测试 ────────────────────────────────────────────────────
// Node 的 fetch 不执行 CORS，所以线上"渲染进程 origin=dsh-app://app 被拦"这个坑
// 只能在测试里显式断言响应头。这一组就是那次崩溃的回归用例。
const ORIGIN = 'dsh-app://app';
const pre = await fetch(`${BASE}/poll`, {
  method: 'OPTIONS',
  headers: { Origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-dsh-browser-agent' },
});
check('预检 OPTIONS 返回 2xx', pre.status === 204 || pre.status === 200, `status=${pre.status}`);
check('预检带 Access-Control-Allow-Origin', pre.headers.get('access-control-allow-origin') === '*', pre.headers.get('access-control-allow-origin'));
check('预检允许自定义头', String(pre.headers.get('access-control-allow-headers') ?? '').includes('x-dsh-browser-agent'));

const idle = await fetch(`${BASE}/poll?wait=150`, { headers: { Origin: ORIGIN, 'x-dsh-browser-agent': TOKEN } });
check('空闲轮询 204 带 ACAO（崩溃点回归）', idle.status === 204 && idle.headers.get('access-control-allow-origin') === '*',
  `status=${idle.status} acao=${idle.headers.get('access-control-allow-origin')}`);

const forbidden = await fetch(`${BASE}/poll`, { headers: { Origin: ORIGIN, 'x-dsh-browser-agent': 'wrong' } });
check('403 响应同样带 ACAO', forbidden.headers.get('access-control-allow-origin') === '*', `status=${forbidden.status}`);

const okRes = await fetch(`${BASE}/health`, { headers: { Origin: ORIGIN } });
check('200 响应带 ACAO', okRes.headers.get('access-control-allow-origin') === '*');

// 新增：滚动（桩环境无 CDP → 走渲染层回退）
const scr = await call('browser_scroll', { dy: 400 });
console.log('browser_scroll  :', JSON.stringify(scr.value));
check('browser_scroll 可用（回退路径）', scr.value?.ok === true);

// 新增：按键（必须走 CDP，桩环境应明确报错）
let pressErr = null;
try { await call('browser_press', { key: 'Enter' }); } catch (e) { pressErr = String(e?.message ?? e); }
check('browser_press 在无 CDP 时明确报错', typeof pressErr === 'string' && pressErr.includes('需要 CDP'), pressErr);

// 新增：Cookie 保险库 list 不需要 CDP
const vaults = await call('browser_cookies', { action: 'list' });
console.log('browser_cookies :', JSON.stringify({ count: vaults.value?.count, dir: vaults.value?.vaultDir }));
check('browser_cookies list 可用', vaults.value?.ok === true && typeof vaults.value?.vaultDir === 'string', JSON.stringify(vaults.value?.vaultDir));
let vaultErr = null;
try { await call('browser_cookies', { action: 'import', name: '__nope__' }); } catch (e) { vaultErr = String(e?.message ?? e); }
check('browser_cookies import 缺库时报错含路径提示', typeof vaultErr === 'string' && vaultErr.includes('保险库不存在'), vaultErr);

// 新增：设备预设需要 CDP
let devErr = null;
try { await call('browser_viewport', { device: 'iphone-15-pro' }); } catch (e) { devErr = String(e?.message ?? e); }
check('viewport device 预设无 CDP 时明确报错', typeof devErr === 'string' && devErr.includes('需要 CDP'), devErr);

// 新增：document-start 注入（需要 CDP，桩环境应明确报错）
let injErr = null;
try { await call('browser_inject', { action: 'list' }); } catch (e) { injErr = String(e?.message ?? e); }
check('browser_inject list 可用（桩环境返回空列表）', injErr === null, injErr);
let injAddErr = null;
try { await call('browser_inject', { action: 'add', code: 'window.__x=1' }); } catch (e) { injAddErr = String(e?.message ?? e); }
check('browser_inject add 无 CDP 时明确报错', typeof injAddErr === 'string' && injAddErr.includes('需要 CDP'), injAddErr);

// 新增：cookie clear 需要 CDP
let clearErr = null;
try { await call('browser_cookies', { action: 'clear' }); } catch (e) { clearErr = String(e?.message ?? e); }
check('browser_cookies clear 无 CDP 时明确报错', typeof clearErr === 'string' && clearErr.includes('需要 CDP'), clearErr);

// 截图新增 full / clip 参数
const shotFull = await call('browser_screenshot', { full: true });
check('browser_screenshot 支持 full 参数', !!shotFull.value?.path, shotFull.value?.engine);

// 新增：网络与权限控制（CDP 通道）
const pol = await call('browser_policy', { action: 'status' });
check('browser_policy status 可用（不需 CDP）', pol.value?.ok === true && typeof pol.value?.intercept === 'boolean', JSON.stringify(pol.value?.sessionAlive));
let polErr = null;
try { await call('browser_policy', { action: 'permissions.grant', origin: 'https://example.com' }); } catch (e) { polErr = String(e?.message ?? e); }
check('browser_policy 无 CDP 时明确报错', typeof polErr === 'string' && polErr.includes('需要 CDP'), polErr);

const toolDefShape = tools.get('browser_read');
check('工具定义形状正确（JSON Schema 参数 + output.render）',
  toolDefShape.parameters?.type === 'object' && typeof toolDefShape.output?.render === 'function' && typeof toolDefShape.timeoutMs === 'number');

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log('\n──────── 汇总 ────────');
console.log(`通过 ${pass.length} 项：`);
for (const p of pass) console.log('  ✅', p);
if (fail.length) {
  console.log(`失败 ${fail.length} 项：`);
  for (const f of fail) console.log('  ❌', f);
} else {
  console.log('失败 0 项');
}
console.log(`\nguest 脚本注入次数: ${guestScripts.length}`);
console.log(`浏览器操作覆盖: open/read(text,links,dom)/click/type/eval/history/screenshot`);
process.exit(fail.length ? 1 : 0);
