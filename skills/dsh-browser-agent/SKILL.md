---
name: dsh-browser-agent
description: |
  Drive DeepSeek Harness's own built-in browser as an agent: read a page as a
  structured accessibility tree, click/type by stable refs, take screenshots
  (viewport/full-page/region), manage tabs, observe and **intercept/rewrite
  network requests**, control viewport/device emulation, persist or clear
  cookies, inject scripts at document-start, spawn extra browser instances,
  and send raw Chrome DevTools Protocol commands. Ships a standalone CLI too.
  Use whenever a task needs a real browser controlled from DSH — 打开网页/读页面/
  点击/填表/截图/抓请求/mock 接口/设备模拟/多开浏览器/CDP 调试/保持登录.
  Not for the user's own Chrome (that is `browser-skill` / bsk) and not for
  HTTP-only fetching.
metadata:
  version: "3"
  tool_count: 19
  plugin: dsh-browser-agent
---

# dsh-browser-agent

DSH 自带的侧边栏浏览器**对模型是只读的**：它的宿主半是空 `apply(){}`，不注册任何工具。
本 skill 对应的插件以**非侵入式加装**的方式补上了 agent 动作面 —— 不改 DSH 一行代码，
只借它已经挂在渲染层里的那个 `<webview>`。

## 何时用它

- 任务需要**真实浏览器**（JS 渲染、登录后的页面、需要点击/输入才能出现的界面）
- 需要**结构化地读页面**（不是抓 HTML 字符串，而是 role/name/ref 语义树）
- 需要截图、网络观测、多开浏览器实例、或直接发 CDP 命令
- **不要**用它做纯 HTTP 抓取（有更轻的工具）
- **不要**用它操作用户自己的 Chrome（那是 `browser-skill` / bsk）

## 核心工作流（照这个顺序）

```
1. browser_status                  → 确认 clientOnline、有没有页面
2. browser_read {mode:"ax"}        → 拿到语义树：role / name / state / 几何 + 【稳定 ref】
3. 按 ref 操作                      → browser_click {ref:"e12"} / browser_type {ref:"e5", text:"…"}
4. 再读一次 mode=ax                 → 确认动作生效、拿到新的 ref
```

**为什么首选 `mode=ax`**：它比截图省、比 `mode=dom` 信息量大，而且天然可寻址 ——
对标 Codex 内置浏览器的 `AXAPI`。截图只在确实需要视觉信息时才用。

**ref 会失效**：页面变化后 ref 可能指向旧节点。动作失败时报错会提示
`ref 已失效…请重新 browser_read mode=ax`，照做即可。

## 19 个工具一览

| 工具 | 用途 |
|---|---|
| `browser_status` | 连接状态、URL/标题、`webviewCount`、CDP 可用性、**能力矩阵**、config |
| `browser_open` | 打开 URL（**复用已有 webview**，无标签页时才新建） |
| `browser_read` | `mode=ax`（首选）/ `text` / `html` / `links` / `dom` |
| `browser_click` | `ref`（推荐）/ `selector` / `text`；`hoverOnly:true` 只悬停 |
| `browser_type` | `ref` / `selector` + `text`；`submit:true` 回车（CDP 优先 + 自动回退） |
| `browser_scroll` | 滚动（CDP 真实滚轮；`dy`/`dx`，或滚到 `ref`/`selector`） |
| `browser_press` | 按键（CDP 真实键盘）：Enter/Tab/Esc/方向键/PageUp… 或单字符 |
| `browser_eval` | 兜底：页面内跑任意 JS（async 函数体，可 `return`） |
| `browser_history` | `back` / `forward` / `reload` / `list`（历史条目） |
| `browser_tabs` | `list` / `activate` / `close` |
| `browser_assets` | 资源清单（图片是否真的加载成功）+ WebMCP 探测 |
| `browser_viewport` | `zoom` / `width` / `height` / `hidden` / `css` / `reset` / **`device` 设备预设** |
| `browser_network` | 资源时序 + 按域名汇总；`install:true` 挂钩 fetch/XHR |
| `browser_policy` | **网络与权限控制**：`intercept.*`（mock/redirect/block/header 规则）、`net.offline/block/headers/cache`、`cert.ignore`、`downloads.set` |
| `browser_cookies` | Cookie 保险库：`export` / `import` / `list` / `clear`（含 httpOnly） |
| `browser_inject` | **document-start 注入**（`Page.addScriptToEvaluateOnNewDocument`）：在页面脚本之前 hook |
| `browser_instance` | 多浏览器实例：`create` / `list` / `select` / `close` |
| `browser_cdp` | **任意 CDP 命令透传**（需调试端口，见下） |
| `browser_screenshot` | 截图（`full` 整页 / `clip` 区域）；优先 CDP 原生，失败回退 SVG |

