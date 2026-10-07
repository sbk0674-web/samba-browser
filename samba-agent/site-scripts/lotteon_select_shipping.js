// 롯데온 선물 주문서: '받는 분 주소로 보내기' → 배송지 선택 창에서 이름·도로명이 같은 기존 배송지를 고르고 선택완료 → 빠른 선물 켬.
// 직배 주문서(선물 시트 아님)면 ok:false(기존 선택 없음 — set_shipping 이 맡는다). args: name, address, address_detail, profile
// 반환 {ok, name, address, note}. 이름의 '*' 은 롯데온이 거부해 'O' 로 저장돼 있다 — 대조는 원래 이름으로 돌려준다
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o;}
const G=async(q,sel)=>page.get(q?{query:q}:(sel?{selector:sel,interactive:true}:{}));
const els=async(q,sel)=>pe((await G(q,sel)).tree);
const text=async sel=>((await G(null,sel)).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');
const addr=String(A.address||'').trim();const det=String(A.address_detail||'').trim();
const full=det.startsWith(addr)?det:addr;
const m=full.match(/^(.*?(?:로|길)\s+\d+(?:-\d+)?)(?![\d-])/)||full.match(/^(.*?(?:로|길)\d+(?:-\d+)?)(?![\d-])/);
const road=(m?m[1]:addr).replace(/\s/g,'').slice(-8);
const R={ok:false,name:null,address:null,note:null};
if(!name||!addr)return{...R,note:'name/address missing'};
const rr=(await els('받는 분 주소로 보내기')).filter(e=>e.role==='radio'&&/주소로/.test(e.text));
let b=null;
if(rr.length){
  await page.click(rr[0].id);await sleep(1500);
  b=(await els('배송지 선택하기')).find(e=>e.role==='button'&&/배송지 선택하기/.test(e.text))||(await els('배송지 수정하기')).find(e=>e.role==='button'&&/배송지 수정하기/.test(e.text));
}else{
  // 직배 주문서 — '변경'(배송지, 첫 번째) 으로 같은 배송지 목록을 연다. 이미 있는 배송지를 또 만들지 않는다(사용자 2026-10-07:
  // 기본주소가 있는데 시도마다 같은 이름의 배송지가 하나씩 늘었다)
  b=(await els('변경')).filter(e=>/^(배송지\s*)?변경$/.test(String(e.text).trim())&&e.role==='button').sort((x,y)=>x.id-y.id)[0]||null;
  if(!b)return{...R,note:'선물 주문서 아님(받는 분 주소로 보내기 없음)'};
  R.direct=true;
}
if(!b)return{...R,note:'배송지 선택 버튼 없음'};
await page.click(b.id);await sleep(2500);
let L=await els(null,'[role=dialog]');let tx=await text('[role=dialog]');
// 창 글자가 목록을 다 못 담으면(실기 2026-09-30) 페이지 전체 글자에서 도로명을 본다
if(!tx.includes(name))tx=await text();
const labs=L.filter(e=>e.role==='label'&&e.text.includes(name));
if(!(labs.length&&tx.replace(/\s/g,'').includes(road))){
  const c=L.find(e=>e.role==='button'&&e.text==='닫기');if(c)await page.click(c.id);
  return{...R,note:'목록에 같은 배송지 없음(이름 라벨 '+labs.length+'개, 이름 글자 '+(tx.split(name).length-1)+'곳, 도로명 '+(tx.replace(/\s/g,'').includes(road)?'있음':'없음 '+road.replace(/[가-힣]/g,'가').replace(/\d/g,'0'))+')'};
}
const lid=labs[labs.length-1].id;const rid=Math.max(...L.filter(e=>e.role==='radio'&&e.id<lid).map(e=>e.id),0);
if(!rid)return{...R,note:'배송지 라디오 없음'};
await page.click(rid);await sleep(800);
// 라디오가 안 눌리면(숨은 input) 이름 라벨을 누른다(실기 2026-09-30: 선택완료 뒤에도 '배송지 선택하기' 그대로)
const rv=(await els(null,'[role=dialog]')).find(e=>e.id===rid);if(!rv||rv.value!=='on'){await page.click(lid);await sleep(800);}
if(R.direct){
  // 직배 배송지 창은 라디오를 누르는 순간 주문서에 반영된다(선택완료 버튼 없음, 실기 2026-10-07) — 켜졌는지 보고 창을 닫는다
  const on=(await els(null,'[role=dialog]')).find(e=>e.id===rid||e.id===lid);
  const chk=(await els(null,'[role=dialog]')).filter(e=>e.role==='radio'&&e.value==='on');
  if(!chk.some(e=>e.id>=Math.min(rid,lid)-1&&e.id<=lid+1))return{...R,note:'직배 배송지 라디오가 안 켜졌다'};
  const cl=(await els(null,'[role=dialog]')).find(e=>e.role==='button'&&e.text==='닫기')||(await els('닫기')).find(e=>e.role==='button'&&e.text==='닫기');
  if(cl){await page.click(cl.id);await sleep(2500);}
  const dt=(await text()).replace(/\s/g,'');
  if(!dt.includes(road))return{...R,note:'직배 주문서에 고른 배송지가 안 보인다'};
  return{ok:true,name:name0,address:addr,address_detail:det||null,note:null,direct:true,picked_existing:true};
}
const done=(await els('선택완료')).find(e=>e.role==='button'&&e.text==='선택완료');
if(!done)return{...R,note:'선택완료 없음'};
await page.click(done.id);await sleep(3000);
// 롯데온이 '선물 보내기 불가한 지역입니다' 로 거절하면 선택이 반영되지 않는다(실기 2026-10-07 경북 문경시 동로면) —
// 이름이 없다는 일반 실패와 구분해 돌려준다(하네스가 그 지역을 기억하고 직배 주문서로 다시 산다)
const gdlg=await text('[role=dialog]');
if(/선물 ?보내기 ?불가/.test(gdlg)||/선물 ?보내기 ?불가/.test(await text())){const c=(await els(null,'[role=dialog]')).find(e=>e.role==='button'&&e.text==='닫기');if(c)await page.click(c.id);return{...R,gift_blocked:true,note:'선물 보내기 불가 지역'};}
tx=await text();
if(!tx.includes(name)){const mk=name[0]+'*'+name.slice(2),i=tx.indexOf('받는 분');if(tx.includes(mk))R.masked=1;return{...R,note:'선택 뒤 주문서에 받는 분 이름 없음(가린 이름 '+(tx.split(mk).length-1)+'곳, 성+별표 '+(tx.split(name[0]+'*').length-1)+'곳, 도로명 '+(tx.replace(/\s/g,'').includes(road)?'있음':'없음')+') '+(()=>{const j=tx.indexOf('주소로 보내기');return tx.slice(j,j+160).replace(/[가-힣]/g,c=>'받는분주소로보내기배송지선택하기수정빠른선물휴대폰번호'.includes(c)?c:'○').replace(/\d/g,'0')})()};return{...R,note:'선택 뒤 주문서에 받는 분 이름 없음 — '+(i<0?'받는 분 글자 없음':tx.slice(i,i+40).replace(/[가-힣]/g,'가').replace(/\d/g,'0'))};}
if(R.direct)return{ok:true,name:name0,address:addr,address_detail:det||null,note:null,direct:true};
let cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');
if(cb&&cb.value!=='on'){await page.click(cb.id);for(let k=0;k<8&&(!cb||cb.value!=='on');k++){await sleep(800);cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');}}
if(!cb||cb.value!=='on')return{...R,name:name0,address:addr,note:'빠른 선물 못 켬'};
return{ok:true,name:name0,address:addr,address_detail:det||null,note:null,quick_gift:true};
