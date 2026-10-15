#!/usr/bin/env node
/**
 * dsh-browser-agent 独立 CLI —— 不经过 agent，直接从终端驱动 DSH 内置浏览器。
 *
 * 零依赖：只用 Node 内置模块 + 插件自带的 lib/cdp.js。
 *
 *   node cli/browser.mjs status
 *   node cli/browser.mjs open https://example.com/
 *   node cli/browser.mjs ax                 # 语义树（带 ref）
 *   node cli/browser.mjs read --mode text
 *   node cli/browser.mjs click e10
 *   node cli/browser.mjs type e5 "hello" --submit
 *   node cli/browser.mjs scroll 800
 *   node cli/browser.mjs press Enter
 *   node cli/browser.mjs screenshot --out shot.png [--full]
 *   node cli/browser.mjs tabs list | tabs close 1 | tabs activate 0
 *   node cli/browser.mjs cookies export work | cookies import work | cookies list
 *   node cli/browser.mjs eval "return document.title"
 *   node cli/browser.mjs cdp Page.getNavigationHistory
 *   node cli/browser.mjs targets
 *   node cli/browser.mjs health
 *
 * 走两条路（与插件一致）：
 *   - 渲染层操作 → POST 127.0.0.1:8791/debug/exec（桥接长轮询 → 渲染半 → <webview>）
 *   - CDP 操作   → 直连 127.0.0.1:9222（需要 --remote-debugging-port）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, listTargets, pickTarget, probeCdp } from '../lib/cdp.js';

const BRIDGE = process.env.DSH_BROWSER_BRIDGE ?? 'http://127.0.0.1:8791';
const TOKEN = 'dsh-browser-agent-local-bridge-v1';
const CDP_PORT = Number(process.env.DSH_CDP_PORT) || 9222;
const BRIDGE_HEADERS = { 'content-type': 'application/json', 'x-dsh-browser-agent': TOKEN };

const argv = process.argv.slice(2);
const cmd = (argv.shift() ?? 'help').toLowerCase();

/** 解析 --key value / --flag。 */
function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}
const { flags, positional } = parseFlags(argv);

