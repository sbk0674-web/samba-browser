function readCost(tree){
  const idx = tree.indexOf('총 결제금액');
  if (idx<0) return null;
  const seg = tree.slice(idx, idx+400);
  let m = seg.match(/총\d+건\s*([\d,]+)/);
  if (!m) m = seg.match(/할인금액[^0-9]*[-\d,]+원\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g,''),10) : null;
}
async function curCost(){ const s = await page.get({selector:'body'}); return readCost(s.tree); }
async function findOpt(name){
  const s = await page.get({query:name});
  const l = s.tree.split('\n').find(x=>/^\[\d+\] (option|listitem|clickable|button|link) /.test(x) && x.includes(name) && !/본문 바로가기/.test(x));
  return l ? parseInt(l.slice(1),10) : -1;
}
async function pickCard(name){
  let cid = -1;
  for (const open of ['textbox','label']) {
    const s = await page.get({query:'카드'});
    const re = open==='textbox' ? /^\[(\d+)\] textbox "카드(를 선택|선택)/ : /^\[(\d+)\] label "카드선택"/;
    const l = s.tree.split('\n').find(x=>re.test(x));
    if (!l) continue;
    await page.click(parseInt(l.slice(1),10)); await sleep(600);
    cid = await findOpt(name);
    if (cid >= 0) break;
  }
  if (cid < 0) {
    const s = await page.get({query:'카드선택'});
    const tb = s.tree.match(/\[(\d+)\] textbox "카드/);
    if (tb) { await page.type(parseInt(tb[1],10), name, false); await sleep(500); cid = await findOpt(name); }
  }
  if (cid < 0) return false;
  await page.click(cid); await sleep(900); return true;
}

const list = await tabs.list();
let cands = list.filter(t => t.kind==='tab' && /lotteon\.com/.test(t.url) && /orderSheet\/one\/payments/.test(t.url));
if (!cands.length) cands = list.filter(t => t.kind==='tab' && /lotteon\.com/.test(t.url) && /orderSheet/.test(t.url));
if (!cands.length) return { quotes:[], base_cost:null, note:'no lotteon orderSheet tab open' };
await tabs.switch(cands[cands.length-1].id);
await sleep(300);

let chk = await page.get({selector:'body'});
if (!/결제수단/.test(chk.tree)) return { quotes:[], base_cost:null, note:'payments UI not found on target tab: '+page.url() };

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
    const rl = (await page.get({query:'L.PAY 카드'})).tree.split('\n').find(l=>/^\[\d+\] radio "L\.PAY 카드"/.test(l));
    if (rl && !/value="on"/.test(rl)) { await page.click(parseInt(rl.slice(1))); await sleep(1200); }
    const P0 = (String((await page.get({})).tree||'').split('PAGE TEXT')[1]||'').replace(/\s+/g,' ');
    const cur = ((P0.match(/카드선택 ([^+]{2,30}?) L\.PAY/)||[])[1]||'').trim();
    const ok = cur.includes('롯데') ? true : await pickCard('롯데카드');
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

try{
  const Q=async(q,re)=>{const x=(await page.get({query:q})).tree.split('\n').filter(l=>re.test(l));return x;};
  const BR=/button "[\d,]+원 할인혜택 받기"/;
  const amtOf=async()=>{const bl=(await Q('할인혜택 받기',BR)).sort((a,b)=>parseInt(b.slice(1))-parseInt(a.slice(1)))[0];return bl?parseInt((bl.match(/"([\d,]+)원/)||[])[1].replace(/,/g,''),10):0;};
  const hb=await page.idOf('할인변경');
  if(hb>=0){
    await page.click(hb);await sleep(2000);
    // 카카오페이 머니 견적 금지 — 사용자는 카카오머니를 안 쓴다(머니 결제요청이 가서 취소, 사용자 2026-11-11)
    // 카카오페이 카드 즉시할인 + 현대카드 청구할인(2.7%)이 롯데카드(즉시할인+2%)보다 쌀 수 있다(사용자 2026-11-04)
    const kc=(await Q('카카오페이 카드',/radio "카카오페이 카드\s*\d+%/)).map(l=>({id:parseInt(l.slice(1)),p:+(l.match(/카드\s*(\d+)%/)||[])[1],on:/value="on"/.test(l)}));
    const kmx=kc.length?Math.max(...kc.map(x=>x.id)):0;
    // 7% 칸은 조건 제한으로 눌러도 안 켜질 때가 있다 — 큰 것부터 일반 클릭으로 눌러 실제 켜진 칸으로 견적한다
    // (실기 2026-11-10 진단: 카드7% 안 켜짐·5% 켜짐, 진짜 마우스 클릭은 'click not sent' — 7% 로 잘못 견적해 원가가 1,980원 낮았다)
    const kOn=async id=>(await Q('카카오페이 카드',/radio "카카오페이 카드/)).some(l=>parseInt(l.slice(1))===id&&/value="on"/.test(l));
    let kbest=null;
    for(const r of kc.filter(r=>r.id>kmx-20).sort((a,b)=>b.p-a.p)){if(!r.on){await page.click(r.id);await sleep(1200);}if(await kOn(r.id)){kbest=r;break;}}
    if(kbest){
      const kamt=await amtOf();
      if(kamt>0)quotes.push({method:'카카오페이',card:'현대카드',cost:base_cost-kamt,discount:'카카오페이 카드'+kbest.p+'% 즉시할인',kakao_card:true});}
    const lr=(await Q('롯데카드',/radio "롯데카드\s*\d+%/)).map(l=>({id:parseInt(l.slice(1)),p:+(l.match(/롯데카드\s*(\d+)%/)||[])[1],on:/value="on"/.test(l)}));
    const lmx=lr.length?Math.max(...lr.map(x=>x.id)):0;
    const lbest=lr.filter(r=>r.id>lmx-20).sort((a,b)=>b.p-a.p)[0];
    if(lbest){
      let lamt=0;
      // 오래된 창이 남아 있을 수 있어 lbest.id 줄만 보고 켜짐 판단. 라벨(id+1) 클릭이 라디오를 켠다
      const isOn=async()=>{const ls=await Q('롯데카드',/radio "롯데카드\s*\d+%/);const l=ls.find(x=>parseInt(x.slice(1))===lbest.id);return !!l&&/value="on"/.test(l);};
      for(const tid of [lbest.id+1,lbest.id]){
        if(await isOn())break;
        await page.click(tid);await sleep(1200);
      }
      if(await isOn())lamt=await amtOf();
      if(lamt>0){
        for(let i=quotes.length-1;i>=0;i--)if(quotes[i].method==='간편결제')quotes.splice(i,1);
        quotes.push({method:'간편결제',card:'롯데카드',cost:base_cost-lamt,discount:'롯데카드 '+lbest.p+'% 즉시할인'});
      }
    }
    const cs=(await Q('장바구니',/radio "\d+% ?장바구니 ?쿠폰/)).map(l=>parseInt(l.slice(1)));
    if(cs.length){await page.clickNative(Math.max(...cs));await sleep(1200);
      const ca=await amtOf();
      // 할인창은 '1개만 선택' — 카드 즉시할인(롯데카드·카카오페이)과 장바구니 쿠폰은 겹치지 않는다(실기 2026-11-07 롯데온 노스페이스:
      // 롯데카드 10%+쿠폰 15% 를 겹쳐 91,414 로 잘못 견적 → L.PAY 가 골라짐). 즉시할인이 없는 수단에만 쿠폰을 뺀다
      if(ca>0)for(const q of quotes)if(q.cost!=null&&q.method!=='카카오페이'&&!q.discount){q.cost-=ca;q.discount='장바구니 쿠폰';}
    }
    const cl=(await Q('닫기',/button "닫기"/)).map(l=>parseInt(l.slice(1))).sort((a,b)=>b-a);
    for(const c of cl.slice(0,2)){await page.click(c);await sleep(400);}
  }
}catch(e){note=(note?note+' / ':'')+'카카오페이 머니 견적 실패: '+String(e).slice(0,60);}

return { quotes, base_cost, note };