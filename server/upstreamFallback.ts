import net from 'node:net'
import dns from 'node:dns'

/**
 * Validates whether four IPv4 octets belong to a safe public destination.
 * Rejects RFC 1918, loopback, link-local / cloud metadata, carrier-grade NAT,
 * multicast, and reserved/documentation ranges.
 */
function isSafeIpv4Octets(o1: number, o2: number, o3: number, _o4: number): boolean {
  // 0.0.0.0/8 (Current network)
  if (o1 === 0) return false
  // 10.0.0.0/8 (Private RFC 1918)
  if (o1 === 10) return false
  // 100.64.0.0/10 (Carrier-grade NAT: 100.64.0.0 - 100.127.255.255)
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return false
  // 127.0.0.0/8 (Loopback)
  if (o1 === 127) return false
  // 169.254.0.0/16 (Link-local / Cloud metadata)
  if (o1 === 169 && o2 === 254) return false
  // 172.16.0.0/12 (Private RFC 1918: 172.16.0.0 - 172.31.255.255)
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return false
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (o1 === 192 && o2 === 0 && o3 === 0) return false
  // 192.0.2.0/24 (TEST-NET-1)
  if (o1 === 192 && o2 === 0 && o3 === 2) return false
  // 192.168.0.0/16 (Private RFC 1918)
  if (o1 === 192 && o2 === 168) return false
  // 198.18.0.0/15 (Network benchmark tests: 198.18.0.0 - 198.19.255.255)
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return false
  // 198.51.100.0/24 (TEST-NET-2)
  if (o1 === 198 && o2 === 51 && o3 === 100) return false
  // 203.0.113.0/24 (TEST-NET-3)
  if (o1 === 203 && o2 === 0 && o3 === 113) return false
  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (o1 >= 224 && o1 <= 239) return false
  // 240.0.0.0/4 (Reserved / Broadcast: 240.0.0.0 - 255.255.255.255)
  if (o1 >= 240) return false

  return true
}

/**
 * Parses any standard or alternative IPv4 representation (dotted decimal,
 * octal, hex, or shortened 1-3 parts) into a 32-bit unsigned integer.
 * Returns null if the string is not an IPv4 address.
 */
function parseIpv4ToNumber(raw: string): number | null {
  const parts = raw.split('.')
  if (parts.length < 1 || parts.length > 4) return null

  const values: number[] = []
  for (const part of parts) {
    if (!part) return null
    let val: number
    if (/^0x[0-9a-f]+$/i.test(part)) {
      val = parseInt(part, 16)
    } else if (/^0[0-7]+$/.test(part)) {
      val = parseInt(part, 8)
    } else if (/^\d+$/.test(part)) {
      if (part.length > 1 && part.startsWith('0')) {
        // Leading zero with digits 8 or 9 is invalid octal
        return null
      }
      val = parseInt(part, 10)
    } else {
      return null
    }
    if (!Number.isSafeInteger(val) || val < 0) return null
    values.push(val)
  }

  let num = 0
  if (values.length === 1) {
    if (values[0] > 0xffffffff) return null
    num = values[0]
  } else if (values.length === 2) {
    if (values[0] > 0xff || values[1] > 0xffffff) return null
    num = values[0] * 0x1000000 + values[1]
  } else if (values.length === 3) {
    if (values[0] > 0xff || values[1] > 0xff || values[2] > 0xffff) return null
    num = values[0] * 0x1000000 + values[1] * 0x10000 + values[2]
  } else if (values.length === 4) {
    if (values[0] > 0xff || values[1] > 0xff || values[2] > 0xff || values[3] > 0xff) return null
    num = values[0] * 0x1000000 + values[1] * 0x10000 + values[2] * 0x100 + values[3]
  }
  return num >>> 0
}

/**
 * Returns true if a host string exhibits non-standard alternative IPv4 notations
 * such as hex components, octal components, or fewer than 4 parts.
 */
function checkAlternativeIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length >= 1 && parts.length <= 4) {
    let numeric = true
    let hasAlternative = false
    for (const p of parts) {
      if (/^0x[0-9a-f]+$/i.test(p) || (p.length > 1 && p.startsWith('0')) || /^\d+$/.test(p)) {
        if (/^0x/i.test(p) || (p.length > 1 && p.startsWith('0')) || parts.length < 4) {
          hasAlternative = true
        }
      } else {
        numeric = false
        break
      }
    }
    if (numeric && hasAlternative) return true
  }
  return false
}

/**
 * Parses an IPv6 address string into an 8-element array of 16-bit integers.
 * Supports zero-compression `::`, embedded IPv4, brackets, and zone index.
 */
function parseIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase().trim()
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1)
  }
  const zoneIndex = ip.indexOf('%')
  if (zoneIndex !== -1) {
    ip = ip.slice(0, zoneIndex)
  }

  let embeddedIpv4: number[] | null = null
  const lastColon = ip.lastIndexOf(':')
  if (lastColon !== -1) {
    const potentialIpv4 = ip.slice(lastColon + 1)
    if (potentialIpv4.includes('.')) {
      const parts = potentialIpv4.split('.').map((p) => parseInt(p, 10))
      if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
        embeddedIpv4 = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]]
        if (lastColon > 0 && ip[lastColon - 1] === ':') {
          ip = ip.slice(0, lastColon + 1)
        } else {
          ip = ip.slice(0, lastColon)
        }
      } else {
        return null
      }
    }
  }

  const doubleColonIndex = ip.indexOf('::')
  let head: number[] = []
  let tail: number[] = []
  if (doubleColonIndex !== -1) {
    if (ip.indexOf('::', doubleColonIndex + 2) !== -1) return null
    const headStr = ip.slice(0, doubleColonIndex)
    const tailStr = ip.slice(doubleColonIndex + 2)
    head = headStr ? headStr.split(':').map((s) => parseInt(s, 16)) : []
    tail = tailStr ? tailStr.split(':').map((s) => parseInt(s, 16)) : []
  } else {
    head = ip.split(':').map((s) => parseInt(s, 16))
  }

  if (head.some((v) => isNaN(v) || v < 0 || v > 0xffff)) return null
  if (tail.some((v) => isNaN(v) || v < 0 || v > 0xffff)) return null

  const totalSegmentsNeeded = embeddedIpv4 ? 6 : 8
  const missing = totalSegmentsNeeded - (head.length + tail.length)
  if (doubleColonIndex === -1 && missing !== 0) return null
  if (missing < 0) return null

  const zeros = new Array(missing).fill(0)
  const groups = [...head, ...zeros, ...tail]
  if (embeddedIpv4) {
    groups.push(...embeddedIpv4)
  }
  return groups.length === 8 ? groups : null
}

/**
 * Validates an IPv6 address against loopback, unspecified, link-local,
 * unique local (ULA), site-local, multicast, documentation, discard,
 * and embedded IPv4 mapped / compatible addresses.
 */
function isSafeIpv6(raw: string): boolean {
  const g = parseIpv6(raw)
  if (!g) return false

  // Unspecified (::)
  if (g.every((x) => x === 0)) return false

  // Loopback (::1)
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0 &&
    g[6] === 0 &&
    g[7] === 1
  ) {
    return false
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96)
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  ) {
    const o1 = (g[6] >> 8) & 0xff
    const o2 = g[6] & 0xff
    const o3 = (g[7] >> 8) & 0xff
    const o4 = g[7] & 0xff
    return isSafeIpv4Octets(o1, o2, o3, o4)
  }

  // IPv4-compatible IPv6 (::0:0/96)
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    const o1 = (g[6] >> 8) & 0xff
    const o2 = g[6] & 0xff
    const o3 = (g[7] >> 8) & 0xff
    const o4 = g[7] & 0xff
    return isSafeIpv4Octets(o1, o2, o3, o4)
  }

  // IPv4-translated (64:ff9b::/96)
  if (
    g[0] === 0x64 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    const o1 = (g[6] >> 8) & 0xff
    const o2 = g[6] & 0xff
    const o3 = (g[7] >> 8) & 0xff
    const o4 = g[7] & 0xff
    return isSafeIpv4Octets(o1, o2, o3, o4)
  }

  // Discard prefix (100::/64)
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false

  // Documentation (2001:db8::/32)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false

  // Unique Local Addresses (fc00::/7 - covers fc00::/8 and fd00::/8)
  if ((g[0] & 0xfe00) === 0xfc00) return false

  // Link-Local (fe80::/10 - covers fe80:: through febf::)
  if ((g[0] & 0xffc0) === 0xfe80) return false

  // Site-Local deprecated (fec0::/10)
  if ((g[0] & 0xffc0) === 0xfec0) return false

  // Multicast (ff00::/8)
  if ((g[0] & 0xff00) === 0xff00) return false

  return true
}

