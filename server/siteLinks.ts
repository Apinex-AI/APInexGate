import { getSetting, setSetting } from './db.js'
import { sanitizeSiteLink, type SiteLinks } from '../shared/siteLinks.js'

const KEYS: Record<keyof SiteLinks, string> = {
  telegram: 'link_telegram',
  x: 'link_x',
  telegramSupport: 'link_telegram_support',
}

function stored(kind: keyof SiteLinks) {
  const raw = getSetting(KEYS[kind], '')
  if (!raw.trim()) return ''
  try {
    return sanitizeSiteLink(kind, raw)
  } catch {
    return ''
  }
}

export function getSiteLinks(): SiteLinks {
  return {
    telegram: stored('telegram'),
    x: stored('x'),
    telegramSupport: stored('telegramSupport'),
  }
}

export function saveSiteLinks(input: Partial<SiteLinks>): SiteLinks {
  for (const kind of Object.keys(KEYS) as Array<keyof SiteLinks>) {
    if (input[kind] == null) continue
    setSetting(KEYS[kind], sanitizeSiteLink(kind, input[kind]))
  }
  return getSiteLinks()
}
