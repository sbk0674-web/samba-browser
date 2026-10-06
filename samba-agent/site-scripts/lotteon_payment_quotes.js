
function readCost(tree){
  const idx = tree.indexOf('총 결제금액');
  if (idx<0) return null;
  const seg = tree.slice(idx, idx+400);
  let m = seg.match(/총\d+건\s*([\d,]+)/);
  if (!m) m = seg.match(/할인금액[^0-9]*[-\d,]+원\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g,''),10) : null;
}
async function curCost(){ const s = await page.get({selector:'body'}); return readCost(s.tree); }
async function pickCard(name){
  const lid = await page.idOf('카드선택');
  if (lid < 0) return false;
  await page.click(lid); await sleep(400);
  let cid = await page.idOf(name);
  if (cid < 0) {
    // search-combobox fallback: type into the textbox to filter options
    const s = await page.get({query:'카드선택'});
    const tb = s.tree.match(/\[(\d+)\] textbox "카드선택"/);
    if (tb) {
      await page.type(parseInt(tb[1],10), name, false);
      await sleep(500);
      cid = await page.idOf(name);
    }
  }
  if (cid < 0) return false;
  await page.click(cid); await sleep(700); return true;
}

const list = await tabs.list();
let cands = list.filter(t => t.kind==='tab' && /lotteon\.com/.test(t.url) && /orderSheet\/one\/payments/.test(t.url));
if (!cands.length) cands = list.filter(t => t.kind==='tab' && /lotteon\.com/.test(t.url) && /orderSheet/.test(t.url));
if (!cands.length) return { quotes:[], base_cost:null, note:'no lotteon orderSheet tab open' };
await tabs.switch(cands[cands.length-1].id);
await sleep(300);

let chk = await page.get({selector:'body'});
if (!/결제수단/.test(chk.tree)) return { quotes:[], base_cost:null, note:'payments UI not found on target tab: '+page.url() };

// 간편결제 = L.PAY 카드(롯데카드) — 롯데카드 즉시할인이 붙는 줄(사용자 2026-10-06). 카드는 buyer 가 easy_pay_card 로 채운다
const defMethods = ['간편결제','신용카드','카카오페이','네이버페이','토스페이','삼성페이','휴대폰결제','퀵계좌이체','온누리상품권'];
const methods = (args.methods && args.methods.length) ? args.methods : defMethods;
const defCards = ['롯데카드','신한카드','KB국민카드','삼성카드','현대카드','BC카드','하나카드','씨티카드','우리카드','NH농협카드'];
const cards = (args.cards && args.cards.length) ? args.cards.slice(0,12) : defCards;

let base_cost = null;
for (let i = 0; i < 10 && base_cost == null; i++) { base_cost = await curCost(); if (base_cost == null) await sleep(800); }
if (base_cost == null) return { quotes:[], base_cost:null, note:'total not read on order sheet' };
const quotes = [];
let note = null;

for (const m of methods) {
  const mid = await page.idOf(m);
  if (mid < 0) { quotes.push({method:m, card:null, cost:null}); continue; }
  await page.click(mid); await sleep(800);
  if (m === '신용카드') {
    for (const c of cards) {
      const ok = await pickCard(c);
      quotes.push({method:m, card:c, cost: ok ? await curCost() : null});
    }
  } else if (m === '간편결제') {
    // L.PAY 카드 = 롯데카드 한 줄 — 카드선택에서 골라야 즉시할인이 금액에 반영된다
    const ok = await pickCard('롯데카드');
    quotes.push({method:m, card: ok ? '롯데카드' : null, cost: ok ? await curCost() : null});
  } else {
    quotes.push({method:m, card:null, cost: await curCost()});
  }
}

const rid = await page.idOf('신용카드');
if (rid >= 0) {
  await page.click(rid); await sleep(800);
  const restored = await pickCard('롯데카드');
  if (!restored) note = 'restore to 롯데카드 failed, please check manually';
}

// 카카오페이 머니 즉시할인(사용자 2026-09-30: 모든 결제수단 비교) — 결제수단을 누르는 것만으로는 반영되지 않고 '할인변경' 창에서
// 받아야 한다. 견적은 창의 'N원 할인혜택 받기'(가장 큰 머니 할인)만 읽고 적용하지 않은 채 닫는다. 적용은 결제 진입(checkout)이 한다.
// 창은 두 벌이 그려져 뒤쪽(번호가 큰 쪽)이 살아 있고, 전체 목록이 잘려 검색으로 찾는다(실기 2026-09-30)
try{
  const Q=async(q,re)=>{const x=(await page.get({query:q})).tree.split('\n').filter(l=>re.test(l));return x;};
  const hb=await page.idOf('할인변경');
  if(hb>=0){
    await page.click(hb);await sleep(2000);
    const rs=(await Q('카카오페이 머니',/radio "카카오페이 머니\d+%/)).map(l=>({id:parseInt(l.slice(1)),p:+(l.match(/머니(\d+)%/)||[])[1],on:/value="on"/.test(l)}));
    const mx=rs.length?Math.max(...rs.map(x=>x.id)):0;
    const best=rs.filter(r=>r.id>mx-20).sort((a,b)=>b.p-a.p)[0];
    if(best&&!best.on){await page.click(best.id);await sleep(1200);}
    const bl=(await Q('할인혜택 받기',/button "[\d,]+원 할인혜택 받기"/)).sort((a,b)=>parseInt(b.slice(1))-parseInt(a.slice(1)))[0];
    const amt=bl?parseInt((bl.match(/"([\d,]+)원/)||[])[1].replace(/,/g,''),10):0;
    if(best&&amt>0)quotes.push({method:'카카오페이',card:null,cost:base_cost-amt,discount:'카카오페이 머니'+best.p+'% 즉시할인'});
    // 장바구니 쿠폰(결제수단과 무관한 주문할인, 2026-10-02): 고르면 버튼 금액이 그 쿠폰 금액으로 바뀐다 — 읽기만 하고 닫는다
    const cs=(await Q('장바구니',/radio "\d+% ?장바구니 ?쿠폰/)).map(l=>parseInt(l.slice(1)));
    if(cs.length){await page.click(Math.max(...cs));await sleep(1200);
      const cb=(await Q('할인혜택 받기',/button "[\d,]+원 할인혜택 받기"/)).sort((a,b)=>parseInt(b.slice(1))-parseInt(a.slice(1)))[0];
      const ca=cb?parseInt((cb.match(/"([\d,]+)원/)||[])[1].replace(/,/g,''),10):0;
      if(ca>0)for(const q of quotes)if(q.cost!=null&&q.method!=='카카오페이'){q.cost-=ca;q.discount='장바구니 쿠폰';}
    }
    const cl=(await Q('닫기',/button "닫기"/)).map(l=>parseInt(l.slice(1))).sort((a,b)=>b-a);
    for(const c of cl.slice(0,2)){await page.click(c);await sleep(400);}
  }
}catch(e){note=(note?note+' / ':'')+'카카오페이 머니 견적 실패: '+String(e).slice(0,60);}

return { quotes, base_cost, note };