详细参数与返回值见 [references/tools.md](references/tools.md)。

## 独立 CLI（不经过 agent）

插件自带零依赖 CLI，可以直接在终端驱动浏览器：

```bash
cd ~/.dsh/profiles/desktop/node_modules/dsh-browser-agent
node cli/browser.mjs help
node cli/browser.mjs status
node cli/browser.mjs open https://example.com/
node cli/browser.mjs ax                    # 语义树
node cli/browser.mjs click e10
node cli/browser.mjs type e5 "hello" --submit
node cli/browser.mjs screenshot --out shot.png --full
node cli/browser.mjs cookies export work   # 导出登录态
node cli/browser.mjs cdp Page.getNavigationHistory
```

适合调试、脚本化、或验证「到底是插件的问题还是页面/环境的问题」。

## 四条必须知道的事

1. **CDP 需要调试端口。** `browser_cdp` 以及"原生截图/真实输入"都要求 DSH 以
   `--remote-debugging-port=9222` 启动（本机快捷方式已写入）。没有也能用，只是自动降级。
2. **绝不要让 CDP 打在外壳页面上。** 曾经一条 `Page.navigate` 把 DSH 自己的界面导航走了。
   现在有硬护栏：默认只选 `webview` target；非 webview 上拒绝破坏性方法。
   **不要传 `allowShell:true`，除非你确切知道在做什么。**
3. **webview guest 用久了会"降级"**：CDP 原生截图开始挂起（页面本身仍正常）。
   **重开一个标签即恢复**（`browser_tabs {action:"close"}` → `browser_open`）。
4. **虚拟鼠标**：点击/输入时页面里会出现指针 + 蓝色光环，这是给人看的。
   批量操作想省时间可传 `visual:false`。

## 常见任务配方

**读一个页面的主要内容**
```
browser_open {url}
browser_read {mode:"ax", maxChars:120}   → 看结构
browser_read {mode:"text"}               → 要正文
```

**搜索并打开结果**
```
browser_open {url:"https://cn.bing.com/"}
browser_read {mode:"ax"}                          → 找 searchbox 的 ref
browser_type {ref:"e21", text:"关键词", submit:true}
browser_read {mode:"ax"}                          → 找结果链接 ref
browser_click {ref:"e8"}
```

**在隔离的浏览器里做事（不打扰用户当前页面）**
```
browser_instance {action:"create", url:"…", visible:true}
   ← 此后所有工具自动作用于该实例
browser_instance {action:"select", id:null}       ← 切回侧边栏
browser_instance {action:"close", id:"…"}
```

**用 CDP 做协议级操作**
```
browser_cdp {listTargets:true}                                  → 先看有哪些 target
browser_cdp {method:"Network.enable", eventsMs:3000}            → 抓 3 秒网络事件
browser_cdp {method:"Emulation.setDeviceMetricsOverride",
             params:{width:390,height:844,deviceScaleFactor:3,mobile:true}}
browser_cdp {method:"Page.getNavigationHistory"}
```

**排查"图没显示 / 请求失败"**
```
browser_assets                       → 看 images[].loaded
browser_network {install:true}       → 然后触发动作，再 browser_network {}
browser_cdp {method:"Network.enable", eventsMs:5000}   → 更全的事件
```

## 故障排查

见 [references/troubleshooting.md](references/troubleshooting.md)：
连不上、截图挂起、ref 失效、CDP 不可用、标签页堆积、端口安全与关闭方法。

## 环境事实（本机）

- 插件位置：`~/.dsh/profiles/desktop/node_modules/dsh-browser-agent`
- profile bundle 行：`dsh-browser-agent`（在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`）
- 桥接：`127.0.0.1:8791`（长轮询，令牌 `x-dsh-browser-agent`）
- 版本核对：`GET http://127.0.0.1:8791/health` → `pluginVersion` / `clientVersion` / `cdp`
- 调试通道（绕过工具直接下发一次操作，用于自检）：
  `POST http://127.0.0.1:8791/debug/exec`，body `{"op":"status","args":{}}`
