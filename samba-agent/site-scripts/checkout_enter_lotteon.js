let PC=i=>page.click(i),GQ=q=>page.get({query:q}),S=ms=>sleep(ms),PI=parseInt,ON=l=>/value="on"/.test(l),ID=l=>PI(l.slice(1)),F=e=>({ok:false,error:e});
let AT=async()=>String((await page.get({})).tree||'');
let cardCompanies=['롯데카드','신한카드','KB국민카드','삼성카드','현대카드','BC카드','하나카드','우리BC카드','우리카드','NH농협카드'];
let simplePays=['간편결제','카카오페이','네이버페이','토스페이','삼성페이','퀵계좌이체'];
let card=simplePays.find(p=>String(args.card||'').startsWith(p))||(args.issuer||args.card||'');
if(args.tab&&(await tabs.list()).some(t=>t.id===String(args.tab))) await tabs.switch(String(args.tab));
{ let ot=(await tabs.list()).filter(t=>/orderSheet/.test(t.url||'')&&t.profile==args.profile);
let good=async()=>{let T=(await AT());let r=T.split('\n').find(l=>/radio "받는 분 주소로/.test(l));return !r||(ON(r)&&!/배송지를 선택해 ?주세요/.test(T))};
if(ot.length>1&&!(await good())){for(let t of ot){await tabs.switch(t.id);await S(300);if(await good())break}}}
let url=await page.url();
if(!/orderSheet/.test(url))return F('no sheet');
for(let i=0;i<6&&!/결제수단/.test((await GQ('결제수단')).tree);i++){
let c=await page.idOf('계속하기');if(c<0)break;await PC(c);await S(2500);
}
let fu=await page.idOf('전액사용');if(fu>=0){await PC(fu);await S(2500)}
let method=null;
let mc=cardCompanies.find(c=>c.includes(card)||(card&&card.length>0&&c.replace('카드','').includes(card)));
if(mc){
await page.clickText('신용카드');
await S(600);
let sel=await page.idOf('카드를 선택해 주세요.');
if(sel<0)return F('no card');
await PC(sel);
await S(600);
await page.clickText(mc);
method=mc;
} else {
let mp=simplePays.find(p=>p.includes(card)||(card&&card.length>0&&p.includes(card)));
if(!mp)return F('no method');
let KP=mp==='카카오페이',KK=args.kakao_card?'카카오페이 카드':'카카오페이 머니';
let LC=mp==='간편결제';
await page.clickText(mp);await S(1500);
{
let Q=async(q,re)=>(await GQ(q)).tree.split('\n').filter(l=>re.test(l));
let hi=ls=>ls.length?Math.max(...ls.map(l=>ID(l))):-1;
let disc=async()=>{let t=(await GQ('주문할인금액')).tree;let m=(t.split('PAGE TEXT')[1]||t).match(/주문할인금액\s*할인변경\s*(-?[\d,]+)원/);return m?PI(m[1].replace(/[,-]/g,''),10):0};
if(LC||!(await disc())){
let hb=await page.idOf('할인변경');var nd=hb<0;
if(hb>=0){await PC(hb);await S(2000);
let rs=(KP?await Q(KK,new RegExp('radio "'+KK+'\\d+%')):LC?await Q('롯데카드',/radio "롯데카드\s*\d+%/):await Q('장바구니',/radio "\d+% ?장바구니 ?쿠폰/)).map(l=>({id:ID(l),p:+(l.match(/(\d+)%/)||[])[1],on:ON(l)}));let QK=KP?KK:'롯데카드',TX=(await GQ('즉시할인')).tree.replace(/\s+/g,' '),AM=r=>+((TX.match(QK+' ?'+r.p+'% 즉시할인.{0,9}-([0-9,]+)')||[])[1]||'0').replace(/,/g,'');
let mx=rs.length?Math.max(...rs.map(x=>x.id)):0;let cs=rs.filter(r=>r.id>mx-20).sort((a,b)=>(AM(b)-AM(a))||b.p-a.p);let best=cs[0];
if(!best&&(KP||LC))return{ok:false,error:(KP?KK:'롯데카드')+' 할인없음'};
if(!best){let c=hi(await Q('닫기',/button "닫기"/));if(c>0){await PC(c);await S(600)}}
else{var want=1;if(!best.on){if((LC||KP)&&page.clickNative)await page.clickNative(best.id);else await PC(best.id);await S(1200)}let on=async()=>(await Q(QK,/radio/)).some(l=>+l.slice(1,l.indexOf(']'))===best.id&&ON(l));if((KP||LC)&&!(await on())){for(let c of cs){best=c;for(let x of [c.id+1,c.id]){await PC(x);await S(1200);if(await on())break}if(await on())break}if(!(await on()))return{ok:false,error:QK+' 미선택'}}
let b=hi(await Q('할인혜택 받기',/button "[\d,]+원 할인혜택 받기"/));if(b<0)return F('할인버튼?');
await PC(b);await S(2500);
let ap=hi(await Q('적용하기',/button "적용하기"/));if(ap>0){await PC(ap);await S(3500)}
}}
}
if((KP&&!nd||typeof want!=='undefined')&&!(await disc()))return{ok:false,error:(KP?KK+' 즉시할인':LC?'롯데카드 즉시할인':'장바구니 쿠폰')+' 안 붙음'};
}
await page.clickText(mp);
method=mp;
if(mp==='간편결제'){
await S(1200);
let want=String(args.easy_card||(args.card==='간편결제'?args.issuer:'')||'롯데카드');
let rl=(await GQ('L.PAY 카드')).tree.split('\n').find(l=>/^\[\d+\] radio "L\.PAY 카드"/.test(l));
if(rl&&!ON(rl)){await PC(PI(rl.slice(1)));await S(1200)}
let sel='';for(let k=0;k<8&&!sel;k++){let P=((await AT()).split('PAGE TEXT')[1]||'').replace(/\s+/g,' ');sel=/카드를 먼저 선택/.test(P)?'':((P.match(/카드선택 ([^+]{2,30}?) L\.PAY/)||[])[1]||'').trim();if(!sel)await S(700)}
if(!sel.includes(want.replace('카드',''))){
for(let o of ['textbox','label']){let g=await GQ('카드');let re=o==='textbox'?/^\[(\d+)\] (?:textbox|combobox) "카드(를 선택|선택)/:/^\[(\d+)\] label "카드선택"/;let l=g.tree.split('\n').find(x=>re.test(x));if(!l)continue;await PC(ID(l));await S(600);let f=(await GQ(want)).tree.split('\n').find(x=>/^\[\d+\] (option|listitem|clickable|button|link) /.test(x)&&x.includes(want));if(f){await PC(PI(f.slice(1)));await S(900);break}}
sel='';for(let k=0;k<6&&!sel;k++){let P=((await AT()).split('PAGE TEXT')[1]||'').replace(/\s+/g,' ');sel=/카드를 먼저 선택/.test(P)?'':((P.match(/카드선택 ([^+]{2,30}?) L\.PAY/)||[])[1]||'').trim();if(!sel)await S(700)}
}
if(!sel.includes(want.replace('카드','')))return{ok:false,error:'L.PAY '+want+'≠'+sel,method};
method='간편결제/'+sel;
}
}
await S(600);
let receipt=null,after=null;
try{
let rt=(await GQ('지출증빙용')).tree;
let rm=rt.match(/\[(\d+)\] radio "지출증빙용"[^\n]*/);
if(rm){
if(!ON(rm[0])){await PC(PI(rm[1]));await S(900)}
receipt='지출증빙용';
let tb=null;
for(let k=0;k<8&&!tb;k++){tb=(await GQ('10자리')).tree.split('\n').find(l=>/^\[\d+\] textbox "[^"]*10자리/.test(l))||null;if(!tb)await S(700)}
if(!tb)receipt='지출증빙용?';
let cur=tb?((tb.match(/value="([^"]*)"/)||[])[1]||'').replace(/\D/g,''):'';
if(tb&&args.biz_no&&cur!==String(args.biz_no)){await page.type(PI(tb.slice(1)),String(args.biz_no),true);await S(500);receipt='지출증빙용(번호 입력)'}
}
}catch(e){receipt='확인 실패'}
try{let st=(await GQ('입력한 이름으로 선물')).tree.split('\n').find(l=>/^\[\d+\] textbox "입력한 이름으로 선물/.test(l));
if(st&&!/value="[^"]+"/.test(st)){let hn=((await GQ('님로그아웃')).tree.match(/([가-힣A-Za-z]{2,10})님\s*로그아웃/)||[])[1];if(hn){await page.type(PI(st.slice(1)),hn,false);await S(500)}}}catch(e){}
try{let ra=(await GQ('받는 분 주소로 보내기')).tree.split('\n').find(l=>/^\[\d+\] radio "받는 분 주소로/.test(l));
if(ra&&!ON(ra)){await PC(PI(ra.slice(1)));await S(1500)}}catch(e){}
if(args.gift&&!ON(((await GQ('받는 분 주소로 보내기')).tree.match(/radio "받는 분 주소로[^\n]*/)||[''])[0]))return F('선물 주문서 아님');
if(args.amount){let m=(await AT()).replace(/\s+/g,' ').match(/총 결제금액.{0,200}?총 ?\d+ ?건 ?([\d,]+)/);if(m&&+m[1].replace(/,/g,'')>args.amount+10)return F('결제액>견적')}let payId=await page.idOf('결제하기');
if(payId<0)return{ok:false,error:'결제하기?',method};
let pr=String(await PC(payId));
let LP=/dialog "L\.PAY 비밀번호/,DN=/order\/complete/;for(let k=0;k<4;k++){
let T='',h=0;for(let w=0;w<20;w++){await S(1e3);T=await AT();if(LP.test(T)||DN.test(T)||/OVERLAY: "[^"]*(주문할인|할인 결제|혜택이)/.test(T))break}
if(LP.test(T)||DN.test(T))break;
let Z=async(q,r)=>(await GQ(q)).tree.split('\n').filter(l=>r.test(l)).map(l=>ID(l));
if(/OVERLAY: "[^"]*주문할인혜택/.test(T)){let P=l=>+l.match(/(\d+)%/)[1]+(/간편/.test(method)&&/롯데카드/.test(l)?99:0),q=(await GQ('%')).tree.split('\n').filter(l=>/^\[\d+\] radio "[^"]*\d+%/.test(l)).sort((x,y)=>P(y)-P(x)),r=q.slice(0,1).map(l=>ID(l));if(r.length&&!k){await PC(r[0]+1);await S(800);await PC(r[0]);await S(1200);let g=await Z('할인혜택 받기',/button "[\d,]+원 할인혜택 받기"/);if(g.length){await PC(g[0]);await S(2500);h=1}}
if(!h){let b=await Z('닫기',/button "닫기"/);if(b.length){await PC(Math.max(...b));await S(2000);h=1}}}
if(/OVERLAY: "[^"]*할인 결제수단으로만/.test(T)){let b=await Z('적용하기',/button "적용하기"/);if(b.length){await PC(Math.max(...b));await S(2500);h=1}}
if(/OVERLAY: "혜택이 변경/.test(T)){await S(2500);continue}
if(!h)break;
let a=await page.idOf('결제하기');if(a<0)break;pr=String(await PC(a))}
await S(3000);
if(/OVERLAY: "[^"]*주문할인혜택/.test((await AT())))return{ok:false,error:'할인창',method};
if(/네이버페이/.test(method)){
return{ok:false,naver_card_required:true,error:'네이버 카드검증',method,receipt};
}
try{let T=(await AT());if(/^URL: [^\n]*orderSheet/.test(T)){let m=T.match(/사업자등록번호[^\n]{0,25}입력해 ?주세요/);if(m)after='주문서 막힘:'+m[0];
}}catch(e){}
if(after)return{ok:false,error:after,method,receipt};
let tbs=await tabs.list();
let popup=tbs.find(t=>t.kind==='popup');
return{ok:true,method,receipt,popup_url:popup?popup.url:null,keypad_in_tab:LP.test(await AT())};