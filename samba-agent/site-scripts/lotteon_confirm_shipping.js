function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o;}
const G=async(q,sel)=>page.get(q?{query:q}:(sel?{selector:sel,interactive:true}:{}));
const els=async(q,sel)=>pe((await G(q,sel)).tree);
const text=async sel=>((await G(null,sel)).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const A=args||{};const name0=String(A.name||'').trim();let name=name0.replace(/\*/g,'O');const addr=String(A.address||'').trim();
// 받는 분 칸은 한글·영어·숫자만 허용 — 괄호 등 특수문자 제거한 이름을 저장 이름으로 쓴다
const nameS=name.replace(/[^가-힣A-Za-z0-9]/g,'');const nameP=name.split(/[(\[]/)[0].replace(/[^가-힣A-Za-z0-9]/g,'');
let cand=[name,nameS];
const mk=n=>n.length>2?[n[0]+'*'+n.slice(2),n.slice(0,-1)+'O',n[0]+'O'+n.slice(2)]:[n];
const mkc=()=>[...new Set(cand.flatMap(n=>[n,...mk(n)]).filter(n=>n&&n.length>=2))];
let hasName=t=>mkc().some(n=>t.includes(n));
const R={ok:false,name:null,address:null,note:null};
// 같은 이름 배송지가 여럿이면 주소로 고르고, 선택 뒤 주문서 시군구를 되읽어 검증(2026-10-23 여수 오배송)
const NS=s=>String(s||'').replace(/\s+/g,'');
const rk=addr.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);const roadKey=rk?NS(rk[1]+rk[2]):'';
const jk=rk?null:addr.match(/([가-힣]+(?:동|리|가))\s+(\d+(?:-\d+)?)/);const jibKey=jk?NS(jk[1]+jk[2]):'';
const gus=(addr.match(/[가-힣]{1,6}(?:시|군|구)(?=\s)/g)||[]).filter(k=>!/(특별자치|광역|특별)시$/.test(k));
const addrHit=t=>{const n=NS(t);return (roadKey&&n.includes(roadKey))||(jibKey&&n.includes(jibKey))||gus.some(g=>n.includes(g));};
// 이미 주문서에 'TO. 이름' 으로 반영돼 있으면 저장 단계 생략(남은 숨은 창 때문에 재저장 방지)
const t00=await text();
const to=(t00.match(/TO\. (.{1,40}?) 배송비/)||[])[1]||'';
const already=!!to&&hasName(to)&&!/배송지 선택하기/.test(t00);
let tx='';let named=false;let saved=false;let opened=false;let dlg=[];
const regForm=async()=>{const L=await els(null,'[role=dialog]');const segs=[];let cur=null;
  for(const e of L){if(e.role==='dialog'){cur=/^배송지 등록/.test(e.text)?{els:[]}:null;if(cur)segs.push(cur);}else if(cur)cur.els.push(e);}
  const ok=segs.filter(s=>s.els.some(e=>e.role==='button'&&e.text==='저장'));
  const filled=ok.filter(s=>s.els.some(e=>e.role==='textbox'&&e.value&&e.text==='주소')&&s.els.some(e=>e.role==='textbox'&&!e.text&&/[가-힣]/.test(e.value||'')));
  return {L,form:(filled.length?filled:ok).pop()||null};};
const regForm2=async()=>{const m=new Map();for(const q of ['저장','필수','휴대폰 번호','받는 분']){for(const e of await els(q))m.set(e.id,e);}
  const all=[...m.values()].sort((a,b)=>a.id-b.id);const ds=all.filter(e=>e.role==='dialog'&&/^배송지 등록/.test(e.text));
  const segs=ds.map((d,i)=>({els:all.filter(e=>e.id>d.id&&e.id<(ds[i+1]?ds[i+1].id:1e9)&&e.role!=='dialog')})).filter(s=>s.els.some(e=>e.role==='button'&&e.text==='저장'));
  const filled=segs.filter(s=>s.els.some(e=>e.role==='textbox'&&/받는 분/.test(e.text)&&/[가-힣]/.test(e.value||'')));
  return (filled.length?filled:segs).slice(-1)[0]||null;};
const regOpen=d=>d.some(e=>e.role==='dialog'&&/^배송지 등록/.test(e.text));
const isOpen=async()=>(await els(null,'[role=dialog]')).some(e=>e.role==='radio'&&/배송지/.test(e.text));
const openList=async()=>{const ob=(await els('배송지 선택하기')).find(e=>e.role==='button'&&/배송지 ?(선택|변경)/.test(e.text));
  if(ob){await page.click(ob.id);for(let k=0;k<6;k++){await sleep(700);if(await isOpen())break;}return true;}return false;};
const pick=async()=>{
  let labs=[];const qn=nameS||name;
  for(let k=0;k<3&&!labs.length;k++){labs=(await els(qn)).filter(e=>e.role==='label'&&hasName(e.text));if(!labs.length)await sleep(1000);}
  if(!labs.length){
    const L=await els(null,'[role=dialog]');
    const rd=addr.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);
    if(rd)labs=L.filter(e=>e.role!=='radio'&&e.text&&e.text.replace(/\s+/g,'').includes(rd[1]+rd[2]));
  }
  if(!labs.length){const vt=await text();const er=(vt.match(/[^ ]{0,12}\s?[^ ]{0,12}\s?(?:입력해|선택해|확인해|동의해)\s?주세요/)||[''])[0];return{...R,note:'저장 뒤 목록에 없음'+(er?' — '+er:'')+(saved?'(저장 시도함)':'(저장 폼 못 찾음)')};}
  if(labs.length>1){const pref=labs.filter(e=>addrHit(e.text));if(pref.length)labs=pref;}
  const lid=labs[labs.length-1].id;
  for(let t=0;t<2;t++){
    await page.click(lid-2);await sleep(500);
    if(t===1)await page.click(lid);
    const done=(await els('선택완료')).filter(e=>e.role==='button'&&e.text==='선택완료').sort((a,b)=>b.id-a.id)[0];
    if(done){await page.click(done.id);await sleep(1200);}
    const tt=await text();
    if(hasName(tt)&&!/배송지 선택하기/.test(tt))break;
  }
  return null;
};
if(already){named=true;}
else{
  dlg=await els(null,'[role=dialog]');
  let form=null;
  if(regOpen(dlg)){form=(await regForm()).form;if(!form)form=await regForm2();}
  saved=!!form;
  if(saved){
    let nb=form.els.find(e=>e.role==='textbox'&&/받는 분/.test(e.text));
    if(!nb){const q=await els('받는 분');nb=q.find(e=>e.role==='textbox'&&/받는 분/.test(e.text));}
    if(nb){
      if(nb.value!==nameS&&nameS){await page.type(nb.id,nameS);await sleep(400);}
      const q=await els('받는 분');const nb2=q.find(e=>e.id===nb.id);
      cand.push((nb2&&nb2.value)||nameS,nameP);
    }
    const reqs=form.els.filter(e=>e.role==='checkbox'&&/\(필수\)/.test(e.text));
    for(const c of reqs){
      for(let t=0;t<3;t++){
        const q=await els('필수');
        const cur=q.find(e=>e.id===c.id);
        if(cur&&cur.value==='on')break;
        if(t===0)await page.click(c.id);
        else{const lb=q.find(e=>e.role==='label'&&e.text===c.text);if(lb)await page.click(lb.id);}
        await sleep(400);
      }
    }
    const pm=(await text('[role=dialog]')).match(/01\d-\d{3,4}-\d{4}/);
    const p=form.els.find(e=>e.role==='textbox'&&/휴대폰/.test(e.text));
    if(pm&&p&&!p.value){await page.type(p.id,pm[0].replace(/-/g,''));await sleep(400);}
    const sb=form.els.find(e=>e.role==='button'&&e.text==='저장');
    if(sb)await page.click(sb.id);
    for(let k=0;k<4;k++){await sleep(700);const cur=await els('저장');if(!cur.some(e=>e.id===(sb&&sb.id)))break;}
    await sleep(800);
  }else if(!dlg.length){
    if(/받는 분 주소로 보내기/.test(t00)&&!hasName(t00)){if(await openList())opened=true;}
  }
  if(saved&&!(await isOpen())){if(await openList())opened=true;}
  if(saved||opened||dlg.some(e=>e.role==='radio'&&/배송지/.test(e.text))){const r=await pick();if(r)return r;}
  for(let k=0;k<3;k++){tx=await text();if(hasName(tx))break;await sleep(1000);}
  named=hasName(tx);
  if(!named){
    const ob=(await els('배송지')).find(e=>e.role==='button'&&/배송지 ?(선택|변경|수정)/.test(e.text));
    if(ob){await page.click(ob.id);await sleep(1500);const r=await pick();if(r)return r;for(let k=0;k<3;k++){tx=await text();if(hasName(tx))break;await sleep(1000);}named=hasName(tx);}
  }
}
if(!named)return{...R,note:'주문서에 받는 분 이름 없음'+(saved?'(저장 창 거침)':'(저장 창 없음)')+(opened?'(목록 재오픈)':'')+(/받는 분 주소로 보내기/.test(tx)?'(선물 주문서)':'')};
{
  const vt=await text();
  const names=mkc();let at=-1;for(const n of names){const i=vt.indexOf(n);if(i>=0&&(at<0||i<at))at=i;}
  const zone=at>=0?vt.slice(at,at+500):vt;const zn=NS(zone);
  const seen=(zone.match(/[가-힣]{1,6}(?:시|군|구)(?=\s|\d)/g)||[]).filter(k=>!/(특별자치|광역|특별)시$/.test(k));
  const guOk=!gus.length||!seen.length?true:gus.some(g=>seen.includes(g));
  if(!guOk)return{...R,note:'받는 분 시군구 불일치('+seen.slice(0,3).join('/')+')'};
  if(roadKey&&!zn.includes(roadKey)&&/(로|길)\d/.test(zn))return{...R,note:'받는 분 도로명 불일치'};
  if(gus.length&&!seen.length&&!(roadKey&&zn.includes(roadKey))&&!(jibKey&&zn.includes(jibKey)))return{...R,note:'받는 분 주소 못 읽음'};
}
let cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');
if(cb){
  if(cb.value!=='on'){await page.click(cb.id);for(let k=0;k<6&&(!cb||cb.value!=='on');k++){await sleep(800);cb=(await els('빠른 선물')).find(e=>e.role==='checkbox');}}
  if(!cb||cb.value!=='on')return{...R,name:name0,address:addr,note:'빠른 선물 못 켬'};
}
return{ok:true,name:name0,address:addr,note:null,quick_gift:!!cb};