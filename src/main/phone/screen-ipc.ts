// 폰 화면 IPC 배선. handlers.ts 가 이 함수 하나만 부르면 되도록 묶어 두었다.
// electron 을 직접 import 하지 않고 등록 함수를 주입받아 테스트 가능하게 남긴다

import { IPC } from '../../shared/ipc'
import type { Settings } from '../../shared/settings'
import type { ScreenMode } from '../../shared/phone'
import { isPhoneKey, pressKey, swipe, tap, toDeviceCoord, wakeIfAsleep } from './input'
import {
  DISPLAY_DUMP_ARGS,
  parseDisplayCurrentSize,
  parseDisplayRotation,
  parseWmSize,
  rotatedSize
} from './screen'
import { shellArgs } from './adb'
import { createAdbRunner, createSpawner, type AdbRunner } from './process'
import { tr } from '../i18n'
import { ScreenStream } from './screen'
import { ScrcpyWindows } from './scrcpy'

export interface PhoneScreenIpcDeps {
  /** 렌더러 전용 invoke 채널 등록(발신자 검증 포함) */
  handle: <A extends unknown[], T>(channel: string, fn: (...args: A) => T | Promise<T>) => void
  /** main → renderer 통지 */
  send: (channel: string, payload: unknown) => void
  settings: () => Settings
  /** 테스트에서 갈아끼운다. 없으면 실제 adb 실행기를 만든다 */
  adb?: AdbRunner
  scrcpy?: ScrcpyWindows
  /**
   * 지금 이 폰이 비밀번호 화면인가(phone/wiring.ts 의 SecretScreenGate).
   * 참이면 그 프레임은 전송도 저장도 하지 않는다
   */
  isSecretScreen?: (serial: string) => boolean
}

export interface PhoneScreenIpc {
  stream: ScreenStream
  windows: ScrcpyWindows
  dispose: () => void
}

/** 폰 해상도 캐시 수명. 가로/세로 회전이 반영될 만큼 짧게 둔다 */
export const SIZE_CACHE_TTL_MS = 5000
/** 스와이프 시간(ms) 상한 — 오래 누르고 있는 제스처가 화면을 붙잡지 않게 */
export const MAX_SWIPE_MS = 5000

/**
 * 렌더러가 보낸 0~1 비율 좌표를 검증한다.
 * NaN·Infinity 가 그대로 지나가면 `input tap NaN NaN` 이 폰으로 나간다
 */
export function assertRatio(...values: number[]): void {
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(tr('phone.invalidCoords'))
    }
  }
}

/** 스와이프 시간. 주지 않으면 기본값(undefined)을 그대로 넘긴다 */
export function assertSwipeMs(ms?: number): number | undefined {
  if (ms === undefined) return undefined
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > MAX_SWIPE_MS) {
    throw new Error(tr('phone.invalidSwipeDuration'))
  }
  return Math.round(ms)
}

