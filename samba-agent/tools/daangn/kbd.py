# scrcpy 서버를 제어 전용으로 띄워 한글 텍스트를 클립보드 붙여넣기로 주입
import socket, struct, subprocess, sys, time, io
ADB = r'C:\Users\canno\Downloads\pt\platform-tools\adb.exe'
import os
DEV = os.environ.get('DAANGN_DEV', 'adb-R3CW60F49RY-uzSPwc._adb-tls-connect._tcp')
JAR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scrcpy-server')   # scrcpy 4.1 서버(원본 폴더가 지워져 S916N 에서 회수)
VER = '4.1'
PORT = int(os.environ.get('DAANGN_PORT', '27183'))
SCID = os.environ.get('DAANGN_SCID', '00000001')   # 삼바 앱의 scrcpy 와 소켓 이름이 겹치지 않게 기기별로 다르게

def adb(*a, **k):
  return subprocess.run([ADB, '-s', DEV, *a], creationflags=0x08000000, capture_output=True, **k)

class Kbd:
  def __init__(self):
    adb('push', JAR, '/data/local/tmp/scrcpy-server.jar')
    adb('forward', f'tcp:{PORT}', f'localabstract:scrcpy_{SCID}')
    self.proc = subprocess.Popen([ADB, '-s', DEV, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server', VER,
      f'scid={SCID}', 'log_level=info', 'video=false', 'audio=false', 'control=true',
      'tunnel_forward=true', 'send_device_meta=false', 'send_dummy_byte=true', 'clipboard_autosync=false', 'cleanup=false'],
      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=0x08000000)
    for i in range(50):
      try:
        s = socket.create_connection(('127.0.0.1', PORT), timeout=1)
        b = s.recv(1)
        if b == b'\x00':
          self.sock = s; break
        s.close()
      except OSError:
        pass
      time.sleep(0.2)
    else:
      raise RuntimeError('scrcpy server 연결 실패: ' + self.proc.stdout.read().decode('utf-8','replace'))
    self.seq = 1
  def paste(self, text):
    data = text.encode('utf-8')
    self.sock.sendall(struct.pack('>BQBI', 9, self.seq, 1, len(data)) + data)
    self.seq += 1
    time.sleep(0.3)
  def close(self):
    try: self.sock.close()
    except Exception: pass
    self.proc.kill()
    adb('forward', '--remove', f'tcp:{PORT}')

if __name__ == '__main__':
  k = Kbd(); k.paste(sys.argv[1]); time.sleep(0.5); k.close(); print('pasted')
