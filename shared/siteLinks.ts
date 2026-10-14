export type SiteLinks = {
  telegram: string
  x: string
  telegramSupport: string
}

export const SITE_LINK_DEFAULTS: SiteLinks = {
  telegram: '',
  x: '',
  telegramSupport: '',
}

const ALLOWED_HOSTS: Record<keyof SiteLinks, string[]> = {
  telegram: ['t.me', 'telegram.me'],
  x: ['x.com', 'twitter.com'],
  telegramSupport: ['t.me', 'telegram.me'],
}

export function sanitizeSiteLink(kind: keyof SiteLinks, raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${kind} must be an https URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${kind} must start with https://`)
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  if (!ALLOWED_HOSTS[kind].includes(host)) {
    throw new Error(`${kind} must be a ${ALLOWED_HOSTS[kind].join(' or ')} link`)
  }
  return url.toString()
}
