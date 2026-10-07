const out={ok:false,found:false,name:null,address:null,note:null};
async function G(o){for(let i=0;i<6;i++){try{return await page.get(o||{});}catch(e){await sleep(400);}}throw new Error('busy');}
async function C(id){try{return await page.click(id);}catch(e){return 'warn';}}
async function CX(id,ms){const p=C(id);p.catch&&p.catch(()=>{});await Promise.race([p,sleep(ms||2500)]);}
const nm=String(args.name||'').trim();const ad=String(args.address||'').trim();const dt=String(args.address_detail||'').trim();
const toks=ad.split(/[\s,]+/).filter(t=>t.length>=2);
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const nmRe=new RegExp(nm.split('').map(esc).join('[*xX·]?'));
const nmMask=nm.length>1?new RegExp('^'+esc(nm[0])+'[*xX]'+(nm.length>2?esc(nm[nm.length-1]):'')+'$'):/$^/;
let list=await tabs.list();
const __ofs=list.filter(t=>t.url&&t.url.includes('/order/order-form'));const __one=args.tab?__ofs.find(t=>t.id===args.tab):__ofs.length===1?__ofs[0]:null;
let orderTab=__one;
if(!orderTab){out.note=__ofs.length?'order forms '+__ofs.length+' open — pass args.tab':'no order-form tab open';return out;}
let popup=list.find(t=>t.kind==='popup'&&/address/i.test(t.url||''));
if(!popup){
  await tabs.switch(orderTab.id);
  const mb=(await G({interactive:true})).tree.match(/^\[(\d+)\] (?:button|link|clickable) "(?:배송지 변경|변경)"/m);
  if(!mb){out.note='배송지 변경 버튼 없음';return out;}
  await CX(parseInt(mb[1]),4000);
  for(let i=0;i<16;i++){await sleep(250);list=await tabs.list();
    popup=list.find(t=>t.kind==='popup'&&/address/i.test(t.url||''))||list.find(t=>t.kind==='popup');
    if(popup)break;}
}
if(!popup){out.note='배송지 팝업 못 찾음';return out;}
await tabs.switch(popup.id);
try{await page.waitFor('배송지 추가하기',8000);}catch(e){}
function rowsFrom(g){
  const lines=g.tree.split('\n');const ids=[];
  for(let i=0;i<lines.length;i++){
    if(!/^\[\d+\] (?:button|clickable) "수정"/.test(lines[i]))continue;
    // 수정 바로 앞의 행 clickable 을 거슬러 찾는다(변경하기·검색어 삭제 버튼이 끼어도 건너뜀)
    for(let j=i-1;j>=Math.max(0,i-5);j--){
      const m=lines[j].match(/^\[(\d+)\] clickable/);
      if(m){ids.push(parseInt(m[1]));break;}
      if(/^\[\d+\] button "(?:수정|삭제)"/.test(lines[j]))break;
    }
  }
  let tx=g.tree.split('PAGE TEXT:')[1]||'';
  const a=tx.indexOf('배송지 추가하기');if(a>=0)tx=tx.slice(a+8);
  const ch=tx.split(/수정/).map(s=>s.replace(/^\s*삭제/,'').trim());
  return ids.map((id,i)=>({id,tx:(ch[i]||'').replace(/\s+/g,' ')}));
}
function pick(rs,needName){
  let best=null,bs=-1;
  for(const r of rs){
    const t=r.tx,first=(t.split(' ')[0]||'');
    const nameOk=!!nm&&(t.includes(nm)||nmRe.test(t)||nmMask.test(first));
    if(needName&&!nameOk)continue;
    const hit=toks.filter(k=>t.includes(k)).length;
    if(!needName&&toks.length&&hit<Math.max(2,toks.length-1))continue;
    const s=hit+(nameOk?2:0)+(dt&&t.includes(dt)?1:0);
    if(s>bs){bs=s;best=r;}
  }
  if(best&&needName&&toks.length&&bs<3)best=null;
  return best;
}
async function search(q){
  let g=await G({interactive:true});
  const cl=g.tree.match(/^\[(\d+)\] button "입력한 검색어 삭제"/m);
  if(cl){await CX(parseInt(cl[1]),1500);await sleep(300);g=await G({interactive:true});}
  const sb=g.tree.match(/^\[(\d+)\] (?:textbox|searchbox) "[^"]*검색[^"]*"/m);
  if(!sb)return null;
  try{await page.type(parseInt(sb[1]),q);}catch(e){return null;}
  const btn=(await G({interactive:true})).tree.match(/^\[(\d+)\] button "검색[^"]*"/m);
  if(btn)await CX(parseInt(btn[1]),2000);
  await sleep(600);return await G({query:q});
}
let fb=false;
let best=pick(rowsFrom(await G({interactive:true,query:nm})),true);
if(!best){const key=toks.filter(t=>/[0-9]/.test(t)||t.length>=3).slice(-2).join(' ')||ad;
  for(const q of [nm,key]){if(!q)continue;const g=await search(q);if(!g)break;
    const rs=rowsFrom(await G({interactive:true,query:q}));best=pick(rs,true);if(!best){best=pick(rs,false);if(best)fb=true;}if(best)break;}}
