# 工具详细参考

所有工具的返回值都是 JSON。绝大多数会带 `engine` 字段，标明**实际用了哪条实现路径**
（例如 `cdp-input` / `renderer-dom`、`cdp-page-captureScreenshot` / `svg-foreignobject`）——
看到 `engine` 就知道能力等级。

---

## browser_status

无参数。返回：

```json
{
  "bridgePort": 8791,
  "pluginVersion": "0.6.1",
  "clientOnline": true,
  "clientId": "renderer-xxxx",
  "queued": 0,
  "cdp": { "available": true, "port": 9222, "browser": "Chrome/152.0.7977.54", "protocolVersion": "1.3" },
  "page": {
    "present": true,
    "webviewCount": 1,
    "url": "https://example.com/",
    "title": "Example Domain",
    "loading": false,
    "canGoBack": true,
    "canGoForward": false
  }
}
```

- `clientOnline:false` → DSH 侧边栏"浏览器"标签页从未打开过，或插件渲染半未加载。
- `webviewCount > 1` → 侧边栏堆了重复标签，用 `browser_tabs` 清理。
- `cdp.available:false` → 没有调试端口，CDP 类能力不可用（其余工具正常）。

---

## browser_open

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | ✅ | 绝对 HTTP(S) URL |

**会复用已有 webview**（优先可见的那个），只有在一个浏览器标签页都没有时才新建。
返回 `{url, title}`。

---

## browser_read

| 参数 | 说明 |
|---|---|
| `mode` | `ax`（默认推荐）\| `text` \| `html` \| `links` \| `dom` |
| `selector` | 可选 CSS 选择器，只读该子树 |
| `maxChars` | `mode=ax` 时是**节点上限**（默认 150，最大 400）；其它模式是字符上限（默认 20000，最大 500000） |

### mode=ax —— 首选

返回 `{ok, url, title, count, text, nodes}`。`text` 是给人看的紧凑视图：

```
[e2]  button   "中文"                          @809,16 48x25
[e5]  heading h1 "DeepSeek Harness 现在，开箱即用"  @301,204 370x120
[e10] link     "下载 Windows 版"                @379,451 171x41
[e11] button   "桌面端下载选项" [expanded=false]  @550,451 43x41
```

`nodes[]` 每项：`{ref, role, tag, name, interactive?, value?, state?, level?, box:[x,y,w,h]}`。

- `role` 由显式 `role` 属性优先，否则按标签/输入类型推断（link/button/textbox/searchbox/
  checkbox/combobox/heading/img/list/navigation/…）
- `name` 是 accessible name：`aria-label > alt > placeholder > title > name > value > 文本`
- `ref` 会写进元素的 `data-dsh-ref`，**后续 click/type 直接用它**

### 其它模式

- `text` → `{ok, mode:"text", truncated, text}`
- `html` → `{ok, mode:"html", html}`
- `links` → `{ok, mode:"links", count, links:[{text,href}]}`
- `dom` → `{ok, mode:"dom", count, nodes:[{tag,text,…}]}`

---

## browser_click

| 参数 | 说明 |
|---|---|
| `ref` | **推荐**，来自 `mode=ax` |
| `selector` | CSS 选择器 |
| `text` | 按可见文本匹配 |
| `index` | 多个匹配时选第几个（默认 0） |
| `hoverOnly` | `true` = 只悬停不点击（用于展开 hover 菜单） |
| `visual` | 默认 `true` 显示虚拟鼠标；批量操作可设 `false` |
| `forceRenderer` | `true` = 强制走合成事件路径（默认优先 CDP 真实输入） |

返回 `{ok, engine, clicked:{tag,text,href}, at:[x,y], hoverOnly}`。
`engine: "cdp-input"` 表示用的是**真实鼠标事件**（`isTrusted:true`）。

---

## browser_type

| 参数 | 说明 |
|---|---|
| `ref` / `selector` | 目标输入元素（二选一，`ref` 推荐） |
| `text` | **必填**，要输入的文本 |
| `submit` | `true` 时输入后回车 |
| `clear` | 默认 `true`，先清空原值 |
| `visual` / `forceRenderer` | 同上 |

返回 `{ok, engine, tag, value, submitted, at}`。`value` 是从 `document.activeElement` 回读的，
**可以据此确认真的写进去了**。

---

## browser_eval

| 参数 | 说明 |
|---|---|
| `code` | 作为 **async 函数体**执行，用 `return` 返回值 |
| `awaitPromise` | 默认 `true` |

