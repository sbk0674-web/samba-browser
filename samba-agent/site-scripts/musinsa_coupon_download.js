const sku=String(args.sku||'');const url=/^http/.test(sku)?sku:'https://www.musinsa.com/products/'+sku;
if(!/^http/.test(sku)&&!/^\d{5,}$/.test(sku))return{ok:false,note:'bad sku'};
const before=new Set((await tabs.list()).map(t=>t.id));
const close=async()=>{try{for(const t of await tabs.list())if(!before.has(t.id))try{await tabs.close(t.id)}catch(e){}}catch(e){}};
const tmo=(p,ms)=>Promise.race([p,sleep(ms).then(()=>{throw new Error('timeout')})]);
const rd=async()=>{for(let i=0;i<2;i++){try{return await tmo(page.get({interactive:true}),12000)}catch(e){await sleep(1000)}}return{tree:''}};
const btn=/^\[(\d+)\] (?:button|clickable|link) "쿠폰\s?받기"/m;
try{
await tmo(tabs.open({url,profile:args.profile||undefined}),20000);
try{await tmo(page.waitFor('로그아웃',8000),10000)}catch(e){await sleep(1500)}
try{await tmo(page.dismissOverlay(),5000)}catch(e){}
let g=await rd();
let m=g.tree.match(btn);
if(!m){await sleep(1500);g=await rd();m=g.tree.match(btn)}
if(!m){await close();return{ok:true,clicked:false,issued:[]}}
await tmo(page.click(+m[1]),10000);
try{await tmo(page.waitFor('레이어 닫기',6000),8000)}catch(e){await sleep(1500)}
g=await rd();
const all=g.tree.match(/^\[(\d+)\] (?:button|clickable) "(?:모두 받기|전체 받기|쿠폰 모두 받기|전체 쿠폰 받기|모두받기|전체받기)"/m);
if(all){await tmo(page.click(+all[1]),10000);await sleep(1500);g=await rd();}
const issued=[...g.tree.matchAll(/radio "([\d,]+)원 할인\s*[^"]*?발급완료/g)].map(x=>x[1]);
const c=g.tree.match(/^\[(\d+)\] button "레이어 닫기"/m);if(c){try{await tmo(page.click(+c[1]),8000)}catch(e){}await sleep(300);}
await close();
return{ok:true,clicked:true,issued};
}catch(e){try{await close()}catch(_){}return{ok:false,note:String(e&&e.message||e)}}