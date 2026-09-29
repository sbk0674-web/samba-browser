import { describe, expect, it } from 'vitest'
import { ensureAwake, parseAwake, wakeIfAsleep } from '../src/main/phone/input'

function fakeAdb(states: string[]): { calls: string[][]; adb: never } {
  const calls: string[][] = []
  let i = 0
  return {
    calls,
    adb: {
      run: async (args: string[]) => {
        calls.push(args)
        if (args.includes('power'))
          return {
            stdout: `mWakefulness=${states[Math.min(i++, states.length - 1)]}`,
            stderr: '',
            code: 0
          }
        return { stdout: '', stderr: '', code: 0 }
      }
    } as never
  }
}
const wakes = (calls: string[][]): number =>
  calls.filter((a) => a.includes('KEYCODE_WAKEUP')).length

describe('폰 깨우기', () => {
  it('parseAwake: Awake 만 깨어 있음, 읽지 못하면 깨어 있다고 본다', () => {
    expect(parseAwake('  mWakefulness=Awake\n')).toBe(true)
    expect(parseAwake('  mWakefulness=Dozing\n')).toBe(false)
    expect(parseAwake('')).toBe(true)
  })
  it('사용자 입력: 깨어 있으면 그대로, 잠들어 있으면 깨우고 입력을 버린다', async () => {
    const on = fakeAdb(['Awake'])
    expect(await wakeIfAsleep(on.adb, 'S')).toBe(false)
    expect(wakes(on.calls)).toBe(0)
    const off = fakeAdb(['Dozing'])
    expect(await wakeIfAsleep(off.adb, 'S')).toBe(true)
    expect(wakes(off.calls)).toBe(1)
  })
  it('자동 작업: 깨운 뒤 Awake 가 될 때까지 기다린다', async () => {
    const f = fakeAdb(['Dozing', 'Dozing', 'Awake'])
    await ensureAwake(f.adb, 'S', async () => {})
    expect(wakes(f.calls)).toBe(1)
    expect(f.calls.filter((a) => a.includes('power')).length).toBe(3)
  })
})
