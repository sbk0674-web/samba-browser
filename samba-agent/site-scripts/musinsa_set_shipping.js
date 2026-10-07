async function G(){for(let i=0;i<8;i++){try{return await page.get({interactive:true});}catch(e){await sleep(800);}}throw new Error('page busy');}
async function C(id){try{return await page.click(id);}catch(e){return 'warn';}}
async function T(id,s){for(let i=0;i<3;i++){try{return await page.type(id,s,false);}catch(e){if(!/frame|gone|detach/i.test(''+e))throw e;await sleep(700);}}return 'warn';}
async function W(t,ms){try{return await page.waitFor(t,ms||8000);}catch(e){return null;}}
async function P(re,ms){const t0=Date.now();let g=await G();while(!re.test(g.tree)&&Date.now()-t0<(ms||5000)){await sleep(300);g=await G();}return g;}
const nrm=s=>(s||'').replace(/[()\[\],]/g,' ').replace(/\s+/g,' ').trim();
const toks=s=>nrm(s).split(' ').filter(t=>t.length>1);
const out={name:null,address:null,phone:null,phone_field_ids:[],ok:false,note:null};
let list=await tabs.list();
const __ofs=list.filter(t=>t.url&&t.url.includes('/order/order-form'));const __one=args.tab?__ofs.find(t=>t.id===args.tab):__ofs.length===1?__ofs[0]:null;
let ot=__one;
if(!ot){out.note=__ofs.length?'order forms '+__ofs.length+' open — pass args.tab':'no order-form tab open';return out;}
let pp=list.find(t=>t.kind==='popup'&&t.openerId===ot.id);
if(!pp)pp=list.find(t=>t.kind==='popup'&&t.url&&/addresses/.test(t.url));
if(!pp){
  await tabs.switch(ot.id);await sleep(300);
  let g0=await G();
  let m0=g0.tree.match(/^\[(\d+)\] button "배송지 변경"/m);
  if(!m0)m0=g0.tree.match(/^\[(\d+)\] (?:button|link) "[^"]*배송지[^"]*(변경|추가)[^"]*"/m);
  if(!m0){out.note='배송지 변경 버튼 없음';return out;}
  await C(parseInt(m0[1]));await W('배송지',8000);await sleep(800);
  list=await tabs.list();
  pp=list.find(t=>t.kind==='popup'&&t.openerId===ot.id)||list.find(t=>t.kind==='popup'&&t.url&&/addresses/.test(t.url));
}
if(!pp){out.note='배송지 팝업 못 찾음';return out;}
await tabs.switch(pp.id);await W('배송지',8000);
let g=await G();
if(!/name=address1/.test(g.tree)){
  let m=g.tree.match(/^\[(\d+)\] (?:link|button) "[^"]*배송지 추가[^"]*"/m);
  if(!m){out.note='배송지 추가하기 링크 없음';return out;}
  C(parseInt(m[1]));g=await P(/name=address1/,8000);
}
const nM=g.tree.match(/^\[(\d+)\] textbox name=name/m);
const mM=g.tree.match(/^\[(\d+)\] textbox name=(?:mobile|phone|tel)\b/m);
if(mM)out.phone_field_ids.push(parseInt(mM[1]));
if(nM)await T(parseInt(nM[1]),args.name);
if(mM)await T(parseInt(mM[1]),'');
await sleep(200);
const at=toks(args.address);
const qs=[at.slice(0,at.findIndex(t=>/^\d/.test(t))+1).join(' ')||args.address,args.address,args.postal_code].filter(q=>q&&(''+q).trim());
const bad=/(취소|검색|영문보기|더보기|지도|확인|안내)/;
const dbg=[];
for(const q of [...qs,...qs]){
  g=await G();
  if(/name=address1 value="[^"]+"/.test(g.tree))break;
  let kM=g.tree.match(/\[(\d+)\] textbox "[^"]*" name=region_name/);
  if(!kM){
    let sM=g.tree.match(/^\[(\d+)\] button "[^"]*주소[^"]*(찾기|검색)[^"]*"/m);
    if(sM){await C(parseInt(sM[1]));g=await P(/name=region_name/,5000);kM=g.tree.match(/\[(\d+)\] textbox "[^"]*" name=region_name/);}
  }
  if(!kM){dbg.push('검색창 없음');break;}
  await T(parseInt(kM[1]),''+q);await sleep(200);
  g=await G();
  const sb=g.tree.match(/\[(\d+)\] button "검색"/);
  if(sb)await C(parseInt(sb[1]));
  g=await P(/검색 결과 보기|검색 결과가 없|결과가 없습니다|name=address1 value="[^"]+"/,9000);
  const re=/\[(\d+)\] button "([^"]+)"/g;let bm,best=null;
  while((bm=re.exec(g.tree))){
    const id=parseInt(bm[1]),lb=bm[2];
    if(id<parseInt(kM[1])||bad.test(lb)||/^\d+$/.test(lb))continue;
    const lt=nrm(lb).split(' ');
    const sc=lt.filter(t=>at.indexOf(t)>=0).length+(/(로|길)\s?\d/.test(nrm(lb))?1:0);
    if(sc>=2&&(!best||sc>best.sc))best={id,sc};
  }
  if(best){await C(best.id);await P(/name=address1 value="[^"]+"/,8000);}
  g=await G();
  const hit=/name=address1 value="[^"]+"/.test(g.tree);
  dbg.push('q'+dbg.length+(best?':점수'+best.sc:/결과가 없/.test(g.tree)?':결과없음':':후보없음')+(hit?':OK':''));
  if(hit)break;
}
g=await G();
const zM=g.tree.match(/\[(\d+)\] textbox name=(?:zipcode1|zipcode|postcode)[^\n]*value="([^"]*)"/);
if(zM&&!zM[2]&&args.postal_code){await T(parseInt(zM[1]),''+args.postal_code);g=await G();}
let aM=g.tree.match(/\[(\d+)\] textbox name=address1 value="([^"]*)"/);
if(aM&&nrm(aM[2])!==nrm(args.address)&&args.address){
  await T(parseInt(aM[1]),args.address);await sleep(200);g=await G();
  aM=g.tree.match(/\[(\d+)\] textbox name=address1 value="([^"]*)"/);
}
let base=aM?aM[2]:'';
let dt=(args.address_detail||args.memo||'').trim();
if(!dt&&base){
  const i=nrm(args.address).indexOf(nrm(base));
  dt=i>=0?args.address.replace(base,'').replace(/^[\s,]+/,'').trim():at.filter(t=>nrm(base).split(' ').indexOf(t)<0).join(' ');
}
const a2=g.tree.match(/^\[(\d+)\] textbox name=address2/m);
if(a2)await T(parseInt(a2[1]),dt);
await sleep(200);g=await G();
const nV=g.tree.match(/\[(\d+)\] textbox name=name value="([^"]*)"/);
const aV=g.tree.match(/\[(\d+)\] textbox name=address1 value="([^"]*)"/);
const d2=g.tree.match(/\[(\d+)\] textbox name=address2 value="([^"]*)"/);
out.name=nV?nV[2]:null;
out.address=aV?((aV[2]+' '+(d2?d2[2]:'')).trim()):null;
out.ok=!!(out.name&&aV&&aV[2]);
if(!out.ok)out.note='주소 입력 실패('+(!nV?'이름칸 없음 ':'')+(!aV?'주소칸 없음 ':aV[2]?'':'주소 빈칸 ')+dbg.join(',')+')';
return out;