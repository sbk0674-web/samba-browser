
// 신용카드 탭 직접결제는 card='신용카드'+issuer=카드사(2026-10-06)
const card = args.issuer || args.card || '';
const cardCompanies=['롯데카드','신한카드','KB국민카드','삼성카드','현대카드','BC카드','하나카드','씨티카드','우리BC카드','우리카드','NH농협카드','카카오뱅크','광주카드'];
// 간편결제=L.PAY 카드(롯데카드 즉시할인, 웹 결제비번·폰 불필요 2026-10-06)
const simplePays=['간편결제','카카오페이','네이버페이','토스페이','삼성페이','휴대폰결제','충전결제','퀵계좌이체','온누리상품권'];
// 구매가 만든 주문서 탭(args.tab)으로 먼저 옮긴다 — 주문서 탭이 여럿이면 받는 분을 지정하지 않은 다른 선물…
// 결제하기를 눌러 '이름을 입력해 주세요'로 막혔다(실기 2026-09-30)
if (args.tab && (await tabs.list()).some(t => t.id === String(args.tab))) await tabs.switch(String(args.tab));
// 주문서 탭이 둘 이상이면 배송지가 고른 쪽을 쓴다 — 구매 탭(args.tab)에 '배송지를 선택해 주세요'가 남고…
{ const ot=(await tabs.list()).filter(t=>/orderSheet/.test(t.url||''));
  // 좋은 주문서 = '받는 분 주소로 보내기'가 켜져 있고 '배송지를 선택해 주세요'가 없다(전화번호 모드면 배송지가 없…
  const good=async()=>{const T=String((await page.get({})).tree||'');const r=T.split('\n').find(l=>/radio "받는 분 주소로/.test(l));return !r||(/value="on"/.test(r)&&!/배송지를 선택해 ?주세요/.test(T));};
  if(ot.length>1&&!(await good())){for(const t of ot){await tabs.switch(t.id);await sleep(300);if(await good())break;}}}
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
  // 카카오페이 = 머니 즉시할인을 '할인변경' 창에서 받아야 한다(사용자 2026-09-30): 가장 큰 머니 할인 →…
  // 확인창 '적용하기'. 창은 두 벌이라 번호가 큰 쪽이 살아 있고 전체 목록이 잘려 검색으로 찾는다. 할인이 안 붙으면…
  // 그 밖의 간편결제는 같은 창의 장바구니 쿠폰을 받는다(2026-10-02 선캡 3개: 쿠폰 12,070원을 안 받고…
  const KP=mp==='카카오페이';
  const LC=mp==='간편결제'; // 간편결제 = L.PAY 롯데카드 — 같은 창의 '롯데카드 N% 즉시할인'을 받는다(2026-10-06)
  if(!KP){await page.clickText(mp);await sleep(1500);}
  {
    const Q=async(q,re)=>(await page.get({query:q})).tree.split('\n').filter(l=>re.test(l));
    const hi=ls=>ls.length?Math.max(...ls.map(l=>parseInt(l.slice(1)))):-1;
    const disc=async()=>{const t=(await page.get({query:'주문할인금액'})).tree;const m=(t.split('PAGE TEXT')[1]||t).match(/주문할인금액\s*할인변경\s*(-?[\d,]+)원/);return m?parseInt(m[1].replace(/[,-]/g,''),10):0;};
    if(!(await disc())){
      const hb=await page.idOf('할인변경'); if(hb<0&&KP) return {ok:false,error:'카카오페이 할인변경 버튼 없음'};
      if(hb>=0){await page.click(hb); await sleep(2000);
      const rs=(KP?await Q('카카오페이 머니',/radio "카카오페이 머니\d+%/):LC?await Q('롯데카드',/radio "롯데카드\s*\d+%/):await Q('장바구니',/radio "\d+% ?장바구니 ?쿠폰/)).map(l=>({id:parseInt(l.slice(1)),p:+(l.match(/(\d+)%/)||[])[1],on:/value="on"/.test(l)}));
      const mx=rs.length?Math.max(...rs.map(x=>x.id)):0; const best=rs.filter(r=>r.id>mx-20).sort((a,b)=>b.p-a.p)[0];
      if(!best&&KP) return {ok:false,error:'카카오페이 머니 즉시할인 없음'};
      if(!best&&LC) return {ok:false,error:'롯데카드 즉시할인 없음 — 결제하지 않음'};
      if(!best){const c=hi(await Q('닫기',/button "닫기"/)); if(c>0){await page.click(c); await sleep(600);}}
      else{var want=1; if(!best.on){await page.click(best.id); await sleep(1200);}
      const b=hi(await Q('할인혜택 받기',/button "[\d,]+원 할인혜택 받기"/)); if(b<0) return {ok:false,error:'할인혜택 받기 버튼 없음'};
      await page.click(b); await sleep(2500);
      const ap=hi(await Q('적용하기',/button "적용하기"/)); if(ap>0){await page.click(ap); await sleep(3500);}
      }}
    }
    if((KP||typeof want!=='undefined')&&!(await disc())) return {ok:false,error:(KP?'카카오페이 머니 즉시할인':LC?'롯데카드 즉시할인':'장바구니 쿠폰')+'이 주문서에 안 붙음 — 결제하지 않음'};
  }
  await page.clickText(mp);
  method = mp;
  if(mp==='간편결제'){
    await sleep(1200);
    const want=String(args.easy_card||'롯데카드');
    const rl=(await page.get({query:'L.PAY 카드'})).tree.split('\n').find(l=>/^\[\d+\] radio "L\.PAY 카드"/.test(l));
    if(rl&&!/value="on"/.test(rl)){await page.click(parseInt(rl.slice(1)));await sleep(1200);}
    let sel='';for(let k=0;k<8&&!sel;k++){const P=(String((await page.get({})).tree||'').split('PAGE TEXT')[1]||'').replace(/\s+/g,' ');sel=((P.match(/카드선택 ([^+]{2,30}?) L\.PAY/)||[])[1]||'').trim();if(!sel)await sleep(700);}
    if(!sel.includes(want.replace('카드','')))return {ok:false,error:'L.PAY 카드가 '+want+' 아님: '+(sel||'선택 없음')+' — 결제하지 않음',method};
    method='간편결제/'+sel;
  }
}
await sleep(600);
// 현금영수증은 항상 지출증빙용(사용자 2026-09-29). args.biz_no 가 있으면 번호 칸을 사업자등록번호로…
let receipt=null,after=null;
try{
  const rt=(await page.get({query:'지출증빙용'})).tree;
  const rm=rt.match(/\[(\d+)\] radio "지출증빙용"[^\n]*/);
  if(rm){
    if(!/value="on"/.test(rm[0])){await page.click(parseInt(rm[1]));await sleep(900);}
    receipt='지출증빙용';
    // 번호 칸은 라디오를 누른 뒤 늦게 뜬다(실기 2026-09-29: 바로 읽으면 없음) — 뜰 때까지 기다린다. 전체…
    let tb=null;
    for(let k=0;k<8&&!tb;k++){tb=(await page.get({query:'10자리'})).tree.split('\n').find(l=>/^\[\d+\] textbox "[^"]*10자리/.test(l))||null;if(!tb)await sleep(700);}
    if(!tb)receipt='지출증빙용(번호 칸 못 찾음)';
    // 칸에 다른 번호(소득공제용 휴대폰 번호 등)가 미리 들어 있으면 지우고 사업자등록번호로 바꾼다(실기 2026-09-29)
    const cur=tb?((tb.match(/value="([^"]*)"/)||[])[1]||'').replace(/\D/g,''):'';
    if(tb&&args.biz_no&&cur!==String(args.biz_no)){await page.type(parseInt(tb.slice(1)),String(args.biz_no),true);await sleep(500);receipt='지출증빙용(번호 입력)';}
  }
}catch(e){receipt='확인 실패';}
// 선물 주문서의 '보내는 분 이름'이 비면 결제하기가 '이름을 입력해 주세요'로 막힌다(실기 2026-09-30) —…
try{const st=(await page.get({query:'입력한 이름으로 선물'})).tree.split('\n').find(l=>/^\[\d+\] textbox "입력한 이름으로 선물/.test(l));
  if(st&&!/value="[^"]+"/.test(st)){const hn=((await page.get({query:'님로그아웃'})).tree.match(/([가-힣A-Za-z]{2,10})님\s*로그아웃/)||[])[1];if(hn){await page.type(parseInt(st.slice(1)),hn,false);await sleep(500);}}}catch(e){}
// 선물 주문서는 결제수단·포인트를 바꾸면 '전화번호로 보내기'로 돌아가기도 한다 — 그러면 받는 분 이름 칸이 비어 막…
// '받는 분 주소로 보내기'가 꺼져 있으면 다시 켠다(고른 배송지는 그대로 남는다)
try{const ra=(await page.get({query:'받는 분 주소로 보내기'})).tree.split('\n').find(l=>/^\[\d+\] radio "받는 분 주소로/.test(l));
  if(ra&&!/value="on"/.test(ra)){await page.click(parseInt(ra.slice(1)));await sleep(1500);}}catch(e){}
const payId = await page.idOf('결제하기');
if (payId<0) return {ok:false, error:'결제하기 button not found', method};
await page.click(payId);
await sleep(3000);
// 네이버페이는 같은 탭에서 m.pay.naver.com 으로 넘어가 '동의하고 결제하기' 뒤 비밀번호 키패드가 뜬다(팝…
if (/네이버페이/.test(method)) {
  for (let i = 0; i < 8; i++) { const ag = await page.idOf('동의하고 결제하기'); if (ag >= 0) { await page.click(ag); await sleep(3000); break; } await sleep(1000); }
}
try{const T=String((await page.get({})).tree||'');if(/^URL: [^\n]*orderSheet/.test(T)){const m=T.match(/사업자등록번호[^\n]{0,25}입력해 ?주세요/);if(m)after='주문서에서 막힘: '+m[0];
// 네이버페이는 같은 탭이 pay.naver.com 으로 넘어가야 한다 — 결제하기 뒤에도 주문서면 결제창이 안 열린 것…
// 성공으로 돌려주면 하네스가 주문서에서 키패드를 30초 찾다 멈춘다 — 화면의 안내 문구를 붙여 실패로 돌려준다
else if(/네이버페이/.test(method)){const P=T.split('PAGE TEXT')[1]||'';const g=(P.match(/[^\n.]{0,30}(?:해 ?주세요|하세요|불가|없습니다|초과)[^\n.]{0,10}/)||[''])[0];after='결제하기 뒤에도 주문서(네이버페이 창 안 열림)'+(g?': '+g.trim():'');
}}}catch(e){}
if(after)return{ok:false,error:after,method,receipt};
const tbs = await tabs.list();
const popup = tbs.find(t=>t.kind==='popup');
return { ok:true, method, receipt, popup_url: popup? popup.url : null, keypad_in_tab: /네이버페이/.test(method) };
