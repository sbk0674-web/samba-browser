const nz=s=>String(s||'').replace(/\s+/g,' ').trim(),num=s=>parseInt(String(s||'').replace(/\D/g,''),10)||0;
const no=nz(args.source_order_no||args.orderNo).replace(/\D/g,'');
const R={source_order_no:no||null,status:'',paid:0,points_used:0,reward:0,reward_verified:false,card:'',note:null,selected:null,qty:null,shipping:{name:null,address:null,address_detail:null}};
if(!/^\d{12,20}$/.test(no))return {...R,note:'no order number'};
const pf=args.profile?{profile:args.profile}:{},opened=[];
const read=async selector=>nz(String((await page.get(selector?{selector}:{})).tree||'').split('PAGE TEXT:')[1]);
const visit=async url=>{let x=(await tabs.list()).find(x=>x.url===url&&(!args.profile||x.profile===args.profile));let id=x?.id;if(!id){id=(String(await tabs.open({...pf,url})).match(/tab (\S+)/)||[])[1];if(id)opened.push(id)}if(id)await tabs.switch(id);await page.waitFor(/결제\s*정보|결제\s*금액|로그인|Incapsula/,8000).catch(()=>{});return read()};
const base='https://www.lotteon.com/p/order/';
let t='';const existing=(await tabs.list()).find(x=>(x.url||'').includes('odNo='+no)&&(!args.profile||x.profile===args.profile));
if(existing){await tabs.switch(existing.id);await page.waitFor('결제',8000).catch(()=>{});t=await read()}
for(const path of ['claim/orderDetail?odNo='+no,'claim/giftBoxDetail?odNo='+no+'&type=snd']){if(t.includes(no)&&/결제\s*정보/.test(t))break;t=await visit(base+path)}
if(t.includes(no)&&/결제\s*정보/.test(t)){
const body=t.slice(t.indexOf(no));
const interactive=String((await page.get({interactive:true})).tree||'');
let st=body.split(/결제\s*정보|구매적립|리뷰적립/)[0].replace(/(?:자동\s*)?구매\s?확정\s*예정(?:일)?/g,'').replace(/구매\s?확정연장/g,'');if(/\] button "구매\s?확정"/.test(interactive))st=st.replace(/구매\s?확정/g,'');
R.status=(st.match(/결제\s?완료|상품준비중|출고지시|배송중|배송완료|구매\s?확정|취소완료|취소요청|반품회수/)||[])[0]||'';
for(const m of body.matchAll(/([가-힣A-Za-z.]*적립(?:예정|완료))\s*([\d,]+)\s*P/g))if(!/리뷰|후기/.test(m[1])){R.reward+=num(m[2]);R.reward_verified=true}
const pay=(body.split(/결제\s*정보/)[1]||'').split(/현금영수증|목록보기|최근본상품/)[0],methods=[];
for(const m of pay.matchAll(/([가-힣A-Za-z.\s()\-·\d]+?)\s*결제\s?완료\s*([\d,]+)\s*(원|P)/g)){const name=nz(m[1].replace(/\([^)]*\)/g,''));if(m[3]==='P'||/포인트|적립금|L\.POINT/.test(name))R.points_used+=num(m[2]);else{R.paid+=num(m[2]);methods.push(name)}}
R.card=methods.join(' + ');if(!R.paid)R.paid=num((body.match(/(?:총|최종|실제)?\s*결제\s*금액\s*([\d,]+)\s*원/)||[])[1]);
const issuers=[...new Set(pay.match(/(?:롯데|현대|신한|삼성|KB국민|국민|하나|우리|농협|BC)카드/g)||[])];if(!R.card&&issuers.length===1)R.card=(/L\.PAY/.test(pay)?'L.PAY - ':'')+issuers[0];
let opt=await read('[class*="option"]');opt=nz(opt.replace(/옵션\s*변경/g,''));if(opt&&!/영수증|전체 주문/.test(opt))R.selected=opt;
if(!R.selected)R.selected=(body.match(/(?:옵션|색상|컬러|사이즈)\s*[:：]\s*(.+?)(?=옵션변경|[\d,]+원|수량)/)||[])[1]||null;
R.qty=num((body.match(/수량\s*[:：]?\s*(\d+)/)||[])[1])||null;
const visible=s=>s&&!/[*＊●]/.test(s)?nz(s):null;
R.shipping.name=visible((body.match(/(?:받는\s*(?:분|사람)|수취인|수령인)\s*[:：]?\s*(.+?)(?=휴대|연락|전화|배송지|주소)/)||[])[1]||(body.match(/To\.\s*(.+?)\s*보낸 선물/)||[])[1]);
R.shipping.address=visible((body.match(/(?:배송지|배송주소|주소)\s*[:：]?\s*(.+?)(?=상세주소|배송\s*(?:메시지|메세지|요청)|휴대전화|연락처|주문 금액|결제정보)/)||[])[1]);
R.shipping.address_detail=visible((body.match(/상세주소\s*[:：]?\s*(.+?)(?=배송|휴대|연락|주문 금액|결제정보)/)||[])[1]);
}else R.note=/login/i.test(await page.url())?'login required':/Incapsula|Imperva|hcaptcha/i.test(t)?'bot check blocked':'detail page is another order';
if(!R.paid&&!R.points_used){const c=await visit(base+'complete/'+no);const m=c.match(/결제\s?금액\s*([\d,]+)\s*원\s*(네이버페이|카카오페이|토스페이|토스|페이코|L\.PAY|엘페이|무신사페이|[가-힣]{2,4}카드|신용카드)/);if(m){R.paid=num(m[1]);R.card=m[2];R.status=/결제\s?완료|보냈어요|주문이 완료/.test(c)?'결제완료':R.status;R.note='from order-complete page'}}
for(const id of opened)await tabs.close(id).catch(()=>{});
return R;