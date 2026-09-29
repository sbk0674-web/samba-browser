// 2026-09-26 점검: 주문서 탭을 '가장 최근 것'으로 고르지 않는다 — args.tab, 없으면 레인에 하나뿐인 무신사 주문서(여럿이면 멈춘다, 197←196 사고). 나머지 흐름은 실적(runs/fails 0) 그대로.
const out={ok:false,name:null,address:null,note:null};
async function G(o){for(let i=0;i<8;i++){try{return await page.get(o||{interactive:true});}catch(e){await sleep(700);}}throw new Error('page busy');}
async function C(id){try{await page.clickNative(id);}catch(e){try{await page.click(id);}catch(e2){}}}
async function W(t,ms){try{return await page.waitFor(t,ms||8000);}catch(e){return null;}}
const strip=s=>(s||'').replace(/\s+/g,'');
const PRESET=['문 앞에 놔주세요','경비실에 맡겨주세요','택배함에 넣어주세요','배송 전에 연락 주세요'];
let list=await tabs.list();
const __ofs=list.filter(t=>t.url&&t.url.includes('/order/order-form'));const __one=args.tab?__ofs.find(t=>t.id===args.tab):__ofs.length===1?__ofs[0]:null;
const orderTab=__one;
if(!orderTab){out.note=__ofs.length?'order forms '+__ofs.length+' open — pass args.tab':'no order-form tab open';return out;}
let popup=list.find(t=>t.kind==='popup'&&/address/.test(t.url||''));const hadPopup=!!popup;
if(popup){
  await tabs.switch(popup.id);await sleep(300);
  let g=await G();
  if(/name=address1/.test(g.tree)){
    const a2=g.tree.match(/\[(\d+)\] textbox name=address2 value="([^"]*)"/);
    if(a2&&!a2[2]){
      let d=args.address_detail;
      if(!d){
        const a1=(g.tree.match(/textbox name=address1 value="([^"]*)"/)||[])[1]||args.address||'';
        const m=a1.match(/[0-9A-Za-z가-힣]*\d+동\s*\d+호|\d+-\d+호|\d+호|\d+층/g);
        d=m?m[m.length-1]:'-';
      }
      await page.type(parseInt(a2[1]),d,false);await sleep(300);g=await G();
    }
    // 배송 요청사항: 아직 프리셋이 안 골라졌으면 고른다(시트가 닫혀 있으면 먼저 연다)
    for(let k=0;k<3;k++){
      const done=PRESET.some(p=>new RegExp('\\[\\d+\\] button "'+p+'"').test(g.tree));
      const freeBox=g.tree.match(/\[(\d+)\] textbox "[^"]*50자[^"]*" value="([^"]*)"/);
      if(done&&!(freeBox&&!freeBox[2]))break;
      const sheetOpen=PRESET.every(p=>new RegExp('\\[\\d+\\] (?:clickable|button|radio) "'+p+'"').test(g.tree));
      if(!sheetOpen){
        const sel=g.tree.match(/\[(\d+)\] button "(배송 요청사항[^"]*|직접입력|선택해주세요)"/);
        if(!sel)break;
        await C(parseInt(sel[1]));await W(PRESET[0],5000);g=await G();
      }
      let one=null;
      for(const p of PRESET){
        const m=g.tree.match(new RegExp('\\[(\\d+)\\] (?:clickable|radio) "'+p+'"'));
        if(m){one=m;break;}
      }
      if(one){await C(parseInt(one[1]));await sleep(600);g=await G();}
      else if(freeBox){await page.type(parseInt(freeBox[1]),PRESET[0],false);await sleep(300);g=await G();break;}
      else break;
    }
    // 바텀시트가 남아 있으면 닫아 저장 버튼 위 오버레이를 없앤다
    for(let k=0;k<3;k++){
      const cl=g.tree.match(/\[(\d+)\] (?:clickable|button) "(?:바텀 시트 닫기|Close|닫기)"/);
      const open=PRESET.filter(p=>new RegExp('\\[\\d+\\] clickable "'+p+'"').test(g.tree)).length>=3;
      if(!open||!cl)break;
      await C(parseInt(cl[1]));await sleep(600);g=await G();
    }
    const sv=g.tree.match(/\[(\d+)\] button "(?:저장하기|저장|확인)"/);
    if(!sv){out.note='저장하기 없음';return out;}
    await C(parseInt(sv[1]));await sleep(1200);
  }
  for(let i=0;i<10;i++){
    list=await tabs.list();popup=list.find(t=>t.kind==='popup');
    if(!popup)break;
    await tabs.switch(popup.id);g=await G();
    if(/name=address2/.test(g.tree)){
      if(i===9){const t=g.tree.slice(g.tree.indexOf('PAGE TEXT:'));const e=t.match(/(입력해주세요|올바르지|확인해주세요)[^\n]{0,30}/);out.note='저장 안 됨: '+(e?e[0]:'폼 유지');return out;}
      await sleep(900);continue;
    }
    const rows=g.tree.split('\n').filter(l=>/^\[\d+\] (clickable|radio|button)/.test(l)&&l.includes(args.name)&&!/수정|삭제/.test(l));
    if(rows[0]){await C(parseInt(rows[0].match(/^\[(\d+)\]/)[1]));await sleep(600);g=await G();}
    const ch=g.tree.match(/\[(\d+)\] (?:button|link|clickable) "(?:변경하기|선택하기|선택|적용)"/);
    if(ch){await C(parseInt(ch[1]));await sleep(1500);}
    break;
  }
}
await tabs.switch(orderTab.id);await sleep(500);
await W('배송지',6000);
const of=await G({query:'배송지'});
const tx=of.tree.slice(of.tree.indexOf('PAGE TEXT:'));
// 주문서는 긴 수취인 이름을 '앞 몇 자...'로 줄여 보인다(실기 2026-09-27: 15자 이름) — 앞 5자+ 와 ... 이면 같은 이름
const nm=args.name||'';let hit=!!nm&&tx.includes(nm);
for(let k=nm.length-1;!hit&&k>=5;k--)hit=tx.includes(nm.slice(0,k)+'...')||tx.includes(nm.slice(0,k)+'…');
out.name=hit?args.name:null;
const ad=strip(args.address||'');const nums=ad.match(/\d+/g)||[];
const st=strip(tx);
out.address=ad&&st.includes(ad.slice(0,12))?args.address:(nums.length&&st.includes(nums[nums.length-1])?args.address:null);
out.ok=!!(out.name&&out.address);
if(!out.ok)out.note='주문서 되읽기 불일치'+(out.name?'':' (이름 없음)')+(out.address?'':' (주소 없음)')+(hadPopup?'':' (주소 창 없었음)');
return out;