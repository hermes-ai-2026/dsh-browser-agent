/**
 * 验证插件能注册常驻系统提示段（解决"新会话忘记用插件"）。
 * 运行：node verify-prompt.mjs
 */
const m = await import('./lib/index.js?t=' + Date.now());

const tools = new Map();
let registered = null;
const logs = [];

const ctx = {
  tools: { register: (d) => (tools.set(d.name, d), () => {}) },
  effect: (f) => f(),
  logger: () => ({ info: (s) => logs.push('info: ' + s), warn: (s) => logs.push('warn: ' + s) }),
  systemPrompt: {
    getSectionOrder: (k) => 100,
    section: (s) => { registered = s; return () => {}; },
  },
};

await m.apply(ctx);

console.log('① 工具注册:', tools.size, '个');
console.log('② 提示段注册:', registered ? '✅ ' + registered.name : '❌ 未注册');
console.log('   order =', registered?.order);
const txt = typeof registered?.text === 'function' ? registered.text({ scope: null }) : registered?.text;
console.log('   文本类型:', typeof registered?.text, ' 长度:', txt ? txt.length : 0);

const must = ['browser_read', 'mode:"ax"', 'ref', 'allowShell', 'browser_policy', 'browser_cookies', 'browser_instance', 'browser_status'];
const missing = must.filter((k) => !txt.includes(k));
console.log('③ 关键指引齐全:', missing.length === 0 ? '✅' : '❌ 缺 ' + missing.join(', '));
console.log('   含硬护栏提醒:', txt.includes('allowShell') && txt.includes('Fetch.enable') ? '✅' : '❌');
console.log('④ 日志:');
for (const l of logs) console.log('   ', l);

// 再测一次：没有 systemPrompt 服务时不能崩
console.log('\n⑤ 无 systemPrompt 服务时（应跳过且不报错）');
const tools2 = new Map();
let crashed = false;
try {
  await m.apply({
    tools: { register: (d) => (tools2.set(d.name, d), () => {}) },
    effect: (f) => f(),
    logger: () => ({ info: () => {}, warn: (s) => logs.push('warn2: ' + s) }),
  });
} catch (e) { crashed = true; console.log('   ❌ 崩了:', e.message); }
console.log('   工具仍注册:', tools2.size, '个 | 未崩溃:', crashed ? '❌' : '✅');

console.log('\n前 12 行提示段内容：');
console.log(txt.split('\n').slice(0, 12).map((l) => '   ' + l).join('\n'));
