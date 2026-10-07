// 롯데온 직배 주문서 1단계('/orders/N')를 통과해 결제 단계의 견적 값을 읽는다. 기본배송지가 판매자 배송 불가 지역이면 '계속하기'가
// alert('설정하신 기본배송지는 배송이 어려운 지역입니다')만 띄우고 넘어가지 않는다(실기 2026-10-07 아디다스 KA4340, 기본배송지 경주) —
// '변경' 목록에서 받는 곳을 먼저 고른 뒤 계속한다. args: ship_name, ship_address, profile. 반환은 스냅샷과 같은 키(methods·cost·selected·qty·coupons·order_tab)
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?/);if(m)o.push({id:parseInt(m[1]),role:m[2],text:m[3]||''});}return o;}
const tx=async q=>{try{return (await page.get({query:q})).tree;}catch(e){return '';}};
const DL=async()=>pe((await page.get({selector:'[role=dialog]',interactive:true})).tree);
const r={methods:[],coupons:{},cost:null,selected:null,qty:null,note:null,order_tab:null};
const sn=String(args.ship_name||'').replace(/\*/g,'O').trim(),sa=String(args.ship_address||'').replace(/\s/g,'');
if(!sn||!sa)return{...r,error:'ship args missing'};
const wz=async()=>/\/orders\/\d/.test(await page.url());
if(await wz()){
  const cb=pe((await page.get({query:'변경'})).tree).filter(e=>e.role==='button'&&/^(배송지\s*)?변경$/.test(e.text.trim())).sort((x,y)=>x.id-y.id)[0];
  if(!cb)return{...r,error:'change-button-nf'};
  await page.click(cb.id);await sleep(2500);
  const dl=await DL(),dt=((await page.get({selector:'[role=dialog]'})).tree.split('PAGE TEXT:')[1]||'').replace(/\s/g,'');
  const m=sa.match(/([가-힣A-Za-z0-9.]+(?:로|길))(\d+(?:-\d+)?)/)||[],rd=(m[1]&&m[2]?m[1]+m[2]:sa).slice(-8);
  const lb=dl.filter(e=>e.role==='label'&&e.text.includes(sn));
  if(!lb.length||!dt.includes(rd)){const c=dl.find(e=>e.role==='button'&&e.text==='닫기');if(c)await page.click(c.id);return{...r,error:'address-not-listed',note:'목록에 같은 배송지 없음(이름 라벨 '+lb.length+'개)'};}
  const l=lb[lb.length-1].id,q=Math.max(...dl.filter(e=>e.role==='radio'&&e.id<l).map(e=>e.id),0);
  await page.click(q||l);await sleep(900);
  const b=(await DL()).find(e=>e.role==='button'&&(e.text==='확인'||e.text==='닫기'));if(b){await page.click(b.id);await sleep(2500);}
  for(let i=0;i<4&&await wz();i++){const c=pe(await tx('계속하기')).find(x=>x.text==='계속하기');if(c){await page.click(c.id);await page.waitFor('결제수단',6000).catch(()=>{});}else await sleep(1000);}
  if(await wz())return{...r,error:'delivery-impossible',note:'받는 곳을 골랐는데 계속하기가 안 넘어간다 — 판매자가 그 지역으로 배송 불가(성남 주소로 바꾸면 넘어가는 것을 확인)'};
}
let t='';
for(let i=0;i<12;i++){t=await tx('결제');if(/결제수단/.test(t)&&/총\s*\d+\s*건|총\s*결제\s*금액/.test(t))break;await sleep(800);}
const mn=['신용카드','휴대폰결제','충전결제','퀵계좌이체','카카오페이','네이버페이','토스페이','삼성페이','온누리상품권','간편결제'];
const gm=()=>mn.filter(x=>t.includes(x));
r.methods=gm();
for(let i=0;i<6&&!r.methods.includes('네이버페이');i++){await sleep(1000);t=await tx('결제');r.methods=gm();}
if(!r.methods.includes('네이버페이')){r.methods=[...new Set([...r.methods,'신용카드','네이버페이','카카오페이','토스페이'])];r.note='기본 수단';}
const cm=t.match(/쿠폰[^\d]{0,20}?(-?[\d,]+)\s*원/);
r.coupons[args.account||args.profile||'현재 로그인 계정']=cm?parseInt(cm[1].replace(/,/g,'')):0;
const com=t.match(/총\s*\d+\s*건\s*([\d,]{3,})/)||t.match(/(?:총\s*결제\s*금액[\s\S]{0,120}?|결제\s*예정\s*금액[\s\S]{0,60}?)([\d,]{3,})\s*원?/);
if(com)r.cost=parseInt(com[1].replace(/,/g,''));
let om=t.match(/([^\s]+(?:\s*\/\s*[^\s]+)+)\s*(?:수량|\d+\s*개)\s*\d/);
if(!om)om=t.match(/옵션\s*:?\s*([^\n]{1,40}?)\s*(?:수량|\d+\s*개)/);
if(om)r.selected=om[1].trim();
const qm=t.match(/수량\s*:?\s*(\d+)\s*개?/);r.qty=qm?+qm[1]:null;
r.order_tab=(await tabs.list()).find(x=>/orderSheet/.test(x.url||''))?.id||null;
return r;
