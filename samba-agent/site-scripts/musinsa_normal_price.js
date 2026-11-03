const out={normal_price:null,sale_price:null,final_price:null,goods_no:null,note:null};
const sku=String(args.sku||'');
const m=sku.match(/products\/(\d+)/)||sku.match(/^(\d{5,})$/);
if(!m){out.note='goods_no 를 알 수 없다';return out;}
out.goods_no=m[1];
const pf=args.profile?{profile:args.profile}:{};
const url='https://goods-detail.musinsa.com/api2/goods/'+m[1]+'?goodsSaleType=SALE';
let tx='';
for(let a=0;a<3&&!/normalPrice/.test(tx);a++){
  let r='';
  try{r=String(await tabs.open({...pf,url}));}catch(e){out.note='open: '+e;}
  const id=(r.match(/tab ([0-9a-f-]{36})/)||[])[1];
  if(id){try{await tabs.switch(id);}catch(e){}}
  for(let i=0;i<10;i++){
    await sleep(700);
    try{
      const g=await page.get({interactive:false});
      const k=g.tree.indexOf('PAGE TEXT:');
      tx=g.tree.slice(k<0?0:k);
      if(/normalPrice/.test(tx)||/DISPLAY_000_0002|"result":"FAIL"/.test(tx))break;
    }catch(e){out.note='get: '+e;}
  }
  try{
    for(const x of await tabs.list()){if(/goods-detail\.musinsa\.com/.test(x.url||'')){try{await tabs.close(x.id);}catch(e){}}}
  }catch(e){}
  if(/DISPLAY_000_0002|"result":"FAIL"/.test(tx))break;
}
const n=tx.match(/"normalPrice"\s*:\s*(\d+)/),s=tx.match(/"salePrice"\s*:\s*(\d+)/),f=tx.match(/"finalPrice"\s*:\s*(\d+)/);
if(n){out.normal_price=parseInt(n[1]);out.note=null;}
if(s)out.sale_price=parseInt(s[1]);if(f)out.final_price=parseInt(f[1]);
if(!n){
  // 대체: 무신사 검색 목록의 할인율·가격으로 정상가 역산
  let sid=null;
  try{
    const r=String(await tabs.open({...pf,url:'https://www.musinsa.com/search/goods?keyword='+m[1]+'&gf=A'}));
    sid=(r.match(/tab ([0-9a-f-]{36})/)||[])[1];
    if(sid){try{await tabs.switch(sid);}catch(e){}}
    let st='';
    for(let i=0;i<10;i++){
      await sleep(700);
      try{const g=await page.get({interactive:false});const k=g.tree.indexOf('PAGE TEXT:');st=g.tree.slice(k<0?0:k);if(st.indexOf(m[1])>=0&&/\d[\d,]*원/.test(st))break;}catch(e){}
    }
    const re=new RegExp(m[1]+'[^%원]{0,40}?(?:(\\d{1,2})%\\s*)?([\\d,]{3,})원');
    const mm=st.match(re);
    if(mm){
      const p=parseInt(mm[2].replace(/,/g,''));
      const d=mm[1]?parseInt(mm[1]):0;
      out.sale_price=p;
      out.normal_price=d>0?Math.round(p/(1-d/100)/10)*10:p;
      out.note='검색목록 역산(상품 API 없음)';
    }
  }catch(e){out.note='search: '+e;}
  if(sid){try{await tabs.close(sid);}catch(e){}}
  if(!out.normal_price)out.note='normalPrice 없음'+(out.note?' ('+out.note+')':'');
}
return out;