if(!best){out.note='목록에 맞는 배송지 없음';return out;}
out.found=true;
const pickedName=(best.tx.replace(/^(?:기본 배송지|최근 사용)\s*/,'').split(' ')[0]||'');
const pickedFirst=(best.tx.split(' ')[0]||'');
await CX(best.id,2500);await sleep(300);
let cm=(await G({query:'변경하기',interactive:true})).tree.match(/^\[(\d+)\] (?:button|link|clickable) "(?:변경하기|선택하기|선택|적용)"/m);
if(!cm)cm=(await G({interactive:true})).tree.match(/^\[(\d+)\] (?:button|link|clickable) "(?:변경하기|선택하기|선택|적용)"/m);
if(cm)await CX(parseInt(cm[1]),3000);else out.note='변경하기 버튼 없음';
for(let i=0;i<10;i++){await sleep(250);list=await tabs.list();if(!list.find(t=>t.id===popup.id))break;}
await tabs.switch(orderTab.id);
try{await page.waitFor('배송지 변경',8000);}catch(e){}
let tx='';
for(let k=0;k<6;k++){
  tx=((await G({query:'배송지'})).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
  const mm=tx.match(/주문서\s+(.{1,20}?)\s*(?:기본 배송지|최근 사용)*\s*배송지 변경/);
  if(!nm||(mm&&(mm[1].trim()===nm||nmRe.test(mm[1])||nmMask.test(mm[1].trim()))))break;
  await sleep(500);
}
const m2=tx.match(/주문서\s+(.{1,20}?)\s*(?:기본 배송지|최근 사용)*\s*배송지 변경\s+(.+?)\s+0\d{1,2}-\d{3,4}-\d{4}/);
if(m2){out.name=m2[1].trim();out.address=m2[2].trim();}
else{out.name=(nm&&(tx.includes(nm)||nmRe.test(tx)))?nm:null;
  out.address=toks.filter(t=>tx.includes(t)).length>=Math.min(2,toks.length)?ad:null;}
const hit2=toks.filter(t=>(out.address||'').includes(t)).length;
let nOk=!nm||out.name===nm||nmRe.test(out.name||'')||nmMask.test(out.name||'');
if(!nOk&&fb&&out.name&&pickedName&&(out.name===pickedName||out.name===pickedFirst)){nOk=true;out.note='이름 배송지 없어 주소 일치 행 선택: '+out.name;}
out.ok=!!(out.address&&hit2>=Math.max(2,toks.length-1)&&nOk);
if(!out.ok&&!out.note)out.note='주문서 되읽기 불일치';
return out;