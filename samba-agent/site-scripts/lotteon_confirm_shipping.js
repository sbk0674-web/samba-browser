// 롯데온 선물 주문서의 '새 배송지 등록' 폼(이름·전화·주소가 채워진 상태)을 저장 → 방금 저장한 배송지 선택 → 선택완료 → 빠른 선물 켬 → 주문서 되읽기.
// 직배 주문서(선물 시트 아님)면 set_shipping 이 이미 저장했으므로 주문서 되읽기만 한다. args: name, address, profile
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o;}
const G=async(q,sel)=>page.get(q?{query:q}:(sel?{selector:sel,interactive:true}:{}));
const els=async(q,sel)=>pe((await G(q,sel)).tree);
const text=async sel=>((await G(null,sel)).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');const addr=String(A.address||'').trim();
const R={ok:false,name:null,address:null,note:null};
const dlg=await els(null,'[role=dialog]');
// 저장 버튼이 [role=dialog] 밖(시트 아래)에 그려지기도 한다(실기 2026-09-30) — 창 안에 없으면 전체에서 찾는다
const svb=async()=>(await els(null,'[role=dialog]')).find(e=>e.role==='button'&&e.text==='저장')||(await els('저장')).find(e=>e.role==='button'&&e.text==='저장');
const saved=dlg.length>0&&!!(await svb());
if(saved){
  // (필수) 동의 칸은 등록 창 안쪽이라 첫 [role=dialog] 목록에 안 잡힌다 — 전체에서 찾는다(안 누르면 '필수 약관 항목에 동의해 주세요' 알림으로 저장 안 됨, 실기 2026-09-30)
  const req=(await els('(필수)')).filter(e=>e.role==='checkbox'&&/\(필수\)/.test(e.text));
  const reqs=req.length?req:dlg.filter(e=>e.role==='checkbox'&&/\(필수\)/.test(e.text));
  for(const c of reqs.filter(e=>e.value!=='on'))await page.click(c.id);
  const sv=await svb();
  await page.click(sv.id);await sleep(4000);
  let L=await els(null,'[role=dialog]');
  // 목록 라벨은 배송지 별칭일 수 있다 — 라벨에 없으면 목록 안 모든 글자에서 받는 분 이름을 찾는다(실기 2026-09-30)
  const fl=()=>{let x=L.filter(e=>e.role==='label'&&e.text.includes(name));if(!x.length)x=L.filter(e=>e.role!=='radio'&&e.text&&e.text.includes(name));return x;};
  let labs=fl();
  // 목록이 늦게 갱신되면 새 항목이 아직 없다 — 한 번 더 읽는다. 그래도 없으면 도로명+번호로 찾는다(주문서 이름 검사가 뒤에서 다시 거른다)
  if(!labs.length){await sleep(2500);L=await els(null,'[role=dialog]');labs=fl();}
  const rd=addr.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);
  if(!labs.length&&rd)labs=L.filter(e=>e.role!=='radio'&&e.text&&e.text.replace(/\s+/g,'').includes(rd[1]+rd[2]));
  if(!labs.length){const vt=await text();const er=(vt.match(/[^ ]{0,12}\s?[^ ]{0,12}\s?(?:입력해|선택해|확인해|동의해)\s?주세요/)||[''])[0];return{...R,note:'저장 뒤 목록에 없음'+(er?' — '+er:'')+' 첫 라벨 형태: '+((L.find(e=>e.role==='label')||{}).text||'').replace(/[가-힣]/g,'가').replace(/\d/g,'0').slice(0,60)+' / 첫 라디오: '+((L.find(e=>e.role==='radio')||{}).text||'').replace(/[가-힣]/g,'가').replace(/\d/g,'0').slice(0,60)+' / 새 등록 입력칸 '+(await els(null,'[role=dialog]')).filter(e=>e.role==='textbox').length+'개'};}
  const lid=labs[labs.length-1].id;const rid=Math.max(...L.filter(e=>e.role==='radio'&&e.id<lid).map(e=>e.id),0);
  if(rid){await page.click(rid);await sleep(800);const rv=(await els(null,'[role=dialog]')).find(e=>e.id===rid);if(!rv||rv.value!=='on'){await page.click(lid);await sleep(800);}}
  const done=(await els('선택완료')).find(e=>e.role==='button'&&e.text==='선택완료');
  // 직배 주문서는 저장하면 바로 반영되고 선택완료가 없다 — 없으면 주문서 되읽기로 넘어간다(실기 2026-09-30)
  if(done){await page.click(done.id);await sleep(3000);}else await sleep(1500);
}
const tx=await text();
// 선물 주문서가 아닌 일반(직배) 주문서: 배송지 창이 열린 채면 화면 글자에 주소록(방금 저장한 항목 포함)이 섞여, 실제 배송지는
// 기본 주소인데도 통과한다(실기 2026-09-30 쿠팡 737393619370002: 직배인데 사무실로 갔다). 창이 닫힌 주문서에서 이름과 도로명+번호를 함께 본다
if(!/받는 분 주소로 보내기/.test(tx)){
  if((await els(null,'[role=dialog]')).length)return{...R,note:'배송지 창이 닫히지 않음 — 주문서 배송지 확인 불가'};
  const rd2=addr.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);
  if(tx.includes(name)&&rd2&&!tx.replace(/\s+/g,'').includes(rd2[1]+rd2[2]))return{...R,note:'주문서에 받는 분 주소 없음(이름만 있음) — 배송지가 바뀌지 않았다'};
}
if(!tx.includes(name))return{...R,note:'주문서에 받는 분 이름 없음'+(saved?'(저장 창 거침)':'(저장 창 없음)')+(tx.includes(name.slice(0,2))?'(앞 두 글자는 있음)':'')+(/받는 분 주소로 보내기/.test(tx)?'(선물 주문서)':'')+' 창'+dlg.length+' 저장버튼 '+(await els('저장')).filter(e=>e.role==='button').map(e=>e.text).slice(0,3).join('/')+' 배송지칸 '+(/새 ?배송지|배송지 ?(선택|변경)/.exec(tx)||[''])[0]};
let cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');
if(cb){
  if(cb.value!=='on'){await page.click(cb.id);for(let k=0;k<8&&(!cb||cb.value!=='on');k++){await sleep(800);cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');}}
  if(!cb||cb.value!=='on')return{...R,name:name0,address:addr,note:'빠른 선물 못 켬'};
}
return{ok:true,name:name0,address:addr,note:null,quick_gift:!!cb};
