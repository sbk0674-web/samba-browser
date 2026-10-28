#!/bin/bash
# S916N 폰 조작 도우미: ph.sh <명령> ...
ADB="/c/Users/canno/Downloads/pt/platform-tools/adb.exe"; D=${DAANGN_DEV:-adb-R3CW60F49RY-uzSPwc._adb-tls-connect._tcp}
case "$1" in
  shot) "$ADB" -s $D exec-out screencap -p > "${2:-shot.png}" ;;
  dump) "$ADB" -s $D shell uiautomator dump //sdcard/ui.xml >/dev/null; "$ADB" -s $D pull //sdcard/ui.xml ui.xml >/dev/null; python -I dump.py < ui.xml ;;
  tap) "$ADB" -s $D shell input tap $2 $3 ;;
  text) "$ADB" -s $D shell am broadcast -a ADB_INPUT_TEXT --es msg "$2" ;;
  key) "$ADB" -s $D shell input keyevent $2 ;;
  swipe) "$ADB" -s $D shell input swipe $2 $3 $4 $5 ${6:-300} ;;
  *) "$ADB" -s $D "$@" ;;
esac
