const B=e=>e.role==='button',X=e=>e.role==='textbox';
function pe(t){const o=[];for(const l of t.split('\n')){const m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null});}return o.sort((a,b)=>a.id-b.id);}async function E(q,sel){let er;for(let i=0;i<10;i++){try{return pe((await page.get(q?{query:q}:{selector:sel,interactive:true})).tree);}catch(e){er=e;await sleep(800);}}throw er;}async function C(id){try{await page.click(id);}catch(e){await sleep(1000);}}function L(a,f){const c=a.filter(f);return c.length?c[c.length-1]:null;}
const A=args||{};const name0=String(A.name||'').trim();const name=name0.replace(/\*/g,'O');const addr=String(A.address||'').trim();const det0=String(A.address_detail||A.detail||'').trim();const R={name:null,phone:null,address:null,saved:false,gift:false};if(!name||!addr)return{...R,error:'args missing'};
const OR=/ord|checkout|purchase/i;
if(A.tab){const t=(await tabs.list()).find(t=>t.id===String(A.tab));if(!t||!/lotteon\.com\//.test(t.url||'')||(A.profile&&t.profile&&t.profile!==A.profile))return{...R,error:'order-tab-mismatch'};await tabs.switch(t.id);}
else if(!OR.test(String(await page.url()))){const ts=(await tabs.list()).filter(t=>/lotteon\.com\//.test(t.url||'')&&OR.test(t.url||'')&&(!A.profile||!t.profile||t.profile===A.profile));if(ts.length)await tabs.switch(ts[ts.length-1].id);}
if(!/^https:\/\/[^/]*lotteon\.com\//.test(String(await page.url())))return{...R,error:'not-on-lotteon'};
const joined=!!(det0&&!det0.startsWith(addr)&&/^\d/.test(det0)&&/(로|길)\s*$/.test(addr));const pre2=addr.split(/\s+/).slice(0,2).join(' ');const detFull=!!(det0&&!det0.startsWith(addr)&&!joined&&pre2&&det0.startsWith(pre2)&&/[가-힣0-9](로|길)\s*\d/.test(det0));const full=det0&&(det0.startsWith(addr)||detFull)?det0:(joined?addr+' '+det0:addr);
const cut=full.match(/^(.*?[가-힣]로\s*\d+번?길\s*\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)||full.match(/^(.*?(?:로|길)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)||full.match(/^(.*?(?:로|길)\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
const jb=cut?null:full.match(/^(.*?[가-힣](?:동|리|가)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
const query=(cut?cut[1]:(jb?jb[1]:addr.replace(/[,\s]+$/,''))).replace(/(번길)(\d)/,'$1 $2');const rest=(jb?jb[2]:'').trim();
const detail=(det0&&!det0.startsWith(addr)&&!joined&&!detFull)?((rest&&!det0.includes(rest)?rest+' ':'')+det0):(cut?cut[2]:rest).trim();
await page.waitFor(/받는 분 주소로 보내기|새 ?배송지 ?추가|변경|받는 분을 입력/,12000).catch(()=>{});
let add=null;let n0=L(await E('받는 분을 입력'),e=>X(e)&&/받는 분/.test(e.text));
const rr=n0?[]:(await E('받는 분 주소로 보내기')).filter(e=>e.role==='radio'&&/주소로/.test(e.text));
if(n0){R.gift=true;}else if(rr.length){R.gift=true;await C(rr[0].id);await sleep(1200);
const gb=async t=>L(await E('배송지 '+t+'하기'),e=>B(e)&&e.text.includes('배송지 '+t+'하기'));const b=await gb('선택')||await gb('수정');
if(!b)return{...R,error:'gift-address-button-nf'};
await C(b.id);await sleep(1500);
for(let i=0;i<8&&!add;i++){add=L(await E('새 배송지 등록'),e=>B(e)&&/새 ?배송지 ?등록/.test(e.text));if(!add)await sleep(700);}
if(!add)return{...R,error:'gift-add-button-nf'};
}else{
const okR=e=>/^(button|clickable|link)$/.test(e.role);
const fa=async()=>(await E('새 배송지 추가')).filter(e=>/새 ?배송지 ?(추가|등록)/.test(e.text)&&okR(e))[0]||null;
const fc=async()=>{let c=(await E('변경')).filter(e=>/^(배송지\s*)?(변경|변경하기|수정|선택|추가)$/.test(e.text.trim())&&okR(e))[0];if(c)return c;return (await E('배송지')).filter(e=>/배송지\s*(변경|선택|추가|관리)|주소\s*변경|변경하기/.test(e.text)&&e.text.length<20&&okR(e))[0]||null;};
let ch=null;for(let i=0;i<10&&!add&&!ch;i++){add=await fa();if(!add)ch=await fc();if(!add&&!ch)await sleep(1000);}
if(!add){if(!ch)return{...R,error:'change-button-nf'};await C(ch.id);for(let i=0;i<8&&!add;i++){await sleep(800);add=await fa();}}
if(!add)return{...R,error:'add-address-button-nf'};
}
if(add){const ed=(await E('수정')).filter(e=>B(e)&&e.text==='수정')[1];if(ed){add=ed;R.edited=true;}}let n=n0;if(add){await C(add.id);await sleep(1000);n=null;}
const nameQ=R.gift?'받는 분':'받는 분을 입력';
for(let i=0;i<6&&!n;i++){n=L(await E(nameQ),e=>X(e)&&/받는 분/.test(e.text));if(!n)await sleep(700);}
if(!n)return{...R,error:'name-input-nf'};
await page.type(n.id,name,true);
const dl=await E('휴대폰');let p=L(dl,e=>X(e)&&/휴대폰/.test(e.text));R.phone_field_id=p?p.id:null;
let z=L(dl,e=>B(e)&&/우편번호/.test(e.text))||L(await E('우편번호 찾기'),e=>B(e));
if(!z)return{...R,error:'zip-button-nf'};
await C(z.id);await sleep(700);
const nums=s=>(String(s).match(/[0-9]+/g)||[]);const want=nums(query);
let si=null;for(let i=0;i<6&&!si;i++){si=L(await E('올림픽로 300'),e=>X(e)&&/올림픽로/.test(e.text));if(!si)await sleep(500);}
if(!si)return{...R,error:'addr-input-nf'};
const NS=s=>String(s).replace(/\s+/g,'');const roadKey=((full.match(/[가-힣A-Za-z.]+로\s*\d+번길(?=\s*\d)/)||full.match(/[가-힣A-Za-z0-9.]+(?:로|길)(?=\s*\d)/)||full.match(/[가-힣]+(?:동|리|가)(?=\s+\d)/)||[''])[0]);
const guKeys=(full.match(/[가-힣]{1,6}(?:시|군|구)(?=\s)/g)||[]).filter(k=>!/(특별자치|광역|특별)시$/.test(k));
const pz=String(A.postal_code||'').trim();
const okLine=t=>{const n=NS(t);if(roadKey&&!n.includes(NS(roadKey)))return false;if(pz&&n.includes('['+pz+']'))return true;if(guKeys.length&&!guKeys.some(k=>n.includes(k)))return false;return true;};
async function search(q,po){await page.type(si.id,q,true);
const sb=(await E('검색')).filter(e=>B(e)&&e.text==='검색'&&e.id>si.id)[0];if(sb)await C(sb.id);
for(let i=0;i<6;i++){await sleep(400);const ls=(await E('[',null)).filter(e=>e.role==='link'&&/^\[\d{5}\]/.test(e.text));
if(ls.length){let b=null,sc=-1;const pm=l=>pz&&l.text.includes('['+pz+']');for(const l of ls.filter(l=>okLine(l.text)&&(!po||pm(l)))){const s=nums(l.text).filter(x=>want.includes(x)).length+(pm(l)?100:0);if(s>sc){sc=s;b=l;}}if(b||!po||i>=5)return b;}}
return null;}
const pmz=h=>!!(h&&pz&&h.text.includes('['+pz+']'));
let hit=await search(query);
if(pz&&!pmz(hit)){const num=(det0.match(/^\d+(?:-\d+)?/)||[''])[0],tok=(addr.match(/[가-힣0-9]+(?:동|리|가)$/)||[''])[0];if(num){const h2=await search((tok||addr)+' '+num,1);if(h2)hit=h2;}}
if(!hit&&pz&&roadKey){const w=rest.split(/\s+/).filter(Boolean);for(const q of w.length?[roadKey+' '+w[0],w.join(' ')]:[]){if(hit)break;hit=await search(q,1);}}
const alts=[query.replace(/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\S*\s+/,''),(query.match(/[가-힣0-9]+(?:로|길)\s?\d+(?:-\d+)?/)||[''])[0]];
for(const q of alts){if(hit)break;if(q&&q!==query)hit=await search(q);}
if(!hit)return{...R,error:'address-result-nf'};
await C(hit.id);await sleep(800);
const lt=hit.text;const mz=lt.match(/\[(\d{5})\]/);R.zip=mz?mz[1]:(A.postal_code||null);
const dd=await E('상세주소');let d=L(dd,e=>X(e));if(d&&(detail||R.edited))await page.type(d.id,detail,false);if(R.edited){for(const q of ['예: #1234','배송 요청사항']){const x=L(await E(q),e=>X(e));if(x)await page.type(x.id,'',false);}}
R.address_detail=detail||null;
const use=L(dd,e=>B(e)&&e.text==='사용')||L(await E('사용'),e=>B(e)&&e.text==='사용');
if(use){await C(use.id);await sleep(800);}
if(!R.gift){const ag=L(await E('수취인정보'),e=>e.role==='checkbox');if(ag&&ag.value!=='on')await C(ag.id);
const sv=L(await E('저장'),e=>B(e)&&e.text==='저장');if(sv&&!R.edited){await C(sv.id);await sleep(1000);}R.saved=!R.edited;}
let ad=lt.replace(/^\[\d{5}\]\s*/,'');const ri=ad.indexOf('도로명 ');
const roadPart=ri>=0?ad.slice(ri+4).trim():ad;let jibPart=ri>=0?ad.slice(0,ri).replace(/^지번\s*/,'').trim():'';
const SI={'경북':'경상북도','경남':'경상남도','전북':'전북특별자치도','전남':'전라남도','충북':'충청북도','충남':'충청남도'};
const full1=s=>s.replace(/^[가-힣]{2}(?=\s)/,m=>SI[m]||m);
const inputJibun=!cut&&!!jb;const sel=(inputJibun&&jibPart)?jibPart:roadPart;
R.address=SI[addr.slice(0,2)]?sel:(full1(sel).startsWith(addr.split(' ')[0])?full1(sel):sel);
const pm=full.match(/\(([^)]*)\)/);
if(pm&&detail&&!inputJibun){const bn=NS(pm[1].split(',').pop());if(bn&&!NS(R.address).includes(bn)&&NS(detail).includes(bn)){R.address=roadPart.replace(/\(.*$/,'').trim()+', '+detail;}}
R.address_road=roadPart;R.name=name0;
return R;
