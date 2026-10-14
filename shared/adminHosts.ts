/** Hostnames where the admin console UI + /api/auth + /api/admin are allowed. */
const DEFAULT_ADMIN_HOSTS = new Set(['localhost', '127.0.0.1'])

function envAdminHosts() {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    const raw = env?.ADMIN_ALLOWED_HOSTS ?? ''
    return raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function isAdminConsoleHost(hostname: string | null | undefined) {
  const host = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .split(':')[0]
  if (!host) return false
  if (DEFAULT_ADMIN_HOSTS.has(host)) return true
  if (host.startsWith('admin.') || host.startsWith('dev-admin.')) return true
  return envAdminHosts().includes(host)
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
  return raw ? raw.split(':')[0]?.toLowerCase() ?? '' : ''
}
