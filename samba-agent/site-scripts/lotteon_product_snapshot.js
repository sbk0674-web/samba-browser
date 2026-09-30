const so=t=>/\[품절\]|\s품절$/.test(t);
const cl=t=>t.replace(/\[품절\]/g,'').replace(/\(?\s*품절임박\s*\)?/g,'').replace(/\d+\s*개\s*남음/g,'').replace(/품절/g,'').replace(/\s\d{1,3},\d{3}(?=\s|$)/g,' ').replace(/\s\d{4,}(?=\s|$)/g,' ').replace(/\s+/g,' ').trim();
const nm=s=>s.toLowerCase().replace(/[\s()·\-\/,]/g,'');
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?/);if(m)o.push({id:parseInt(m[1]),role:m[2],text:m[3]||''});}return o;}
function sc(ov,size){const t=String(size||'').trim();const o=cl(ov);if(!t||!o)return 0;
 if(nm(o)===nm(t))return 100;const toks=t.split(/[\s·]+/).filter(Boolean);
 for(const k of toks)if(nm(k)===nm(o))return 90;
 const ob=o.match(/\(([^)]+)\)/);if(ob)for(const k of toks)if(nm(k)===nm(ob[1]))return 85;
 for(const k of toks)if(k.length>1&&nm(k)&&!/^(x{0,3}[sml]|xxl|xxxl|free)$/i.test(k)&&(nm(o).includes(nm(k))||nm(k).includes(nm(o))))return 70-Math.abs(o.length-k.length);
 const on=o.match(/\d+/);if(on)for(const k of toks){const kn=k.match(/\d+/);if(kn&&kn[0]===on[0])return 60;}
 return 0;}
const wf=async(txt,ms)=>{try{await page.waitFor(txt,ms||8000);}catch(e){await sleep(800);}};
const tx=async q=>{try{return (await page.get({query:q})).tree;}catch(e){return '';}};
// 글자로 버튼 찾아 누르기(해당 글자로 별도 조회해야 목록에 나옴)
const clickLabel=async re=>{const t=await tx(re.source.replace(/[\\^$()|?]/g,''));const b=pe(t).find(x=>re.test(x.text));if(b){await page.click(b.id);return true;}return false;};

const sku=args.sku;
const r={options:[],already_ordered:false,coupons:{},methods:[],cost:null,margin_pct:null,product_url:null,account:null,selected:null,note:null};
const gift=args.gift===true||args.gift==='true';
const bt=gift?'선물하기':'바로 구매하기';
if(typeof sku==='string'&&sku.startsWith('http')){
  if(args.entry_url){
    // 샵백 적립 경유(사용자 2026-09-27): 추적 링크로 롯데온에 먼저 들어간 뒤 같은 탭에서 상품으로 간다
    await tabs.open({...(args.profile?{profile:args.profile}:{}),url:String(args.entry_url)});
    for(let i=0;i<20&&!/lotteon\.com/.test(await page.url());i++)await sleep(1000);
    r.entry_landed=/lotteon\.com/.test(await page.url());
    await tabs.open({...(args.profile?{profile:args.profile}:{}),url:sku});
  }else await tabs.open({...(args.profile?{profile:args.profile}:{}),url:sku});
  await wf(bt,9000);
}else{
  await tabs.open({...(args.profile?{profile:args.profile}:{}),url:`https://www.lotteon.com/csearch/search/search?render=search&platform=pc&q=${encodeURIComponent(sku)}&sort=ranking`});
  await wf('상품',8000);
  let g=await page.get({selector:'a[href*="/p/product"]'});
  let e=pe(g.tree).find(x=>x.role==='link');
  if(!e)return{...r,error:'product-not-found'};
  await page.click(e.id);await wf('바로 구매하기',8000);
}
r.product_url=await page.url();
// 상품명(TITLE) — 결제 직전 주문서 대조가 포이즌 번역명 대신 이 이름으로도 본다(실기 2026-09-30 웜 캡↔트래퍼햇)
r.product_name=(((await tx('판매가')).match(/^TITLE: (.*)$/m)||[])[1]||'').replace(/\s*:\s*롯데.*$/,'').trim()||null;
r.seller=null;for(let k=0;k<8&&!r.seller;k++){const st=await tx('판매자');for(const m of st.matchAll(/(?<!다른\s?)판매자\s*:?\s*([가-힣A-Za-z][가-힣A-Za-z0-9()]{1,19})/g)){if(!/^(서비스|가|에게|정보|센터)/.test(m[1])){r.seller=m[1].trim();break;}}if(!r.seller)await sleep(1500);}
if(args.required_seller&&!(r.seller||'').includes(String(args.required_seller))){r.coupons[r.account||args.account||'현재 로그인 계정']=0;return{...r,error:'seller-not-allowed',note:'판매자 '+(r.seller||'?')+' — '+args.required_seller+' 아님'};}
try{let am=(await tx('님')).match(/([\w가-힣*]{2,20})\s*님/);r.account=(am&&am[1])||args.account||null;}catch(e){r.account=args.account||null;}

