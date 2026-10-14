export function fillLast7Days<
  T extends { day: string; spend_tokens: number; requests: number; free_tokens?: number; paid_tokens?: number },
>(
  points: T[],
): Array<{ day: string; spend_tokens: number; requests: number; free_tokens?: number; paid_tokens?: number }> {
  const byDay = new Map(points.map((point) => [point.day.slice(0, 10), point]))
  const filled: Array<{ day: string; spend_tokens: number; requests: number; free_tokens?: number; paid_tokens?: number }> = []
  const today = new Date()
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date(today)
    date.setUTCDate(today.getUTCDate() - i)
    const key = date.toISOString().slice(0, 10)
    const existing = byDay.get(key)
    filled.push({
      day: key,
      spend_tokens: Number(existing?.spend_tokens ?? 0),
      requests: Number(existing?.requests ?? 0),
      free_tokens: existing?.free_tokens !== undefined ? Number(existing.free_tokens) : undefined,
      paid_tokens: existing?.paid_tokens !== undefined ? Number(existing.paid_tokens) : undefined,
    })
  }
  return filled
}
