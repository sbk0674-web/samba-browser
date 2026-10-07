function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o.sort((a,b)=>a.id-b.id);}
async function E(q,sel){return pe((await page.get(q?{query:q}:{selector:sel,interactive:true})).tree);}
function L(a,f){const c=a.filter(f);return c.length?c[c.length-1]:null;}
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');
const addr=String(A.address||'').trim();const det0=String(A.address_detail||A.detail||'').trim();
const R={name:null,phone:null,address:null,saved:false,gift:false};
if(!name||!addr)return{...R,error:'name/address missing'};
const joined=!!(det0&&!det0.startsWith(addr)&&/^\d/.test(det0)&&/(로|길)\s*$/.test(addr));
const full=det0&&det0.startsWith(addr)?det0:(joined?addr+' '+det0:addr);
const cut=full.match(/^(.*?[가-힣]로\s*\d+번?길\s*\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)||full.match(/^(.*?(?:로|길)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)||full.match(/^(.*?(?:로|길)\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
const jb=cut?null:full.match(/^(.*?[가-힣](?:동|리|가)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
const query=(cut?cut[1]:(jb?jb[1]:addr.replace(/[,\s]+$/,''))).replace(/(번길)(\d)/,'$1 $2');
const rest=(jb?jb[2]:'').trim();
const detail=(det0&&!det0.startsWith(addr)&&!joined)?((rest&&!det0.includes(rest)?rest+' ':'')+det0):(cut?cut[2]:rest).trim();
await page.waitFor(/받는 분 주소로 보내기|새 ?배송지 ?추가|변경/,8000).catch(()=>{});
const rr=(await E('받는 분 주소로 보내기')).filter(e=>e.role==='radio'&&/주소로/.test(e.text));
let add=null;
if(rr.length){
  R.gift=true;await page.click(rr[0].id);await sleep(1200);
  const b=L(await E('배송지 선택하기'),e=>e.role==='button'&&/배송지 선택하기/.test(e.text))||L(await E('배송지 수정하기'),e=>e.role==='button'&&/배송지 수정하기/.test(e.text));
  if(!b)return{...R,error:'gift-address-button-nf'};
  await page.click(b.id);await sleep(1500);
  add=L(await E('새 배송지 등록'),e=>e.role==='button'&&/새 ?배송지 ?등록/.test(e.text));
  if(!add)return{...R,error:'gift-add-button-nf'};
}else{
  const fa=async()=>(await E('새 배송지 추가')).filter(e=>/새 ?배송지 ?추가/.test(e.text)&&e.role==='button')[0]||null;
  const fc=async()=>(await E('변경')).filter(e=>/^(배송지\s*)?변경$/.test(String(e.text).trim())&&e.role==='button').sort((a,b)=>a.id-b.id)[0]||null;
  let ch=null;
  for(let i=0;i<8&&!add&&!ch;i++){add=await fa();if(!add)ch=await fc();if(!add&&!ch)await sleep(1000);}
  if(!add){
    if(!ch){
      const seen=(await E(null,'button,a')).filter(e=>e.text).map(e=>String(e.text).slice(0,12)).slice(0,12);
      const at=String(await page.url()).replace(/^https?:\/\//,'').split('?')[0].slice(0,60);
      return{...R,error:'change-button-nf @'+at+' ['+seen.join('|')+']'};
    }
    await page.click(ch.id);for(let i=0;i<8&&!add;i++){await sleep(800);add=await fa();}
  }
  if(!add)return{...R,error:'add-address-button-nf'};
}
await page.click(add.id);await sleep(1000);
const nameQ=R.gift?'받는 분':'받는 분을 입력';
let n=L(await E(nameQ),e=>e.role==='textbox');
if(!n)return{...R,error:'name-input-nf'};
await page.type(n.id,name,false);
let p=L(await E('휴대폰'),e=>e.role==='textbox');
R.phone_field_id=p?p.id:null;
let z=L(await E('우편번호 찾기'),e=>e.role==='button');
if(!z)return{...R,error:'zip-button-nf'};
await page.click(z.id);await sleep(1000);
const nums=s=>(String(s).match(/[0-9]+/g)||[]);const want=nums(query);
let si=L(await E('올림픽로 300'),e=>e.role==='textbox');
if(!si)return{...R,error:'address-search-input-nf'};
const NS=s=>String(s).replace(/\s+/g,'');const roadKey=((full.match(/[가-힣A-Za-z.]+로\s*\d+번길(?=\s*\d)/)||full.match(/[가-힣A-Za-z0-9.]+(?:로|길)(?=\s*\d)/)||full.match(/[가-힣]+(?:동|리|가)(?=\s+\d)/)||[''])[0]);
const guKeys=(full.match(/[가-힣]{1,6}(?:시|군|구)(?=\s)/g)||[]).filter(k=>!/(특별자치|광역|특별)시$/.test(k)&&!/^(서울|부산|대구|인천|광주|대전|울산|세종)시$/.test(k));
const okLine=t=>{const n=NS(t);if(roadKey&&!n.includes(NS(roadKey)))return false;if(guKeys.length&&!guKeys.some(k=>n.includes(k)))return false;return true;};
async function search(q){
  await page.type(si.id,q,true);
  const sb=(await E('검색')).filter(e=>e.role==='button'&&e.text==='검색'&&e.id>si.id)[0];
  if(sb)await page.click(sb.id);
  for(let i=0;i<6;i++){await sleep(500);
    const ls=(await E('[',null)).filter(e=>e.role==='link'&&/^\[\d{5}\]/.test(e.text));
    if(ls.length){let b=null,sc=-1;for(const l of ls.filter(l=>okLine(l.text))){const s=nums(l.text).filter(x=>want.includes(x)).length;if(s>sc){sc=s;b=l;}}return{hit:b,count:ls.length};}
  }
  return{hit:null,count:0};
}
let {hit,count}=await search(query);
if(!hit){const sh=query.replace(/^\S*(특별자치도|특별시|광역시|특별자치시|도|시)\s+/,'');if(sh&&sh!==query)({hit,count}=await search(sh));}
if(!hit){const sp=query.replace(/([가-힣])(\d)/g,'$1 $2');if(sp!==query)({hit,count}=await search(sp));
  if(!hit){const rd=sp.match(/[가-힣0-9]+(?:로|길)\s?\d+(?:-\d+)?/);if(rd)({hit,count}=await search(rd[0]));}}
if(!hit)return{...R,error:'address-result-nf',note:'주소 검색 결과 없음(도로명·시군구 일치 줄 없음): '+query};
R.address_results=count;
await page.click(hit.id);await sleep(1000);
const lt=hit.text;const mz=lt.match(/\[(\d{5})\]/);R.zip=mz?mz[1]:(A.postal_code||null);
let d=L(await E('상세주소'),e=>e.role==='textbox');
if(d&&detail)await page.type(d.id,detail,false);
R.address_detail=detail||null;
const use=L(await E('사용'),e=>e.role==='button'&&e.text==='사용');
if(use){await page.click(use.id);await sleep(1000);}
if(!R.gift){
  const ag=L(await E('수취인정보'),e=>e.role==='checkbox');
  if(ag&&ag.value!=='on')await page.click(ag.id);
  const sv=L(await E('저장'),e=>e.role==='button'&&e.text==='저장');
  if(sv){await page.click(sv.id);await sleep(1000);}
  R.saved=true;
}
// 줄 형식: [우편번호] 지번주소 도로명 도로명주소. 입력이 지번이면 지번 부분, 아니면 도로명 부분
let ad=lt.replace(/^\[\d{5}\]\s*/,'');
const ri=ad.indexOf('도로명 ');
const roadPart=ri>=0?ad.slice(ri+4).trim():ad;
let jibPart=ri>=0?ad.slice(0,ri).replace(/^지번\s*/,'').trim():'';
const SI={'경북':'경상북도','경남':'경상남도','전북':'전북특별자치도','전남':'전라남도','충북':'충청북도','충남':'충청남도'};
const full1=s=>s.replace(/^(경북|경남|전북|전남|충북|충남)(?=\s)/,m=>SI[m]);
const inputJibun=!cut&&!!jb;
R.address=(inputJibun&&jibPart)?(/^(경북|경남|전북|전남|충북|충남)/.test(addr)?jibPart:(full1(jibPart).startsWith(addr.split(' ')[0])?full1(jibPart):jibPart)):roadPart;
R.address_road=roadPart;R.address_jibun=jibPart||null;
R.name=name0;R.address_input=addr;
return R;