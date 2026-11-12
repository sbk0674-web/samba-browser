let B=e=>e.role==='button',X=e=>e.role==='textbox';
function pe(t){let o=[];for(let l of t.split('\n')){let m=l.match(/^\[(\d+)\]\s+(\S+)(?:\s+"([^"]*)")?(?:\s+name=\S+)?(?:\s+value="([^"]*)")?/);if(m)o.push({id:+m[1],role:m[2],text:m[3]||'',value:m[4]!==undefined?m[4]:null})}return o.sort((a,b)=>a.id-b.id)}async function E(q,sel){let er;for(let i=0;i<10;i++){try{return pe((await page.get(q?{query:q}:{selector:sel,interactive:true})).tree)}catch(e){er=e;await S(800)}}throw er}async function C(id){try{await page.click(id)}catch(e){await S(1000)}}function L(a,f){let c=a.filter(f);return c.length?c[c.length-1]:null}
let A=args||{};let name0=String(A.name||'').trim();let name=name0.replace(/\*/g,'O');let addr=String(A.address||'').trim();let det0=String(A.address_detail||A.detail||'').trim();let R={name:null,phone:null,address:null,saved:false,gift:false};if(!name||!addr)return{...R,error:'args missing'};
let OR=/ord|checkout|purchase/i;let F=e=>({...R,error:e}),S=sleep;
if(A.tab){let t=(await tabs.list()).find(t=>t.id===String(A.tab));if(!t||!/lotteon\.com\//.test(t.url||'')||(A.profile&&t.profile&&t.profile!==A.profile))return F('order-tab-mismatch');await tabs.switch(t.id)}
else if(!OR.test(String(await page.url()))){let ts=(await tabs.list()).filter(t=>/lotteon\.com\//.test(t.url||'')&&OR.test(t.url||'')&&(!A.profile||!t.profile||t.profile===A.profile));if(ts.length)await tabs.switch(ts[ts.length-1].id)}
if(!/^https:\/\/[^/]*lotteon\.com\//.test(String(await page.url())))return F('not-on-lotteon');
let joined=!!(det0&&!det0.startsWith(addr)&&/^\d/.test(det0)&&/(로|길)\s*$/.test(addr));let pre2=addr.split(/\s+/).slice(0,2).join(' ');let detFull=!!(det0&&!det0.startsWith(addr)&&!joined&&pre2&&det0.startsWith(pre2)&&/[가-힣0-9](로|길)\s*\d/.test(det0));let full=det0&&(det0.startsWith(addr)||detFull)?det0:(joined?addr+' '+det0:addr);
let cut=full.match(/^(.*?[가-힣]로\s*\d+번?길\s*\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)||full.match(/^(.*?(?:로|길)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)||full.match(/^(.*?(?:로|길)\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
let jb=cut?null:full.match(/^(.*?[가-힣](?:동|리|가)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/);
let query=(cut?cut[1]:(jb?jb[1]:addr.replace(/[,\s]+$/,''))).replace(/(번길)(\d)/,'$1 $2');let rest=(jb?jb[2]:'').trim();
let detail=(det0&&!det0.startsWith(addr)&&!joined&&!detFull)?((rest&&!det0.includes(rest)?rest+' ':'')+det0):(cut?cut[2]:rest).trim();
await page.waitFor(/받는 분 주소로 보내기|새 ?배송지 ?추가|변경|받는 분을 입력/,12000).catch(()=>{});
let add=null;let n0=L(await E('받는 분을 입력'),e=>X(e)&&/받는 분/.test(e.text));
let rr=n0?[]:(await E('받는 분 주소로 보내기')).filter(e=>e.role==='radio'&&/주소로/.test(e.text));
if(n0){R.gift=true}else if(rr.length){R.gift=true;await C(rr[0].id);await S(1200);
let gb=async t=>L(await E('배송지 '+t+'하기'),e=>B(e)&&e.text.includes('배송지 '+t+'하기'));let b=await gb('선택')||await gb('수정');
if(!b)return F('gift-address-button-nf');
await C(b.id);await S(1500);
for(let i=0;i<8&&!add;i++){add=L(await E('새 배송지 등록'),e=>B(e)&&/새 ?배송지 ?등록/.test(e.text));if(!add)await S(700)}
if(!add)return F('gift-add-button-nf');
}else{
let okR=e=>/^(button|clickable|link)$/.test(e.role);
let fa=async()=>(await E('새 배송지 추가')).filter(e=>/새 ?배송지 ?(추가|등록)/.test(e.text)&&okR(e))[0]||null;
let fc=async()=>{let c=(await E('변경')).filter(e=>/^(배송지\s*)?(변경|변경하기|수정|선택|추가)$/.test(e.text.trim())&&okR(e))[0];if(c)return c;return (await E('배송지')).filter(e=>/배송지\s*(변경|선택|추가|관리)|주소\s*변경|변경하기/.test(e.text)&&e.text.length<20&&okR(e))[0]||null};
let ch=null;for(let i=0;i<10&&!add&&!ch;i++){add=await fa();if(!add)ch=await fc();if(!add&&!ch)await S(1000)}
if(!add){if(!ch)return F('change-button-nf');await C(ch.id);for(let i=0;i<8&&!add;i++){await S(800);add=await fa()}}
if(!add)return F('add-address-button-nf');
}
if(add){let ed=[];for(let i=0;i<8&&ed.length<2;i++){ed=(await E('수정')).filter(e=>B(e)&&e.text==='수정');if(ed.length<2)await S(700)}if(ed.length<2)return F('second-row-nf');add=ed[1];R.edited=true}let n=n0;if(add){await C(add.id);await S(1000);n=null}
let nameQ=R.gift?'받는 분':'받는 분을 입력';
for(let i=0;i<6&&!n;i++){n=L(await E(nameQ),e=>X(e)&&/받는 분/.test(e.text));if(!n)await S(700)}
if(!n)return F('name-input-nf');
await page.type(n.id,name,true);
let dl=await E('휴대폰');let p=L(dl,e=>X(e)&&/휴대폰/.test(e.text))||L(await E('하이픈'),X);R.phone_field_id=p?p.id:null;
let z=L(dl,e=>B(e)&&/우편번호/.test(e.text))||L(await E('우편번호 찾기'),e=>B(e));
if(!z)return F('zip-button-nf');
await C(z.id);await S(700);
let nums=s=>(String(s).match(/[0-9]+/g)||[]);let want=nums(query);
let si=null;for(let i=0;i<6&&!si;i++){si=L(await E('올림픽로 300'),e=>X(e)&&/올림픽로/.test(e.text));if(!si)await S(500)}
if(!si)return F('addr-input-nf');
let NS=s=>String(s).replace(/\s+/g,'');let roadKey=((full.match(/[가-힣A-Za-z.]+로\s*\d+번길(?=\s*\d)/)||full.match(/[가-힣A-Za-z0-9.]+(?:로|길)(?=\s*\d)/)||full.match(/[가-힣]+(?:동|리|가)(?=\s+\d)/)||[''])[0]);
let guKeys=(full.match(/[가-힣]{1,6}(?:시|군|구)(?=\s)/g)||[]).filter(k=>!/(특별자치|광역|특별)시$/.test(k));
let pz=String(A.postal_code||'').trim();
let okLine=t=>{let n=NS(t);if(roadKey&&!n.includes(NS(roadKey)))return false;if(pz&&n.includes('['+pz+']'))return true;if(guKeys.length&&!guKeys.some(k=>n.includes(k)))return false;return true};
async function search(q,po){await page.type(si.id,q,true);
let sb=(await E('검색')).filter(e=>B(e)&&e.text==='검색'&&e.id>si.id)[0];if(sb)await C(sb.id);
for(let i=0;i<6;i++){await S(400);let ls=(await E('[',null)).filter(e=>e.role==='link'&&/^\[\d{5}\]/.test(e.text));
if(ls.length){let b=null,sc=-1;let pm=l=>pz&&l.text.includes('['+pz+']');for(let l of ls.filter(l=>okLine(l.text)&&(!po||pm(l)))){let s=nums(l.text).filter(x=>want.includes(x)).length+(pm(l)?100:0);if(s>sc){sc=s;b=l}}if(b||!po||i>=5)return b}}
return null}
let pmz=h=>!!(h&&pz&&h.text.includes('['+pz+']'));
let hit=await search(query);
if(pz&&!pmz(hit)){let num=(det0.match(/^\d+(?:-\d+)?/)||[''])[0],tok=(addr.match(/[가-힣0-9]+(?:동|리|가)$/)||[''])[0];if(num){let h2=await search((tok||addr)+' '+num,1);if(h2)hit=h2}}
if(!hit&&pz&&roadKey){let w=rest.split(/\s+/).filter(Boolean);for(let q of w.length?[roadKey+' '+w[0],w.join(' ')]:[]){if(hit)break;hit=await search(q,1)}}
let alts=[query.replace(/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\S*\s+/,''),(query.match(/[가-힣0-9]+(?:로|길)\s?\d+(?:-\d+)?/)||[''])[0],(addr.match(/\S+[동리가](?=\s|$)/)||[''])[0]+' '+det0.split(/\s+/)[0]];
for(let q of alts){if(hit)break;if(q&&q!==query)hit=await search(q)}
if(!hit)return F('address-result-nf');
await C(hit.id);await S(800);
let lt=hit.text;let mz=lt.match(/\[(\d{5})\]/);R.zip=mz?mz[1]:(A.postal_code||null);
let dd=await E('상세주소');let d=L(dd,X);if(d)await page.type(d.id,detail,false);if(R.edited){let en=String(A.entrance||'');let x=L(await E('예: #1234'),X);if(x)await page.type(x.id,en,false);if(en){R.entrance=!!x;x=L(await E('공동현관 출입정보'),e=>e.role=='checkbox');if(x&&x.value!='on')await C(x.id)}x=L(await E('배송 요청사항'),X);if(x)await page.type(x.id,'',false)}
R.address_detail=detail||null;
let use=L(dd,e=>B(e)&&e.text==='사용')||L(await E('사용'),e=>B(e)&&e.text==='사용');
if(use){await C(use.id);await S(800)}
if(!R.gift){let ag=L(await E('수취인정보'),e=>e.role==='checkbox');if(ag&&ag.value!=='on')await C(ag.id)}
let ad=lt.replace(/^\[\d{5}\]\s*/,'');let ri=ad.indexOf('도로명 ');
let roadPart=ri>=0?ad.slice(ri+4).trim():ad;let jibPart=ri>=0?ad.slice(0,ri).replace(/^지번\s*/,'').trim():'';
let SI={'경북':'경상북도','경남':'경상남도','전북':'전북특별자치도','전남':'전라남도','충북':'충청북도','충남':'충청남도'};
let full1=s=>s.replace(/^[가-힣]{2}(?=\s)/,m=>SI[m]||m);
let inputJibun=!cut&&!!jb;let sel=(inputJibun&&jibPart)?jibPart:roadPart;
R.address=SI[addr.slice(0,2)]?sel:(full1(sel).startsWith(addr.split(' ')[0])?full1(sel):sel);
let pm=full.match(/\(([^)]*)\)/);
if(pm&&detail&&!inputJibun){let bn=NS(pm[1].split(',').pop());if(bn&&!NS(R.address).includes(bn)&&NS(detail).includes(bn)){R.address=roadPart.replace(/\(.*$/,'').trim()+', '+detail}}
R.name=name0;
return R;