/**
 * Validates whether an IP address string (IPv4 or IPv6) is a safe public destination.
 */
export function isSafeIpAddress(ip: string): boolean {
  try {
    const clean = ip.replace(/^\[|\]$/g, '').trim()
    const ipType = net.isIP(clean)
    if (ipType === 4) {
      const parts = clean.split('.').map(Number)
      if (parts.length !== 4 || parts.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        return false
      }
      return isSafeIpv4Octets(parts[0], parts[1], parts[2], parts[3])
    }
    if (ipType === 6 || clean.includes(':')) {
      return isSafeIpv6(clean)
    }
    const num = parseIpv4ToNumber(clean)
    if (num !== null) {
      const o1 = (num >>> 24) & 0xff
      const o2 = (num >>> 16) & 0xff
      const o3 = (num >>> 8) & 0xff
      const o4 = num & 0xff
      return isSafeIpv4Octets(o1, o2, o3, o4)
    }
    return false
  } catch {
    return false
  }
}

/**
 * Checks whether an upstream target URL points to a safe public destination.
 * Blocks access to internal/metadata services (e.g., 169.254.169.254, localhost, private RFC1918)
 * unless explicitly intended via ALLOW_INTERNAL_UPSTREAM=true.
 */
export function isSafeUpstreamUrl(target: string | URL): boolean {
  try {
    let rawHost = ''
    if (typeof target === 'string') {
      const match = target.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/)
      if (match) {
        const hostWithPort = match[1]
        if (hostWithPort.includes('@')) {
          return false
        }
        rawHost = hostWithPort.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase().trim()
      }
    }

    const parsed = typeof target === 'string' ? new URL(target) : target

    // Only allow http: and https: protocols
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false
    }

    // Disallow userinfo (http://user:pass@host)
    if (parsed.username || parsed.password) {
      return false
    }

    const hostname = parsed.hostname.toLowerCase().trim()
    if (!hostname) return false

    // Explicit override for local development / test mocks when explicitly configured
    if (process.env.ALLOW_INTERNAL_UPSTREAM === 'true') {
      return true
    }

    // Check rawHost and parsed hostname for alternative IP notations
    for (const h of [rawHost, hostname]) {
      if (!h) continue
      if (checkAlternativeIpv4(h)) {
        const num = parseIpv4ToNumber(h)
        if (num !== null) {
          const o1 = (num >>> 24) & 0xff
          const o2 = (num >>> 16) & 0xff
          const o3 = (num >>> 8) & 0xff
          const o4 = num & 0xff
          if (!isSafeIpv4Octets(o1, o2, o3, o4)) {
            return false
          }
        }
        return false
      }
    }

    // 1. Localhost and loopback hostnames
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '0.0.0.0'
    ) {
      return false
    }

    // 2. Cloud metadata hostnames and internal domain extensions
    if (
      hostname === '169.254.169.254' ||
      hostname.startsWith('169.254.') ||
      hostname === 'metadata.google.internal' ||
      hostname === 'instance-data' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.lan') ||
      hostname.endsWith('.corp') ||
      hostname.endsWith('.home')
    ) {
      return false
    }

    // 3. Alternate integer / hex IP representations
    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
      return false
    }

    const cleanHost = hostname.replace(/^\[|\]$/g, '')

    // 4. IPv4 checks
    const ip4Num = parseIpv4ToNumber(cleanHost)
    if (ip4Num !== null && /^\d+\.\d+\.\d+\.\d+$/.test(cleanHost)) {
      const o1 = (ip4Num >>> 24) & 0xff
      const o2 = (ip4Num >>> 16) & 0xff
      const o3 = (ip4Num >>> 8) & 0xff
      const o4 = ip4Num & 0xff
      return isSafeIpv4Octets(o1, o2, o3, o4)
    }

    // 5. IPv6 checks
    if (net.isIP(cleanHost) === 6 || cleanHost.includes(':')) {
      return isSafeIpv6(cleanHost)
    }

    return true
  } catch {
    return false
  }
}

