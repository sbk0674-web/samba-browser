const A=args||{};const name=String(A.name||'').trim().replace(/\*/g,'O');const addr=String(A.address||'').trim();
if(A.tab)await tabs.switch(String(A.tab));
const pe=t=>t.split('\n').map(l=>l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/)).filter(Boolean).map(m=>({id:+m[1],role:m[2],text:m[3]||'',value:m[4]}));
const dl=async()=>pe((await page.get({selector:'[role=dialog]',interactive:true})).tree);
const s=pe((await page.get({query:'저장'})).tree).filter(e=>e.role==='button'&&e.text==='저장').pop();
if(!s)return{ok:false,note:'저장 버튼 없음'};
const ag=pe((await page.get({query:'수취인정보'})).tree).filter(e=>e.role==='checkbox').pop();
if(ag&&ag.value!=='on'){await page.click(ag.id);await sleep(400);}
await page.click(s.id);await sleep(2500);
const L0=await dl();
let r=L0.filter(e=>e.role==='radio'&&e.text===name)[0]||L0.filter(e=>e.role==='radio'&&e.text.includes(name))[0];
if(!r){const ed=L0.filter(e=>e.role==='button'&&e.text==='수정')[1];if(ed)r=L0.filter(e=>e.role==='radio'&&e.id<ed.id).pop();}
if(!r)return{ok:false,note:'저장한 배송지 줄 없음'};
const road=(addr.match(/[가-힣A-Za-z0-9.]+(?:로|길)\s*\d+(?:-\d+)?/)||[addr])[0].replace(/\s+/g,'');
const rows=String((await page.get({selector:'[role=dialog]'})).tree).replace(/\s+/g,'');
if(!rows.includes(name)||!rows.includes(road))return{ok:false,note:'저장한 줄의 이름·주소 확인 불가'};
await page.click(r.id);await sleep(600);
const L1=await dl();
if(!L1.some(e=>e.id===r.id&&e.value==='on'))return{ok:false,note:'배송지 줄 선택 안 됨'};
const ok=L1.filter(e=>e.role==='button'&&/^(선택완료|확인)$/.test(e.text))[0];
if(!ok)return{ok:false,note:'확인 버튼 없음'};
await page.click(ok.id);await sleep(1800);
if(A.gift){
let q=pe((await page.get({query:'빠른 선물'})).tree).find(e=>e.role==='checkbox');
if(q&&q.value!=='on'){await page.click(q.id);await sleep(900);q=pe((await page.get({query:'빠른 선물'})).tree).find(e=>e.role==='checkbox');}
if(!q||q.value!=='on')return{ok:false,note:'빠른 선물 못 켬'};
return{ok:true,name,address:addr,gift:true,quick_gift:true};
}
const txt=(String((await page.get({})).tree).split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ');
const m=txt.match(/배송지\s+(?:배송지\s+)?(.{0,90}?)\s*변경/);
return{ok:!!m,name,address:m?m[1].replace(/^\[\d{5}\]\s*/,'').replace(/01\d[-\d*]+.*/,'').trim():null,note:m?null:'주문서 배송지 못 읽음'};
