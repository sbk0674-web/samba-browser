const path = (typeof args!=='undefined' && args && args.path) || '/orders/trading/';
const urls = ['https://snkrdunk.com' + path, 'https://snkrdunk.com/'];
const before = (await tabs.list()).map(t=>t.id);
const checked = [];
for (const u of urls) {
  await tabs.open({ url: u });
  await sleep(2500);
  let s = await page.get({ interactive: true });
  let title = String(await page.title() || '');
  let tree = String(s.tree || '');
  if (!/取引ID/.test(tree) && !/403/.test(tree)) { await sleep(1800); s = await page.get({ interactive: true }); tree = String(s.tree || ''); title = String(await page.title() || ''); }
  const blocked = /403|forbidden|access denied/i.test(title) || /403 Forbidden/i.test(tree);
  const needs_login = /ログイン|会員登録/i.test(tree) && !/取引ID/.test(tree);
  checked.push({ url: u, title, blocked, needs_login, sample: tree.replace(/\s+/g,' ').slice(0, 300) });
  if (!blocked && /取引ID/.test(tree)) break;
}
const after = await tabs.list();
for (const t of after) { if (!before.includes(t.id)) { try { await tabs.close(t.id); } catch(e){} } }
const blocked = checked.every(c => c.blocked);
const needs_login = !blocked && checked.some(c => c.needs_login);
const ok = !blocked && !needs_login;
return JSON.stringify({ ok, blocked, needs_login, checked, note: blocked ? '사이트 전체 403 봇차단 — 브라우저 자동화로 점검 불가, 사용자가 앱/직접 확인 필요' : (needs_login ? '로그인 필요 — login 도구 사용' : '접근 가능 — 전수 점검 진행') });