/**
 * Asynchronously checks whether an upstream target URL points to a safe public destination.
 * Runs synchronous syntax checks, then performs DNS pre-resolution to resolve hostnames
 * and validates all resolved IPv4 and IPv6 addresses against private/reserved ranges.
 */
export async function isSafeUpstreamUrlAsync(target: string | URL): Promise<boolean> {
  if (!isSafeUpstreamUrl(target)) {
    return false
  }

  if (process.env.ALLOW_INTERNAL_UPSTREAM === 'true') {
    return true
  }

  try {
    const parsed = typeof target === 'string' ? new URL(target) : target
    const hostname = parsed.hostname.toLowerCase().trim().replace(/^\[|\]$/g, '')

    // If hostname is already an IP address, synchronous check already validated it
    if (net.isIP(hostname) !== 0 || parseIpv4ToNumber(hostname) !== null) {
      return true
    }

    // Perform DNS pre-resolution to validate resolved addresses
    const records = await dns.promises.lookup(hostname, { all: true })
    if (!records || records.length === 0) {
      return false
    }

    for (const record of records) {
      if (!isSafeIpAddress(record.address)) {
        return false
      }
    }

    return true
  } catch {
    return false
  }
}

export function assertSafeUpstreamUrl(target: string | URL): void {
  if (!isSafeUpstreamUrl(target)) {
    throw new Error('SSRF blocked: target URL points to a forbidden or internal address')
  }
}

export async function assertSafeUpstreamUrlAsync(target: string | URL): Promise<void> {
  const safe = await isSafeUpstreamUrlAsync(target)
  if (!safe) {
    throw new Error('SSRF blocked: target URL points to a forbidden or internal address')
  }
}

/** Redacts sensitive credentials, API keys, proxy tokens, and server paths from error strings. */
export function sanitizeErrorMessage(message: unknown): string {
  if (typeof message !== 'string') {
    return 'Upstream request failed'
  }
  let sanitized = message

  // 1. Redact credentials embedded in URLs: http://user:pass@host -> http://[redacted]@host
  sanitized = sanitized.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/\s]+)@/g, '$1[redacted]@')

  // 2. Redact Bearer tokens, secrets, API keys
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9_\-.~+/]+=*/gi, 'Bearer [redacted]')
  sanitized = sanitized.replace(/(?:api[_-]?key|secret|token|password|auth|credential)[=:\s]+[a-zA-Z0-9_\-.~+/]{6,}/gi, 'token=[redacted]')
  sanitized = sanitized.replace(/\b(apx_|sk-|ghp_|glpat-)[a-zA-Z0-9_-]{8,}/gi, '[redacted]')

  // 3. Redact server file system paths
  sanitized = sanitized.replace(/(?:\/(?:Users|home|var|etc|opt|srv|app|tmp|root|node_modules)[\w\-./]+)/g, '[redacted_path]')
  sanitized = sanitized.replace(/(?:[a-zA-Z]:\\[\w\-.\\]+)/g, '[redacted_path]')

  return sanitized
}

// Re-export fallback utilities from gateway
export {
  applyUpstreamPayloadQuirks,
  isProviderVariantRetryableError,
  MODEL_UPSTREAM_FALLBACKS,
  stripUnsupportedGeminiSchemaMeta,
  upstreamFailureMessage,
  upstreamFallbacksFor,
} from './gateway.js'
