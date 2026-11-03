"""네이버페이의 실제 결제수단·금액·적립을 확인한다."""

import re


def parse_receipt(text: str, source_order_no: str) -> dict[str, object]:
    value = re.sub(r'\s+', ' ', text)
    order = re.search(r'결제 확인 번호\s*[:：]?\s*(\d+)', value)
    if not order or order.group(1) != source_order_no:
        raise ValueError('네이버 영수증과 소싱 주문번호 불일치')
    if '결제완료' not in value or re.search(r'취소완료|전액취소|취소금액', value):
        raise ValueError('취소·미완료 영수증은 별도 확인 필요')
    amount = re.search(r'결제금액\s*총\s*([\d,]+)원', value)
    money = re.search(r'네이버페이 머니 사용\s*([\d,]+)원', value)
    credit = re.search(r'카드 간편결제\s*([\d,]+)원', value)
    points = re.search(r'네이버페이 포인트 사용\s*([\d,]+)원', value)
    if not amount:
        raise ValueError('네이버 결제액 미확인')
    paid = int(amount.group(1).replace(',', ''))
    money_paid = int(money.group(1).replace(',', '')) if money else 0
    card_paid = int(credit.group(1).replace(',', '')) if credit else 0
    used = int(points.group(1).replace(',', '')) if points else 0
    if paid <= 0 or paid != money_paid + card_paid + used:
        raise ValueError('실제 결제 구성과 주문 결제액 불일치')
    payment = value.split('결제정보 접기')[-1].split('포인트 혜택')[0]
    issuer = re.search(r'(현대|롯데|삼성|신한|국민|하나|우리|농협)(?:카드)?\s+\d', payment)
    if card_paid and issuer is None:
        raise ValueError('실제 결제 카드사 미확인')
    rewards = re.search(r'구매적립 안내 보기\s*총\s*([\d,]+)원', value)
    components = re.findall(r'(?:기본적립|머니 결제적립)\s*([\d,]+)원', value)
    if not rewards or not components:
        raise ValueError('확정 가능한 네이버 적립 내역 없음')
    reward = sum(int(part.replace(',', '')) for part in components)
    if reward != int(rewards.group(1).replace(',', '')):
        raise ValueError('네이버 적립 총액·구성 불일치')
    transaction = re.search(r'결제번호\s*(\d+NP\d+)', value)
    return {
        'source_order_no': source_order_no,
        'naver_receipt': transaction.group(1) if transaction else '',
        'paid': paid,
        'card': ('네이버페이 - ' + issuer.group(1) + '카드') if card_paid else '네이버페이 머니',
        'payment_kind': 'card' if card_paid else 'money',
        'card_paid': card_paid,
        'money_paid': money_paid,
        'naver_points_used': used,
        'naver_reward': reward,
        'payment_verified': True,
    }


NAVER_PREPARE_JS = r"""
const get=async options=>String((await page.get(options||{})).tree||'');
// Npay's rolling digits expose full 0..9 strips before the final amount.
// Remove only complete strips immediately before a won amount; never guess digits.
const body=tree=>(tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g,' ').replace(/(?:\b0 1 2 3 4 5 6 7 8 9(?:\s*,)?\s+)+(?=[\d,]+\s*원)/g,'');
const num=value=>Number(String(value).replace(/,/g,''));
const chosen=async()=>{
  // 실제 결제창에는 선택 표시 속성이 없다 — 화면 글자 '결제 수단 ○○ 선택됨' 이 있으면 그것만 믿는다(실기 2026-11-02).
  // 다른 칸은 '선택'까지만 적혀 있어 '선택됨' 은 고른 수단 하나뿐이다
  const selected=body(await get()).match(/결제 수단\s+(.{1,40}?)\s*선택됨/);
  if(selected)return /현대/.test(selected[1])&&!/머니|계좌/.test(selected[1]);
  for(const selector of ['[role="radio"][aria-checked="true"]','[role="option"][aria-selected="true"]','.swiper-slide-active','.slick-current']){
    const selectedTree=await get({selector});
    if(/현대/.test(selectedTree)&&!/머니 충전결제|머니 사용|계좌결제/.test(selectedTree))return true;
  }
  return false;
};
let tree=await get();
if(/^URL: https:\/\/pay\.naver\.com\/authentication\/pw\/check(?:[?/#]|$)/m.test(tree))return {ok:false,auth_required:true,error:'네이버페이 추가 비밀번호 인증 화면 — 카드 선택·결제 진행하지 않음'};
if(!/포인트 혜택|네이버페이|Npay/.test(tree))return {ok:false,error:'네이버페이 결제창 미확인'};
for(let attempt=0;attempt<8&&!await chosen();attempt++){
  const id=await page.idOf('현대');
  if(id>=0){await page.click(id);await sleep(500);if(await chosen())break;}
  let next=await page.idOf('다음 결제수단');
  if(next<0)next=await page.idOf('다음 카드');
  if(next<0)break;
  await page.click(next);await sleep(500);
}
if(!await chosen())return {ok:false,error:'현대카드 선택 확인 불가 — 머니 결제 금지'};
tree=await get();const text=body(tree);
const noPoints=/포인트 사용이 불가한 가맹점|포인트 사용 불가|보유 포인트\s*0원/.test(text);
const usedPoints=text.match(/(?:포인트 사용|사용 포인트)\s*([\d,]+)원/);
if(!noPoints&&(!usedPoints||num(usedPoints[1])!==0))return {ok:false,error:'네이버 포인트 사용 여부 미확인 — 결제하지 않음'};
const amount=text.match(/(?:총 결제금액|결제금액)\s*([\d,]+)\s*원/);
if(!amount||num(amount[1])!==EXPECTED_AMOUNT)return {ok:false,error:'네이버 결제액 불일치'};
const reward=text.match(/포인트 혜택\s*[^\d]{0,20}([\d,]+)\s*원\s*적립/);
if(!reward)return {ok:false,error:'현대카드 네이버 적립 미확인'};
const agree=await page.idOf('동의하고 결제하기');
if(agree<0)return {ok:false,error:'네이버 결제 동의 버튼 미확인'};
return {ok:true,agree,card_issuer:'현대카드',payment_kind:'card',naver_reward:num(reward[1]),payment_verified:true};
"""
