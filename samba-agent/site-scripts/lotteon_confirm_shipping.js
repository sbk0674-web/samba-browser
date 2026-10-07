function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o;}
const G=async(q,sel)=>page.get(q?{query:q}:(sel?{selector:sel,interactive:true}:{}));
const els=async(q,sel)=>pe((await G(q,sel)).tree);
const text=async sel=>((await G(null,sel)).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');const addr=String(A.address||'').trim();
const R={ok:false,name:null,address:null,note:null};
const dlg=await els(null,'[role=dialog]');
const svb=async()=>(await els(null,'[role=dialog]')).find(e=>e.role==='button'&&e.text==='저장')||(await els('저장')).find(e=>e.role==='button'&&e.text==='저장');
const saved=dlg.length>0&&!!(await svb());
let opened=false;
if(saved){
  const req=(await els('(필수)')).filter(e=>e.role==='checkbox'&&/\(필수\)/.test(e.text));
  const reqs=req.length?req:dlg.filter(e=>e.role==='checkbox'&&/\(필수\)/.test(e.text));
  for(const c of reqs.filter(e=>e.value!=='on'))await page.click(c.id);
  const sv=await svb();
  await page.click(sv.id);await sleep(4000);
}else if(!dlg.length){
  // 창이 닫혀 있고 선물 주문서에 받는 분 이름이 없으면 배송지 선택하기로 목록을 다시 연다(저장은 이미 됐을 수 있다, 실기 2026-10-07)
  const t0=await text();
  if(/받는 분 주소로 보내기/.test(t0)&&!t0.includes(name)){
    const ob=(await els('배송지 선택하기')).find(e=>e.role==='button'&&/배송지 ?(선택|변경)/.test(e.text));
    if(ob){await page.click(ob.id);await sleep(2500);opened=true;}
  }
}
if(saved||opened||(await els(null,'[role=dialog]')).some(e=>e.role==='radio'&&/배송지/.test(e.text))){
  let L=await els(null,'[role=dialog]');
  const fl=()=>{let x=L.filter(e=>e.role==='label'&&e.text.includes(name));if(!x.length)x=L.filter(e=>e.role!=='radio'&&e.text&&e.text.includes(name));return x;};
  // 창 목록 읽기가 길이 제한으로 잘려 새 항목이 빠질 수 있다 — 글자 검색으로 라벨을 따로 찾는다(실기 2026-10-07)
  const fq=async()=>(await els(name)).filter(e=>e.role==='label'&&e.text.includes(name));
  let viaQuery=false;
  let labs=fl();
  if(!labs.length){await sleep(2000);L=await els(null,'[role=dialog]');labs=fl();}
  if(!labs.length){labs=await fq();viaQuery=labs.length>0;}
  const rd=addr.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);
  if(!labs.length&&rd)labs=L.filter(e=>e.role!=='radio'&&e.text&&e.text.replace(/\s+/g,'').includes(rd[1]+rd[2]));
  if(!labs.length){const vt=await text();const er=(vt.match(/[^ ]{0,12}\s?[^ ]{0,12}\s?(?:입력해|선택해|확인해|동의해)\s?주세요/)||[''])[0];return{...R,note:'저장 뒤 목록에 없음'+(er?' — '+er:'')+' 라벨수 '+L.filter(e=>e.role==='label').length};}
  const lid=labs[labs.length-1].id;
  if(viaQuery){await page.click(lid);await sleep(1000);}
  else{const rid=Math.max(...L.filter(e=>e.role==='radio'&&e.id<lid).map(e=>e.id),0);
  if(rid){await page.click(rid);await sleep(800);const rv=(await els(null,'[role=dialog]')).find(e=>e.id===rid);if(!rv||rv.value!=='on'){await page.click(lid);await sleep(800);}}}
  const done=(await els('선택완료')).find(e=>e.role==='button'&&e.text==='선택완료');
  if(done){await page.click(done.id);await sleep(3000);}else await sleep(1500);
}
const tx=await text();
const rd2=addr.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);
if(!/받는 분 주소로 보내기/.test(tx)){
  if((await els(null,'[role=dialog]')).length)return{...R,note:'배송지 창이 닫히지 않음 — 주문서 배송지 확인 불가'};
  if(tx.includes(name)&&rd2&&!tx.replace(/\s+/g,'').includes(rd2[1]+rd2[2]))return{...R,note:'주문서에 받는 분 주소 없음(이름만 있음) — 배송지가 바뀌지 않았다'};
}else if(rd2&&!(await els(null,'[role=dialog]')).length){
  const cut=tx.search(/회사소개|롯데쇼핑 주식회사/);const body=cut>0?tx.slice(0,cut):tx;
  const flat=body.replace(/\s+/g,'');const roads=flat.match(/[가-힣A-Za-z0-9.]+(?:로|길)\d+(?:-\d+)?/g)||[];
  if(roads.length&&!flat.includes(rd2[1]+rd2[2]))return{...R,note:'선물 주문서의 받는 분 주소가 주문 주소와 다르다('+roads[0].replace(/\d/g,'0')+') — 배송지 다시 확인'};
}
if(!tx.includes(name))return{...R,note:'주문서에 받는 분 이름 없음'+(saved?'(저장 창 거침)':'(저장 창 없음)')+(opened?'(목록 재오픈)':'')+(tx.includes(name.slice(0,2))?'(앞 두 글자는 있음)':'')+(/받는 분 주소로 보내기/.test(tx)?'(선물 주문서)':'')+' 창'+dlg.length+' 배송지칸 '+(/새 ?배송지|배송지 ?(선택|변경)/.exec(tx)||[''])[0]};
let cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');
if(cb){
  if(cb.value!=='on'){await page.click(cb.id);for(let k=0;k<8&&(!cb||cb.value!=='on');k++){await sleep(800);cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');}}
  if(!cb||cb.value!=='on')return{...R,name:name0,address:addr,note:'빠른 선물 못 켬'};
}
return{ok:true,name:name0,address:addr,note:null,quick_gift:!!cb};