const PC=i=>page.click(i),S=ms=>sleep(ms);
const AT=async()=>String((await page.get({})).tree||'');
const cardCompanies=['롯데카드','신한카드','KB국민카드','삼성카드','현대카드','BC카드','하나카드','우리BC카드','우리카드','NH농협카드'];
const simplePays=['간편결제','카카오페이','네이버페이','토스페이','삼성페이','퀵계좌이체'];
const card=simplePays.find(p=>String(args.card||'').startsWith(p))||(args.issuer||args.card||'');
if(args.tab&&(await tabs.list()).some(t=>t.id===String(args.tab))) await tabs.switch(String(args.tab));
{ const ot=(await tabs.list()).filter(t=>/orderSheet/.test(t.url||'')&&t.profile==args.profile);
const good=async()=>{const T=(await AT());const r=T.split('\n').find(l=>/radio "받는 분 주소로/.test(l));return !r||(/value="on"/.test(r)&&!/배송지를 선택해 ?주세요/.test(T));};
if(ot.length>1&&!(await good())){for(const t of ot){await tabs.switch(t.id);await S(300);if(await good())break;}}}
const url=await page.url();
if(!/orderSheet/.test(url))return{ok:false,error:'no sheet'};
for(let i=0;i<6&&!/결제수단/.test((await page.get({query:'결제수단'})).tree);i++){
const c=await page.idOf('계속하기');if(c<0)break;await PC(c);await S(2500);
}
const fu=await page.idOf('전액사용');if(fu >= 0){ await PC(fu);await S(2500);}
let method=null;
const mc=cardCompanies.find(c=>c.includes(card)||(card&&card.length>0&&c.replace('카드','').includes(card)));
if(mc){
await page.clickText('신용카드');
await S(600);
const sel=await page.idOf('카드를 선택해 주세요.');
if(sel<0)return{ok:false,error:'no card'};
await PC(sel);
await S(600);
await page.clickText(mc);
method=mc;
} else {
const mp=simplePays.find(p=>p.includes(card)||(card&&card.length>0&&p.includes(card)));
if(!mp)return{ok:false,error:'no method'};
const KP=mp==='카카오페이',KK=args.kakao_card?'카카오페이 카드':'카카오페이 머니';
const LC=mp==='간편결제';
await page.clickText(mp);await S(1500);
{
const Q=async(q,re)=>(await page.get({query:q})).tree.split('\n').filter(l=>re.test(l));
const hi=ls=>ls.length?Math.max(...ls.map(l=>parseInt(l.slice(1)))):-1;
const disc=async()=>{const t=(await page.get({query:'주문할인금액'})).tree;const m=(t.split('PAGE TEXT')[1]||t).match(/주문할인금액\s*할인변경\s*(-?[\d,]+)원/);return m?parseInt(m[1].replace(/[,-]/g,''),10):0;};
if(LC||!(await disc())){
const hb=await page.idOf('할인변경');var nd=hb<0;
if(hb>=0){await PC(hb);await S(2000);
const rs=(KP?await Q(KK,new RegExp('radio "'+KK+'\\d+%')):LC?await Q('롯데카드',/radio "롯데카드\s*\d+%/):await Q('장바구니',/radio "\d+% ?장바구니 ?쿠폰/)).map(l=>({id:parseInt(l.slice(1)),p:+(l.match(/(\d+)%/)||[])[1],on:/value="on"/.test(l)}));
const mx=rs.length?Math.max(...rs.map(x=>x.id)):0;const cs=rs.filter(r=>r.id>mx-20).sort((a,b)=>b.p-a.p);let best=cs[0];
if(!best&&(KP||LC))return{ok:false,error:(KP?KK:'롯데카드')+' 할인없음'};
if(!best){const c=hi(await Q('닫기',/button "닫기"/));if(c>0){await PC(c);await S(600);}}
else{var want=1;if(!best.on){if((LC||KP)&&page.clickNative)await page.clickNative(best.id);else await PC(best.id);await S(1200);}const on=async()=>(await Q(KK,/radio/)).some(l=>+l.slice(1,l.indexOf(']'))===best.id&&/value="on"/.test(l));if(KP&&!(await on())){for(const c of cs){best=c;await PC(c.id);await S(1200);if(await on())break}if(!(await on()))return{ok:false,error:KK+' 미선택'}}
const b=hi(await Q('할인혜택 받기',/button "[\d,]+원 할인혜택 받기"/));if(b<0)return{ok:false,error:'할인버튼?'};
await PC(b);await S(2500);
const ap=hi(await Q('적용하기',/button "적용하기"/));if(ap>0){await PC(ap);await S(3500);}
}}
}
if((KP&&!nd||typeof want!=='undefined')&&!(await disc()))return{ok:false,error:(KP?KK+' 즉시할인':LC?'롯데카드 즉시할인':'장바구니 쿠폰')+' 안 붙음'};
}
await page.clickText(mp);
method=mp;
if(mp==='간편결제'){
await S(1200);
const want=String(args.easy_card||(args.card==='간편결제'?args.issuer:'')||'롯데카드');
const rl=(await page.get({query:'L.PAY 카드'})).tree.split('\n').find(l=>/^\[\d+\] radio "L\.PAY 카드"/.test(l));
if(rl&&!/value="on"/.test(rl)){await PC(parseInt(rl.slice(1)));await S(1200);}
let sel='';for(let k=0;k<8&&!sel;k++){const P=((await AT()).split('PAGE TEXT')[1]||'').replace(/\s+/g,' ');sel=/카드를 먼저 선택/.test(P)?'':((P.match(/카드선택 ([^+]{2,30}?) L\.PAY/)||[])[1]||'').trim();if(!sel)await S(700);}
if(!sel.includes(want.replace('카드',''))){
for(const o of ['textbox','label']){const g=await page.get({query:'카드'});const re=o==='textbox'?/^\[(\d+)\] (?:textbox|combobox) "카드(를 선택|선택)/:/^\[(\d+)\] label "카드선택"/;const l=g.tree.split('\n').find(x=>re.test(x));if(!l)continue;await PC(parseInt(l.slice(1)));await S(600);const f=(await page.get({query:want})).tree.split('\n').find(x=>/^\[\d+\] (option|listitem|clickable|button|link) /.test(x)&&x.includes(want));if(f){await PC(parseInt(f.slice(1)));await S(900);break}}
sel='';for(let k=0;k<6&&!sel;k++){const P=((await AT()).split('PAGE TEXT')[1]||'').replace(/\s+/g,' ');sel=/카드를 먼저 선택/.test(P)?'':((P.match(/카드선택 ([^+]{2,30}?) L\.PAY/)||[])[1]||'').trim();if(!sel)await S(700);}
}
if(!sel.includes(want.replace('카드','')))return{ok:false,error:'L.PAY '+want+'≠'+sel,method};
method='간편결제/'+sel;
}
}
await S(600);
let receipt=null,after=null;
try{
const rt=(await page.get({query:'지출증빙용'})).tree;
const rm=rt.match(/\[(\d+)\] radio "지출증빙용"[^\n]*/);
if(rm){
if(!/value="on"/.test(rm[0])){await PC(parseInt(rm[1]));await S(900);}
receipt='지출증빙용';
let tb=null;
for(let k=0;k<8&&!tb;k++){tb=(await page.get({query:'10자리'})).tree.split('\n').find(l=>/^\[\d+\] textbox "[^"]*10자리/.test(l))||null;if(!tb)await S(700);}
if(!tb)receipt='지출증빙용?';
const cur=tb?((tb.match(/value="([^"]*)"/)||[])[1]||'').replace(/\D/g,''):'';
if(tb&&args.biz_no&&cur!==String(args.biz_no)){await page.type(parseInt(tb.slice(1)),String(args.biz_no),true);await S(500);receipt='지출증빙용(번호 입력)';}
}
}catch(e){receipt='확인 실패';}
try{const st=(await page.get({query:'입력한 이름으로 선물'})).tree.split('\n').find(l=>/^\[\d+\] textbox "입력한 이름으로 선물/.test(l));
if(st&&!/value="[^"]+"/.test(st)){const hn=((await page.get({query:'님로그아웃'})).tree.match(/([가-힣A-Za-z]{2,10})님\s*로그아웃/)||[])[1];if(hn){await page.type(parseInt(st.slice(1)),hn,false);await S(500);}}}catch(e){}
try{const ra=(await page.get({query:'받는 분 주소로 보내기'})).tree.split('\n').find(l=>/^\[\d+\] radio "받는 분 주소로/.test(l));
if(ra&&!/value="on"/.test(ra)){await PC(parseInt(ra.slice(1)));await S(1500);}}catch(e){}
const payId=await page.idOf('결제하기');
if(payId<0)return{ok:false,error:'결제하기?',method};
let pr=String(await PC(payId));
const LP=/dialog "L\.PAY 비밀번호/,DN=/order\/complete/;for(let k=0;k<4;k++){
let T='',h=0;for(let w=0;w<20;w++){await S(1e3);T=await AT();if(LP.test(T)||DN.test(T)||/OVERLAY: "[^"]*(주문할인|할인 결제|혜택이)/.test(T))break}
if(LP.test(T)||DN.test(T))break;
const Z=async(q,r)=>(await page.get({query:q})).tree.split('\n').filter(l=>r.test(l)).map(l=>parseInt(l.slice(1)));
if(/OVERLAY: "[^"]*주문할인혜택/.test(T)){const P=l=>+l.match(/(\d+)%/)[1]+(/간편/.test(method)&&/롯데카드/.test(l)?99:0),q=(await page.get({query:'%'})).tree.split('\n').filter(l=>/^\[\d+\] radio "[^"]*\d+%/.test(l)).sort((x,y)=>P(y)-P(x)),r=q.slice(0,1).map(l=>parseInt(l.slice(1)));if(r.length){await page.clickNative(r[0]);await S(1200);const g=await Z('할인혜택 받기',/button "[\d,]+원 할인혜택 받기"/);if(g.length){await PC(g[0]);await S(2500);h=1}}
if(!h){const b=await Z('닫기',/button "닫기"/);if(b.length){await page.clickNative(Math.max(...b));await S(2000);h=1}}}
if(/OVERLAY: "[^"]*할인 결제수단으로만/.test(T)){const b=await Z('적용하기',/button "적용하기"/);if(b.length){await PC(Math.max(...b));await S(2500);h=1}}
if(/OVERLAY: "혜택이 변경/.test(T)){await S(2500);continue}
if(!h)break;
const a=await page.idOf('결제하기');if(a<0)break;pr=String(await PC(a))}
await S(3000);
if(/OVERLAY: "[^"]*주문할인혜택/.test((await AT())))return{ok:false,error:'할인창',method};
if(/네이버페이/.test(method)){
return{ok:false,naver_card_required:true,error:'네이버 카드검증',method,receipt};
}
try{const T=(await AT());if(/^URL: [^\n]*orderSheet/.test(T)){const m=T.match(/사업자등록번호[^\n]{0,25}입력해 ?주세요/);if(m)after='주문서 막힘:'+m[0];
}}catch(e){}
if(after)return{ok:false,error:after,method,receipt};
const tbs=await tabs.list();
const popup=tbs.find(t=>t.kind==='popup');
const DT=(await AT());
return{ok:true, method, receipt, popup_url: popup? popup.url : null, keypad_in_tab: LP.test(DT) };
