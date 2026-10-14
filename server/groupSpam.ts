const BLOCKED_DOMAINS: string[] = []

export type GroupSpamMessage = {
  text?: string
  caption?: string
  entities?: Array<{ url?: string }>
  caption_entities?: Array<{ url?: string }>
  reply_markup?: {
    inline_keyboard?: Array<Array<{ text?: string; url?: string }>>
  }
}

/** True when text promotes a blocked competitor, domain, or any t.me link. */
export function containsBlockedPromo(raw: string): boolean {
  const text = raw.toLowerCase().replace(/[\u200b-\u200d\ufeff\u2060]/g, '')
  if (text.includes('apmix')) return true
  // "t . me", "t. me", "t .me", and the same spacing around other blocked domains.
  const compact = text.replace(/\s*\.\s*/g, '.')
  if (BLOCKED_DOMAINS.some((domain) => compact.includes(domain))) return true
  return /(?:^|[^a-z0-9])t\.me(?:[^a-z0-9]|$)/.test(compact)
}

export function groupMessageIsSpam(message: GroupSpamMessage): boolean {
  const parts: string[] = []
  if (message.text) parts.push(message.text)
  if (message.caption) parts.push(message.caption)
  for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
    if (entity.url) parts.push(entity.url)
  }
  for (const row of message.reply_markup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (button.text) parts.push(button.text)
      if (button.url) parts.push(button.url)
    }
  }
  return parts.some(containsBlockedPromo)
}
