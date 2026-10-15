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

---

## 15. ⚠️ `engine` 显示 `renderer-dom` 而不是 `cdp-input` —— 查 `cdpError`

**症状**：点击/输入"看起来成功了"，但返回值里 `engine: "renderer-dom"`（合成事件），
并带一个 `cdpError` 字段。

**真实案例（v1.0.0，2026-10-16 修复）**：

```json
{ "engine": "renderer-dom", "cdpError": "bridge is not defined" }
```

根因：`currentCdpTarget` / `cdpClick` / `cdpType` 是**模块级函数**，而 `bridge` 实例
在 `apply()` 里用 `const` 声明 —— 作用域够不着，于是每次都抛 `ReferenceError`，
被 `catch` 吞掉后**静默回退**。功能"看起来正常"，但所有交互都是合成事件，
**hover 类菜单永远点不动**。

**教训（可推广）**：**动作类工具的返回值必须读 `engine` 和 `cdpError`。**
"操作成功"不等于"走了预期路径"。这个 bug 是靠读返回值发现的，不是靠猜。

| 字段 | 正确 | 有问题 |
|---|---|---|
| `engine` | `cdp-input` | `renderer-dom` |
| `trusted` | `true` | 无 |
| `cdpError` | 不存在 | 有值 |
| `at` | 有坐标 | 无 |

---

## 16. ⚠️ CDP 端口"在监听但连不上" —— 僵尸 socket

**症状**：`browser_status` 报 `cdp.available: false`，但进程命令行**确实带了**
`--remote-debugging-port=9222`。

**诊断三步**：

```powershell
Get-NetTCPConnection -LocalPort 9222 -State Listen | Select OwningProcess   # 谁占着
tasklist /FI "PID eq <PID>"                                                  # 进程还在吗
curl.exe -sS -o NUL -w "%{http_code}" --max-time 6 http://127.0.0.1:9222/json/version
```

`netstat` 显示 LISTENING 但 `tasklist` 说进程不存在 → **已死进程泄漏的监听 socket**。
当前实例绑不上端口时，Chrome 会**静默禁用**远程调试（不报错）。

**原因**：多次重启 DSH 留下孤儿主进程，其中一个死掉时 socket 没释放。

**修法：换端口**（比重启机器快得多）

```powershell
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut("$env:USERPROFILE\Desktop\DeepSeek Harness.lnk")
$s.Arguments = ($s.Arguments -replace '--remote-debugging-port=\d+', '--remote-debugging-port=9444')
$s.Save()
[Environment]::SetEnvironmentVariable('DSH_CDP_PORT', '9444', 'User')   # 插件读这个
```

**关键区分**：`curl` 报 **Connection refused** = 端口没人服务；
**timeout** = 网络层问题。两者含义完全不同。

---

## 17. ⚠️ 表单里的隐藏蜜罐字段

一些站点（含 DSH 插件目录的提交页）有**反机器人蜜罐**：一个名字诱人、
定位在屏幕外的输入框：

```
[e36] textbox "website" @-9999,492 561x47     ← 坐标 -9999 = 屏幕外
```

**人类看不见它，机器人会填它。填了就判定为垃圾提交。**

**做法**：`browser_read {selector:"form"}` 看完整结构，**只填 label 明确要求的字段**。
提交前用 `browser_eval` 验证所有字段值 + 确认蜜罐为空。

---

## 18. Cookie 保险库的边界

实测（2026-10-16，必应）：

```
export → 17 个（含 7 个 httpOnly）
clear  → JS 可见 cookie 归 0
import → restored 17/17，failed []
       → JS 可见恢复 10 个 + 7 个 httpOnly
```

**只覆盖 cookie，不覆盖 localStorage。** 实测 `clear` 之后 localStorage 的 12 个键**原样还在**。
需要保住 localStorage 的站点（很多 SPA 把 token 放那儿）要另外用 `browser_eval`：

```js
// 导出：JSON.stringify(Object.fromEntries(Object.entries(localStorage)))
// 还原：for (const [k,v] of Object.entries(d)) localStorage.setItem(k, v)
```

另外：**`clear` 清的是整个 profile 的 cookie**，不是只清当前站点 —— 多站点登录态会一起没。

---

## 19. 请求拦截实测参考（`browser_policy`）

三条规则一次跑通（2026-10-16）：

| 规则 | 实测结果 |
|---|---|
| `mock` | `status:200`、`content-type: application/json`、body **正是给定的假 JSON** |
| `block` | 页面侧 `Failed to fetch` |
| `redirect` | 请求被透明转发 |
| 未命中 | **自动放行**，真实页面 210 KB 正常返回 ← 证明不会把页面卡死 |

**`redirect` 的语义要注意**：CDP `Fetch.continueRequest({url})` 是**在服务端改写目标**，
页面侧 `response.url` **不会变成新地址**，但拿到的是新资源的内容。
**别拿 `r.url` 判断是否生效，要看 body。**

