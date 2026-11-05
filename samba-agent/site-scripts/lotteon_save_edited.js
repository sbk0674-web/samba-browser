const A=args||{};const name=String(A.name||'').trim().replace(/\*/g,'O');const addr=String(A.address||'').trim();
if(A.tab)await tabs.switch(String(A.tab));
const pe=t=>t.split('\n').map(l=>l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=(\S+))?(?:\s+value="([^"]*)")?/)).filter(Boolean).map(m=>({id:+m[1],role:m[2],text:m[3]||'',name:m[4]||'',value:m[5]}));
const dl=async()=>pe((await page.get({selector:'[role=dialog]',interactive:true})).tree);
const s=pe((await page.get({query:'저장'})).tree).filter(e=>e.role==='button'&&e.text==='저장').pop();
if(!s)return{ok:false,note:'저장 버튼 없음'};
const ag=pe((await page.get({query:'수취인정보'})).tree).filter(e=>e.role==='checkbox').pop();
if(ag&&ag.value!=='on'){await page.click(ag.id);await sleep(400);}
await page.click(s.id);
try{await page.waitFor('선택완료',8000);}catch(e){await sleep(2500);}
await sleep(500);
const nm=x=>x.replace(/\s+/g,'');
const norm=nm(name);
const road=(addr.match(/[가-힣A-Za-z0-9.]+(?:로|길)\s*\d+(?:-\d+)?/)||[''])[0].replace(/\s+/g,'');
const words=addr.split(/\s+/).filter(Boolean);
const keys=words.filter((w,i)=>i>0&&!/\d/.test(w)&&!/(시|도|군|구)$/.test(w));
const okRow=seg=>(road&&seg.includes(road))||(keys.length>0&&keys.every(k=>seg.includes(nm(k))))||seg.includes(nm(addr));
const clean=n=>n.replace(/기본배송지$/,'').replace(/^기본배송지/,'');
const parseRows=txt=>{let t=txt.replace(/\s+/g,' ');const out=[];
let re=/(\S+)\s+수정\s+(?:삭제\s+)?\[(\d{5})\]\s+(.*?)\s+01\d-[\d*]{3,4}-[\d*]{4}/g;let m;
while((m=re.exec(t))){out.push({name:nm(clean(m[1])),seg:nm('['+m[2]+']'+m[3])});}
if(out.length)return out;
const hd=/배송지 선택\s+Checked/.test(t.slice(0,60));
re=/(\S+)\s+(?:기본배송지\s+)?\[(\d{5})\]\s+(.*?)\s+01\d-[\d*]{3,4}-[\d*]{4}/g;
while((m=re.exec(t))){out.push({name:nm(m[1]),seg:nm('['+m[2]+']'+m[3])});}
return hd?out.slice(1):out;};
const generic=x=>/^(기본)?배송지$/.test(x);
// 주문할인혜택 창(할인 라디오)이 같이 열려 있으면 배송지 라디오와 섞여 순서가 어긋났다(2026-11-05) — 배송지 라디오만 센다
const getRadios=L=>{const out=[];L.forEach((e,i)=>{if(e.role!=='radio'||(e.name&&e.name!=='deliveryAddress'))return;
let n=null;
if(!generic(e.text)){n=nm(e.text);}else{for(let j=i+1;j<L.length;j++){const x=L[j];if(x.role==='radio'||x.role==='button')break;if(x.role==='label'&&!generic(x.text)){n=nm(x.text);break;}}}
if(n===null)return;
if(!generic(e.text)&&!L.slice(i+1,i+5).some(x=>x.role==='button'&&x.text==='수정'))return;
out.push({id:e.id,text:n});});return out;};
let r=null,found=0,second=null,dbg='';
for(let k=0;k<8&&!r;k++){
if(k)await sleep(1000);
const L0=await dl();
const radios=getRadios(L0);
const tx=String((await page.get({selector:'[role=dialog]'})).tree).split('PAGE TEXT:')[1]||'';
const rows=parseRows(tx);
// 원인 확인용(개인정보 없이 개수·일치 여부만) — 2026-11-05 '저장한 배송지 줄 없음' 반복
dbg=`라디오${radios.length}·줄${rows.length}·이름같은줄${rows.filter(x=>x.name===norm).length}·라디오이름일치${radios.filter((x,i)=>rows[i]&&x.text===rows[i].name).length}`;
const cands=[];
for(let i=0;i<radios.length&&i<rows.length;i++){
if(radios[i].text!==rows[i].name)continue;
if(rows[i].name===norm){found++;if(okRow(rows[i].seg))cands.push(radios[i]);else if(i===1&&!road)second=radios[i];}
}
if(cands.length)r=cands[0];
// 지번 주소('…면 …리 123')는 롯데온이 도로명으로 바꿔 저장해 글자로 못 맞춘다(실기 2026-11-03 4101) — 방금 덮어쓴 둘째 줄이 이름까지 같으면 그 줄이다
else if(second&&k>=2)r=second;
}
if(!found)return{ok:false,note:'저장한 배송지 줄 없음('+dbg+')'};
if(!r)return{ok:false,note:'저장한 줄의 이름·주소 확인 불가'};
await page.click(r.id);await sleep(600);
const L1=await dl();
if(!L1.some(e=>e.id===r.id&&e.value==='on'))return{ok:false,note:'배송지 줄 선택 안 됨'};
const ok=L1.filter(e=>e.role==='button'&&/^(선택완료|확인)$/.test(e.text))[0];
if(!ok)return{ok:false,note:'확인 버튼 없음'};
await page.click(ok.id);
try{await page.waitFor('빠른 선물',8000);}catch(e){await sleep(1800);}
if(A.gift){
let q=pe((await page.get({query:'빠른 선물'})).tree).find(e=>e.role==='checkbox');
if(q&&q.value!=='on'){await page.click(q.id);await sleep(900);q=pe((await page.get({query:'빠른 선물'})).tree).find(e=>e.role==='checkbox');}
if(!q||q.value!=='on')return{ok:false,note:'빠른 선물 못 켬'};
return{ok:true,name,address:addr,gift:true,quick_gift:true};
}
const txt=(String((await page.get({})).tree).split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const m=txt.match(/배송지\s+(?:배송지\s+)?(.{0,90}?)\s*변경/);
return{ok:!!m,name,address:m?m[1].replace(/^\[\d{5}\]\s*/,'').replace(/01\d[-\d*]+.*/,'').trim():null,note:m?null:'주문서 배송지 못 읽음'};