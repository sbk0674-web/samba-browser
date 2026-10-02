// 폰 연동 정보의 기기 간 동기화 — 폰 목록(이름·나라·와이파이 주소)과 담당 계정을 계정 설정에 얹어 보낸다.
//
// 왜: 폰 표(phones·account_phones)는 PC 로컬이라, 한 PC 에서 연동해 둔 폰이 같은 계정의 다른 PC 에는
// 보이지 않았다(사용자 2026-10-02 "내가 폰연동을 해놓으면 다른 피시에서도 보여야 할 거 아냐").
// 서버에 새 표를 만들지 않고 이미 동기화되는 설정 값(JSON)으로 보낸다.
// 실제 연결은 PC 마다 따로다 — 와이파이 폰은 같은 망이면 저장된 주소로 다시 붙고, USB 폰은 꽂은 PC 에서만 붙는다.

export interface PhoneRegistryEntry {
  serial: string
  label: string
  country: 'KR' | 'CN' | 'JP'
  transport: 'usb' | 'wifi'
  wifiAddress: string | null
  model: string
  /** 담당 폰이 없는 계정이 쓰는 기본 폰인가 */
  isDefault: boolean
}

/** 계정(원격 id) ↔ 담당 폰(serial). 계정의 로컬 번호는 PC 마다 달라 원격 id 로 짝짓는다 */
export interface PhoneAccountLink {
  account: string
  serial: string
}

/** 로컬 폰 줄에서 동기화에 필요한 것만 */
export interface LocalPhone {
  id: number
  serial: string
  label: string
  country: 'KR' | 'CN' | 'JP'
  transport: 'usb' | 'wifi'
  wifiAddress: string | null
  model: string
}

/**
 * 전송 이름으로 만들어진 임시 줄인가(ip:port·무선 디버깅 서비스 이름). 실제 시리얼을 알면 그 줄로 합쳐지므로
 * 다른 PC 로 보내지 않는다
 */
export function isTransportSerial(serial: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(serial) || /\._adb/.test(serial)
}

/** 로컬 폰 목록 → 보낼 목록(시리얼순). 임시 줄·지운 폰은 뺀다 */
export function buildRegistry(
  rows: readonly LocalPhone[],
  defaultSerial: string,
  ignored: readonly string[] = []
): PhoneRegistryEntry[] {
  return rows
    .filter((r) => !isTransportSerial(r.serial) && !ignored.includes(r.serial))
    .map((r) => ({
      serial: r.serial,
      label: r.label,
      country: r.country,
      transport: r.transport,
      wifiAddress: r.wifiAddress,
      model: r.model,
      isDefault: r.serial === defaultSerial
    }))
    .sort((a, b) => a.serial.localeCompare(b.serial))
}

export interface RegistryPlan {
  /** 이 PC 에 없는 폰 — 줄을 새로 만든다(연결 안 됨 상태) */
  insert: PhoneRegistryEntry[]
  /** 이름·나라·와이파이 주소가 다른 폰 — 받은 값으로 맞춘다 */
  update: Array<{
    id: number
    label: string
    country: 'KR' | 'CN' | 'JP'
    wifiAddress: string | null
  }>
  /** 다른 PC 에서 지운 폰 — 이 PC 에서도 지운다 */
  remove: number[]
  /** 받은 목록의 기본 폰(이 PC 에 기본 폰이 정해져 있지 않을 때만 쓴다) */
  defaultSerial: string | null
}

/** 받은 목록을 로컬에 맞추려면 무엇을 해야 하는가 */
export function planApply(
  entries: readonly PhoneRegistryEntry[],
  rows: readonly LocalPhone[],
  ignored: readonly string[]
): RegistryPlan {
  const bySerial = new Map(rows.map((r) => [r.serial, r]))
  const plan: RegistryPlan = { insert: [], update: [], remove: [], defaultSerial: null }
  for (const e of entries) {
    if (isTransportSerial(e.serial) || ignored.includes(e.serial)) continue
    if (e.isDefault) plan.defaultSerial = e.serial
    const row = bySerial.get(e.serial)
    if (!row) {
      plan.insert.push(e)
      continue
    }
    // 와이파이 주소는 받은 쪽이 비어 있으면 이 PC 가 아는 주소를 지우지 않는다
    const wifiAddress = e.wifiAddress ?? row.wifiAddress
    if (row.label !== e.label || row.country !== e.country || row.wifiAddress !== wifiAddress) {
      plan.update.push({ id: row.id, label: e.label, country: e.country, wifiAddress })
    }
  }
  for (const r of rows) if (ignored.includes(r.serial)) plan.remove.push(r.id)
  return plan
}

/** 순서와 무관하게 같은 내용인가 — 같으면 설정을 다시 쓰지 않는다(쓰면 그때마다 서버로 올라간다) */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
