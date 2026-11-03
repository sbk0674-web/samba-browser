import { describe, expect, it } from 'vitest'
import { filterChannels, type DaangnChannelDto } from '../src/shared/daangn'
import { parseScan } from '../src/main/daangn/selectors'
import { withNativeListOrder } from '../src/renderer/src/components/daangn/daangn-view'

const channel = (accountId: number, roomId: string, lastAt: number, listOrder?: number): DaangnChannelDto => ({
  accountId, roomId, peerName: roomId, lastAt, listOrder, lastAtText: lastAt ? '1일 전' : '오전 07:57',
  region: '', lastMessage: '', unread: 0, productTitle: '', productThumb: null
})
const all = { accountId: null, unreadOnly: false }
describe('native chronology when list dates are absent', () => {
  const rows = [channel(1,'latest',1000,0),channel(1,'pandori',0,1),channel(1,'kkongchi',0,2),channel(1,'yesterday',500,3)]
  it('keeps undated clock rows between their actual native neighbors without inventing dates', () => {
    expect(filterChannels(rows,all).map(x=>x.roomId)).toEqual(['latest','pandori','kkongchi','yesterday'])
    expect(rows[1].lastAt).toBe(0)
  })
  it('uses source order even when the input snapshot was shuffled', () => {
    expect(filterChannels([...rows].reverse(),all).map(x=>x.roomId)).toEqual(['latest','pandori','kkongchi','yesterday'])
  })
  it('retains the native first row without a preceding dated message', () => {
    expect(filterChannels([channel(1,'first',0,0),channel(1,'dated',500,1)],all).map(x=>x.roomId)).toEqual(['first','dated'])
  })
  it('merges accounts while keeping each native sequence and every row exactly once', () => {
    const out=filterChannels([...rows,channel(2,'other-new',1200,0),channel(2,'other-old',100,1)],all)
    expect(out[0].roomId).toBe('other-new')
    expect(out.filter(x=>x.accountId===1).map(x=>x.roomId)).toEqual(rows.map(x=>x.roomId))
    expect(new Set(out.map(x=>x.roomId)).size).toBe(6)
  })
  it('keeps the existing timestamp sort for legacy rows without native order', () => {
    expect(filterChannels([channel(1,'old',1),channel(1,'new',2)],all).map(x=>x.roomId)).toEqual(['new','old'])
  })
  it('does not reverse confirmed dates when an undated third row exists', () => {
    const out=filterChannels([channel(1,'yesterday',500,0),channel(1,'today',1000,1),channel(1,'undated',0,2)],all)
    expect(out.findIndex(x=>x.roomId==='today')).toBeLessThan(out.findIndex(x=>x.roomId==='yesterday'))
  })
  it('does not lose read date anchors when unread-only is selected', () => {
    const rows=[channel(1,'anchor',1000,0),{...channel(1,'unknown',0,1),unread:1},{...channel(2,'other',100,0),unread:1}]
    expect(filterChannels(rows,{...all,unreadOnly:true}).map(x=>x.roomId)).toEqual(['unknown','other'])
  })
  it('records order from the actual scan rather than room ID or a fabricated timestamp', () => {
    const out=parseScan({me:null,rows:[{href:'/room/z',timeText:'오전 07:57'},{href:'/room/a',timeText:'1일 전'}]},1,new Date('2026-11-03T04:00:00Z'))
    expect(out.channels.map(x=>x.listOrder)).toEqual([0,1])
    expect(out.channels[0].lastAt).toBe(0)
  })
  it('supports an already-running old main process without changing message dates or the input', () => {
    const old=[channel(1,'latest',1000),channel(2,'other',1200),channel(1,'clock',0),channel(1,'yesterday',500)]
    const normalized=withNativeListOrder(old)
    expect(normalized.map(x=>x.listOrder)).toEqual([0,0,1,2])
    expect(filterChannels(normalized,all).map(x=>x.roomId)).toEqual(['other','latest','clock','yesterday'])
    expect(old.every(x=>x.listOrder===undefined)).toBe(true)
    expect(normalized[2].lastAt).toBe(0)
  })
  it('preserves source positions supplied by the new main process', () => {
    const c=channel(1,'known',1000,7)
    expect(withNativeListOrder([c])[0]).toBe(c)
  })
})