返回 `{ok, result}`。这是兜底手段 —— 能用 `read`/`click`/`type` 表达时优先用它们。

---

## browser_history

| 参数 | 说明 |
|---|---|
| `action` | `back` \| `forward` \| `reload` \| `list` |
| `max` | `list` 时最多返回几条（默认 30） |

`list` 优先走 CDP `Page.getNavigationHistory`，返回
`{engine:"cdp-getNavigationHistory", currentIndex, total, history:[{index,id,url,title,transition}]}`；
无 CDP 时回退为 `{engine:"renderer-length-only", length}`（渲染层拿不到条目明细）。

---

## browser_tabs

| 参数 | 说明 |
|---|---|
| `action` | `list` \| `activate` \| `close`（默认 `list`） |
| `index` | `activate` / `close` 时的序号（来自 `list`） |

返回 `{ok, action, count, tabs:[{index,title,active}]}`。

实现方式：直接操作 **DSH 自身的 UI DOM**（`[role=tab]` + `button[aria-label="关闭"]`）。
只处理**带关闭按钮**的标签条，因此不会误碰"对话/轨迹"那两个面板标签。

---

## browser_assets

无参数。返回 `{ok, url, title, counts, images, scripts, stylesheets, links, webmcp}`。

- `images[]`：`{src, alt, w, h, loaded}` —— `loaded:false` 就是**图没加载出来**
- `webmcp`：`{present, keys?, tools?}`，探测页面通过 `navigator.modelContext` 声明的工具

---

## browser_viewport

| 参数 | 说明 |
|---|---|
| `zoom` | 页面缩放（走 `webview.setZoomFactor`） |
| `width` / `height` | webview **元素**尺寸（px）——会影响用户看到的面板大小 |
| `hidden` | 视觉隐藏（`visibility`） |
| `css` | 注入 CSS（走 `webview.insertCSS`，返回 `cssKey`） |
| `reset` | 清除上面所有覆盖并还原缩放为 1 |

不带参数时只回报当前状态（`zoom` / `rect` / `inlineStyle`）。

---

## browser_network

| 参数 | 说明 |
|---|---|
| `install` | `true` = 挂钩 `fetch` 与 `XMLHttpRequest`，记录**之后**的请求 |
| `max` | 返回条数上限（默认 100，最大 500） |

返回 `{ok, url, hookInstalled, resourceCount, byOrigin, resources, hooked}`。

- `resources` 来自 `performance.getEntriesByType('resource')`，是**已发生**的请求（含耗时/字节）
- `hooked` 是挂钩后捕获的请求（含 status）

**局限**：拿不到请求/响应头与 body、不能拦截改写、看不到 WebSocket 帧。
要全量就用 `browser_cdp` + `Network.enable`。

---

## browser_instance

| 参数 | 说明 |
|---|---|
| `action` | `list` \| `create` \| `close` \| `select`（默认 `list`） |
| `url` | `create` 时可选，新实例打开的地址 |
| `visible` | `create` 时 `true` → 挂成右下角浮层（420×640）供人观看；默认离屏 |
| `select` | `create` 后是否自动切到新实例（默认 `true`） |
| `id` | `close` / `select` 的实例 id；`select` 传 `null` 切回侧边栏 |

**关键语义**：`select` 之后，**所有** `browser_*` 工具都作用于该实例，直到你 `select(null)` 切回。

实现基于 preload 的租约 API：`dshDesktop.browser.acquire()` → `{lease, partition}`，
再用 `<webview partition=… src="about:blank#<lease>">` 挂载；主进程在
`did-attach-webview` → `dom-ready` 时校验 `lease.owner === owner`。
租约被拒时主进程会**静默关闭 guest**（不崩溃），插件检测到未挂载会回滚并报错。

---

## browser_cdp

**需要 `--remote-debugging-port=9222`。** 这是"完整协议域"的入口。

| 参数 | 说明 |
|---|---|
| `method` | CDP 方法名，如 `Page.captureScreenshot`、`Network.enable` |
| `params` | 该方法参数对象 |
| `targetId` | 可选，直接指定 target |
| `targetHint` | 可选，按 URL 子串挑 target |
| `eventsMs` | 可选，等待该毫秒数后一并返回期间的 CDP 事件（配 `Network.enable` 用） |
| `timeoutMs` | 可选，单条命令超时（默认 30000） |
| `listTargets` | `true` 时只列出所有 target |
| `allowShell` | ⚠️ **危险，默认 false**。允许在非 webview 的外壳页面上执行破坏性方法 |

