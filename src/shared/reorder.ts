// 목록에서 한 항목의 자리를 옮긴다(탭 끌어 옮기기). 원본은 건드리지 않고 새 배열을 돌려준다.

/** from 자리의 항목을 to 자리로 옮긴 새 배열. 범위를 벗어나거나 같은 자리면 원본 순서 그대로 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (!Number.isInteger(from) || !Number.isInteger(to)) return next
  if (from < 0 || from >= next.length) return next
  const target = Math.max(0, Math.min(next.length - 1, to))
  if (target === from) return next
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}
