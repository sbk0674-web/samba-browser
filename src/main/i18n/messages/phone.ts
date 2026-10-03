// 폰 문구
import { defineMessages } from '../define'

export const phoneMessages = defineMessages({
  ko: {
    // 도구 설치(adb·scrcpy)
    'phone.toolUrlNotAllowed': '허용되지 않은 내려받기 주소예요: {url}',
    'phone.toolFileEmpty': '{label} 파일이 비어 있어요',
    'phone.toolNotZip': '{label} 내려받기가 올바르지 않아요 (zip 파일이 아니에요)',
    'phone.unzipTooLarge': '압축을 풀면 너무 커져요 ({mb}MB 초과)',
    'phone.archiveEmpty': '내려받은 압축 파일이 비어 있어요',
    'phone.archiveTooManyEntries': '압축 안의 파일이 너무 많아요 ({count}개 초과)',
    'phone.zipSlip': '설치 폴더 밖을 가리키는 파일이 있어요: {name}',
    'phone.downloadTooLarge': '파일이 너무 커요 ({mb}MB 초과)',
    'phone.downloadFailed': '내려받기에 실패했어요 (HTTP {status})',
    'phone.downloadEmpty': '내려받은 파일이 비어 있어요',
    'phone.downloadTimeout': '내려받기 시간이 초과됐어요',
    'phone.scrcpyHashMismatch':
      'scrcpy 내려받기가 손상됐어요 (해시가 달라요). 잠시 뒤 다시 시도해 주세요',
    'phone.scrcpyNoSums': 'scrcpy 해시 목록이 없어 설치를 멈췄어요',
    'phone.scrcpySumsFetchFailed':
      'scrcpy 해시 목록을 받지 못해 설치를 멈췄어요. 잠시 뒤 다시 시도해 주세요',
    'phone.scrcpySumsMissingFile': 'scrcpy 해시 목록에 이 파일이 없어 설치를 멈췄어요',
    'phone.adbExeMissing': '내려받은 platform-tools 안에 adb.exe 가 없어요',
    'phone.scrcpyExeMissing': '내려받은 scrcpy 안에 scrcpy.exe 가 없어요',
    // 화면 조작 IPC
    'phone.invalidCoords': '화면 좌표가 올바르지 않습니다',
    'phone.invalidSwipeDuration': '스와이프 시간이 올바르지 않습니다',
    'phone.unknownKey': '알 수 없는 키: {key}',
    // 기기 감시
    'phone.pairBadAddress': '페어링 주소는 192.168.0.5:37123 처럼 IP:포트로 적어 주세요',
    'phone.pairBadCode': '페어링 코드는 숫자 6자리예요',
    // 결제 승인(확인 카드·진행 로그)
    'phone.payConfirm': '결제 승인: {amount}원 · {merchant} · {method} · {phone}',
    'phone.payRejected': '결제 거부: {reason}',
    'phone.gateBadAmount': '결제 금액이 0 이하',
    'phone.gateVaultLocked': '키마스터 잠김',
    'phone.gateNoAccount': '이 사이트의 계정을 특정할 수 없음',
    'phone.gatePayAccountAmbiguous': '{app} 계정이 여럿이라 골라야 함: {list}',
    'phone.gatePayAccountMissing': '{app} 계정 "{name}" 이 키마스터에 없음',
    'phone.gatePayAccountMismatch':
      '네이버페이 창이 다른 계정({shown})으로 로그인됨 — 결제할 계정은 {expected}',
    'phone.payAccountChecked': '네이버페이 창 계정 확인: {shown}',
    'phone.gateNoPhone': '연결된 폰 없음',
    'phone.gateAssignedOffline':
      '담당 폰({name})이 연결되어 있지 않음 — 폰의 무선 디버깅·와이파이를 확인',
    'phone.payConfirmDeclined': '결제 확인 거부',
    'phone.payFailedStep': '결제 실패: {reason}',
    'phone.payFailedNotice': '결제를 끝내지 못했습니다({reason}). 폰에서 직접 확인해 주세요.',
    'phone.payKeypadHandoff': '결제 비밀번호 키패드',
    'phone.payDoneByUser': '결제 완료(사용자 확인)',
    'phone.payCvvTyped': '카드 CVV 입력(금고 카드 항목)',
    'phone.payPinTyped': '카드사 PIN 입력(결제 비밀번호와 같은 값)',
    'phone.payDone': '결제 완료',
    'phone.payNotificationOpened': '폰 알림창에서 결제 요청 알림을 열었습니다',
    'phone.payCardReady': '카드 확인: {card}',
    'phone.payCardTap': '카드 맞추기: [{label}] 누름',
    'phone.payCardUnspecified': '카드 미지정 — 앱에 선택된 카드로 결제: {card}',
    'phone.payCardRequired':
      '카드 미지정 거부: 지시문에 {card}가 있는데 결제 도구에 card 를 넘기지 않음',
    'phone.payPasswordEntered': '결제 비밀번호 입력({digits}자리)',
    'phone.payPasswordPartial': '시험 입력: 결제 비밀번호 {digits}자리만 누름(결제 안 함)',
    'phone.payDryRunCancelled': '시험 입력 취소: 키패드에서 빠져나왔습니다({digits}자리 입력)',
    'phone.payDryRunSucceeded':
      '시험 입력인데 결제 완료 문구가 보입니다 — 폰에서 결제 상태를 바로 확인해 주세요',
    'phone.arsNotice': '전화 인증 수신 감지: 폰 화면을 확인하세요'
  },
  en: {
    'phone.toolUrlNotAllowed': 'This download URL is not allowed: {url}',
    'phone.toolFileEmpty': 'The {label} file is empty',
    'phone.toolNotZip': 'The {label} download is invalid (not a zip file)',
    'phone.unzipTooLarge': 'The archive is too large when extracted (over {mb}MB)',
    'phone.archiveEmpty': 'The downloaded archive is empty',
    'phone.archiveTooManyEntries': 'The archive contains too many files (over {count})',
    'phone.zipSlip': 'The archive has a file pointing outside the install folder: {name}',
    'phone.downloadTooLarge': 'The file is too large (over {mb}MB)',
    'phone.downloadFailed': 'Download failed (HTTP {status})',
    'phone.downloadEmpty': 'The downloaded file is empty',
    'phone.downloadTimeout': 'The download timed out',
    'phone.scrcpyHashMismatch':
      'The scrcpy download is corrupted (hash mismatch). Please try again in a moment',
    'phone.scrcpyNoSums': 'Installation stopped: no scrcpy hash list is available',
    'phone.scrcpySumsFetchFailed':
      'Installation stopped: could not download the scrcpy hash list. Please try again in a moment',
    'phone.scrcpySumsMissingFile': 'Installation stopped: this file is not in the scrcpy hash list',
    'phone.adbExeMissing': 'adb.exe was not found in the downloaded platform-tools',
    'phone.scrcpyExeMissing': 'scrcpy.exe was not found in the downloaded scrcpy',
    'phone.invalidCoords': 'Invalid screen coordinates',
    'phone.invalidSwipeDuration': 'Invalid swipe duration',
    'phone.unknownKey': 'Unknown key: {key}',
    'phone.pairBadAddress': 'Enter the pairing address as IP:port, e.g. 192.168.0.5:37123',
    'phone.pairBadCode': 'The pairing code is 6 digits',
    'phone.payConfirm': 'Approve payment: KRW {amount} · {merchant} · {method} · {phone}',
    'phone.payRejected': 'Payment refused: {reason}',
    'phone.gateBadAmount': 'payment amount must be positive',
    'phone.gateVaultLocked': 'Key Master is locked',
    'phone.gateNoAccount': 'could not identify the account for this site',
    'phone.gatePayAccountAmbiguous': 'several {app} accounts - pick one: {list}',
    'phone.gatePayAccountMissing': '{app} account "{name}" is not in KeyMaster',
    'phone.gatePayAccountMismatch':
      'Naver Pay window is signed in as {shown}; the account to pay with is {expected}',
    'phone.payAccountChecked': 'Naver Pay window account verified: {shown}',
    'phone.gateNoPhone': 'no phone connected',
    'phone.gateAssignedOffline':
      'the assigned phone ({name}) is not connected - check its wireless debugging and Wi-Fi',
    'phone.payConfirmDeclined': 'Payment confirmation declined',
    'phone.payFailedStep': 'Payment failed: {reason}',
    'phone.payFailedNotice':
      'Could not complete the payment ({reason}). Please check on your phone.',
    'phone.payKeypadHandoff': 'Payment password keypad',
    'phone.payDoneByUser': 'Payment complete (confirmed by user)',
    'phone.payCvvTyped': 'Card CVV entered (vault card item)',
    'phone.payPinTyped': 'Card issuer PIN entered (same as payment password)',
    'phone.payDone': 'Payment complete',
    'phone.payNotificationOpened': 'Opened the payment request from the phone’s notifications',
    'phone.payCardReady': 'Card confirmed: {card}',
    'phone.payCardTap': 'Matching card: tapped [{label}]',
    'phone.payCardUnspecified':
      'No card specified — paying with the card selected in the app: {card}',
    'phone.payCardRequired':
      'Refused: the instruction names {card} but the payment tool was called without card',
    'phone.payPasswordEntered': 'Payment password entered ({digits} digits)',
    'phone.payPasswordPartial':
      'Dry run: pressed only {digits} digits of the payment password (not paying)',
    'phone.payDryRunCancelled': 'Dry run cancelled: left the keypad after {digits} digits',
    'phone.payDryRunSucceeded':
      'Dry run, but a payment-complete message is on screen - check the payment on your phone now',
    'phone.arsNotice': 'Incoming verification call detected: check the phone screen'
  }
})