返回 `{ok, cdp, method, target, targetCount, result, events}`。

### 常用命令

```
Browser.getVersion
Page.captureScreenshot            {format:"png", captureBeyondViewport:false}
Page.getNavigationHistory
Runtime.evaluate                  {expression:"…", returnByValue:true}
Network.enable                    （然后 eventsMs 收事件）
Network.emulateNetworkConditions  {offline:true, latency:0, downloadThroughput:0, uploadThroughput:0}
Emulation.setUserAgentOverride    {userAgent:"…"}
Emulation.setDeviceMetricsOverride{width:390,height:844,deviceScaleFactor:3,mobile:true}
Emulation.clearDeviceMetricsOverride
Input.dispatchMouseEvent          {type:"mousePressed", x, y, button:"left", buttons:1, clickCount:1}
Input.insertText                  {text:"…"}
Fetch.enable                      （请求拦截；配合 Fetch.requestPaused / continueRequest）
```

### ⚠️ 硬护栏（真实事故换来的）

早期 `pickTarget()` 在没有 webview 时会回退到 `type:"page"` 的**外壳 target**，
结果一条 `Page.navigate` **把 DSH 自己的界面导航成了 example.com**。现在：

1. 默认 `allowPage:false` —— 没有 webview 就返回 `null`，**永不返回外壳页面**；
2. 非 webview target 上**拒绝** `Page.navigate` / `Page.reload` / `Page.navigateToHistoryEntry` /
   `Page.close` / `Page.crash` / `Target.closeTarget`，除非显式 `allowShell:true`。

**别开这个开关。** 需要"导航"时用 `browser_open`。

---

## browser_screenshot

| 参数 | 说明 |
|---|---|
| `selector` | 可选，只截该元素（**仅 SVG 回退方案支持**） |

返回 `{path, engine, url, title, …}` 或回退时 `{path, width, height, engine, cdpError}`。

- 先试 CDP `Page.captureScreenshot`（超时 8 秒）→ `engine:"cdp-page-captureScreenshot"`
- 失败回退 SVG `foreignObject`→canvas → `engine:"svg-foreignobject"`，原因在 `cdpError`

**保真度**：CDP 原生 >> SVG 回退。SVG 方案不内联图片会截成一片黑，且遇 CSP 限制图片的站点
（如 iana.org）会直接失败。**要图就用 CDP；CDP 挂了就重开标签。**

新增参数：`full:true` 走 `captureBeyondViewport` 整页截图；`clip:"x,y,width,height"` 只截区域
（**clip 输出会乘以 devicePixelRatio**，例如 300 CSS px × dpr1.75 = 525 像素）。

---

## browser_scroll

| 参数 | 说明 |
|---|---|
| `dy` | 纵向像素，正数向下（默认 600） |
| `dx` | 横向像素（默认 0） |
| `selector` / `ref` | 滚动到该元素（优先于 dx/dy） |

返回 `{engine:"cdp-mouseWheel", from:{y,x}, to:{y,x}}`；无 CDP 时 `engine:"renderer-scrollBy"`。

---

## browser_press

| 参数 | 说明 |
|---|---|
| `key` | 按键名或单字符 |
| `times` | 重复次数（默认 1，最大 20） |

支持 `Enter` `Tab` `Escape` `Backspace` `Delete` `ArrowUp/Down/Left/Right` `PageUp` `PageDown` `Home` `End` `Space`。

⚠️ 需要 CDP，且依赖窗口有 OS 级键盘焦点 —— 焦点不在 DSH 时键盘事件会被静默丢弃
（鼠标事件不受影响）。详见 troubleshooting 第 12 节。

---

## browser_cookies

| 参数 | 说明 |
|---|---|
| `action` | `export` \| `import` \| `list` \| `clear`（默认 `list`） |
| `name` | 保险库名（默认 `default`） |
| `url` | 可选：只处理该 URL 作用域内的 cookie |

- `export` → `~/.dsh/dsh-browser-agent/vault/<name>.json`，**含 httpOnly**（JS 读不到，只有 CDP 能拿）
- `import` → 逐条 `Network.setCookie`，返回 `restored/total`
- `list` → 列出已有保险库（**不需要 CDP**）
- `clear` → `Network.clearBrowserCookies`

