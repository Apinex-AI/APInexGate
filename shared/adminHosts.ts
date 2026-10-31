/** Hostnames where the admin console UI + /api/auth + /api/admin are allowed in non-production. */
const DEFAULT_LOCAL_ADMIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function normalizeHost(hostname: string | null | undefined): string {
  const raw = String(hostname ?? '').trim().toLowerCase()
  if (!raw) return ''
  const bracketMatch = raw.match(/^\[([a-f0-9:]+)\](?::\d+)?$/)
  if (bracketMatch) return bracketMatch[1] ?? ''
  if ((raw.match(/:/g) || []).length > 1) return raw
  return raw.split(':')[0] ?? ''
}

function getProcessEnv(): Record<string, string | undefined> | undefined {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  } catch {
    return undefined
  }
}

function isProduction(): boolean {
  try {
    const env = getProcessEnv()
    return env?.NODE_ENV === 'production'
  } catch {
    // Browser or sandboxed environment
    return false
  }
}

function envAdminHosts(): string[] {
  try {
    const env = getProcessEnv()
    const raw = env?.ADMIN_ALLOWED_HOSTS ?? ''
    return raw
      .split(',')
      .map((item) => item.trim().toLowerCase().split(':')[0] ?? '')
      .filter(Boolean)
  } catch {
    return []
  }
}

function siteAdminHosts(): string[] {
  try {
    const env = getProcessEnv()
    const raw = env?.SITE_URL?.trim()
    if (!raw) return []
    const urlStr = raw.includes('://') ? raw : `https://${raw}`
    const parsed = new URL(urlStr)
    const siteHost = parsed.hostname.toLowerCase().trim()
    if (!siteHost) return []
    const hosts = [`admin.${siteHost}`, `dev-admin.${siteHost}`]
    const cleanHost = siteHost.replace(/^www\./, '')
    if (cleanHost && cleanHost !== siteHost) {
      hosts.push(`admin.${cleanHost}`, `dev-admin.${cleanHost}`)
    }
    return hosts
  } catch {
    return []
  }
}

export function isAdminConsoleHost(hostname: string | null | undefined) {
  const host = normalizeHost(hostname)
  if (!host) return false
  if (DEFAULT_LOCAL_ADMIN_HOSTS.has(host)) {
    // Disallow loopback / localhost in production to prevent Host header spoofing bypass
    if (isProduction()) return false
    return true
  }
  if (envAdminHosts().includes(host)) return true
  if (siteAdminHosts().includes(host)) return true
  return false
}

export function requestHostname(headers: {
  host?: string | string[]
  'x-forwarded-host'?: string | string[]
}) {
  const hostHeader = headers.host
  const rawHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  const forwarded = headers['x-forwarded-host']
  const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded
  // Prefer host header (authoritative from ingress / reverse proxy) over untrusted client forwarded headers
  const raw = String(rawHost || rawForwarded || '')
    .split(',')[0]
    ?.trim()
  return normalizeHost(raw)
}
