#!/bin/bash
# 당근 판매관리 화면으로 되돌린 뒤 post.py 재개
cd "$(dirname "$0")"; export MSYS_NO_PATHCONV=1
for i in 1 2 3 4 5; do
  out=$(./ph.sh dump 2>/dev/null)
  act=$(./ph.sh shell dumpsys window | grep mCurrentFocus)
  if echo "$act" | grep -q MySalesActivity && echo "$out" | grep -q "t='글쓰기'"; then
    echo "$out" | grep -o "판매중 [0-9]*"; nohup python -u post.py > post.log 2>&1 & echo $! > post.pid; echo "restarted pid=$(cat post.pid)"; exit 0
  fi
  if echo "$out" | grep -q "저장 안 함"; then y=$(echo "$out" | grep "저장 안 함" | cut -d, -f2 | cut -d' ' -f1); ./ph.sh tap 540 $y; sleep 1.5; continue; fi
  if echo "$out" | grep -q "tvPhotoCount\|id=title"; then ./ph.sh shell input keyevent 4; sleep 1.5; continue; fi
  if echo "$out" | grep -q "AI로 글 작성하기\|홍보글 작성"; then ./ph.sh shell input keyevent 4; sleep 1.2; ./ph.sh shell input keyevent 4; sleep 1.5; continue; fi
  if echo "$out" | grep -q "공유하기"; then ./ph.sh shell input keyevent 4; sleep 1.5; continue; fi
  # 그 밖의 화면: 앱 실행 → 나의 당근 탭 → 판매관리 메뉴
  ./ph.sh shell monkey -p com.towneers.www -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 3
  out=$(./ph.sh dump 2>/dev/null)
  if echo "$out" | grep -q "t='나의 당근'"; then
    ./ph.sh tap 972 2172; sleep 2
    out=$(./ph.sh dump 2>/dev/null); y=$(echo "$out" | grep "t='판매관리'" | head -1 | cut -d, -f2 | cut -d' ' -f1)
    [ -n "$y" ] && ./ph.sh tap 246 $y && sleep 2.5
  else
    ./ph.sh shell input keyevent 4; sleep 1.5
  fi
done
echo "판매관리 못 찾음"; exit 1