**为什么需要它**：DSH 侧栏会话是**进程级**的（`dsh-sidebar-browser-<uuid>`，无 `persist:` 前缀），
cookie 随应用退出消失。导出/还原是让登录跨重启保留的唯一办法。

---

## browser_inject

| 参数 | 说明 |
|---|---|
| `action` | `add` \| `list` \| `remove` \| `clear`（默认 `list`） |
| `code` | `add` 时的 JS 源码 |
| `identifier` | `remove` 时的脚本 id |
| `worldName` | 可选：注入到隔离世界（不污染页面全局） |
| `reload` | `add` 后是否立即刷新（默认 true） |

走 `Page.addScriptToEvaluateOnNewDocument`，**在页面脚本之前执行** —— `browser_eval` 做不到
（eval 只能操作已加载完的页面）。典型用途：hook `fetch`/`XHR`、改 `window` 属性、埋点。

⚠️ **脚本随常驻 CDP 会话存活**，会话断了就失效；插件内部维持长连接来保住它。

---

## browser_policy

网络与权限控制，**走已有 CDP 通道，不需要主进程桥**。

| action | 走的方法 | 实测 |
|---|---|---|
| `status` | — | 回报当前生效状态（不需要 CDP） |
| `intercept.enable` + `rules` | `Fetch.enable` + 常驻事件泵 | ✅ mock / redirect / block / header 四类规则 |
| `intercept.disable` | `Fetch.disable` | ✅ |
| `net.offline` / `net.online` | `Network.emulateNetworkConditions` | ✅ |
| `net.block` / `net.unblock` | `Network.setBlockedURLs` | ✅ |
| `net.headers` / `net.headers.clear` | `Network.setExtraHTTPHeaders` | ✅ |
| `net.cache.clear` | `Network.clearBrowserCache` | ✅ |
| `cert.ignore` / `cert.reset` | `Security.setIgnoreCertificateErrors` | ✅ |
| `downloads.set` | `Browser.setDownloadBehavior` | ✅ |
| `permissions.grant` / `permissions.reset` | `Browser.grantPermissions` | ❌ **本环境无效，见下** |

规则格式：`{match:"*api*", action:"mock"|"redirect"|"block"|"header", status?, body?, to?, headers?}`

**实现要点**：`Fetch.enable` 后每个请求都会停在 `Fetch.requestPaused` 等指令，不响应页面就会卡死。
插件用常驻会话 + 150ms 事件泵：**命中规则的按规则处理，未命中的一律自动放行**。

实测（mock 一个不存在的接口）：
```
结果: {"normal":200, "mocked":{"mocked":true,"from":"dsh-browser-agent"}, "blocked":"blocked ✅"}
Fetch 统计：暂停 3 / mock 1 / 拦截 1 / 放行 1
```

### ⚠️ 为什么权限授予无效

```
① 页面 target 的 browserContextId = A16A0408…      ← webview 确实在独立上下文
② 浏览器级端点 Target.getBrowserContexts → []        ← 但 CDP 看不到它
③ Browser.grantPermissions 带该 id → "Failed to find browser context"
④ 不带 id → 成功，但 navigator.permissions 仍是 denied，getCurrentPosition 报 User denied
```

**原因不是"需要主进程"**，而是 webview 跑在 `partition="dsh-sidebar-browser-<uuid>"` 对应的
独立 BrowserContext 里，**而该上下文没有暴露给 CDP**。工具如实上报 `supported:false` 与原因。

---

## browser_viewport 的 device 预设

| device | 尺寸 | dpr |
|---|---|---|
| `iphone-se` | 375×667 | 2 |
| `iphone-15-pro` | 393×852 | 3 |
| `iphone-15-pro-max` | 430×932 | 3 |
| `pixel-8` | 412×915 | 2.625 |
| `galaxy-s23` | 360×780 | 3 |
| `ipad-mini` | 744×1133 | 2 |
| `ipad-air` | 820×1180 | 2 |
| `ipad-pro-11` | 834×1194 | 2 |

配 `landscape:true` 横屏、`device:"reset"` 清除。走 `Emulation.setDeviceMetricsOverride`。

实测：iPhone 15 Pro → `innerWidth=393 innerHeight=852 dpr=3` ✅。
**注意**：对没有 `meta[name=viewport]` 的页面，Chromium 用默认 980px 布局视口，
`innerWidth` 不等于请求值 —— 这是页面自身行为，不是工具问题。
