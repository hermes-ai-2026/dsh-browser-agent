# 故障排查

排查顺序：**先看 `/health` → 再看 `browser_status` → 再动手**。

```powershell
Invoke-RestMethod http://127.0.0.1:8791/health | ConvertTo-Json -Compress
```

三个关键字段：`pluginVersion`（宿主半版本）、`clientVersion`（渲染半版本）、`cdp.available`。

---

## 1. 工具报"浏览器客户端未连接"

`clientOnline:false` 的含义：**DSH 侧边栏的「浏览器」标签页从未打开过**。
插件的渲染半寄生在那个页面里，没有它就无处执行。

**处理**：让用户点开右侧侧边栏的「浏览器」标签页；或直接用 `browser_open`
（它会调用 `ctx.sidebarRight.openTab` 帮你开一个）。

其它可能：DSH 没在运行、插件 bundle 被禁用。

---

## 2. 两个版本号不一致

- `pluginVersion` 是**宿主半**（Node 进程，随 DSH 启动加载）
- `clientVersion` 是**渲染半**（网页里，重新加载页面即生效）

**宿主半不热重载**：改了 `lib/*.js` 必须**整进程重启 DSH**，
否则 DSH 复用 ESM 模块缓存，跑的还是旧版。曾经因此拿旧 host 代码去驱动，
导致渲染进程被 CORS 错误刷崩。

**渲染半会热更新**：改了 `client/client.js` 后等几秒，`clientId` 变化即说明已重载。

---

## 3. 截图挂起 / `Page.captureScreenshot` 超时

**这是已知的 guest 降级现象。** 对照数据：

| 状态 | CDP 原生截图 | 真实点击 |
|---|---|---|
| 旧 guest（用了一阵） | ❌ 超时 | ✅ 正常 |
| **新开标签的 guest** | ✅ ~160KB / ~160ms | ✅ 正常 |
| DSH 外壳页面（同时刻） | ✅ 522KB / 326ms | — |

已逐一排除：UA 覆盖、注入的 DOM、`Page.enable`、`fromSurface` 参数、侧边栏激活的是哪个标签。
**很可能是最初 `<webview>.capturePage()` 原生崩溃的同一底层表面问题**，只是表现为挂起。

**处理：重开标签。**

```
browser_tabs {action:"list"}                 → 看有哪些
browser_tabs {action:"close", index:N}       → 关掉旧的（别关 .md 预览标签）
browser_open {url:"…"}                       → 开新的，guest 恢复
```

插件本身有 8 秒超时 + SVG 回退，所以**不会卡死工具**，`cdpError` 会写明原因。

---

## 4. `browser_cdp` 报"CDP 不可用"

需要在启动 DSH 时带调试端口：

```
DeepSeek Harness.exe --remote-debugging-port=9222
```

本机已把它**永久写入快捷方式**（桌面 + 开始菜单，备份在 `*.lnk.pre-cdp-backup`）。
若从任务栏固定图标启动，那个 .lnk 是独立文件，需要单独改（本机扫过，没有第三个）。

**改变启动方式后必须重启 DSH。**

---

## 5. 报"没有可用的 webview target"

`browser_cdp` 在没有浏览器标签页时会这样报 —— 这是**故意的**：
它宁可失败也**不会**回退到 DSH 外壳页面（那曾导致 DSH 界面被导航走）。

**处理**：先 `browser_open` 打开一个页面，或用 `targetId` / `targetHint` 明确指定。

---

## 6. ref 失效

页面变化（导航、异步渲染、SPA 路由）后旧 ref 可能指向已移除的节点。报错会提示
`ref 已失效（页面可能已变化）`。**重新 `browser_read {mode:"ax"}` 拿新 ref。**

---

## 7. 标签页越堆越多

`browser_open` 现在**优先复用**已有 webview，正常不会新增。
若之前版本留下过重复标签：

```
browser_tabs {action:"list"}
browser_tabs {action:"close", index:1}   ← 逐个关
```

DSH 的 `ctx.sidebarRight` **没有** close/activate API，本工具是通过操作 UI DOM 实现的，
所以只对**带关闭按钮**的标签有效（浏览器标签有，"对话/轨迹"没有）。

---

## 8. 页面里的操作没生效

- 先 `browser_read {mode:"ax"}` 确认目标元素存在、`interactive:true`
- 依赖 **hover 展开**的菜单：用 `browser_click {ref, hoverOnly:true}` 先悬停
- React 受控组件：`browser_type` 已用原生 setter + 派发 `input`/`change`，正常情况下没问题
- 需要真实指针序列时，确认 `engine` 是 `cdp-input` 而不是 `renderer-dom`；
  要强制真实输入就别传 `forceRenderer`

---

## 9. 安全：调试端口

