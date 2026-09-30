// 롯데온 주문서 배송지 입력. 선물 주문서('받는 분 주소로 보내기' 있음)면 배송지 선택 창의 '새 배송지 등록' 폼에,
// 직배 주문서면 '변경'→'새 배송지 추가' 폼에 이름·주소를 넣는다. 전화 칸은 비워 두고 phone_field_id 로 돌려준다.
// 선물 폼의 저장·선택·빠른 선물은 lotteon_confirm_shipping 이 한다(전화가 채워진 뒤). 직배 폼은 여기서 저장한다.
// 이름의 '*' 은 롯데온이 거부한다 → 'O' 로 넣고(사용자 2026-09-28) 대조용 name 은 원래 값으로 돌려준다.
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o.sort((a,b)=>a.id-b.id);}
async function E(q,sel){return pe((await page.get(q?{query:q}:{selector:sel,interactive:true})).tree);}
function L(a,f){const c=a.filter(f);return c.length?c[c.length-1]:null;}
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');
const addr=String(A.address||'').trim();const det0=String(A.address_detail||A.detail||'').trim();
const R={name:null,phone:null,address:null,saved:false,gift:false};
if(!name||!addr)return{...R,error:'name/address missing'};
// 검색어는 도로명+건물번호까지, 나머지는 상세주소(주소에 번호가 없고 상세가 번호로 시작하면 합친다)
const joined=!!(det0&&!det0.startsWith(addr)&&/^\d/.test(det0)&&/(로|길)\s*$/.test(addr));
const full=det0&&det0.startsWith(addr)?det0:(joined?addr+' '+det0:addr);
const cut=full.match(/^(.*?(?:로|길)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)||full.match(/^(.*?(?:로|길)\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
const jb=cut?null:full.match(/^(.*?[가-힣](?:동|리|가)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
const query=cut?cut[1]:(jb?jb[1]:addr);
const rest=(jb?jb[2]:'').trim();
const detail=(det0&&!det0.startsWith(addr)&&!joined)?((rest&&!det0.includes(rest)?rest+' ':'')+det0):(cut?cut[2]:rest).trim();
// 선물 주문서?
// 주문서가 다 그려진 뒤에 선물·직배를 가린다 — 일찍 보면 선물 주문서를 직배로 잘못 본다
await page.waitFor(/받는 분 주소로 보내기|새 ?배송지 ?추가|변경/,8000).catch(()=>{});
const rr=(await E('받는 분 주소로 보내기')).filter(e=>e.role==='radio'&&/주소로/.test(e.text));
let add=null;
if(rr.length){
  R.gift=true;await page.click(rr[0].id);await sleep(1500);
  const b=L(await E('배송지 선택하기'),e=>e.role==='button'&&/배송지 선택하기/.test(e.text))||L(await E('배송지 수정하기'),e=>e.role==='button'&&/배송지 수정하기/.test(e.text));
  if(!b)return{...R,error:'gift-address-button-nf'};
  await page.click(b.id);await sleep(2500);
  add=L(await E('새 배송지 등록'),e=>e.role==='button'&&/새 ?배송지 ?등록/.test(e.text));
  if(!add)return{...R,error:'gift-add-button-nf'};
}else{
  // 주문서가 늦게 그려지면 버튼이 아직 없다 — 몇 초 다시 찾는다(실기 2026-09-29: change-button-nf 2건)
  const fa=async()=>(await E('새 배송지 추가')).filter(e=>/새 ?배송지 ?추가/.test(e.text)&&e.role==='button')[0]||null;
  // '변경'은 배송지·배송요청사항 두 개 — 첫 번째(배송지)를 누른다(마지막 것은 요청사항 창, 실기 2026-09-30)
  const fc=async()=>(await E('변경')).filter(e=>/^(배송지\s*)?변경$/.test(String(e.text).trim())&&e.role==='button').sort((a,b)=>a.id-b.id)[0]||null;
  let ch=null;
  for(let i=0;i<8&&!add&&!ch;i++){add=await fa();if(!add)ch=await fc();if(!add&&!ch)await sleep(1000);}
  if(!add){
    if(!ch){
      // 못 찾았으면 어느 화면이었는지 남긴다 — 다음에 원인을 바로 알 수 있게
      const seen=(await E(null,'button,a')).filter(e=>e.text).map(e=>String(e.text).slice(0,12)).slice(0,12);
      const at=String(await page.url()).replace(/^https?:\/\//,'').split('?')[0].slice(0,60);
      return{...R,error:'change-button-nf @'+at+' ['+seen.join('|')+']'};
    }
    // '새 배송지 추가'는 글자가 아니라 버튼 이름에만 있어 waitFor(글자)로는 못 기다린다 — 버튼을 몇 번 다시 찾는다
    await page.click(ch.id);for(let i=0;i<8&&!add;i++){await sleep(800);add=await fa();}
  }
  if(!add)return{...R,error:'add-address-button-nf'};
}
await page.click(add.id);await sleep(1500);
const nameQ=R.gift?'받는 분':'받는 분을 입력';
let n=L(await E(nameQ),e=>e.role==='textbox');
if(!n)return{...R,error:'name-input-nf'};
await page.type(n.id,name,false);
let p=L(await E('휴대폰'),e=>e.role==='textbox');
R.phone_field_id=p?p.id:null;
let z=L(await E('우편번호 찾기'),e=>e.role==='button');
if(!z)return{...R,error:'zip-button-nf'};
await page.click(z.id);await sleep(1200);
const nums=s=>(String(s).match(/[0-9]+/g)||[]);const want=nums(query);
let si=L(await E('올림픽로 300'),e=>e.role==='textbox');
if(!si)return{...R,error:'address-search-input-nf'};
async function search(q){
  await page.type(si.id,q,true);
  for(let i=0;i<8;i++){await sleep(600);
    const ls=(await E('[',null)).filter(e=>e.role==='link'&&/^\[\d{5}\]/.test(e.text));
    if(ls.length){let b=null,sc=-1;for(const l of ls){const s=nums(l.text).filter(x=>want.includes(x)).length;if(s>sc){sc=s;b=l;}}return{hit:b,count:ls.length};}
  }
  return{hit:null,count:0};
}
let {hit,count}=await search(query);
if(!hit){const sh=query.replace(/^\S*(특별자치도|특별시|광역시|특별자치시|도|시)\s+/,'');if(sh&&sh!==query)({hit,count}=await search(sh));}
// 도로명과 건물번호가 붙어 온 주소('○○로167')는 검색이 안 된다(실기 2026-09-29) — 띄워서, 그래도 없으면 도로명+번호만으로 찾는다
if(!hit){const sp=query.replace(/([가-힣])(\d)/g,'$1 $2');if(sp!==query)({hit,count}=await search(sp));
  if(!hit){const rd=sp.match(/[가-힣0-9]+(?:로|길)\s?\d+(?:-\d+)?/);if(rd)({hit,count}=await search(rd[0]));}}
if(!hit)return{...R,error:'address-result-nf',note:'주소 검색 결과 없음: '+query};
R.address_results=count;
await page.click(hit.id);await sleep(1200);
const lt=hit.text;const mz=lt.match(/\[(\d{5})\]/);R.zip=mz?mz[1]:(A.postal_code||null);
let d=L(await E('상세주소'),e=>e.role==='textbox');
if(d&&detail)await page.type(d.id,detail,false);
R.address_detail=detail||null;
const use=L(await E('사용'),e=>e.role==='button'&&e.text==='사용');
if(use){await page.click(use.id);await sleep(1200);}
// 직배 폼은 여기서 저장(예전 흐름). 선물 폼은 confirm 이 저장한다
if(!R.gift){
  const ag=L(await E('수취인정보'),e=>e.role==='checkbox');
  if(ag&&ag.value!=='on')await page.click(ag.id);
  const sv=L(await E('저장'),e=>e.role==='button'&&e.text==='저장');
  if(sv){await page.click(sv.id);await sleep(1000);}
  R.saved=true;
}
R.name=name0;R.address=addr;
return R;
