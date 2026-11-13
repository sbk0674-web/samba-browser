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

const unsupported=[];
try{
  const Q=async(q,re)=>{const x=(await page.get({query:q})).tree.split('\n').filter(l=>re.test(l));return x;};
  const BR=/button "[\d,]+원 할인혜택 받기"/;
  const amtOf=async()=>{const bl=(await Q('할인혜택 받기',BR)).sort((a,b)=>parseInt(b.slice(1))-parseInt(a.slice(1)))[0];return bl?parseInt((bl.match(/"([\d,]+)원/)||[])[1].replace(/,/g,''),10):0;};
  const hb=await page.idOf('할인변경');
  if(hb>=0){
    await page.click(hb);await sleep(2000);
    // 할인 줄은 화면 글자('○○ N% 즉시할인 -금액원')를 그대로 읽는다 — 칸을 눌러 보고 켜진 것만 믿다가 10%를 5%로 견적했다
    // (사용자 2026-11-13: 롯데온 할인은 매번 바뀐다). 어떤 수단이든 줄이 있으면 전부 읽는다
    const X=(String((await page.get({query:'즉시할인'})).tree||'').split('PAGE TEXT')[1]||'').replace(/\s+/g,' ');
    const RW={};
    for(const m of X.matchAll(/([가-힣A-Za-z.]{2,12}(?: ?(?:카드|머니))?) ?(\d+)% ?즉시할인 ?(?:자세히 ?)?-([0-9,]+) ?원/g)){
      const n=m[1].replace(/\s/g,''),a=parseInt(m[3].replace(/,/g,''),10);if(a>0&&(!RW[n]||a>RW[n].a))RW[n]={a,p:+m[2]};}
    const MAP={'롯데카드':['간편결제','롯데카드'],'카카오페이카드':['카카오페이','현대카드'],'카카오페이머니':['카카오페이',null]};
    for(const n in RW){
      const mp=MAP[n],r=RW[n];
      if(n==='카카오페이머니'&&args.no_kakao_money)continue;
      if(!mp){unsupported.push({name:n,percent:r.p,amount:r.a});continue;}
      if(mp[0]==='간편결제')for(let i=quotes.length-1;i>=0;i--)if(quotes[i].method==='간편결제')quotes.splice(i,1);
      quotes.push({method:mp[0],card:mp[1],cost:base_cost-r.a,discount:n+r.p+'% 즉시할인',...(n==='카카오페이카드'?{kakao_card:true}:{})});
    }
    const cs=(await Q('장바구니',/radio "\d+% ?장바구니 ?쿠폰/)).map(l=>parseInt(l.slice(1)));
    if(cs.length){await page.clickNative(Math.max(...cs));await sleep(1200);
      const ca=await amtOf();
      // 할인창은 '1개만 선택' — 카드 즉시할인과 장바구니 쿠폰은 겹치지 않는다(2026-11-07). 즉시할인이 없는 수단에만 쿠폰을 뺀다
      if(ca>0)for(const q of quotes)if(q.cost!=null&&q.method!=='카카오페이'&&!q.discount){q.cost-=ca;q.discount='장바구니 쿠폰';}
    }
    const cl=(await Q('닫기',/button "닫기"/)).map(l=>parseInt(l.slice(1))).sort((a,b)=>b-a);
    for(const c of cl.slice(0,2)){await page.click(c);await sleep(400);}
  }
}catch(e){note=(note?note+' / ':'')+'할인 견적 실패: '+String(e).slice(0,60);}

return { quotes, base_cost, note, unsupported };
