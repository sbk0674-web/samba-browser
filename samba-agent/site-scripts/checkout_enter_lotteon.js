
const card = args.card || '';
const cardCompanies=['롯데카드','신한카드','KB국민카드','삼성카드','현대카드','BC카드','하나카드','씨티카드','우리BC카드','우리카드','NH농협카드','카카오뱅크','광주카드'];
const simplePays=['카카오페이','네이버페이','토스페이','삼성페이','휴대폰결제','충전결제','퀵계좌이체','온누리상품권'];
const url = await page.url();
if (!/orderSheet/.test(url)) return {ok:false, error:'no lotteon order sheet open in current tab'};
// 결제 단계가 아니면(선물·직배 주문서 첫 화면) '계속하기'로 넘어간다
for (let i = 0; i < 6 && !/결제수단/.test((await page.get({query:'결제수단'})).tree); i++) {
  const c = await page.idOf('계속하기'); if (c < 0) break; await page.click(c); await sleep(2500);
}
// L.POINT 전액 사용(사용자 2026-09-27) — 버튼이 있을 때만
const fu = await page.idOf('전액사용'); if (fu >= 0) { await page.click(fu); await sleep(2500); }
let method=null;
const mc = cardCompanies.find(c=>c.includes(card)||(card && card.length>0 && c.replace('카드','').includes(card)));
if (mc) {
  await page.clickText('신용카드');
  await sleep(600);
  const sel = await page.idOf('카드를 선택해 주세요.');
  if (sel<0) return {ok:false, error:'card select box not found'};
  await page.click(sel);
  await sleep(600);
  await page.clickText(mc);
  method = mc;
} else {
  const mp = simplePays.find(p=>p.includes(card)||(card && card.length>0 && p.includes(card)));
  if (!mp) return {ok:false, error:'payment method not found: '+card};
  await page.clickText(mp);
  method = mp;
}
await sleep(600);
// 현금영수증은 항상 지출증빙용(사용자 2026-09-29). args.biz_no 가 있으면 번호 칸을 사업자등록번호로 맞춘다
let receipt=null,after=null;
try{
  const rt=(await page.get({query:'지출증빙용'})).tree;
  const rm=rt.match(/\[(\d+)\] radio "지출증빙용"[^\n]*/);
  if(rm){
    if(!/value="on"/.test(rm[0])){await page.click(parseInt(rm[1]));await sleep(900);}
    receipt='지출증빙용';
    // 번호 칸은 라디오를 누른 뒤 늦게 뜬다(실기 2026-09-29: 바로 읽으면 없음) — 뜰 때까지 기다린다. 전체 목록은 긴 주문서에서 잘려 검색으로 찾는다
    let tb=null;
    for(let k=0;k<8&&!tb;k++){tb=(await page.get({query:'10자리'})).tree.split('\n').find(l=>/^\[\d+\] textbox "[^"]*10자리/.test(l))||null;if(!tb)await sleep(700);}
    if(!tb)receipt='지출증빙용(번호 칸 못 찾음)';
    // 칸에 다른 번호(소득공제용 휴대폰 번호 등)가 미리 들어 있으면 지우고 사업자등록번호로 바꾼다(실기 2026-09-29)
    const cur=tb?((tb.match(/value="([^"]*)"/)||[])[1]||'').replace(/\D/g,''):'';
    if(tb&&args.biz_no&&cur!==String(args.biz_no)){await page.type(parseInt(tb.slice(1)),String(args.biz_no),true);await sleep(500);receipt='지출증빙용(번호 입력)';}
  }
}catch(e){receipt='확인 실패';}
const payId = await page.idOf('결제하기');
if (payId<0) return {ok:false, error:'결제하기 button not found', method};
await page.click(payId);
await sleep(3000);
// 네이버페이는 같은 탭에서 m.pay.naver.com 으로 넘어가 '동의하고 결제하기' 뒤 비밀번호 키패드가 뜬다(팝업 아님)
if (/네이버페이/.test(method)) {
  for (let i = 0; i < 8; i++) { const ag = await page.idOf('동의하고 결제하기'); if (ag >= 0) { await page.click(ag); await sleep(3000); break; } await sleep(1000); }
}
try{const T=String((await page.get({})).tree||'');if(/^URL: [^\n]*orderSheet/.test(T)){const m=T.match(/사업자등록번호[^\n]{0,25}입력해 ?주세요/);if(m)after='주문서에서 막힘: '+m[0];
// 네이버페이는 같은 탭이 pay.naver.com 으로 넘어가야 한다 — 결제하기 뒤에도 주문서면 결제창이 안 열린 것이다(실기 2026-09-30: 키패드 없음 2회).
// 성공으로 돌려주면 하네스가 주문서에서 키패드를 30초 찾다 멈춘다 — 화면의 안내 문구를 붙여 실패로 돌려준다
else if(/네이버페이/.test(method)){const P=T.split('PAGE TEXT')[1]||'';const g=(P.match(/[^\n.]{0,30}(?:해 ?주세요|하세요|불가|없습니다|초과)[^\n.]{0,10}/)||[''])[0];after='결제하기 뒤에도 주문서(네이버페이 창 안 열림)'+(g?': '+g.trim():'');}}}catch(e){}
if(after)return{ok:false,error:after,method,receipt};
const tbs = await tabs.list();
const popup = tbs.find(t=>t.kind==='popup');
return { ok:true, method, receipt, popup_url: popup? popup.url : null, keypad_in_tab: /네이버페이/.test(method) };
