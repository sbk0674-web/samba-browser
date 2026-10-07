// 삼바웨이브 주문관리에서 상품주문번호로 주문을 찾아 주문상태를 바꾼다(기본 배송대기중). 소싱주문번호로 행을 확정한다
const no=String(args.orderNo||''),sno=String(args.sourcingNo||''),to=args.status||'배송대기중';
if(!no)return{ok:false,note:'orderNo 없음'};
let sw=(await tabs.list()).find(t=>/samba-wave\.vercel\.app\/samba\/orders/.test(t.url||''));
if(sw){await tabs.switch(sw.id);await sleep(500)}else{await tabs.open({url:'https://samba-wave.vercel.app/samba/orders'});await sleep(6000)}
// 오래된 주문(7일 넘음)도 찾도록 올해 기간을 먼저 쓴다(실기 2026-09-25: 7일 조회에 행이 없어 상태를 못 바꿈)
for(const k of ['올해','7일']){const i=await page.idOf(k);if(i!==-1){await page.click(i);await sleep(1500);break}}
// 주문상태 필터 기본값은 취소중·배송중 행을 숨긴다(실기 2026-09-29: 결제했는데 '주문 행 없음') — 전체로 둔다
{const f=(await page.get({interactive:true})).tree.match(/^\[(\d+)\] combobox "전체 주문상태 /m);if(f){await page.select(+f[1],'전체 주문상태');await sleep(800)}}
const ts=await page.idOf('상품명 고객명 상품ID 주문번호 소싱주문번호 송장번호');
if(ts<0)return{ok:false,note:'검색칸 없음'};
await page.select(ts,'주문번호');await sleep(300);await page.type(ts+1,no,true);
// Enter 만으로는 목록이 안 걸러질 때가 있다(실기: 2,522건 그대로) — 검색 버튼을 누른다
{const g=(await page.get({interactive:true})).tree.match(/^\[(\d+)\] button "검색"/m);if(g){await page.click(+g[1])}}
// 검색 결과가 늦게 바뀐다(실기: 앞 주문 행이 그대로 남아 있었다) — 이 소싱주문번호 행이 보일 때까지 기다린다
let L=[];for(let i=0;i<20;i++){await sleep(700);L=(await page.get({interactive:true})).tree.split(String.fromCharCode(10));if(!sno||L.some(l=>l.includes('value="'+sno+'"')))break}
// 소싱주문번호 칸은 주문계정이 없으면 이름이 '주문계정 먼저 선택'이다(실기 29CM) — 이름 대신 값으로 찾는다
let s=L.findIndex(l=>/^\[\d+\] textbox "(소싱주문번호|주문계정 먼저 선택)"/.test(l)&&sno&&l.includes('value="'+sno+'"'));
if(s<0&&!sno)s=L.findIndex(l=>/textbox "소싱주문번호"/.test(l));
if(s<0)return{ok:false,note:'주문 행 없음'};
// 주문상태 콤보박스는 소싱주문번호 칸 바로 앞 번호다(목록 줄 순서는 번호 순이 아니다 — 번호로 찾는다)
const sid=+L[s].match(/^\[(\d+)\]/)[1]-1;
if(!L.some(l=>l.startsWith('['+sid+'] combobox "주문접수 배송대기중')))return{ok:false,note:'상태 칸 없음'};
const before=(await page.text(sid))||'';
if(!/배송대기중/.test(before))return{ok:false,note:'상태 칸 아님: '+before.slice(0,40)};
const r=await page.select(sid,to);await sleep(2500);
return{ok:r==='ok'||/^ok/.test(String(r)),orderNo:no,status:to,result:String(r).slice(0,60)};
