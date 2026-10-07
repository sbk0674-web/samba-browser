const nz=s=>String(s||'').replace(/\s+/g,' ').trim()
const num=s=>parseInt(String(s||'').replace(/[^\d]/g,''),10)||0
const pf=args.profile?{profile:args.profile}:{}
const acct=args.account||args.profile||'me'
const AD=args.allow_department===true
const R={options:[],selected:null,cost:null,pay_amount:null,methods:[],coupons:{},product_url:null,product_name:null,product_no:null,order_tab:null,route:args.route||'direct',ckwhere:null,account:args.account||null,note:null}
const tree=async o=>{for(let i=0;i<4;i++){try{const g=await page.get(o||{});if(g&&g.tree)return g.tree}catch(e){}await sleep(500)}return ''}
const text=async()=>nz((await tree()).split('PAGE TEXT:')[1])
const els=t=>t.split('\n').map(l=>l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m=>({id:+m[1],role:m[2],text:m[3]||'',rest:m[4]}))
const want=nz(String(args.size||'').replace(/^\s*(옵션|사이즈|size)\s*[:：]\s*/i,''))
const nm=s=>nz(s).toLowerCase().replace(/[\s()·\-/,:]/g,'')
const score=o=>{
if(!want)return 0
if(nm(o)===nm(want))return 100
const toks=want.split(/[\s/·,]+/).filter(Boolean)
if(toks.some(k=>nm(k)===nm(o)))return 90
const on=o.match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g)||[]
if(on.length&&toks.some(k=>on.includes(k)))return 70
if(toks.some(k=>k.length>1&&nm(o).includes(nm(k))))return 50
return 0
}
const PI=/pay\.ssg\.com\/item\/itemView/
const fixHost=u=>PI.test(u)?u.replace('pay.ssg.com',/siteNo=6004(?!\d)/.test(u)?'shinsegaemall.ssg.com':/siteNo=6009(?!\d)/.test(u)?'department.ssg.com':'www.ssg.com'):u
const url0=fixHost(args.entry_url||args.sku)
if(!/^https:\/\//.test(String(url0||'')))return{...R,error:'bad-sku'}
const RDY=/바로구매|품절|입고알림|원하셨던 페이지/
const op=async u=>(String(await tabs.open({...pf,url:u})).match(/tab (\S+)/)||[])[1]
let tabId=await op(url0)
const E=o=>({...R,...o,product_tab:tabId})
const z=()=>{R.coupons[acct]=0}
if(tabId)await tabs.switch(tabId)
try{await page.waitFor(RDY,25000)}catch(e){}
const cu=await page.url()
if(PI.test(cu)||/원하셨던 페이지가 아닌가요/.test(await text())){
const old=tabId
tabId=await op(fixHost(PI.test(cu)?cu:args.sku))
if(tabId)await tabs.switch(tabId)
try{await tabs.close(old)}catch(e){}
try{await page.waitFor(RDY,25000)}catch(e){}
}
R.product_url=await page.url()
R.product_no=(R.product_url.match(/itemId=(\d+)/)||[])[1]||null
R.ckwhere=(R.product_url.match(/[?&]ckwhere=([^&]+)/)||[])[1]||null
const mallOk=u=>/shinsegaemall\.ssg\.com|siteNo=6004(?!\d)/.test(u)||(AD&&/department\.ssg\.com|siteNo=6009(?!\d)/.test(u))
let t=await text()
R.mall_ok=mallOk(R.product_url)||(!/siteNo=/.test(R.product_url)&&(/판매자스토어 신세계몰/.test(t)||(AD&&/판매자스토어 신세계 ?백화점/.test(t))))
if(!R.mall_ok&&AD&&!/siteNo=/.test(R.product_url)&&/브랜드 매장\s*:/.test(t)){const o2=tabId;tabId=await op(R.product_url+(R.product_url.includes('?')?'&':'?')+'siteNo=6009');if(tabId)await tabs.switch(tabId);try{await tabs.close(o2)}catch(e){}try{await page.waitFor(RDY,25000)}catch(e){}R.product_url=await page.url();t=await text();R.mall_ok=mallOk(R.product_url)}
R.product_name=nz(String(await page.title()).replace(/\s*-\s*(SSG\.COM|신세계백화점|신세계몰|이마트몰)\s*$/,''))||null
if(/접속이 잠시 제한|자동화된 환경/.test(t))return{...R,error:'blocked',note:'SSG 봇 차단'}
if(/member\.ssg\.com/.test(R.product_url))return{...R,error:'login_required'}
if(!R.mall_ok){z();return E({error:'not_shinsegaemall'})}
if(args.coupon!==false){const cb=await page.idOf('쿠폰받기',0);if(cb>=0){await page.click(cb);await sleep(1200)}}
if((await page.idOf('바로구매',0))<0&&((await page.idOf('입고알림',0))>=0||(await page.idOf('품절',0))>=0)){
z()
return E({sold_out:true,options:[],note:'item sold out'})
}
const picked=[]
for(let step=0;step<3;step++){
const before=new Set(els(await tree({interactive:true})).map(e=>e.id))
const oc=els(await tree({query:'선택하세요'})).filter(e=>e.role==='link'&&/선택하세요\.?$/.test(e.text)&&!picked.includes(e.text))
const opener=(oc.find(e=>e.text!=='선택하세요.')||oc[0]||{id:-1}).id
if(opener<0)break
await page.click(opener)
await sleep(700)
const after=els(await tree({interactive:true}))
const live=after.filter(e=>!before.has(e.id)&&e.role==='link'&&/href=#/.test(e.rest)&&e.text&&e.text.length<=40&&!/배너|이전|다음|닫기|선택하세요|매진|품절|Q&A|추천 상품|교환\/반품|상품상세정보|고객리뷰|바로구매|장바구니|선물하기/.test(e.text))
R.options=[...R.options,...live.map(e=>e.text)]
if(!live.length){R.note='no live option';break}
let best=null,top=0
for(const o of live){const s=score(o.text);if(s>top){top=s;best=o}}
const COLOR=/black|white|red|blue|navy|gr[ae]y|green|beige|pink|블랙|화이트|레드|블루|네이비|그레이|그린|베이지|핑크/i
if(!best&&live.length===1&&(/^(free|f|one ?size|os|프리)$/i.test(live[0].text)||!COLOR.test(want)||COLOR.test(live[0].text)&&COLOR.test(want)))best=live[0]
if(!best&&picked.length&&want&&picked.some(p=>score(p)>0)){best=live[0];R.note='step2 defaulted'}
if(!best){R.note=want?'size not available':'option needs choice';z();return E({})}
await page.click(best.id)
picked.push(best.text)
await sleep(800)
}
t=await text()
const sec=t.slice(0,t.indexOf('바로구매')>0?t.indexOf('바로구매'):t.length)
const chosen=[...sec.matchAll(/(색상|사이즈|옵션|용량|타입)\s*:\s*([^/]+?)(?=\s*\/|\s*삭제|\s*빼기)/g)].map(m=>nz(m[2]))
if(!picked.length&&chosen.length)R.options=chosen
if(!chosen.length&&!picked.length&&/선택하세요\./.test(sec)){z();return E({note:'option not chosen'})}
R.selected=chosen.join(' / ')||picked.join(' / ')||null
const beforeTabs=new Set((await tabs.list()).map(x=>x.id))
let buy=await page.idOf('바로구매',0)
for(let i=0;i<10&&buy<0;i++){await sleep(1000);buy=await page.idOf('바로구매',0)}
if(buy<0)return E({error:'buy-button-not-found'})
await page.click(buy)
let form=null,cont=false,retried=false
for(let i=0;i<40&&!form;i++){
await sleep(500)
const list=await tabs.list()
const login=list.find(x=>(!beforeTabs.has(x.id)||x.openerId===tabId)&&/member\.ssg\.com/.test(x.url||''))
if(login){for(const x of list)if(x.kind==='popup'&&/member\.ssg\.com/.test(x.url||'')){try{await tabs.close(x.id)}catch(e){}}z();return E({error:'login_required'})}
const mine=x=>x.id===tabId||!beforeTabs.has(x.id)
form=list.find(x=>mine(x)&&/pay\.ssg\.com\/(order|payment)\//.test(x.url||''))
const mid=!form&&!cont&&list.find(x=>mine(x)&&/pay\.ssg\.com\/nodcsnOrder\/ordShppInfo/.test(x.url||''))
if(mid){
await tabs.switch(mid.id)
try{await page.waitFor('계속하기',6000)}catch(e){}
const cb=await page.idOf('계속하기',0)
if(cb>=0){await page.click(cb);cont=true}
}
if(!form&&!mid&&!cont&&!retried&&i===5){
retried=true
const ch=els(await tree({interactive:true})).find(e=>e.text==='바로구매'&&e.role==='clickable')
if(ch)await page.click(ch.id)
}
}
if(!form)return E({error:'no_checkout'})
await tabs.switch(form.id)
R.order_tab=form.id
try{await page.waitFor(/결제\s*(수단|예정)/,12000)}catch(e){}
t=await text()
const total=num((t.match(/(최종\s*결제\s*금액|총\s*결제\s*금액|결제\s*예정\s*금액)\s*([\d,]{3,})\s*원/)||[])[2])
R.pay_amount=total||null
R.cost=total||null
R.adpick_rate=R.route==='adpick'?(parseFloat(args.adpick_percent)||0):0
R.adpick_reward=Math.round((total||0)*R.adpick_rate/100)
R.methods=['SSGPAY','SSG MONEY','신용카드','페이코','카카오페이','네이버페이','토스페이'].filter(m=>t.toUpperCase().includes(m.toUpperCase()))
const cp=t.match(/쿠폰\s*(?:할인|사용)?\s*-?\s*([\d,]{3,})\s*원/)
R.coupons[acct]=cp?num(cp[1]):0
const oi=t.indexOf('주문상품 목록')
const om=(oi>=0?t.slice(oi):'').match(/옵션\s*:\s*(.+?)\s*판매가격/)
R.selected=om?nz(om[1]):(picked.join(' / ')||chosen.join(' / ')||null)
if(!R.cost)R.note='no total'
return R