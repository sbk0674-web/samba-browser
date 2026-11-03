const ref=String(args.sku||'').trim()
let pid=(ref.match(/^\d+$/)||ref.match(/^https:\/\/(?:www\.)?musinsa\.com\/products\/(\d+)(?:[?#].*)?$/)||[]);pid=pid[1]||pid[0]
if(!pid)return{options:[],note:'invalid product reference'}
const productUrl='https://www.musinsa.com/products/'+pid
const S=ms=>sleep(ms),U=()=>page.url(),z=()=>S(1200)
const go=async(u,k)=>{await tabs.open({url:u,profile:args.profile||args.account});for(let i=0;i<15&&!(await U()).includes(k);i++)await S(1000)}
const oo=/order-form/.test(await U())
if(args.sku&&!oo&&!(await U()).includes('products/'+pid))await go(productUrl,'products/'+pid)
if(!oo)await page.waitFor('구매하기',6e3).catch(()=>{})
const safe=async(fn,d)=>{for(let i=0;i<3;i++){try{return await fn()}catch{await S(1500)}}return d},
text=async s=>{const t=(await page.get(s?{selector:s}:{})).tree;return t.slice(t.indexOf('PAGE TEXT'))},
it=async()=>(await safe(()=>page.get({interactive:true}),{tree:''})).tree.split('\n'),
has=(L,re)=>L.some(l=>re.test(l))
let ln=await it()
const BUY=/button "(?![^"]*장바구니)[^"]*구매하기/,OPN=/선택 목록 열기/,SO=/button "(일시)?품절"/,hb=()=>has(ln,BUY)
const ID=l=>+l.match(/^\[(\d+)\]/)[1],ck=i=>page.click(i),idL=(a,re)=>{const l=a.find(x=>re.test(x));return l&&ID(l)},
CL=/선택 목록 닫기/,DEL=/옵션 삭제/,UO=/^\(옵션\d+\)$/,CM=/^\[(\d+)\] clickable "([^"]+)"/
const hs=has(ln,/선택 목록 (열기|닫기)/)
let op=[],cho='',pk=!hs
if(!oo&&!hb()&&!hs&&has(ln,SO))return{options:op,note:'soldout'}
const A=String(args.size||'').trim(),NONE=!A||/^\(?없음\)?$/.test(A)
const nz=s=>s.toLowerCase().replace(/[\s_·-]/g,'').replace(/xxl/g,'2xl'),w=nz(A)
const we=w.replace(/블랙|화이트|그레이|베이지|네이비/g,k=>({블랙:'black',화이트:'white',그레이:'grey',베이지:'beige',네이비:'navy'})[k])
const ch=n=>{n=nz(n);return n&&(w.includes(n)||we.includes(n))}
const osz=nz(A.split(/\s+/).pop()),TK=A.toLowerCase().match(/[a-z0-9가-힣]+/g)||[]
const KM={95:'s',100:'m',105:'l',110:'xl',115:'2xl',60:'xs',65:'s',70:'m',75:'l'}[+osz]
const cs=nm=>{
const p=nm.split('-').map(nz),c=p[0],y=p.slice(1).join('')
if(p.length<2||!c||!y||!ch(c))return 0
return y===osz||y==={s:'sm',m:'md',l:'lg'}[osz]?300:0
}
const SZT=/^(xs|s|m|l|xl|2xl|f|free|\d{2,3})$/,CRE=/textbox "(색상|컬러(\(Color\))?)"/i,SRE=/textbox "(사이즈|size)"/i,
si=L=>L.findIndex(l=>SRE.test(l)),af=L=>L.slice(si(L)+1),
avl=L=>af(L).filter(l=>/clickable "[^"]*(발송 예정|도착보장|도착 예정)/.test(l)).map(ID),
AR=/clickable "(.*(?:발송 예정|도착보장|도착 예정)|.*\(품절\))"/,
DL='(?:\\S+\\([^)]*\\)\\s+(?:이내\\s+)?)?(?:발송 예정|도착보장|도착 예정'
const rd1=async()=>{
let dt=await text('[class*=dropdown]')
dt=/도착보장|발송 예정|도착 예정/.test(dt)?dt.replace(/^PAGE TEXT:\s*/,''):''
const head=dt||(await text()).split(/장바구니\s+(?:\S+\s+)?구매하기/)[0]
let st=-1,m,pm
const pr=/(?<![\d,+])[\d,]+원/g
while((pm=pr.exec(head))){if(/(예정|도착보장|출발)\s*$/.test(head.slice(pm.index-30,pm.index)))continue;st=pm.index+pm[0].length}
if(st<0)st=head.lastIndexOf('LV.')+1
let seg=dt||head.slice(st)
const mi=seg.lastIndexOf('더보기')
if(mi>=0&&/발송|도착/.test(seg.slice(mi)))seg=seg.slice(mi+3)
else seg=seg.replace(/^.*?LV\.\d+\s*\S+\s*/,m=>m.length<200?'':m)
const re=new RegExp('(.+?)\\s*(?:'+DL+'|출발)(?:\\s*오늘출발)?|\\(품절\\))','g'),R=[]
while((m=re.exec(seg))){let nm=m[1].replace(/재입고 알림|마지막 \d+개|\d+개 남음/g,'').trim().replace(/^.*?추가\s*적립\s*/,'').replace(/\s*\(\+[\d,]+원\)$/,'');if(dt&&R.some(r=>r.name===nm))continue;R.push({name:nm,so:/\(품절\)/.test(m[0])})}
if(dt&&R.length>1){const n0=R[0].name,r=R.slice(1).map(x=>x.name).find(x=>n0.endsWith(' '+x));if(r)R[0].name=r;return R.filter((r,j)=>R.findIndex(x=>x.name===r.name)===j)}
return R
}
const rd2=L=>{
const start=si(L)
const endI=L.findIndex((l,i)=>i>start&&/button "(좋아요|장바구니|[^"]*구매하기)/.test(l)),R=[]
for(const l of L.slice(start+1,endI<0?L.length:endI)){
const m=l.match(CM)
if(!m||/^(\d+개 남음|마지막 \d+개)$/.test(m[2]))continue
const so=/\(품절\)/.test(m[2])
R.push({id:+m[1],name:!so&&/도착|발송|배송|출고/.test(m[2])?'(옵션'+(R.length+1)+')':m[2].replace(/\(품절\)/,'').trim(),so})
}
return R
}
const sO=L=>{const a=L.findIndex(l=>CRE.test(l)),b=si(L);return L.slice(a+1,b>a?b:a+8)}
const pc=async()=>{
for(let tr=0;tr<2;tr++){
let L=await it()
const ci=L.findIndex(l=>CRE.test(l))
if(ci<0||/textbox "[^"]+" value="[^"]+"/.test(L[ci]))return
if(!has(sO(L),CL)){
const oid=idL(sO(L),OPN)
if(oid){await ck(oid);await z()}
L=await it()
}
const cd=sO(L).map(l=>l.match(CM)).filter(Boolean).map(m=>({id:+m[1],name:m[2]}))
const pick=cd.filter(c=>ch(c.name)).sort((a,b)=>nz(b.name).length-nz(a.name).length)[0]||(cd.length===1&&cd[0])
if(!pick)return
await(tr?page.clickNative(pick.id):ck(pick.id))
await S(1500)
}
}
if(hs&&!oo){
if(!NONE)await pc()
for(let at=0;at<3&&!pk;at++){
ln=await it()
if(has(ln,DEL)){pk=true;break}
if(!has(af(ln),CL)){
const oi=idL(af(ln),OPN)
if(oi){await ck(oi);await z()}
}
ln=await it()
const ids=L=>af(L).filter(l=>AR.test(l)).map(ID)
let ri=ids(ln),R=await safe(rd1,[])
if(!R.length||R.length<ri.length){R=rd2(ln);ri=R.map(r=>r.id)}
op=R.filter(r=>!/선택\s?안함$/.test(r.name)).map(r=>r.name+(r.so?' (품절)':''))
const txo=!ri.length&&R.length&&!R.some(r=>UO.test(r.name))
const ot=KM&&!R.some(r=>/\d{2,3}/.test(r.name))?KM:osz
let best=-1,bs=0
R.forEach((r,i)=>{
if(r.so)return
const n=nz(r.name).replace(/^0+(?=[a-z])/,'')
let s=cs(r.name)||(n&&n===ot?500:n&&(n.length<3?TK.includes(n):w.includes(n))?100+n.length:(r.name.replace(/mm$/i,'').match(/\w+/g)||[]).filter(t=>TK.includes(t.toLowerCase())).length)
const lw=nz(r.name.split(/\s+/).pop())
if(SZT.test(ot)&&SZT.test(lw))s=lw===ot?s+50:0
if(s<1&&(R.length==1||/^(free|f|프리)/.test(n)&&/프리|free/.test(w)))s=150
if(NONE)s=/선택\s?안함|없음/.test(r.name)?600:0
if(s>bs){bs=s;best=i}
})
if(best<0||bs<1)break
const sb=R.slice(0,best).filter(r=>r.so).length
if(txo){
const k=best-sb
let L3=await it()
if(!has(L3,CL)){const o=idL(af(L3),OPN);if(o){await ck(o);await z();L3=await it()}}
const tids=avl(L3)
if(!tids[k])break
await ck(tids[k])
}else{
const all=[]
let tg=0
const soM=R.some(r=>r.so),idf=soM?avl:ids
const bx=soM||ri.length<R.length?best-sb:best
for(let k=0;k<20&&!tg;k++){
const cur=idf(ln)
cur.forEach(i=>all.includes(i)||all.push(i))
all.sort((a,b)=>a-b)
if(all.length>bx&&cur.includes(all[bx]))tg=all[bx]
if(tg||!cur.length)break
try{await page.scroll('down',cur[cur.length-1])}catch{break}
ln=await it()
}
if(!tg)break
await ck(tg)
}
cho=R[best].name
let l2=await it()
for(let q=0;q<6&&!has(l2,DEL);q++){await z();l2=await it()}
pk=has(l2,DEL)
}
}
if(!pk)return{options:op,note:'nopick'}
if(!oo){
const bi=idL(ln,BUY)
if(bi)await ck(bi)
else await page.clickText('구매하기',0)
await z()
const bb=idL(await it(),/button "바로 구매하기"/)
if(bb)await ck(bb)
}
let t=''
for(let i=0;i<12;i++){
await S(1000)
t=await safe(()=>text('body'),'')
if(/주문 상품/.test(t)&&/총 결제 금액/.test(t))break
}
const cm=t.match(/총 결제 금액\s*(?:\d+%)?\s*([\d,]+)\s*원/),cost=cm?+cm[1].replace(/,/g,''):null
const tl=t.slice(t.indexOf('주문 상품'))
const sm=tl.match(/(\S+(?:\s*·\s*\S+)+)\s*\/\s*\d+개/)||t.match(/주문 상품 \d+개\s*(.+?)\s*\/\s*\d+개/)
let sel=sm?sm[1]:''
if(sm&&/·/.test(sm[1])){const b=tl.slice(0,tl.indexOf(sm[0])).trim().split(/\s+/),e=[];for(let i=b.length-1;i>=0&&!/_|^·$/.test(b[i])&&nz(b[i])&&ch(b[i]);i--)e.unshift(b[i]);if(e.length)sel=e.concat(sm[1]).join(' ')}
else if(sel){const b=sel.split(/\s+/),e=[];for(let i=b.length-1;i>=0&&(TK.includes(b[i].toLowerCase())||ch(b[i]));i--)e.unshift(b[i]);sel=e.length?e.join(' '):b[b.length-1]}
const pn=(A.match(/[A-Z][A-Z0-9]{5,}\s*$/)||[])[0]
if(sel&&pn&&!sel.includes(pn)&&(sel.toLowerCase().match(/[a-z0-9가-힣]+/g)||[0]).every(x=>TK.includes(x)))sel=A
if(cs(sel.split(/\s+/).pop()))sel+=' '+A
if(KM&&nz(sel)===KM){sel+=' '+A;op=op.map(o=>nz(o)===KM?o+' '+A:o)}
const s0=t.lastIndexOf('결제 수단'),ms=t.slice(s0,s0+400)
const methods='무신사머니 무신사페이 토스페이 카카오페이 페이코 네이버페이 카드'.split(' ').filter(n=>ms.includes(n))
if(!op.length)op=sel?[sel.split(/\s+/).pop()]:[]
return{cost,options:op,methods,selected:sel,chosen:cho||op[0]||'',qty:+(tl.match(/\/\s*(\d+)개/)||[])[1]||null}