调试端口一开，**本机任何进程都能完全控制 DSH、读取它的 cookie 与登录态**。
DSH 主进程对此**没有任何防护**。

想关掉：把 `*.lnk.pre-cdp-backup` 复制回覆盖对应的 `.lnk`，然后重启 DSH。
插件的其余能力不受影响，只是退化到渲染层路径（没有原生截图/真实输入/Network 域）。

---

## 10. 插件安装 / 卸载

**位置**：`~/.dsh/profiles/desktop/node_modules/dsh-browser-agent`

**启用**：`~/.dsh/profiles/desktop/package.json`

```json
"dependencies": { "dsh-browser-agent": "file:./node_modules/dsh-browser-agent" },
"dsh": { "profile": { "bundles": [ "…", "dsh-browser-agent" ] } }
```

**卸载**：从 `dsh.profile.bundles` 移除 `"dsh-browser-agent"` 即可。

**改 host 代码后**：同步文件 → **整进程重启 DSH** → 核对 `/health.pluginVersion`。

---

## 11. 自检脚本

插件目录里带了这几套（都不改状态，可随时跑）：

| 脚本 | 作用 |
|---|---|
| `verify-e2e.mjs` | 隔离测试台：假 DOM + 真两半代码走真桥接，38 项 |
| `verify-guard.mjs` | 护栏测试：`pickTarget` 永不返回外壳页面，7 项 |
| `verify-cdp.mjs` | 真实 CDP 全套（端口/target/截图/输入/网络/Emulation） |
| `verify-cdp-input.mjs` | CDP 真实输入路径（highlight → Input.* → isTrusted） |
| `verify-priority4.mjs` | 指针序列 / 标签页 / 网络 / WebMCP |
| `demo-all.mjs` | 全能力演示，28 个能力点，产出 3 张截图 |
| `demo-cursor.mjs` | 虚拟鼠标巡游（只悬停不点击） |

跑法：`cd ~/.dsh/profiles/desktop/node_modules/dsh-browser-agent && node verify-e2e.mjs`

**独立 CLI**（不用开会话）：
```bash
node cli/browser.mjs health | status | open <url> | ax | read --mode text
node cli/browser.mjs click <ref> | type <ref> "文字" --submit | scroll 800 | press Enter
node cli/browser.mjs screenshot --out x.png --full | tabs list | cookies export work
node cli/browser.mjs cdp Page.getNavigationHistory | targets
```

另外这几套是新增的：`demo-policy.mjs`（请求拦截/改写实测）、`demo-policy-probe.mjs`
（逐项探测权限/证书/代理可用性）、`demo-inject.mjs`（document-start 注入 + 全页截图）、
`demo-perm2.mjs`（诊断权限为什么无效）。

---

## 12. ⚠️ 键盘输入在窗口失去焦点时会静默失效

**现象**：`browser_type` 的 CDP 路径不写入、`browser_press` 无反应，但
- 页面自己报 `document.hasFocus() === true`
- `document.activeElement` 就是要操作的元素
- **同一时刻鼠标事件（`Input.dispatchMouseEvent`）完全正常**

**已排除**：`Page.bringToFront`、`Emulation.setFocusEmulationEnabled`、`dispatchKeyEvent({text})`
**三种方式都救不回来**；也**不是** guest 降级（新旧 guest 表现一致）。

**结论**：DSH 窗口没有 **OS 级键盘焦点**时，CDP 键盘事件进入浏览器输入管线后被丢弃。

**已加防护**：`browser_type` 现在**不是**"一失败就报错"，而是
**回读校验 + 自动回退到渲染层原生 setter**，所以它始终能把文本写进去 —— 两全其美。

---

## 13. 请求拦截后页面卡住不动

`Fetch.enable` 会让**每个**请求停在 `Fetch.requestPaused` 等指令。
如果外部客户端不响应，页面就永远加载不出来。

**别用裸 `browser_cdp {method:"Fetch.enable"}` 而不处理事件** —— 那样页面会卡死。
改用 `browser_policy {action:"intercept.enable", rules:[...]}`：它带常驻事件泵，
命中规则的按规则处理，**未命中的自动放行**。

要收尾：`browser_policy {action:"intercept.disable"}`。

---

## 14. 权限授予为什么不生效

`browser_policy {action:"permissions.grant"}` 会返回 `supported:false` 并附原因。简短版：

DSH 的 webview 跑在 `partition="dsh-sidebar-browser-<uuid>"` 对应的**独立 BrowserContext**，
而该上下文**没有暴露给 CDP**（浏览器级 `Target.getBrowserContexts` 返回空数组），
所以 `Browser.grantPermissions` 对它无效。

**这不是"需要主进程"** —— 是 CDP 的可见性问题。

**替代做法**：需要权限的页面，用 `browser_click` 点掉站点自己的权限弹窗。
