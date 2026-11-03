const out={ok:false,name:null,address:null,note:null};
const T0=Date.now();const left=()=>Date.now()-T0<62000;
async function G(o){for(let i=0;i<8;i++){try{return await page.get(o||{interactive:true});}catch(e){await sleep(700);}}throw new Error('page busy');}
async function C(id){try{await page.clickNative(id);}catch(e){try{await page.click(id);}catch(e2){}}}
async function K(id){try{await page.click(id);}catch(e){try{await page.clickNative(id);}catch(e2){}}}
async function W(t,ms){try{return await page.waitFor(t,ms||8000);}catch(e){return null;}}
const strip=s=>(s||'').replace(/\s+/g,'');
const PRESET=['문 앞에 놔주세요','경비실에 맡겨주세요','택배함에 넣어주세요','배송 전에 연락 주세요'];
const NM=(args.name||'').slice(0,20);
let list=await tabs.list();
let __ofs=list.filter(t=>t.url&&t.url.includes('/order/order-form'));
if(args.tab){__ofs=__ofs.filter(t=>t.id===args.tab);}
else if(__ofs.length>1&&args.profile){const pf=__ofs.filter(t=>t.profile===args.profile);if(pf.length)__ofs=pf;}
const orderTab=__ofs.length>=1?__ofs[0]:null;
if(!orderTab){out.note='no order-form tab open';return out;}
let popup=list.find(t=>t.kind==='popup'&&/address/.test(t.url||''));const hadPopup=!!popup;
async function pickRow(){
  const l2=await tabs.list();const p=l2.find(t=>t.kind==='popup');
  if(!p)return false;
  await tabs.switch(p.id);
  const minK=Math.min(5,NM.length);
  let rowId=null;
  for(let w=0;w<14&&!rowId;w++){
    const g0=await G({interactive:true,query:NM.slice(0,minK)||NM});
    if(/name=address2/.test(g0.tree))return false;
    for(let k=Math.min(NM.length,20);k>=minK&&k>0&&!rowId;k--){
      const pre=NM.slice(0,k);
      const ln=g0.tree.split('\n').find(l=>/^\[\d+\] (clickable|radio|button)/.test(l)&&!/수정|삭제/.test(l)&&l.includes(pre));
      if(ln)rowId=parseInt(ln.match(/^\[(\d+)\]/)[1]);
    }
    if(!rowId)await sleep(700);
  }
  if(rowId){await C(rowId);await sleep(800);}
  let ch=null;
  for(let w=0;w<6&&!ch;w++){
    const g=await G({interactive:true,query:'변경하기'});
    ch=g.tree.match(/\[(\d+)\] (?:button|link|clickable) "(?:변경하기|선택하기|선택|적용)"/);
    if(!ch)await sleep(600);
  }
  if(ch){await C(parseInt(ch[1]));await sleep(1500);return true;}
  return false;
}
if(popup){
  await tabs.switch(popup.id);await sleep(300);
  let g=await G();
  if(/name=address1/.test(g.tree)){
    const nmB=g.tree.match(/\[(\d+)\] textbox name=name value="([^"]*)"/);
    if(nmB&&(nmB[2].length>20||!nmB[2])){await page.type(parseInt(nmB[1]),NM,false);await sleep(400);g=await G();}
    const mb=g.tree.match(/\[(\d+)\] textbox name=mobile value="([^"]*)"/);
    if(mb&&!mb[2]){await page.type(parseInt(mb[1]),args.mobile||args.phone||'010-9694-0674',false);await sleep(300);g=await G();}
    const z=g.tree.match(/textbox name=zipcode1 value="([^"]*)"/);
    if(z&&!z[1]){
      const q=((args.address||'').match(/[가-힣0-9]+(?:대로|로|길)\s*\d+(?:-\d+)?/)||[])[0]||args.address;
      for(let t=0;t<3;t++){
        let rb=g.tree.match(/\[(\d+)\] textbox [^\n]*name=region_name/);
        if(!rb){const fb=g.tree.match(/\[(\d+)\] button "주소 찾기"/);if(fb){await K(parseInt(fb[1]));await sleep(1500);g=await G();rb=g.tree.match(/\[(\d+)\] textbox [^\n]*name=region_name/);}}
        if(!rb)break;
        await page.type(parseInt(rb[1]),q,false);await sleep(500);
        const sb=g.tree.match(/\[(\d+)\] clickable "검색"/)||g.tree.match(/\[(\d+)\] button "검색"/);
        if(sb)await K(parseInt(sb[1]));
        await sleep(1800);g=await G();
        const res=g.tree.match(/\[(\d+)\] button "(경기|서울|인천|부산|대구|광주|대전|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주)[^"]*"/);
        if(res){await K(parseInt(res[1]));await sleep(1500);g=await G();break;}
      }
      const z2=g.tree.match(/textbox name=zipcode1 value="([^"]*)"/);
      if(!z2||!z2[1]){out.note='우편번호 검색 실패';return out;}
    }
    const a2=g.tree.match(/\[(\d+)\] textbox name=address2 value="([^"]*)"/);
    if(a2&&(!a2[2]||a2[2]==='-'||/[ㄱ-ㅎㅏ-ㅣ]/.test(a2[2]))){
      let d=args.address_detail;
      if(!d){const tail=((args.address||'').match(/\)\s*([^()]+)$/)||[])[1];if(tail&&tail.trim())d=tail.trim();}
      if(!d){const m0=(args.name||'').match(/\d+동\s*\d+호/);if(m0)d=m0[0];}
      if(!d){
        const a1=(g.tree.match(/textbox name=address1 value="([^"]*)"/)||[])[1]||args.address||'';
        const m=a1.match(/[0-9A-Za-z가-힣]*\d+동\s*\d+호|\d+-\d+호|\d+호|\d+층/g);
        d=m?m[m.length-1]:'-';
      }
      if(d!==a2[2]){await page.type(parseInt(a2[1]),d,false);await sleep(300);g=await G();}
    }
    for(let k=0;k<3;k++){
      const pend=g.tree.match(/\[(\d+)\] button "(?:배송 요청사항[^"]*|직접입력|선택해주세요)"/);
      if(!pend)break;
      await C(parseInt(pend[1]));await sleep(800);g=await G();
      let one=null;
      for(const p of PRESET){const m=g.tree.match(new RegExp('\\[(\\d+)\\] (?:clickable|radio) "'+p+'"'));if(m){one=m;break;}}
      if(!one)break;
      await C(parseInt(one[1]));await sleep(800);g=await G();
    }
    {const cl=g.tree.match(/\[(\d+)\] (?:clickable|button) "(?:바텀 시트 닫기)"/);
     if(cl){try{await page.clickNative(parseInt(cl[1]));}catch(e){}await sleep(500);g=await G();}}
    const sv=g.tree.match(/\[(\d+)\] button "(?:저장하기|저장|확인)"/);
    if(!sv){out.note='저장하기 없음';return out;}
    await C(parseInt(sv[1]));await sleep(1500);
  }
  for(let i=0;i<10&&left();i++){
    list=await tabs.list();popup=list.find(t=>t.kind==='popup');
    if(!popup)break;
    await tabs.switch(popup.id);let g=await G({interactive:true,query:'address2'});
    if(/name=address2/.test(g.tree)){
      if(i===9){const t=g.tree.slice(g.tree.indexOf('PAGE TEXT:'));const e=t.match(/(입력해주세요|올바르지|확인해주세요|일시적인 문제)[^\n]{0,30}/);out.note='저장 안 됨: '+(e?e[0]:'폼 유지');return out;}
      await sleep(900);continue;
    }
    await pickRow();
    break;
  }
}
async function readOrder(){
  await tabs.switch(orderTab.id);await sleep(500);
  const of=await G({query:'배송지'});
  const tx=of.tree.slice(of.tree.indexOf('PAGE TEXT:'));
  const nm=NM;let hit=!!nm&&tx.includes(nm);
  for(let k=nm.length-1;!hit&&k>=Math.min(5,nm.length)&&k>0;k--)hit=tx.includes(nm.slice(0,k)+'...')||tx.includes(nm.slice(0,k)+'…');
  const ad=strip(args.address||'');const nums=ad.match(/\d+/g)||[];
  const st=strip(tx);
  const rd=(args.address||'').match(/([가-힣0-9]+(?:대로|로|길))\s*(\d+(?:-\d+)?)/);
  const adHit=!!ad&&(st.includes(ad.slice(0,12))||(nums.length&&st.includes(nums[nums.length-1]))||(rd&&st.includes(rd[1]+rd[2])));
  let line=null;
  if(adHit){const i=tx.indexOf('배송지 변경');const seg=i>=0?tx.slice(i+6,i+220):'';const m=seg.match(/^\s*(.*?)\s+010-/);if(m&&m[1].trim())line=m[1].trim();}
  return {hit,adHit,line};
}
let r=null;let opened=false;
for(let n=0;n<7&&left();n++){
  await W('배송지',4000);
  r=await readOrder();
  if(r.hit&&r.adHit)break;
  const l3=await tabs.list();
  if(l3.some(t=>t.kind==='popup')){await pickRow();}
  else if(n>=1&&(!opened||n>=4)){
    opened=true;
    await tabs.switch(orderTab.id);const og=await G({interactive:true,query:'배송지 변경'});
    const bt=og.tree.match(/\[(\d+)\] (?:button|clickable) "배송지 변경"/);
    if(bt){await K(parseInt(bt[1]));
      for(let w=0;w<10;w++){await sleep(700);const l4=await tabs.list();if(l4.some(t=>t.kind==='popup'))break;}
      await pickRow();}
  }
  await sleep(1000);
}
if(!r)r=await readOrder();
out.name=r.hit?args.name:null;
out.address=r.adHit?(r.line||args.address):null;
out.ok=!!(out.name&&out.address);
if(!out.ok)out.note='주문서 되읽기 불일치'+(out.name?'':' (이름 없음)')+(out.address?'':' (주소 없음)')+(hadPopup?'':' (주소 창 없었음)');
return out;