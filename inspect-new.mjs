import { CdpSession, pickTarget } from './lib/cdp.js';
const t = await pickTarget(9222);
if (!t) { console.log('无 target'); process.exit(1); }
const s = new CdpSession(t.wsUrl);
await s.connect();
const ev = async (c) => (await s.send('Runtime.evaluate', { expression: c, returnByValue: true })).result?.value;
console.log('URL:', await ev('location.href'));
console.log('TITLE:', await ev('document.title'));
console.log('\n--- input / textarea ---');
console.log(await ev(`JSON.stringify([...document.querySelectorAll('input,textarea')].map(e => ({tag:e.tagName,type:e.type,name:e.name,id:e.id,ph:e.placeholder,aria:e.getAttribute('aria-label'),vis:e.offsetParent!==null})), null, 1)`));
console.log('\n--- button / submit ---');
console.log(await ev(`JSON.stringify([...document.querySelectorAll('button,input[type=submit]')].map(e => ({tag:e.tagName,type:e.type,name:e.name,id:e.id,txt:(e.innerText||e.value||'').trim().slice(0,32),vis:e.offsetParent!==null})), null, 1)`));
console.log('\n--- forms ---');
console.log(await ev(`JSON.stringify([...document.forms].map(f => ({action:f.action,method:f.method,id:f.id})), null, 1)`));
console.log('\n--- 正文首 300 字 ---');
console.log(await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)`));
s.close();
process.exit(0);