const C = { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m' };
const ok = (s) => console.log(`${C.g}✓${C.x} ${s}`);
const bad = (s) => { console.error(`${C.r}✗${C.x} ${s}`); process.exitCode = 1; };
const info = (s) => console.log(`${C.dim}${s}${C.x}`);

/** 走桥接执行一次渲染层操作。 */
async function op(o, args = {}, timeoutMs = 90_000) {
  const res = await fetch(`${BRIDGE}/debug/exec`, {
    method: 'POST',
    headers: BRIDGE_HEADERS,
    body: JSON.stringify({ op: o, args, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `桥接 HTTP ${res.status}`);
  return body.data;
}

/** 直连 CDP 执行一条命令。 */
async function cdpSend(method, params = {}, timeoutMs = 30_000) {
  const target = await pickTarget(CDP_PORT);
  if (!target) throw new Error('没有 webview target（先在侧栏打开浏览器标签页或用 open）');
  const s = new CdpSession(target.wsUrl);
  await s.connect();
  try {
    return await s.send(method, params, timeoutMs);
  } finally {
    s.close();
  }
}

const json = (v) => JSON.stringify(v, null, 2);
const here = path.dirname(fileURLToPath(import.meta.url));

try {
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h': {
      console.log(`${C.b}dsh-browser-agent CLI${C.x} —— 直接从终端驱动 DSH 内置浏览器\n`);
      console.log(`  ${C.c}health${C.x}                      桥接与 CDP 状态`);
      console.log(`  ${C.c}status${C.x}                      浏览器连接与页面状态`);
      console.log(`  ${C.c}open${C.x} <url>                  打开 URL（复用已有标签）`);
      console.log(`  ${C.c}ax${C.x} [--max N]              无障碍语义树（带稳定 ref）`);
      console.log(`  ${C.c}read${C.x} [--mode ax|text|html|links|dom] [--selector S]`);
      console.log(`  ${C.c}click${C.x} <ref|selector> [--hover] [--novisual]`);
      console.log(`  ${C.c}type${C.x} <ref|selector> <text> [--submit] [--append]`);
      console.log(`  ${C.c}scroll${C.x} [dy] [--to <ref|selector>]`);
      console.log(`  ${C.c}press${C.x} <key> [--times N]`);
      console.log(`  ${C.c}screenshot${C.x} [--out file] [--full] [--clip x,y,w,h]`);
      console.log(`  ${C.c}tabs${C.x} [list|close <i>|activate <i>]`);
      console.log(`  ${C.c}cookies${C.x} [list|export <name>|import <name>] [--url U]`);
      console.log(`  ${C.c}eval${C.x} "<js>"                 页面内执行（async 函数体，可 return）`);
      console.log(`  ${C.c}targets${C.x}                    CDP target 列表`);
      console.log(`  ${C.c}cdp${C.x} <Method> ['{json}']      任意 CDP 命令`);
      console.log(`  ${C.c}instance${C.x} [list|create <url>|close <id>|select <id|null>]`);
      console.log(`\n${C.dim}环境变量：DSH_BROWSER_BRIDGE / DSH_CDP_PORT${C.x}`);
      break;
    }

    case 'health': {
      const h = await (await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(8000) })).json();
      console.log(json(h));
      const cdp = await probeCdp(CDP_PORT);
      cdp ? ok(`CDP 可用：${cdp.browser}`) : info(`CDP 不可用（端口 ${CDP_PORT} 无响应）—— 需要 --remote-debugging-port`);
      break;
    }

    case 'status': {
      const s = await op('status', {}, 20_000);
      console.log(json(s));
      s.page?.present ? ok(`页面：${s.page.title}  ${s.page.url}`) : bad('当前没有打开的浏览器页面');
      break;
    }

    case 'open': {
      const url = positional[0];
      if (!url) { bad('用法：open <url>'); break; }
      const r = await op('open', { url }, 90_000);
      ok(`${r.title}\n  ${r.url}`);
      break;
    }

    case 'ax': {
      const r = await op('ax', { max: Number(flags.max || 150) }, 60_000);
      console.log(`${C.dim}${r.count} 个节点（可交互 ${(r.nodes || []).filter((n) => n.interactive).length}）${C.x}\n`);
      console.log(r.text);
      break;
    }

    case 'read': {
      const mode = String(flags.mode || 'text').toLowerCase();
      if (mode === 'ax') { const r = await op('ax', { max: Number(flags.max || 150) }, 60_000); console.log(r.text); break; }
      const r = await op('read', { mode, selector: flags.selector, maxChars: Number(flags.max || 20000) }, 60_000);
      if (mode === 'text') console.log(r.text);
      else if (mode === 'html') console.log(r.html);
      else console.log(json(r));
      break;
    }

    case 'click': {
      const sel = positional[0];
      if (!sel) { bad('用法：click <ref|selector>'); break; }
      const args = sel.startsWith('e') || /^[a-z]?\d+$/.test(sel) ? { ref: sel } : { selector: sel };
      const r = await op('click', { ...args, hoverOnly: !!flags.hover, visual: !flags.novisual }, 60_000);
      ok(`点击 ${r.clicked?.tag ?? ''} "${r.clicked?.text ?? ''}"${r.clicked?.href ? '  → ' + r.clicked.href : ''}`);
      break;
    }

    case 'type': {
      const [sel, ...words] = positional;
      const text = words.join(' ');
      if (!sel || !text) { bad('用法：type <ref|selector> <text> [--submit]'); break; }
      const args = sel.startsWith('e') ? { ref: sel } : { selector: sel };
      const r = await op('type', { ...args, text, submit: !!flags.submit, clear: !flags.append }, 60_000);
      ok(`输入完成，回读 value=${JSON.stringify(r.value)}${flags.submit ? '（已回车）' : ''}`);
      break;
    }

    case 'scroll': {
      if (flags.to) {
        const sel = String(flags.to);
        const args = sel.startsWith('e') ? { ref: sel } : { selector: sel };
        const r = await op('highlight', args, 30_000);
        ok(`已滚动到 ${r.tag} "${String(r.text).slice(0, 40)}"`);
        break;
      }
      const dy = Number(positional[0] ?? 600);
      const before = await op('eval', { code: 'return Math.round(window.scrollY)' }, 20_000);
      const r = await op('scroll', { dy }, 20_000);
      ok(`scrollY ${before.result} → ${r.to?.y ?? '?'}（文档高 ${r.docH ?? '?'}，视口 ${r.vh ?? '?'}）`);
      break;
    }

    case 'press': {
      const key = positional[0];
      if (!key) { bad('用法：press <key> [--times N]'); break; }
      const target = await pickTarget(CDP_PORT);
      if (!target) { bad('需要 CDP（没有 webview target）'); break; }
      const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, Space: 32 };
      const vk = KEYS[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const times = Math.max(1, Math.min(Number(flags.times || 1), 20));
      const s = new CdpSession(target.wsUrl);
      await s.connect();
      for (let i = 0; i < times; i += 1) {
        await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await new Promise((r) => setTimeout(r, 60));
      }
      s.close();
      ok(`已发送 ${key} ×${times}`);
      break;
    }

    case 'screenshot': {
      const out = path.resolve(String(flags.out || `shot-${Date.now()}.png`));
      const target = await pickTarget(CDP_PORT);
      if (!target) { bad('需要 CDP（没有 webview target）'); break; }
      const s = new CdpSession(target.wsUrl);
      await s.connect();
      const params = { format: 'png' };
      if (flags.full) { params.captureBeyondViewport = true; }
      if (flags.clip) {
        const [x, y, width, height] = String(flags.clip).split(',').map(Number);
        params.clip = { x, y, width, height, scale: 1 };
      }
      const r = await s.send('Page.captureScreenshot', params, 20_000);
      s.close();
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      ok(`${out}  ${fs.statSync(out).size} 字节  ${flags.full ? '（全页）' : flags.clip ? '（区域）' : '（视口）'}`);
      break;
    }

    case 'tabs': {
      const sub = (positional[0] ?? 'list').toLowerCase();
      if (sub === 'list') { const r = await op('tabs', { action: 'list' }, 20_000); r.tabs.forEach((t) => console.log(`  [${t.index}] ${t.active ? '●' : '○'} ${t.title}`)); break; }
      const idx = Number(positional[1]);
      const r = await op('tabs', { action: sub, index: idx }, 20_000);
      ok(`${sub} → 剩余 ${r.count} 个标签`);
      break;
    }

    case 'cookies': {
      const sub = (positional[0] ?? 'list').toLowerCase();
      const name = positional[1] ?? 'default';
      if (sub === 'list') {
        const dir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'dsh-browser-agent', 'vault');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
        info(`目录 ${dir}`);
        files.forEach((f) => {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          console.log(`  ${f.replace(/\.json$/, '').padEnd(16)} ${String(j.cookies?.length ?? 0).padStart(4)} 个 cookie   ${j.savedAt ?? ''}`);
        });
        if (!files.length) info('（还没有保险库）');
        break;
      }
      if (sub === 'export' || sub === 'import') {
        const target = await pickTarget(CDP_PORT);
        if (!target) { bad('需要 CDP'); break; }
        const dir = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'dsh-browser-agent', 'vault');
        const file = path.join(dir, `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
        const s = new CdpSession(target.wsUrl);
        await s.connect();
        if (sub === 'export') {
          const got = await s.send('Network.getCookies', flags.url ? { urls: [String(flags.url)] } : {}, 20_000);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), source: target.url, cookies: got.cookies }, null, 2));
          ok(`导出 ${got.cookies.length} 个（httpOnly ${got.cookies.filter((c) => c.httpOnly).length} 个）→ ${file}`);
        } else {
          if (!fs.existsSync(file)) { bad(`保险库不存在：${file}`); s.close(); break; }
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          let n = 0;
          for (const c of j.cookies ?? []) {
            const p = { name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
            if (typeof c.expires === 'number' && c.expires > 0) p.expires = c.expires;
            try { const r2 = await s.send('Network.setCookie', p, 10_000); if (r2?.success !== false) n += 1; } catch {}
          }
          ok(`还原 ${n}/${(j.cookies ?? []).length} 个 cookie（保存于 ${j.savedAt}）`);
        }
        s.close();
        break;
      }
      bad(`未知子命令：${sub}`);
      break;
    }

    case 'eval': {
      const code = positional.join(' ');
      if (!code) { bad('用法：eval "<js>"'); break; }
      const r = await op('eval', { code }, 60_000);
      console.log(typeof r.result === 'string' ? r.result : json(r.result));
      break;
    }

    case 'targets': {
      const list = await listTargets(CDP_PORT);
      list.forEach((t) => console.log(`  [${t.type.padEnd(8)}] ${(t.title || '').slice(0, 40).padEnd(42)} ${t.url.slice(0, 50)}`));
      break;
    }

    case 'cdp': {
      const method = positional[0];
      if (!method) { bad('用法：cdp <Method> [\'{json}\']'); break; }
      const params = positional[1] ? JSON.parse(positional[1]) : {};
      const r = await cdpSend(method, params, Number(flags.timeout || 30_000));
      console.log(json(r));
      break;
    }

    case 'instance': {
      const sub = (positional[0] ?? 'list').toLowerCase();
      if (sub === 'list') { console.log(json(await op('instance', { action: 'list' }, 20_000))); break; }
      if (sub === 'create') { const r = await op('instance', { action: 'create', url: positional[1], visible: !!flags.visible }, 90_000); ok(`实例 ${r.id}（共 ${r.count} 个）`); break; }
      if (sub === 'close') { const r = await op('instance', { action: 'close', id: positional[1] }, 40_000); ok(`已关闭，剩余 ${r.count}`); break; }
      if (sub === 'select') { const id = positional[1] === 'null' ? null : positional[1]; const r = await op('instance', { action: 'select', id }, 20_000); ok(`当前实例：${r.active ?? '侧边栏'}`); break; }
      bad(`未知子命令：${sub}`);
      break;
    }

    default:
      bad(`未知命令：${cmd}（用 help 看用法）`);
  }
} catch (e) {
  bad(String(e?.message ?? e));
}
