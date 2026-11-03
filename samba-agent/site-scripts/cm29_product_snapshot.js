const ls=t=>t.split('PAGE TEXT')[0].split('\n').filter(l=>/^\[\d+\]/.test(l))
const ID=l=>parseInt(l.slice(1))
const nm=l=>(l.match(/^\[\d+\] \w+ "([^"]*)"/)||[])[1]
const text=t=>(t.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ')
const U='https://www.29cm.co.kr/',C=id=>page.click(id),S=ms=>sleep(ms)
const SOLD=/\[품절\]|품절(?!임박)/,UP=/\] button "증가"/,BUY=/\] button "바로 ?구매하기"/,OUT=/\] button "(로그아웃|보유중)"|보유 적립금 사용/i,CK=/\/order\/checkout/,ED=/판매 ?(종료|중지)|품절된 상품/,GB=/\] button "구매하기"/
let nu=false
const xq=async(qs,r)=>{const x=new Set();for(const q of qs)for(const l of ls((await page.get({query:q})).tree))if(!r||!r.includes(l))x.add(l);return[...x]}
const tree=async()=>{let r=(await page.get({})).tree
if(!BUY.test(r)||(nu&&!UP.test(r)))r=r.replace('PAGE TEXT',(await xq(['보유','증가','바로 구매하기'],r)).join('\n')+'\nPAGE TEXT')
return r}
const norm=s=>String(s||'').toLowerCase().replace(/[\s\-_/:().,[\]·]/g,'')
const EX=/^(보유중|자세히|로그아웃|로그인|감소|증가|장바구니 담기|바로 ?구매하기|SIZE|받기)$|닫기|혜택|카드|적립|쿠폰|리뷰|원$|^(선물|구매)하기$/i
const btn=(t,re)=>ls(t).find(l=>re.test(l))
const ac=args.account||args.profile||null,ck=ac||'계정'
const sku=String(args.sku||'').trim(),want=String(args.size||'').trim()
let pno=(sku.match(/(?:catalog|products)\/(\d+)/)||[])[1]||(/^\d{5,}$/.test(sku)?sku:null)
const base={options:[],account:ac,coupons:{[ck]:0},methods:[],cost:null,selected:null}
if(!args.profile||!pno)return{...base,error:args.profile?'no_product':'profile_required'}
const tid=(String(await tabs.open({profile:args.profile,url:U+'products/'+pno})).match(/tab (\S+)/)||[])[1]
await tabs.switch(tid)
const bye=async r=>{await tabs.close(tid).catch(0);return r}
let product_url=base.product_url=U+'products/'+pno
await page.waitFor(new RegExp('보유중|보유 적립금|'+ED.source),10000).catch(0)
let t=await tree(),tx=text(t)
if(!OUT.test(t))return bye({...base,error:'login_required'})
const sold=()=>ED.test(tx)||/\] button "품절"/.test(t)&&!btn(t,BUY)
const wake=async()=>{
for(let k=0;k<6;k++){
if(btn(t,BUY)||btn(t,GB)||sold())return
const rv=btn(t,/\] button "[^"]*리뷰/)
if(rv)await C(ID(rv));await S(rv?1200:800)
t=await tree();tx=text(t)
}
}
const ob=async()=>{let k=0
for(let w=0;w<20&&!btn(t,BUY)&&!sold();w++){const b0=btn(t,GB)
if(b0&&(!k||w-k>=8)){await C(ID(b0));k=w+1}
await S(500);t=await tree();tx=text(t)}}
await wake()
await ob()
if(!btn(t,BUY))return bye({...base,...(sold()?{sold_out:true}:{error:'no_buy_button'})})
const dc=((tx.match(/color(?:\/model)? (.+?) (?:색상|사이즈|상품번호)/i)||[])[1]||'').split('/')[0].trim()
const L0=[...new Set([...ls(t),...await xq(['장바구니 담기','사이즈','색상','SIZE'])])].sort((a,b)=>ID(a)-ID(b)),cart=L0.findIndex(l=>/\] button "장바구니 담기"/.test(l)),gs=[]
for(let i=cart-1;i>=0&&i>cart-25;i--){
const l=L0[i],n=nm(l)
if(/\] (link|checkbox) /.test(l)||/카드사별|전체보기|삼성카드|자세히|혜택|적립|구매하기"|선물하기|더보기|도움돼요/.test(l))break
if(/\] button "/.test(l)&&n&&n.length<30&&!SOLD.test(n)&&!/전체/.test(n)&&(!EX.test(n)||(n==='SIZE'&&!gs.length)))gs.unshift({id:ID(l),name:n})
}
const LET=/(?<![A-Za-z])(XXS|XS|S|M|L|XL|XXL|XXXL|FREE|ONE)(?![A-Za-z])/g
const lets=s=>[...new Set(String(s).toUpperCase().replace(/(프리|원)\s*사이즈/g,' FREE ').match(LET)||[])].sort().join()
const CM={화이트:'white',블랙:'black'}
const canon=s=>{let x=String(s).replace(/샌디/g,'샌드');for(const k in CM)x=x.split(k).join(CM[k]+' ');return x.replace(/(?<![A-Za-z])(SM|MD|LG)(?![A-Za-z])/gi,m=>m[0])}
const CODE=/\d[A-Za-z]+\d|[A-Za-z]+\d+[A-Za-z]+\d/
function pick(lv,w,n){
const cc=s=>(String(s).match(/\(([A-Z]+\d+)\)/i)||[])[1]?.toUpperCase();const wc=cc(w);lv=lv.filter(o=>!wc||!cc(o.v)||cc(o.v)===wc)
lv=lv.map(o=>({...o,c:canon(o.v)}));w=canon(w)
const one=f=>{const a=lv.filter(f);return a.length===1?a[0]:null}
const nw=norm(w),w2=w.split(/\s+/).filter(x=>!CODE.test(x)).join(' '),L2=lets(w2)
if(!nw)return n===1?lv[0]:null
let r=one(o=>o.c===w)||one(o=>norm(o.c)===nw)||one(o=>norm(o.c).length>=2&&(nw.includes(norm(o.c))||norm(o.c).includes(nw)))
for(const tk of w.split(/\s+/))if(!r&&norm(tk).length>=2)r=one(o=>o.c.split(/[-\s/]+/).map(norm).includes(norm(tk)))
const wt=w.split(/[\s:/_,·-]+/).filter(x=>/[A-Za-z가-힣]/.test(x)&&norm(x).length>=2&&!lets(x)&&!CODE.test(x))
const aT=lv.some(o=>wt.some(x=>norm(o.c).includes(norm(x))))
const tok=o=>!wt.length||!aT||wt.some(x=>norm(o.c).includes(norm(x)))
for(const d of(w2.match(/\d+(?:\.\d+)?/g)||[]).reverse())if(!r&&d.length>=2)r=one(o=>tok(o)&&(o.c.match(/\d+(?:\.\d+)?/g)||[]).includes(d))
if(!r&&L2&&(!/\d{2,}/.test(w2)||!lv.some(o=>/\d{2,}/.test(o.c))))r=one(o=>lets(o.c)===L2)
if(!r)r=one(o=>o.c.includes(':')&&norm(o.c.split(':').pop())===nw)
return r||(n===1&&lv.length===1?lv[0]:null)
}
const mk=l=>{const n=nm(l);return{id:ID(l),raw:n,v:n.replace(/ ?\[품절\]$/,''),so:SOLD.test(n)}}
let ch=[],sh=[],mv=null
const er=e=>({...base,options:sh,error:e})
const sq=async()=>ls((await page.get({selector:'[role=listbox] *, ul li button'})).tree)
const pre0=(await sq()).map(ID)
const gn=new Set(gs.map(x=>x.name).concat(['색상','사이즈','SIZE']))
for(let g=0;g<gs.length;g++){
const dd=gs[g],last=g===gs.length-1
let opts=[]
for(let a=0;a<2&&!opts.length;a++){
const bf=new Set([...ls(t=await tree()).map(ID),...pre0])
if(g===0||a>0)await C(dd.id)
for(let i=0;i<(g>0&&a===0?5:15)&&!opts.length;i++){
await S(200);t=await tree()
opts=[...new Set([...ls(t),...await sq()])].filter(l=>/\] button "/.test(l)&&!bf.has(ID(l))&&nm(l)&&nm(l).length<40&&nm(l)!==dd.name&&!gn.has(nm(l))&&!EX.test(nm(l))).map(mk)
}
}
if(!opts.length)return bye(er('옵션 없음'))
const pre=ch.map(c=>c.v).join(' ')
sh=opts.map(x=>(pre?pre+' ':'')+x.raw)
let p=pick(opts.filter(x=>!x.so),want,opts.length)
if(!p&&dc&&!last)p=pick(opts.filter(x=>!x.so),dc,opts.length)
if(!p)return bye({...er(),note:pick(opts.filter(x=>x.so),want,0)?'품절':'옵션 불일치'})
await C(p.id)
ch.push(p)
nu=last
for(let i=0;i<15&&!mv;i++){await S(200);const m=((await page.url()).match(/products\/(\d+)/)||[])[1];if(m&&m!=pno)mv=m;else{t=await tree();if(!last||UP.test(t))break}}
if(mv)break
}
nu=true
if(mv){pno=mv;product_url=base.product_url=U+'products/'+pno;await page.waitFor(/구매하기/,10000).catch(0);t=await tree();await wake();await ob()}
if(gs.length&&!UP.test(t))return bye(er('선택 미반영'))
const inc=btn(t,UP)
for(let i=1;i<(+args.qty||1)&&inc;i++){await C(ID(inc));await S(150)}
const buy=btn(await tree(),BUY)
if(!buy)return bye(er('no_buy_button'))
await C(ID(buy))
let url=''
for(let i=0;i<80&&!CK.test(url);i++){await S(250);url=await page.url()}
if(!CK.test(url))return er('no_checkout')
for(let i=0;i<60;i++){t=(await page.get({})).tree;tx=text(t);if(/(?:총|최종) 결제 ?금액 [\d,]+원/.test(tx)&&/\d+개/.test(tx))break;await S(250)}
const nos=[...new Set([...t.matchAll(/\/product\/catalog\/(\d+)/g)].map(m=>m[1]))]
if(nos.length!==1||nos[0]!=pno)return er('order_form_mismatch')
const om=tx.slice(Math.max(0,tx.indexOf('배송지'))).match(/((?:\[[^\]]{1,12}\][^\[]{0,40}?)+?)\s*(\d+)개/)
let sel=om?om[1].replace(/\[[^\]]{1,12}\]\s*/g,' ').replace(/\s+/g,' ').trim():null
if(sel){for(const k in CM)if(want.includes(k))sel=sel.replace(new RegExp(CM[k],'i'),k)
const mi=x=>!norm(sel).includes(norm(x)),wd=want.split(/[\s·]+/)
sel=[...wd.filter(c=>/^[가-힣]{2,}$/.test(c)&&mi(c)),sel,...[...wd.filter(c=>CODE.test(c)),...(want.match(/KR\s*\d+/gi)||[])].filter(mi)].join(' ')}
const amt=re=>parseInt(((tx.match(re)||[])[1]||'').replace(/\D/g,''),10)||0
const total=amt(/(?:총|최종) 결제 ?금액 ([\d,]+)원/)
const cost=total?total+amt(/ㄴ 결제 즉시 할인 [^ㄴ]*?-([\d,]+)원/)+amt(/ㄴ 제휴카드[^ㄴ]*?-([\d,]+)원/)+amt(/보유 적립금 사용 -?([\d,]+)원/):null
const pt=text((await page.get({selector:'label:has(input[type=radio])'})).tree)
const methods=['무신사머니','무신사페이','토스페이','카카오페이','카드 결제'].filter(n=>pt.includes(n))
if(/다른 결제 방법/.test(pt))methods.push('페이코')
return{options:sh,account:ac,coupons:{[ck]:amt(/쿠폰 할인 금액 (?:최대 할인 적용 )?-([\d,]+)원/)},methods,cost,
selected:sel||(gs.length?null:''),qty:om?+om[2]:null,product_url}