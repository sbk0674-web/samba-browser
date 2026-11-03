const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const good = '경기도 의정부시 시민로 123 101동 202호';
const bad = '부산광역시 해운대구 해운대로 123 101동 202호';
const baseArgs = {name:'이지원', address:good, profile:'user1'};
// Only a radio's own text provides the positive destination evidence.
async function run(script, opt={}) {
  const file = process.env.LOTTEON_BACKUP === '1'
    ? path.join(__dirname, '../../output/lotteon-gift-destination', script+'-before.json')
    : path.join(__dirname, '../site-scripts', script+'.js');
  const raw = fs.readFileSync(file, 'utf8');
  const code = process.env.LOTTEON_BACKUP === '1' ? JSON.parse(raw).code : raw;
  let open=opt.open ?? script.includes('confirm'), on=opt.initialOn ?? -1, quick=false;
  let actual=opt.actual ?? good;
  const rows=opt.rows ?? [{name:'이지원',address:good,rid:17,lid:91}];
  const clicks=[], reads=[], switched=[], typed=[];
  let registering=!!opt.register, regName='기존이름', phone='', consent=false;
  const reg=()=>`[400] dialog "배송지 등록"\n[401] textbox "받는 분" value="${regName}"\n[402] textbox "주소" value="경기도 의정부시 시민로 123"\n[403] textbox "" value="101동 202호"\n[404] textbox "휴대폰 번호" value="${phone}"\n[405] checkbox "(필수) 동의" value="${consent?'on':'off'}"\n[406] button "저장"\nPAGE TEXT:\n배송지 등록 연락처 010-1234-5678`;
  const dialog=()=>open ? '[8] dialog "배송지 선택"\n'+rows.map((r,i)=>
    `[${r.rid}] radio "${opt.shortRadio?'배송지':opt.nameOnlyRadio?'배송지 '+r.name:'배송지 '+r.name+' [11700] '+r.address}" value="${on===i?'on':'off'}"\n[${r.lid}] label "${r.name}${opt.labelAddress?' '+r.address:''}"\n[${300+i*2}] button "수정"\n[${301+i*2}] button "삭제"`).join('\n')+
    `\n[900] button "${opt.doneText||'선택완료'}"\nPAGE TEXT:\n배송지 선택 `+rows.map(r=>`배송지 ${r.name} 수정 삭제 [11700] ${r.address} 010-1234-5678`).join(' ') : 'PAGE TEXT:\n';
  const page={url:async()=> 'https://www.lotteon.com/p/order/orderSheet/one',get:async (q={})=>{
    reads.push({q,open});
    if(registering)return {tree:reg()};
    if(q.selector==='[role=dialog]')return {tree:dialog()};
    const giftSheet=`TO. ${opt.sheetName||'이지원'}${actual?' '+actual:''} 배송비 무료 상품정보`;
    const directSheet=`배송지 정보 받는 분 ${opt.sheetName||'이지원'} ${actual} 배송요청 없음 주문상품 기타`;
    const sheet=opt.sheetText??(opt.direct?directSheet:giftSheet);
    if(q.query==='빠른 선물') return {tree:opt.direct?'':`[6] checkbox "빠른 선물" value="${quick?'on':'off'}"\nPAGE TEXT:\n`};
    if(q.query==='받는 분 주소로 보내기')return {tree:opt.direct?'':'[1] radio "받는 분 주소로 보내기" value="on"'};
    if(q.query && /배송지|변경/.test(q.query))return {tree:'[2] button "배송지 선택하기"\n[3] button "배송지 수정하기"\n[4] button "변경"'};
    if(q.query==='선택완료') return {tree:open?'[900] button "선택완료"':''};
    if(q.query) return {tree:dialog()};
    return {tree:`[6] checkbox "빠른 선물" value="${quick?'on':'off'}"\nPAGE TEXT:\n${sheet} ${opt.hidden||''} ${open?dialog().split('PAGE TEXT:')[1]:''}`};
  }, click:async id=>{
    clicks.push(id);
    if(id===405)consent=true;
    if(id===406){registering=false;open=true;}
    if(id===2||id===3||id===4)open=true;
    if(id===6){quick=true;if(opt.afterQuick!==undefined)actual=opt.afterQuick;}
    const i=rows.findIndex(r=>r.rid===id||r.lid===id);
    if(i>=0&&!opt.ignoreRadio)on=i;
    if(id===900){open=false;if(opt.apply!==false&&on>=0)actual=rows[on].address;}
  },type:async(id,value)=>{typed.push([id,value]);if(id===401)regName=value;if(id===404)phone=value;}};
  const tabs={list:async()=>[{id:'order1',profile:'user1',url:await page.url()}],switch:async id=>switched.push(id)};
  const result=await new AsyncFunction('args','page','tabs','sleep',code)({...baseArgs,...opt.args},page,tabs,async()=>{});
  return {result,clicks,reads,switched,code,typed};
}
test('confirm preserves sanitized name / phone autofill / consent / save',async()=>{
  const {result,typed,clicks}=await run('lotteon_confirm_shipping',{
    register:true,args:{name:'이*원'},sheetName:'이O원',rows:[{name:'이O원',address:good,rid:17,lid:91}]
  });
  assert.equal(result.ok,true,JSON.stringify(result));
  assert(typed.some(([id,v])=>id===401&&v==='이O원'));
  assert(typed.some(([id,v])=>id===404&&v==='01012345678'));
  assert(clicks.includes(405));assert(clicks.includes(406));
});
test('confirm direct registration saves and confirms without quickgift',async()=>{
  const {result,typed,clicks}=await run('lotteon_confirm_shipping',{register:true,direct:true});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.address,good);
  assert(typed.some(([id,v])=>id===404&&v==='01012345678'));
  assert(clicks.includes(406));assert(!clicks.includes(6));
});
for(const script of ['lotteon_confirm_shipping','lotteon_select_shipping']){
  for(const direct of [false,true])test(script+' avoids repeated closed-modal reads '+(direct?'direct':'gift'),async()=>{
    const {result,reads}=await run(script,{direct});assert.equal(result.ok,true);
    const checks=reads.filter(r=>!r.open&&r.q.selector==='[role=dialog]').length;
    assert(checks<=(script.includes('confirm')?3:4),`redundant modal reads: ${checks}`);
  });
  test(script+' direct normal without TO or quickgift succeeds',async()=>{
    const {result,clicks}=await run(script,{direct:true});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.address,good);assert(!clicks.includes(6));
  });
  for(const doneText of ['확인','닫기'])test(script+' direct '+doneText+' succeeds',async()=>{
    const {result}=await run(script,{direct:true,doneText});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.address,good);
  });
  for(const heading of ['받는분','수령인'])test(script+' direct '+heading+' actual region succeeds',async()=>{
    const {result}=await run(script,{direct:true,sheetText:heading+' 이지원 '+good+' 배송비 무료'});assert.equal(result.ok,true,JSON.stringify(result));
  });
  test(script+' direct wrong address fails',async()=>{
    const {result}=await run(script,{direct:true,actual:bad,apply:false});assert.equal(result.ok,false);assert.equal(result.address,null);
  });
  test(script+' gift without TO cannot use direct region',async()=>{
    const {result}=await run(script,{sheetText:'배송지 정보 받는 분 이지원 '+good+' 배송요청 없음'});assert.equal(result.ok,false);assert.equal(result.address,null);
  });
  test(script+' gift TO name only cannot borrow direct region',async()=>{
    const {result}=await run(script,{sheetText:'TO. 이지원 배송비 무료 배송지 정보 받는 분 이지원 '+good+' 배송요청 없음'});assert.equal(result.ok,false);assert.equal(result.address,null);
  });
  test(script+' two direct sections fail',async()=>{
    const {result}=await run(script,{direct:true,sheetText:'배송지 정보 이지원 '+good+' 배송요청 없음 배송지 정보 이지원 '+good+' 배송요청 없음'});assert.equal(result.ok,false);assert.equal(result.address,null);
  });
  test(script+' direct other section cannot supply address',async()=>{
    const {result}=await run(script,{direct:true,sheetText:'배송지 정보 이지원 '+bad+' 배송요청 없음 주문상품 '+good});assert.equal(result.ok,false);assert.equal(result.address,null);
  });
  for(const [label,opt] of [
    ['same name Busan wrongAddr',{rows:[{name:'이지원',address:bad,rid:17,lid:91}],actual:bad}],
    ['other row contains requested Gyeonggi',{rows:[{name:'김다른',address:good,rid:17,lid:91},{name:'이지원',address:bad,rid:53,lid:113}],actual:bad}],
    ['TO name only fails',{actual:'',apply:false}],
    ['ambiguous identical rows fail',{rows:[{name:'이지원',address:good,rid:17,lid:91},{name:'이지원',address:good,rid:53,lid:113}]}],
    ['quickgift changes destination fails',{afterQuick:bad}],
    ['building number prefix fails',{rows:[{name:'이지원',address:good.replace('123','1234'),rid:17,lid:91}]}],
    ['detail mismatch fails',{rows:[{name:'이지원',address:good.replace('202호','203호'),rid:17,lid:91}]}],
    ['detail numeric prefix fails',{rows:[{name:'이지원',address:good.replace('101동','1101동'),rid:17,lid:91}]}],
    ['name substring fails',{rows:[{name:'김이지원',address:good,rid:17,lid:91}],sheetName:'김이지원'}],
    ['wrong selected radio remains off',{initialOn:-1,ignoreRadio:true}],
    ['postcode mismatch fails',{args:{address:'[11800] '+good}}],
  ])test(script+' '+label,async()=>{
    const {result}=await run(script,opt);assert.equal(result.ok,false);assert.equal(result.address,null);
  });
  test(script+' correct actual readback succeeds / radio ID not arithmetic',async()=>{
    const {result,clicks}=await run(script);
    assert.equal(result.ok,true,JSON.stringify({result,clicks}));assert.equal(result.address,good);assert(!clicks.includes(89));
    if(script.includes('select'))assert(clicks.includes(17)||clicks.includes(91));
  });
  test(script+' no whole PAGE TEXT while modal open',async()=>{
    const {reads}=await run(script);assert(!reads.some(r=>r.open&&!r.q.query&&!r.q.selector));
  });
  test(script+' requested tab mismatch fails closed',async()=>{
    const {result,clicks}=await run(script,{args:{tab:'missing'}});assert.equal(result.ok,false);assert.equal(result.address,null);assert.equal(clicks.length,0);
  });
  test(script+' requested profile mismatch fails closed',async()=>{
    const {result,clicks}=await run(script,{args:{profile:'user2'}});assert.equal(result.ok,false);assert.equal(result.address,null);assert.equal(clicks.length,0);
  });
  test(script+' masked name succeeds',async()=>{
    const {result}=await run(script,{rows:[{name:'이*원',address:good,rid:17,lid:91}],sheetName:'이*원'});assert.equal(result.ok,true);
  });
  for(const opt of [{shortRadio:true},{nameOnlyRadio:true},{shortRadio:true,labelAddress:true},{nameOnlyRadio:true,initialOn:0}])
  test(script+' no address evidence in radio fails '+JSON.stringify(opt),async()=>{
    const {result,clicks}=await run(script,opt);assert.equal(result.ok,false);assert.equal(result.address,null);assert(!clicks.includes(17));assert(!clicks.includes(91));
  });
  test(script+' returned address is actual readback, not request echo',async()=>{
    const {result}=await run(script,{args:{address:'경기도 의정부시 시민로123 101동 202호'}});assert.equal(result.ok,true);assert.equal(result.address,good);
  });
  test(script+' returns selected radio actual address rather than TO string',async()=>{
    const actual=good+' (문 앞)';
    const {result}=await run(script,{apply:false,rows:[{name:'이지원',address:actual,rid:17,lid:91}]});assert.equal(result.ok,true);assert.equal(result.address,actual);
  });
  test(script+' correct earlier row beats same name wrong last row',async()=>{
    const {result,clicks}=await run(script,{rows:[{name:'이지원',address:good,rid:17,lid:91},{name:'이지원',address:bad,rid:53,lid:113}]});
    assert.equal(result.ok,true);assert(clicks.includes(17));assert(!clicks.includes(53));
  });
  test(script+' jibun actual succeeds',async()=>{
    const address='경기도 의정부시 의정부동 123-4 101동 202호';
    const {result}=await run(script,{args:{address},rows:[{name:'이지원',address,rid:17,lid:91}]});assert.equal(result.ok,true);assert.equal(result.address,address);
  });
  test(script+' under 8000 characters',async()=>{const {code}=await run(script);assert(code.length<8000);});
}
