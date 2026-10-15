# dsh-browser-agent

**让 DeepSeek Harness 的 agent 真正用上内置浏览器。**

DSH 桌面版右侧侧边栏有一个浏览器，但它**只给人用**：官方 bundle
`@deepseek-ai/dsh-client-ui-sidebar-browser` 只注册了一个 UI 页签，宿主半是一行空 `apply() {}`，
不注册任何模型工具。

本插件以**非侵入式加装**的方式补上 agent 动作面 —— 不改 `app.asar`、不动应用签名、
不需要额外安装步骤，装完即用。

```
browser_status → browser_open → browser_read {mode:"ax"} → 按 ref 操作 → 再读一次确认
```

---

## 亮点

| | |
|---|---|
| **19 个 `browser_*` 工具** | 读 / 点 / 输入 / 滚动 / 按键 / 截图 / 标签页 / 网络 / 设备模拟 / 拦截改写 / 多实例 / 任意 CDP |
| **无障碍语义树 + 稳定 ref** | `browser_read {mode:"ax"}` 返回 role / name / 几何与 `ref`，读完直接按 ref 操作，不用猜选择器 |
| **CDP 原生协议域** | `browser_cdp` 可发**任意** CDP 命令；真实鼠标键盘（`isTrusted:true`）、原生截图、Network 域 |
| **网络拦截与改写** | `browser_policy` 支持 mock / redirect / block / header 四类规则，另有离线模拟、URL 黑名单、改请求头 |
| **Cookie 保险库** | 侧栏会话是进程级的，cookie 默认随应用退出消失。导出/还原**含 httpOnly** 的 cookie，登录跨重启保留 |
| **document-start 注入** | `Page.addScriptToEvaluateOnNewDocument`，在页面脚本**之前**执行（hook fetch/XHR） |
| **多浏览器实例** | 基于 DSH 的租约 API 另开实例，离屏或右下角浮层，不打扰用户当前页面 |
| **虚拟鼠标** | 操作时页面里出现指针 + 蓝色光环，**用户看得见 agent 在点哪里** |
| **常驻系统提示段** | 插件会往系统提示词里写一段用法说明，**新会话不会忘记调用**（不需要额外装 skill） |
| **独立 CLI** | 零依赖，17 个子命令，不用开会话就能从终端驱动浏览器 |
| **能力矩阵** | `browser_status` 逐项上报每类能力走哪条路径、是否可用，而不是让你猜 |

---

## 安装

**方式一：DSH 插件界面**（推荐）

打开 **插件** → **添加插件** → 填入：

```
github:hermes-ai-2026/dsh-browser-agent
```

按 **安装**，再按 **立即启用**。然后**开一个新会话**。

**方式二：命令行**

```bash
dsh plugin --profile desktop add github:hermes-ai-2026/dsh-browser-agent
```

**方式三：本地克隆（想改代码时）**

```bash
git clone https://github.com/hermes-ai-2026/dsh-browser-agent.git
dsh plugin --profile desktop add "$PWD/dsh-browser-agent"
```

装完**重启 DSH**，然后打开右侧侧边栏的「浏览器」标签页（插件的渲染半需要它承载 `<webview>`）。

---

## 为什么新会话不会忘记用

只把工具注册进 registry 是不够的 —— 新会话面对「帮我查一下…」这种通用任务时，
很容易去用 `eval` 或 HTTP 抓取。所以插件在 `apply()` 里做了两件事：

1. 注册 19 个工具（`ctx.tools.register`）
2. **注册一个常驻系统提示段**（`ctx.systemPrompt.section`），内容包含工具索引、
   推荐工作流、以及两条硬护栏提醒

提示段进的是**系统提示词**，每个新会话自动生效 —— 比依赖模型去翻 skill 目录可靠得多。
（`systemPrompt` 服务缺失时会自动跳过，插件其余功能不受影响。）

另外仓库里也**随包附带了一份 skill**（`skills/dsh-browser-agent/`），
可以复制到 `~/.dsh/skills/` 或 `~/.agents/skills/` 作为补充文档。
但**它不是必需的** —— 提示段已经覆盖了"让模型知道该用这些工具"这件事。

---

## 工具清单（19）

| 工具 | 用途 |
|---|---|
| `browser_status` | 状态、URL、`webviewCount`、CDP 可用性、**能力矩阵** |
| `browser_open` | 打开 URL（复用已有 webview） |
| `browser_read` | `ax`（首选）/ `text` / `html` / `links` / `dom` |
| `browser_click` | 按 `ref` / `selector` / `text`；`hoverOnly` 只悬停 |
| `browser_type` | 输入 + `submit` 回车（CDP 优先 + 回读校验 + 自动回退） |
| `browser_scroll` | 滚动（CDP 真实滚轮） |
| `browser_press` | 按键（CDP 真实键盘） |
| `browser_eval` | 页面内跑任意 JS |
| `browser_history` | `back` / `forward` / `reload` / `list` |
| `browser_tabs` | `list` / `activate` / `close` |
| `browser_assets` | 资源清单（图片是否真的加载成功）+ WebMCP |
| `browser_viewport` | 缩放 / 尺寸 / CSS 注入 / **8 种设备预设** |
| `browser_network` | 资源时序 + 按域名汇总 |
| `browser_policy` | **拦截改写** / 离线 / 黑名单 / 请求头 / 证书 / 下载 |
| `browser_cookies` | Cookie 保险库：`export` / `import` / `list` / `clear` |
| `browser_inject` | **document-start 注入** |
| `browser_instance` | 多实例：`create` / `list` / `select` / `close` |
| `browser_cdp` | **任意 CDP 命令透传** |
| `browser_screenshot` | 截图（`full` 整页 / `clip` 区域） |

