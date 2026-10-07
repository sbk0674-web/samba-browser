const nz=s=>String(s||'').replace(/\s+/g,' ').trim()
const lc=s=>nz(s).toLowerCase()
const nsl=s=>lc(s).replace(/\s*\/\s*/g,'/')
const OF=/musinsa\.com\/order\/order-form/
const IT='[class*=dropdown] [data-button-name]:not(button)'
const notes=[]
const O={options:[],color:null,selected:null,cost:null,methods:[],coupons:{},sold_out:false}
const done=n=>{if(n)notes.push(n);O.note=notes.join('; ')||null;return O}
const lines=t=>t.split('PAGE TEXT')[0].split('\n').filter(l=>/^\[\d+\]/.test(l))
const textOf=t=>nz(t.split('PAGE TEXT:')[1])
const safe=async f=>{try{return await f()}catch{}}
const get=async o=>{for(let i=0;i<6;i++){try{return await page.get(o)}catch{await sleep(600)}}return{tree:''}}
const itree=async()=>(await get({interactive:1})).tree+'\n'+(await get({selector:'[class*=Purchase],[class*=Option]',interactive:1})).tree
const code=(String(args.sku||'').match(/products\/(\d+)|^(\d{5,})$/)||[]).slice(1).find(Boolean)
if(!code)return done('no code')
O.product_url='https://www.musinsa.com/products/'+code
const want=nz(String(args.size||'').replace(/（/g,'(').replace(/）/g,')').replace(/\b(\d{1,2})\s+(\d)\s*\/\s*(\d)\b/g,'$1$2$3').replace(/\b\d{7,}\b/g,' ').replace(/옵션\s*\d?\s*[:：]/g,' ').replace(/\//g,' / '))
const CM={블랙:'black',화이트:'white',네이비:'navy',그레이:'gray',베이지:'beige'}
const FREE=/^(free|f|one|onesize|os|프리|프리사이즈|원사이즈)$/i
const isFree=s=>FREE.test(lc(s).replace(/\s/g,''))
const toks=s=>lc(s).split(/[\s/·,:]+/).filter(Boolean)
const ol=dd=>dd.items.map(x=>x.so?x.label+' (품절)':x.label)
function hits(av,w){
if(!av.length||!w)return[]
const W=lc(w),T=toks(w),L=o=>lc(o.label)
const eng=T.map(t=>CM[t]||CM[Object.keys(CM).find(k=>t.includes(k))]).filter(Boolean)
const lead=s=>(s.match(/^\d+(?:\.\d+)?/)||[])[0]
for(const t of[
o=>nsl(o.label)===nsl(W),
o=>T.includes(L(o)),
o=>L(o).length>1&&(' '+W+' ').includes(' '+L(o)+' '),
o=>T.includes(lc((o.label.match(/\(([^)]+)\)/)||[])[1])),
o=>{const n=lead(L(o));return!!n&&n.length>1&&T.some(x=>lead(x)===n)},
o=>eng.some(e=>L(o).includes(e)),
o=>isFree(o.label)&&T.some(x=>FREE.test(x)),
]){const h=av.filter(t);if(h.length)return h}
return[]
}
const pick=(av,w)=>{const h=hits(av,w);return h.length===1?h[0]:null}
const TAIL=/\s*(\(품절\)|품절|무신사 ?직|재입고 ?알림|[가-힣]{0,3}\([월화수목금토일]\)|\d\d\.\d\d|오늘|내일|모레|도착|발송|\d+ ?개 ?남음|\(?[+-]\s?[\d,]+원).*$/
async function readDD(){
const items=[]
for(let k=1;k<80;k++){
const t=(await page.get({selector:IT+':nth-of-type('+k+')',interactive:1})).tree
const id=+((lines(t).find(l=>/ clickable/.test(l))||'').match(/^\[(\d+)\]/)||[])[1]||0
if(!id)break
const raw=textOf(t)
items.push({id,label:nz(raw.replace(TAIL,'')),so:/품절(?!\s?임박)|재입고/.test(raw)})
}
return{items,ok:items.length>0&&items.every(x=>x.label)}
}
const pickers=t=>[...t.matchAll(/^\[\d+\] textbox "([^"]*)".*\n\[(\d+)\] button "선택 목록 (?:열기|닫기)"/gm)].map(m=>({name:m[1],btn:+m[2]})).filter((p,i,a)=>a.findIndex(q=>q.btn==p.btn)==i)
const before=new Set((await tabs.list()).map(t=>t.id))
const pid=(String(await tabs.open({profile:args.profile,url:O.product_url})).match(/tab (\S+)/)||[])[1]
if(!pid)return done('tab not opened')
const closeP=()=>safe(()=>tabs.close(pid))
await tabs.switch(pid)
await safe(()=>page.waitFor(/나의 할인가|구매하기|판매 ?종료|재입고 알림/,10000))
const buyId=t=>+((t.match(/^\[(\d+)\] button "(?:구매하기|바로구매)"/m)||t.match(/^\[\d+\] button "장바구니"\n(?:\[\d+\] clickable.*\n)*\[(\d+)\] button "(?![^"]*(?:좋아요|공유|삭제|재입고|품절|선물|쿠폰|찜|알림|판매 ?종료))[^"]+"/m)||[])[1]||0)
let tree=await itree()
for(let i=0;i<8&&!buyId(tree);i++){await sleep(400);tree=await itree()}
const pname=O.product_name=nz(((tree.match(/^TITLE: (.*)$/m)||[])[1]||'').replace(/ - 사이즈 & 후기.*$| \| 무신사$/g,''))
if(!/"로그아웃"/.test(tree)&&/link "로그인/.test(tree)){await closeP();O.error='login_required';return done('로그인 필요')}
if(!buyId(tree)){
const sold=/^\[\d+\] button "(?:품절|일시품절|재입고 ?알림 ?신청|판매 ?종료)"/m.test(tree)
await closeP()
if(!sold)return done('buy button not found')
O.sold_out=true;O.options=[(want||'옵션')+' (품절)']
return done('product sold out')
}
const chosen=[]
let rest=want,spent=false
const boxes=pickers(tree),n=boxes.length
for(let lv=0;lv<n;lv++){
const cur=boxes[lv]
await page.click(cur.btn)
await safe(()=>page.waitFor(/도착|발송|품절|재입고|남음/,3000))
let dd=await readDD()
if(!dd.ok){await sleep(500);dd=await readDD()}
if(!dd.ok){await closeP();return done(`option list ${cur.name} 읽지 못함`)}
const last=lv===n-1,av=dd.items.filter(x=>!x.so)
if(last&&!spent)O.options=ol(dd)
let c=pick(av,rest)||(av.length===1&&(!last||!want||spent||(dd.items.length===1&&isFree(av[0].label)))?av[0]:null)
if(!c&&last&&spent&&av.length){c=av[0];notes.push('size not given')}
if(!c){
await closeP()
if(!last)O.options=ol(dd)
if(hits(av,rest).length>1){O.options=dd.items.map(x=>x.label);return done(`option ambiguous: ${want}`)}
const sh=pick(dd.items.filter(x=>x.so),rest)
return done(sh?`option sold out: ${sh.label}`:av.length?`option not matched: ${want}`:'all options sold out')
}
if(!last)O.color=c.label
chosen.push(c.label)
const r2=nz(nsl(rest).replace(new RegExp(nsl(c.label).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'),' ').replace(/^\s*\/\s*|\s*\/\s*$/g,''))
if(r2)rest=r2;else{spent=true;O.options=ol(dd)}
await page.click(c.id)
await sleep(400)
}
const WQ=Math.max(1,+args.qty||1),QR=/\[(\d+)\] button\n(?:\[\d+\] clickable.*\n)*\[\d+\] textbox value="(\d+)"(?:\n\[\d+\] clickable.*)*\n\[(\d+)\] button/
for(let k=0,lv=0;k<24&&WQ>1;k++){const q=(await itree()).match(QR)
if(!q){await sleep(500);continue}const v=+q[2];if(v===WQ)break;if(v===lv){await sleep(300);continue}lv=v;await page.clickNative(+(v<WQ?q[3]:q[1]));await sleep(300)}
const bi=buyId(await itree())
if(!bi){await closeP();return done('buy button gone')}
page.click(bi).catch(()=>{})
let of=null,bs=null
for(let i=0;i<40&&!of;i++){
await sleep(250)
of=(await tabs.list()).find(t=>!before.has(t.id)&&OF.test(t.url||''))
if(!of&&i%10==6){bs=bs||[...(await itree()).matchAll(/^\[(\d+)\] button "바로 ?구매하기"/gm)].map(m=>+m[1]);const b=bs.pop();if(b)page.click(b).catch(()=>{})}
}
if(!of){O.error='no_checkout';return done('no order form')}
await tabs.switch(of.id)
await safe(()=>page.waitFor('총 결제 금액',10000))
O.order_tab=of.id
if(of.id!==pid)await closeP()
const MN=['무신사머니','무신사페이','토스페이','카카오페이','페이코','네이버페이']
let tx=''
for(let i=0;i<8;i++){
tx=textOf((await get({})).tree)
O.methods=MN.filter(m=>tx.slice(Math.max(tx.search(/결제 ?수단/),0)).includes(m))
if(O.methods.length)break
await sleep(600)
}
const seg=nz((tx.match(/주문 ?상품\s*\d+\s*개\s*(.*?)\s*\/\s*\d+\s*개/)||[])[1])
O.order_item=seg||null
O.qty=+((tx.match(/주문 ?상품\s*\d+\s*개.*?\/\s*(\d+)\s*개/)||[])[1]||0)||null
const join=chosen.join(' · ')
const sg=seg.replace(/\s*\(?[+-]\s?[\d,]+원\)?$/,'')
O.selected=sg?(join&&lc(sg).endsWith(lc(join))?sg.slice(sg.length-join.length):(sg.match(/(?:\S+ · )*\S+$/)||[''])[0])||null:null
const wf=toks(want).find(t=>FREE.test(t)),sf=O.selected&&toks(O.selected).find(t=>FREE.test(t))
if(wf&&sf&&wf!==sf)O.selected+=` (=${wf.toUpperCase()})`
else if(O.selected&&(' '+lc(want).replace(/\s*\/\s*/g,' ')+' ').includes(' '+lc(O.selected)+' '))O.selected=want
if(seg&&!pname.split(/[\s/()[\],·_-]+/).some(w=>w.length>2&&lc(seg).includes(lc(w)))){
notes.push('order form item mismatch');O.selected=null
}
if(!n&&O.selected)O.options=[O.selected]
O.cost=+((tx.match(/총 결제 금액\s*(?:\d+%\s*)?([\d,]+)\s*원/)||[])[1]||'').replace(/,/g,'')||null
return done(null)
