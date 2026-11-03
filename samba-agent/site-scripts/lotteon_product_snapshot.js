const so=t=>/\[품절\]|\s품절$/.test(t);
const cl=t=>t.replace(/\(?\s*품절임박\s*\)?/g,'').replace(/\d+\s*개\s*남음/g,'').replace(/\[?품절\]?/g,'').replace(/\s(\d{1,3},\d{3}|\d{4,})(?=\s|$)/g,' ').replace(/\s+/g,' ').trim();
const nm=s=>s.toLowerCase().replace(/[\s()·\-\/,]/g,'');const bz=k=>k.replace(/\([^)]*\)/g,'');const TK=s=>String(s||'').split(/[\s·]+/).filter(Boolean);
const WF=/화이트|white|아이보리|크림/i;const SM={xs:'080',s:'085',m:'090',l:'095',xl:'100',xxl:'105'};
const CODE=k=>/^(?=.*\d)(?=.*[A-Za-z])\w{5,}$/.test(k);
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?/);if(m)o.push({id:parseInt(m[1]),role:m[2],text:m[3]||''});}return o;}
const gr=async s=>pe((await page.get({selector:s})).tree);
function sc(ov,size){const t=String(size||'').trim();const o=cl(ov);if(!t||!o)return 0;if(nm(o)===nm(t))return 100;const toks=TK(t);
for(const k of toks)if(nm(k)===nm(o)||nm(bz(k))===nm(o))return 90;
const ob=o.match(/\(([^)]+)\)/);if(ob)for(const k of toks)if(nm(k)===nm(ob[1]))return 85;
for(const k of toks)if(k.length>1&&nm(k)&&!/^(x{0,3}[sml]|free)$/i.test(k)&&(nm(o).includes(nm(k))||nm(k).includes(nm(o))))return 70;
const on=o.match(/\d+/);if(on)for(const k of toks){if(/[가-힣]/.test(k))continue;const kn=k.match(/\d+/);if(kn&&kn[0]===on[0])return 60;}
return 0;}
const wf=async(txt,ms)=>{try{await page.waitFor(txt,ms);}catch{await sleep(800);}};
const tx=async q=>{try{return (await page.get({query:q})).tree;}catch{return '';}};
const tl=()=>tabs.list();const sku=args.sku;
const r={options:[],already_ordered:false,coupons:{},methods:[],cost:null,margin_pct:null,product_url:null,account:null,selected:null,note:null};
const bt=String(args.gift)==='true'?'선물하기':'바로 구매하기';const PF=args.profile?{profile:args.profile}:{};const ERR=/서버 오류|접속이 원활하지/;
const SW=async(re,f)=>{for(let i=0;i<15&&!re.test(await page.url());i++){const t=(await tl()).find(f);if(t)return tabs.switch(t.id);await sleep(1e3)}};
const AK=()=>r.account||args.account||'현재 로그인 계정';
if(sku?.startsWith?.('http')){
if(args.entry_url){await tabs.open({...PF,url:args.entry_url});
for(let i=0;i<20&&!/lotteon\.com/.test(await page.url());i++)await sleep(1e3);}
for(let a=0;a<4;a++){
await tabs.open({...PF,url:sku});await SW(/\/p\/product\//,x=>(x.url||'').includes(sku)&&!ERR.test(x.title||''));await wf(bt,9000);
const hh=await tx('판매자');
if(!ERR.test(hh)&&hh.includes('구매하기'))break;
await sleep(3000);}
}else{
await tabs.open({...PF,url:`https://www.lotteon.com/csearch/search/search?render=search&q=${encodeURIComponent(sku)}`});
await wf('상품',8000);
const e=(await gr('a[href*="/p/product"]')).find(x=>x.role==='link');
if(!e)return{...r,error:'product-not-found'};
await page.click(e.id);await wf('바로 구매하기',8000);
}
r.product_url=await page.url();
for(let k=0;k<8&&!r.seller;k++){const st=await tx('판매자');for(const m of st.matchAll(/(?<!다른\s?)판매자\s*:?\s*([가-힣A-Za-z][가-힣A-Za-z0-9()]{1,19})/g)){if(!/^(서비스|가|에게|정보|센터)/.test(m[1])){r.seller=m[1];break;}}if(!r.seller)await sleep(1500);}
if(args.required_seller&&(!r.seller||!r.seller.includes(args.required_seller))){r.coupons[AK()]=0;return{...r,error:r.seller?'seller-not-allowed':'seller-read-failed',note:r.seller||null};}
const am=(await tx('님')).match(/([\w가-힣*]{2,20})\s*님/);r.account=(am&&am[1])||args.account||null;
let picked=[],pc=true,sg=false,pw=null,cs=false,fb=false;const seen=new Set();const NO='option not matched: ';
const wc=/[가-힣]{2,}|[A-Za-z]{3,}/.test(String(args.size||'').replace(/옵션\d*|사이즈|색상|컬러|선택|FREE|ONE ?SIZE|X{2,}L|X{2,}S/gi,' '));
for(let step=0;step<5;step++){
let combos=[];
for(let w=0;w<6&&!combos.length;w++){combos=await gr('[role="combobox"]');if(!combos.length)await sleep(700);}
const lab=c=>c.text.split(',')[0].trim();const cand=combos.filter(c=>!seen.has(lab(c)));
if(!cand.length)break;
const combo=cand[0];seen.add(lab(combo));
await page.click(combo.id);await sleep(500);
let opts=[];
for(let w=0;w<4&&!opts.length;w++){opts=await gr('[role="option"]');if(!opts.length)await sleep(600);}
if(!opts.length)break;
r.options=opts.map(o=>o.text);
const lA=opts.filter(o=>!so(o.text)),live=lA.filter((o,i)=>lA.findIndex(p=>cl(p.text)===cl(o.text))===i);
let m=null;
if(args.size){let best=0;for(const o of live){const s=sc(o.text,args.size);if(s>best){best=s;m=o;}}}
if(args.size&&!m&&opts.some(o=>so(o.text)&&sc(o.text,args.size)>=85)){r.note='size not available (sold out)';pc=false;break;}
const isCol=/색상|컬러|color/i.test(lab(combo));
if(isCol)cs=true;
if(!m&&live.length===1&&(!(wc&&isCol)||!/[가-힣]{2,}|[A-Za-z]{3,}/.test(cl(live[0].text)))){m=live[0];fb=true;}
if(!m&&isCol&&live.length===1&&(opts.length===lA.length||WF.test(cl(live[0].text))&&WF.test(args.size||'')))m=live[0];
if(!m&&wc&&isCol){r.note=NO+'색상';pc=false;break;}
if(!m&&!args.size)m=live[0];
if(m){picked.push(cl(m.text));pw=m.text;await page.click(m.id);await sleep(700);}
else{r.note='size not available';pc=false;break;}
}
if(pc&&!picked.length&&!r.options.length){
const sp=(await tx('색상')).match(/색상\s+(.+?)\s+(?:크기|사이즈)\s+(\S+)/);
if(sp){const c=sp[1],z=sp[2],fr=/^(free|one|onesize)$/i;
r.options=[c+' '+z,c,z];
if(!TK(args.size).every(k=>CODE(k)||nm(c).includes(nm(k))||nm(k).includes(nm(c))||nm(k)===nm(z)||(fr.test(k)&&fr.test(z)))){r.note=NO+c+' '+z;pc=false;}
else{sg=c+' '+z;if(args.size)r.options.push(args.size);}}}
if(!pc){r.coupons[AK()]=0;return r;}
const bs=pe((await page.get({query:bt})).tree).filter(x=>nm(x.text)===nm(bt)&&/button|clickable/.test(x.role));
if(!bs.length){r.note='no buy btn';return r;}
const before=new Set((await tl()).map(t=>t.id));
await page.click(bs[0].id);
for(let i=0;i<20;i++){
if(/orderSheet/.test(await page.url()))break;
const nt=(await tl()).find(t=>!before.has(t.id)&&/orderSheet/.test(t.url||''));
if(nt){await tabs.switch(nt.id);break;}
await sleep(1e3);}
for(let i=0;i<10;i++){
const g=await tx('계속하기');
if(/총 결제금액/.test(g)&&/수량\s*\d/.test(g))break;
const cb=pe(g).filter(x=>nm(x.text)==='계속하기'&&x.role==='button');
if(cb.length&&/배송\/픽업 선택|택배배송받기/.test(g)){await page.click(cb[0].id);await sleep(1500);}
else await sleep(1e3);
}
await wf('총 결제금액',12000);
let T='';
for(let i=0;i<8;i++){T=(await tx('결제수단')).replace(/\s+/g,' ');if(/총 결제금액/.test(T)&&/수량\s*\d/.test(T)&&/카카오페이|토스페이/.test(T))break;await sleep(1200);}
const num=s=>parseInt(String(s).replace(/,/g,''),10);
const tm=T.match(/총 결제금액[\s\S]*?총\s*\d+건\s*([\d,]+)/)||T.match(/총 결제금액[\s\S]*?([\d,]{4,})/);
if(tm)r.cost=num(tm[1]);
const dm=T.match(/주문할인금액\s*(?:할인변경)?\s*-?([\d,]+)원/);
r.coupons[AK()]=dm?num(dm[1]):0;
r.methods=['신용카드','퀵계좌이체','카카오페이','네이버페이','토스페이','삼성페이','온누리상품권','L.PAY','페이코','무신사머니','무신사페이'].filter(k=>T.includes(k));
const pm=T.match(/상품정보\s*(?:\(\d+개\))?\s*(?:상품정보 열기\/닫기)?\s*([\s\S]*?)\s수량\s*\d/);
if(pm){let ln=pm[1].replace(/^[\s\S]*배송비\s*(?:무료|[\d,]+원)\s*/,'').trim();
const ks=picked.concat(sg?[sg]:[]).filter(k=>k&&ln.includes(k));
if(ks.length){const st=Math.min(...ks.map(k=>ln.lastIndexOf(k)));ln=ln.slice(st);}
r.selected=ln||null;
if(ln&&args.size){const toks=TK(args.size),nlz=nm(ln);
const okTok=toks.filter(k=>{const n=nm(k),kb=nm(bz(k));if(!n||nlz.includes(n)||kb&&nlz.includes(kb))return true;return [k.replace(/\D/g,''),SM[k.toLowerCase()]].filter(Boolean).some(d=>new RegExp('(^|\\D)0*'+d+'(\\D|$)').test(ln));});
const fine=toks.every(k=>/^(kr|eu|us|uk|free|one|onesize)$/i.test(k)||CODE(k)||okTok.includes(k)||(!cs&&!SM[k.toLowerCase()]));
if((fine&&okTok.length)||(fb&&ln.includes(picked.at(-1)))){if(!nm(ln).includes(nm(args.size)))r.selected=ln+' ('+args.size+')';
if(pw&&!r.options.some(o=>nm(o).includes(nm(args.size))))r.options=r.options.map(o=>o===pw?args.size+' '+o:o);}}}
if(r.cost==null)r.note='cost not read';
return r;