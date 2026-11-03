# 표본이 적은 상위권 시·구의 주변 동 id 를 더 훑는다(±5)
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import region_scan as rs, seller_research as sr
data = json.load(open(rs.OUT, encoding='utf-8'))
targets = {('경상북도','영주시'),('경기도','수원시 영통구'),('경기도','동두천시'),('부산광역시','해운대구'),('경상남도','창원시 성산구'),('전북특별자치도','전주시 완산구'),
           ('울산광역시','남구'),('대전광역시','유성구'),('부산광역시','연제구'),('경기도','과천시'),('경상남도','창원시 마산회원구'),('인천광역시','계양구'),
           ('경기도','고양시 일산서구'),('서울특별시','금천구'),('서울특별시','구로구'),('서울특별시','서대문구'),('경기도','광명시'),('경기도','여주시'),('경기도','이천시'),
           ('전남광주통합특별시','남구'),('전남광주통합특별시','광산구')}
ids = set()
for k, v in data.items():
    r = v.get('region')
    if r and (r[0], r[1]) in targets:
        for d in range(-5, 6):
            ids.add(int(k) + d)
ids = sorted(i for i in ids if str(i) not in data and 1 <= i <= 3840)
print('추가 대상', len(ids), flush=True)
for n, rid in enumerate(ids):
    data[str(rid)] = sr.with_backoff(rs.scan, rid)
    json.dump(data, open(rs.OUT, 'w', encoding='utf-8'), ensure_ascii=False)
    if n % 10 == 0:
        print(n, '/', len(ids), data[str(rid)].get('region'), flush=True)
print('끝', flush=True)
