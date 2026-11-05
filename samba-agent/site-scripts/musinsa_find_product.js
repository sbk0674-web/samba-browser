const A=(typeof args!=='undefined'&&args)||{}
const src=A.source_url||A.sourceUrl||A.url||''
const out={found:false,product_url:null,name:null,model:null}
function N(s){return (s||'').toUpperCase().replace(/[^A-Z0-9가-힣]+/g,'')}
async function tree(q){let t='';for(let i=0;i<6;i++){try{t=((await page.get({query:q}))||{}).tree||''}catch(e){t=''}if(t.length>400)break;await sleep(1500)}return t}
// 1) 원본 상품 페이지 읽기
await tabs.open({url:src});await sleep(3000)
const st=await tree('브랜드 상품명 품번 가격')
const title=(((st.match(/TITLE:\s*([^\n]+)/)||[])[1])||'').split(' - ')[0].trim()
// 품번(모델코드) 추출: [CODE] / _CODE / 라벨형
let model=String(A.model||'').trim()||((title.match(/\[([A-Za-z0-9\-]{5,})\]/)||[])[1])||((title.match(/_([A-Za-z]{2}\d{2,}[A-Za-z0-9]{3,})$/)||[])[1])||''
if(!model){const m=st.match(/(?:품번|모델\s*번호|상품\s*코드|스타일\s*(?:넘버|번호))\s*[:：]?\s*([A-Za-z0-9\-]{5,})/);if(m)model=m[1]}
// 상품명 / 색상 분리
let base=title.replace(/\[[^\]]*\]/g,' ').replace(/\s+/g,' ').trim()
let color=''
const um=base.match(/[_·]\s*([^_·]+)$/)
if(um){color=um[1].trim();base=base.replace(/[_·]\s*[^_·]+$/,'').trim()}
base=base.replace(/[,\s]+$/,'')
// 브랜드 추출
let brand=''
const bm=st.match(/([가-힣A-Za-z0-9&.\s]{2,30}?)\s*브랜드(?:알림|홈|정보)/)
if(bm)brand=(bm[1].trim().split(/\s+/)[0]||'')
if(!brand){const b2=st.match(/브랜드\s*[:：]\s*([^\s]{2,20})/);if(b2)brand=b2[1]}
async function search(k){
  if(!k||!k.trim())return ''
  await tabs.open({url:'https://www.musinsa.com/search/goods?keyword='+encodeURIComponent(k.trim())})
  await sleep(3500)
  const t=await tree('검색 결과 상품 목록')
  const i=t.indexOf('장바구니'),j=t.indexOf('추천 상품')
  return (i>=0?(j>i?t.slice(i,j):t.slice(i)):t)
}
async function openHit(labels){
  for(const lab of labels){
    if(!lab)continue
    try{await page.clickText(lab)}catch(e){continue}
    await sleep(3000)
    const u=await page.url()
    if(/musinsa\.com\/(products|app\/goods)\//.test(u)){
      const tt=(((await tree('상품명')).match(/TITLE:\s*([^\n]+)/)||[])[1]||'').split(' - ')[0].trim()
      return {u,tt}
    }
  }
  return null
}
const labels=[title,base+'_'+color,base].filter(Boolean)
// 2) 품번 우선 검색
let body=''
if(model){
  body=await search(model)
  if(body&&!/검색 결과가 없습니다/.test(body)&&N(body).includes(N(model))){
    const h=await openHit([model,...labels])
    if(h){out.found=true;out.product_url=h.u;out.name=h.tt||title;out.model=model;return out}
  }
}
// 3) 브랜드+상품명 검색
const kws=[]
if(brand)kws.push(brand+' '+base)
kws.push(base)
if(brand)kws.push(brand+' '+base.split(/\s+/).slice(0,3).join(' '))
for(const k of kws){
  body=await search(k)
  if(!body||/검색 결과가 없습니다/.test(body))continue
  const nb=N(body)
  if(model&&nb.includes(N(model))){
    const h=await openHit([...labels,model])
    if(h){out.found=true;out.product_url=h.u;out.name=h.tt||title;out.model=model;return out}
  }
  if(N(base).length>=8&&nb.includes(N(base))){
    const h=await openHit(labels)
    if(h){
      const nt=N(h.tt)
      if(nt.includes(N(base))){
        out.found=true;out.product_url=h.u;out.name=h.tt
        out.model=((h.tt.match(/\[([A-Za-z0-9\-]{5,})\]/)||[])[1])||model||null
        return out
      }
    }
  }
}
out.model=null
return out