export function registerPhoneScreenIpc(deps: PhoneScreenIpcDeps): PhoneScreenIpc {
  const settings = deps.settings
  const adb = deps.adb ?? createAdbRunner(() => settings().adbPath)

  const stream = new ScreenStream({
    adb,
    size: () => settings().phoneScreenMaxSize,
    fps: () => settings().phoneScreenFps,
    onChunk: (c) =>
      deps.send(IPC.phoneScreenChunk, {
        serial: c.serial,
        mode: c.mode,
        keyframe: c.keyframe,
        data: c.data
      }),
    onModeChange: (serial, mode) => deps.send(IPC.phoneScreenMode, { serial, mode }),
    ...(deps.isSecretScreen === undefined ? {} : { isSecretScreen: deps.isSecretScreen }),
    now: () => Date.now()
  })

  const windows =
    deps.scrcpy ??
    new ScrcpyWindows({
      spawn: createSpawner(() => settings().scrcpyPath),
      path: () => settings().scrcpyPath,
      size: () => settings().phoneScreenMaxSize,
      fps: () => settings().phoneScreenFps,
      onClosed: (serial) => deps.send(IPC.phoneScreenMode, { serial, mode: stream.mode(serial) })
    })

  deps.handle(IPC.phoneScreenStart, (serial: string, mode?: string): ScreenMode => {
    stream.start(serial, mode === 'still')
    // 방금 시작했으면 우선 video 로 보고, 폴백이 일어나면 phone:screenMode 로 알려 준다
    return stream.mode(serial) ?? 'video'
  })

  // 사용자가 앱 안 폰 화면을 직접 누른 경우. 좌표는 0~1 비율로 받아 폰 해상도로 환산한다.
  //
  // `wm size` 는 회전과 상관없이 물리 해상도(세로 기준)를 돌려준다. 폰을 가로로 눕히면
  // 화면에 그려지는 프레임은 뒤집혀 있으므로 그대로 쓰면 탭 좌표가 어긋난다 —
  // `dumpsys window displays` 의 `cur=`(없으면 회전값)으로 지금 화면 크기를 맞춘다.
  // 회전은 언제든 바뀌므로 짧게만 캐시한다
  const sizeCache = new Map<string, { width: number; height: number; at: number }>()
  const deviceSize = async (serial: string): Promise<{ width: number; height: number }> => {
    const now = Date.now()
    const cached = sizeCache.get(serial)
    if (cached && now - cached.at < SIZE_CACHE_TTL_MS) {
      return { width: cached.width, height: cached.height }
    }
    const [sizeRes, dumpRes] = await Promise.all([
      adb.run(shellArgs(serial, 'wm size')),
      adb.run(shellArgs(serial, DISPLAY_DUMP_ARGS)).catch(() => ({ stdout: '' }))
    ])
    const phys = parseWmSize(sizeRes.stdout) ?? { width: 1080, height: 2400 }
    const dump = dumpRes.stdout ?? ''
    const size = rotatedSize(phys, parseDisplayRotation(dump), parseDisplayCurrentSize(dump))
    sizeCache.set(serial, { ...size, at: now })
    return size
  }
  const ratioToDevice = async (
    serial: string,
    rx: number,
    ry: number
  ): Promise<{ x: number; y: number }> => {
    assertRatio(rx, ry)
    const size = await deviceSize(serial)
    return toDeviceCoord({ x: rx, y: ry }, { width: 1, height: 1 }, size)
  }
  // 폰이 잠들어 검은 화면일 때 누르면 깨우기만 하고 그 입력은 버린다(사용자 요청 2026-09-30)
  deps.handle(IPC.phoneTap, async (serial: string, rx: number, ry: number) => {
    if (await wakeIfAsleep(adb, serial)) return
    const p = await ratioToDevice(serial, rx, ry)
    await tap(adb, serial, p.x, p.y)
  })
  deps.handle(
    IPC.phoneSwipe,
    async (serial: string, rx1: number, ry1: number, rx2: number, ry2: number, ms?: number) => {
      if (await wakeIfAsleep(adb, serial)) return
      const a = await ratioToDevice(serial, rx1, ry1)
      const b = await ratioToDevice(serial, rx2, ry2)
      await swipe(adb, serial, a, b, assertSwipeMs(ms))
    }
  )
  deps.handle(IPC.phoneKey, async (serial: string, key: string) => {
    if (!isPhoneKey(key)) throw new Error(tr('phone.unknownKey', { key }))
    if (await wakeIfAsleep(adb, serial)) return
    await pressKey(adb, serial, key)
  })

  deps.handle(IPC.phoneScreenStop, (serial: string) => {
    stream.stop(serial)
    deps.send(IPC.phoneScreenMode, { serial, mode: null })
  })

  deps.handle(IPC.phoneOpenWindow, (serial: string) => {
    windows.open(serial)
  })

  return {
    stream,
    windows,
    dispose: () => {
      stream.stopAll()
      windows.closeAll()
    }
  }
}
