// 이 PC 의 식별자 — 예약의 실행 주체를 가를 때 쓴다.
//
// 기기 로컬 파일(userData/device-id.json)에만 남고 동기화하지 않는다. 로그인 여부와 상관없이 항상 있어야
// 하므로 서버가 주는 기기 등록 번호를 쓰지 않는다(오프라인이거나 로그아웃 상태에서도 예약은 돈다).
// 파일이 없거나 깨져 있으면 새로 만든다 — 새로 만들면 이 PC 는 새 기기로 보이고, 예전에 이 PC 가 맡던 예약은
// 주인이 없는 것으로 바뀌지 않으므로(예전 식별자가 남음) 다른 PC 가 가져가거나 사용자가 다시 저장해야 한다.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LocalDevice {
  id: string
  name: string
}

export function loadLocalDevice(filePath: string, hostname: string): LocalDevice {
  const name = hostname.trim().slice(0, 80) || 'PC'
  try {
    if (existsSync(filePath)) {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { id?: unknown }).id === 'string' &&
        (parsed as { id: string }).id.length >= 8
      ) {
        return { id: (parsed as { id: string }).id, name }
      }
    }
  } catch {
    // 깨진 파일은 아래에서 새로 만든다
  }
  const device: LocalDevice = { id: randomUUID(), name }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify({ id: device.id }), 'utf8')
  } catch (e) {
    console.warn(
      '기기 식별자 저장 실패 — 이번 실행 동안만 쓴다',
      e instanceof Error ? e.message : ''
    )
  }
  return device
}
