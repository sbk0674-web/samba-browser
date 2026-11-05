// 롯데온에서 같은 상품 찾기(품절 대체 구매용) — 품번으로 검색하고 판매처를 롯데백화점(cpCode=le)으로 거른다.
// 결과에 그 품번이 보일 때만 첫 롯데백화점 상품(LE…)을 돌려준다. 결제·장바구니는 누르지 않는다.
const A=(typeof args!=='undefined'&&args)||{}
const out={found:false,product_url:null,name:null,model:null}
let model=String(A.model||'').trim()
if(!model){const m=String(A.name||'').match(/\b([A-Z]{2}\d[A-Z0-9]{4,})\b/);if(m)model=m[1]}
if(!model)return out
const r=await tabs.open({url:'https://www.lotteon.com/csearch/search/search?render=search&platform=pc&q='+encodeURIComponent(model)+'&mallId=1&sort=ranking&cpCode=le'})
const id=(String(r).match(/tab (\S+)/)||[])[1]
let T=''
for(let i=0;i<8;i++){await sleep(1500);T=String(((await page.get({}))||{}).tree||'');if(/p\/product\/LE\d/.test(T)||/검색결과가 없|결과가 없습니다/.test(T))break}
const text=(T.split('PAGE TEXT')[1]||'')
const N=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9가-힣]/g,'')
const hit=(T.match(/href=https:\/\/www\.lotteon\.com\/p\/product\/(LE\d+)/)||[])[1]
const at=N(text).indexOf(N(model))
if(hit&&at>=0){
  const i=text.toUpperCase().indexOf(model.toUpperCase())
  out.found=true
  out.product_url='https://www.lotteon.com/p/product/'+hit
  out.name=(i>=0?text.slice(Math.max(0,i-30),i+60):model).replace(/\s+/g,' ').trim()
  out.model=model
}
if(id){try{await tabs.close(id)}catch(e){}}
return out
