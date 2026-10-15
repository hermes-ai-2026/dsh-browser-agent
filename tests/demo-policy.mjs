/**
 * 实测 browser_policy 的核心能力：**请求拦截与改写**（Fetch 域）。
 * 这等价于"代理能做的事"里除了"改出口 IP"以外的全部。
 *
 * 运行：node demo-policy.mjs
 */
import { CdpSession, pickTarget } from './lib/cdp.js';

const t = await pickTarget(9222);
if (!t) { console.log('无 webview target'); process.exit(1); }
const s = new CdpSession(t.wsUrl);
await s.connect();
await s.send('Network.enable').catch(() => {});
const ev = async (e, awaitPromise = false) =>
  (await s.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise })).result?.value;

console.log('① 权限授予（Browser.grantPermissions）');
await s.send('Browser.grantPermissions', { origin: 'https://example.com', permissions: ['geolocation', 'notifications'] }, 15_000);
const perm = await ev(`navigator.permissions.query({name:'geolocation'}).then(p => p.state)`, true);
console.log('   geolocation 权限状态 =', perm, '(granted 表示已授予)');

console.log('\n② 忽略证书错误（Security.setIgnoreCertificateErrors）');
await s.send('Security.setIgnoreCertificateErrors', { ignore: true }, 15_000);
console.log('   ✅ 已开启（会话级）');
await s.send('Security.setIgnoreCertificateErrors', { ignore: false }, 15_000);

console.log('\n③ 请求拦截 —— mock 一个不存在的接口');
await s.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, 15_000);
const rules = [
  { match: '*__mock_api*', action: 'mock', status: 200, body: JSON.stringify({ mocked: true, from: 'dsh-browser-agent' }) },
  { match: '*__blocked*', action: 'block' },
];
let paused = 0, mocked = 0, blocked = 0, passed = 0;
const pump = setInterval(async () => {
  for (const e of s.takeEvents('Fetch.')) {
    if (e.method !== 'Fetch.requestPaused') continue;
    paused += 1;
    const { requestId, request } = e.params;
    const url = request?.url ?? '';
    const rule = rules.find((r) => new RegExp('^' + r.match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(url));
    try {
      if (!rule) { await s.send('Fetch.continueRequest', { requestId }, 8000); passed += 1; continue; }
      if (rule.action === 'block') { await s.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, 8000); blocked += 1; continue; }
      await s.send('Fetch.fulfillRequest', {
        requestId, responseCode: rule.status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(rule.body, 'utf8').toString('base64'),
      }, 8000);
      mocked += 1;
    } catch {}
  }
}, 100);

console.log('   发起三个请求：正常 / mock / 拦截');
const result = await ev(`(async () => {
  const out = {};
  try { const r = await fetch(location.href, { cache: 'no-store' }); out.normal = r.status; } catch (e) { out.normal = 'ERR'; }
  try { const r = await fetch('https://example.com/__mock_api?x=1'); out.mocked = await r.json(); } catch (e) { out.mocked = 'ERR:' + e.message; }
  try { await fetch('https://example.com/__blocked.js'); out.blocked = 'unexpectedly-succeeded'; } catch (e) { out.blocked = 'blocked ✅'; }
  return out;
})()`, true);
console.log('   结果:', JSON.stringify(result));

await new Promise((r) => setTimeout(r, 800));
clearInterval(pump);
await s.send('Fetch.disable', {}, 15_000);
console.log(`   Fetch 统计：暂停 ${paused} / mock ${mocked} / 拦截 ${blocked} / 放行 ${passed}`);
console.log('   ', result?.mocked?.mocked === true && result?.blocked === 'blocked ✅' ? '✅ 请求改写与拦截都生效' : '⚠️ 部分生效，见上面结果');

console.log('\n④ URL 黑名单 + 离线模拟 + 附加请求头');
await s.send('Network.setBlockedURLs', { urls: ['*__blocked2*'] }, 10_000);
const blk = await ev(`fetch('https://example.com/__blocked2').then(()=>'succeeded').catch(()=> 'blocked ✅')`, true);
console.log('   setBlockedURLs →', blk);
await s.send('Network.setBlockedURLs', { urls: [] }, 10_000);

await s.send('Network.setExtraHTTPHeaders', { headers: { 'X-DSH-Probe': 'policy' } }, 10_000);
console.log('   setExtraHTTPHeaders ✅');
await s.send('Network.setExtraHTTPHeaders', { headers: {} }, 10_000);

await s.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, 10_000);
const off = await ev(`fetch(location.href).then(()=>'online').catch(()=> 'offline ✅')`, true);
console.log('   emulateNetworkConditions(offline) →', off);
await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, 10_000);

console.log('\n⑤ 对照：真正的代理配置（预期不存在）');
for (const m of ['Network.setProxy', 'Browser.setProxy', 'Network.setProxyServer']) {
  try { await s.send(m, {}, 5000); console.log('   ⚠️', m, '竟然可用?'); }
  catch (e) { console.log('   ❌', m, '→', String(e.message).slice(0, 60)); }
}

s.close();
console.log('\n完成');
