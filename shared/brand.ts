export type PublicBrand = {
  name: string
  slug: string
  siteUrl: string
  apiBaseUrl: string
  apiOrigin: string
  contactEmail: string
}

function env(key: string) {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const value = proc?.env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function strip(url: string) {
  return url.replace(/\/+$/, '')
}

export function siteName() {
  return env('SITE_NAME') || 'Gateway'
}

export function brandSlug() {
  const slug = siteName().toLowerCase().replace(/[^a-z0-9]+/g, '')
  return slug || 'gateway'
}

export function siteUrl() {
  return strip(env('SITE_URL') || 'http://127.0.0.1:5173')
}

export function apiBaseUrl() {
  const explicit = env('API_BASE_URL')
  if (explicit) return strip(explicit)
  const origin = strip(env('API_ORIGIN') || 'http://127.0.0.1:8787')
  return origin.endsWith('/v1') ? origin : `${origin}/v1`
}

export function apiOrigin() {
  return apiBaseUrl().replace(/\/v1$/, '')
}

export function contactEmail() {
  const explicit = env('CONTACT_EMAIL') || env('SITE_EMAIL')
  if (explicit) return explicit
  try {
    return `info@${new URL(siteUrl()).hostname.replace(/^www\./, '')}`
  } catch {
    return 'info@localhost'
  }
}

export function publicBrand(): PublicBrand {
  return {
    name: siteName(),
    slug: brandSlug(),
    siteUrl: siteUrl(),
    apiBaseUrl: apiBaseUrl(),
    apiOrigin: apiOrigin(),
    contactEmail: contactEmail(),
  }
}