---

## 独立 CLI

零依赖，不用开会话：

```bash
node cli/browser.mjs help
node cli/browser.mjs status
node cli/browser.mjs open https://example.com/
node cli/browser.mjs ax                      # 语义树
node cli/browser.mjs click e10
node cli/browser.mjs type e5 "hello" --submit
node cli/browser.mjs screenshot --out x.png --full
node cli/browser.mjs cookies export work     # 导出登录态
node cli/browser.mjs cdp Page.getNavigationHistory
```

排障时特别有用：当 agent 说"点不动"，你在终端敲一条就能判断是插件、页面还是环境的问题。

---

## CDP 调试端口（可选，但推荐）

核心能力走渲染层桥，**不需要任何启动参数**。但以下能力需要 CDP：

- `browser_cdp`（任意协议域）
- `browser_press`（真实键盘）、CDP 真实指针路径
- 原生截图、`browser_policy` 全部、`browser_cookies`、`browser_inject`、设备预设

开启方式：启动 DSH 时加 `--remote-debugging-port=9222`。

```powershell
# Windows：写进快捷方式（一次性）
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:USERPROFILE\Desktop\DeepSeek Harness.lnk")
$s.Arguments = "--remote-debugging-port=9222"
$s.Save()
```

没开也能用 —— `browser_status` 会告诉你哪些能力当前走降级路径。

> ⚠️ **安全提醒**：调试端口一开，**本机任何进程都能完全控制 DSH、读取它的登录态**。
> 只在需要时开启，用完把启动参数去掉。

实验数据（Windows / Electron 44 / Chrome 152）：
`Playwright`/`Puppeteer` 都**无法**接管 —— Electron 把侧栏页报成 `type:"webview"`，
而它们只枚举 `page`。本插件直接用 Node 内置 `WebSocket` 说话，**零依赖**。

---

## 已知边界

我们查清了每一条，**不假装能做到**：

| 边界 | 原因 |
|---|---|
| **真正的代理服务器**（改出口 IP） | CDP 没有这个域（`Network.setProxy`/`Browser.setProxy` 不存在）。其余"代理能做的事"（mock/拦截/改头/离线）都已覆盖 |
| **权限授予**（geolocation 等） | webview 跑在 `partition` 对应的独立 BrowserContext，而该上下文**未暴露给 CDP**（`Target.getBrowserContexts` 返回 `[]`）。**不是"需要主进程"**，是 CDP 的可见性问题 |
| 主进程 session 对象 | 渲染层拿不到，属真边界 —— 但 cookie 保险库已覆盖实际需求 |
| `browser_press` 在窗口失焦时 | 无 OS 级键盘焦点时 CDP 键盘事件被丢弃（鼠标不受影响）。`browser_type` 有回读校验+自动回退，所以不受此限 |
| guest 长期使用后截图挂起 | 已知的 Electron webview 表面问题，**重开标签即恢复**；插件有 8s 超时 + SVG 回退，不会卡住 |

---

## 测试

仓库自带验证套件（隔离测试台用假 DOM + 真两半代码走真桥接）：

```bash
node tests/verify-e2e.mjs        # 53 项
node tests/verify-guard.mjs      # 7 项：护栏（绝不把 DSH 外壳当浏览器目标）
node tests/verify-prompt.mjs     # 系统提示段注册
node tests/verify-cdp.mjs        # 真实 CDP 全套
node tests/demo-policy.mjs       # 请求拦截/改写实测
```

---

## 安全护栏（真实事故换来的）

早期版本在没有 webview 时会回退到 `type:"page"` 的**外壳 target**，
一条 `Page.navigate` **把 DSH 自己的界面导航成了 example.com**。现在：

1. `pickTarget()` 默认 `allowPage:false` —— 没有 webview 就返回 `null`，**永不返回外壳页面**
2. 非 webview target 上拒绝破坏性方法（`Page.navigate`/`reload`/`close`/`crash`/`Target.closeTarget`），
   除非显式 `allowShell:true`

**除非你确切知道在做什么，不要传 `allowShell:true`。**

---

## License

MIT

---

# English

**dsh-browser-agent** gives DeepSeek Harness agents a real browser — the one already
sitting in the right sidebar.

DSH ships that browser for humans only: `@deepseek-ai/dsh-client-ui-sidebar-browser`
registers a UI tab and nothing else, and its host half is a single empty `apply() {}`.
This plugin bolts the agent-facing surface on **without touching `app.asar`**, without
breaking code signing, and without an extra install step.

**19 `browser_*` tools**: accessibility-tree reads with stable refs, real CDP input,
screenshots (viewport/full-page/region), tab management, network inspection,
request interception & rewriting, device emulation, cookie vault (httpOnly included),
document-start injection, multi-instance, and raw CDP passthrough.

It also registers a **system-prompt section**, so fresh sessions know the tools exist
and how to use them — no skill required.

```bash
dsh plugin --profile desktop add github:hermes-ai-2026/dsh-browser-agent
```

Zero runtime dependencies (Node builtins + one bundled CDP client). Optional
`--remote-debugging-port=9222` unlocks the native CDP capabilities; everything else
works without it.

MIT licensed.

---

## 致谢

设计过程中对比过三个同类项目，其中 `alesha-pro/dsh-sidebar-browser` 的
**cookie 保险库**与**独立 CLI** 两个想法被借鉴并在此实现；`Gnatnaituy/dsh-sidebar-browser`
的**设备视口预设**给了启发。感谢。