let picked=[],proceed=true;const seen=new Set();
const wantsColor=/[가-힣]{2,}|[A-Za-z]{3,}/.test(String(args.size||'').replace(/옵션\d*|사이즈|색상|컬러|선택|FREE|ONE ?SIZE|X{2,}L|X{2,}S/gi,' '));
for(let step=0;step<5;step++){
  let combos=[];
  for(let w=0;w<6&&!combos.length;w++){let g=await page.get({selector:'[role="combobox"], select'});combos=pe(g.tree).filter(x=>x.role==='combobox');if(!combos.length)await sleep(700);}
  const lab=c=>c.text.split(',')[0].trim();
  const cand=combos.filter(c=>!seen.has(lab(c)));
  if(!cand.length)break;
  const combo=cand[0];seen.add(lab(combo));
  await page.click(combo.id);await sleep(500);
  let opts=[];
  for(let w=0;w<4&&!opts.length;w++){let g2=await page.get({selector:'[role="listbox"], [role="option"]'});opts=pe(g2.tree).filter(x=>x.role==='option');if(!opts.length)await sleep(600);}
  if(!opts.length)break;
  r.options=opts.map(o=>o.text);
  const live=opts.filter(o=>!so(o.text));
  let m=null;
  if(args.size){let best=0;for(const o of live){const s=sc(o.text,args.size);if(s>best){best=s;m=o;}}}
  // 색상이 하나뿐이고 이름이 품번 코드('108542_01')면 그것을 고른다 — 색 글자가 없어 주문 색과 대조할 수 없다(실기 09-30 푸마)
  if(!m&&live.length===1&&(!(wantsColor&&/색상|컬러|color/i.test(lab(combo)))||!/[가-힣]{2,}|[A-Za-z]{3,}/.test(cl(live[0].text))))m=live[0];
  if(!m&&wantsColor&&/색상|컬러|color/i.test(lab(combo))){r.options=opts.map(o=>o.text);r.note='option not matched: 색상 — 주문 옵션과 맞는 색상이 없다';proceed=false;break;}
  if(!m&&!args.size)m=live[0];
  if(m){picked.push(cl(m.text));await page.click(m.id);await sleep(700);}
  // 품절 항목도 돌려준다 — 빼면 주문 사이즈가 '[품절] 255' 여도 '품절 미확인'이 된다(실기 2026-09-30)
  else{r.options=opts.map(o=>o.text);r.note='size not available';proceed=false;break;}
}
if(!proceed){r.coupons[r.account||args.account||'현재 로그인 계정']=0;return r;}

// 수량: 주문 수량까지 증가/감소(값을 보며)
const WQ=Math.max(1,+args.qty||1);for(let k=0,lv=0;k<24&&WQ>1;k++){const qt=await tx('수량');const sv=(qt.match(/spinbutton "[^"]*" value="(\d+)"/)||[])[1];if(!sv){await sleep(500);continue}const v=+sv;if(v===WQ)break;if(v===lv){await sleep(300);continue}lv=v;const b=pe(qt).find(x=>x.text===(v<WQ?'수량 증가':'수량 감소'));if(!b)break;await page.click(b.id);await sleep(300)}
let bg=await tx(bt);
let bb=gift?pe(bg).find(x=>/^선물하기$/.test(x.text)):(pe(bg).find(x=>x.text==='바로 구매하기')||pe(bg).find(x=>/^(바로구매|구매하기)$/.test(x.text)));
r.gift=gift;
if(!bb){r.coupons[r.account||args.account||'현재 로그인 계정']=0;return{...r,error:picked.length?'buy-button-not-found':'all-options-soldout'};}
await page.click(bb.id);
await wf('배송',8000);
let t='';
for(let i=0;i<12;i++){
  t=await tx('결제');
  if(/결제수단/.test(t)&&/총\s*\d+\s*건|총\s*결제\s*금액/.test(t))break;
  let moved=await clickLabel(/^계속하기$/);
  if(!moved)moved=await clickLabel(/^(다음 단계|주문하기)$/);
  if(moved)await wf('결제수단',6000);else await sleep(800);
}
const mn=['신용카드','휴대폰결제','충전결제','퀵계좌이체','카카오페이','네이버페이','토스페이','삼성페이','온누리상품권','간편결제'];
r.methods=mn.filter(m=>t.includes(m));
for(let i=0;i<6&&!r.methods.includes('네이버페이');i++){await sleep(1000);t=await tx('결제');r.methods=mn.filter(m=>t.includes(m));}
if(!r.methods.includes('네이버페이')){r.methods=[...new Set([...r.methods,'신용카드','네이버페이','카카오페이','토스페이'])];r.note='결제수단 목록을 다 못 읽어 롯데온 기본 수단으로 채움';}
const cm=t.match(/쿠폰[^\d]{0,20}?(-?[\d,]+)\s*원/);
r.coupons[r.account||args.account||'현재 로그인 계정']=cm?parseInt(cm[1].replace(/,/g,'')):0;
let com=t.match(/총\s*\d+\s*건\s*([\d,]{3,})/);
if(!com)com=t.match(/총\s*결제\s*금액[\s\S]{0,120}?([\d,]{3,})\s*원?/);
if(!com)com=t.match(/결제\s*예정\s*금액[\s\S]{0,60}?([\d,]{3,})\s*원/);
if(com)r.cost=parseInt(com[1].replace(/,/g,''));
let om=t.match(/([^\s]+(?:\s*\/\s*[^\s]+)+)\s*(?:수량|\d+\s*개)\s*\d/);
if(!om)om=t.match(/옵션\s*:?\s*([^\n]{1,40}?)\s*(?:수량|\d+\s*개)/);
if(om)r.selected=om[1].trim();
else if(picked.length)r.selected=picked.join(' / ');
const qm=t.match(/수량\s*:?\s*(\d+)\s*개?/);r.qty=qm?+qm[1]:null;
r.order_tab=((await tabs.list()).find(x=>/orderSheet/.test(x.url||''))||{}).id||null;
return r;