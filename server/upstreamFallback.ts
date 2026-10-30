import net from 'node:net'

/**
 * Checks whether an upstream target URL points to a safe public destination.
 * Blocks access to internal/metadata services (e.g., 169.254.169.254, localhost, private RFC1918)
 * unless explicitly intended via ALLOW_INTERNAL_UPSTREAM=true.
 */
export function isSafeUpstreamUrl(target: string | URL): boolean {
  try {
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

    const ipType = net.isIP(hostname)

    // 4. IPv4 checks
    if (ipType === 4) {
      const octets = hostname.split('.').map(Number)
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        return false
      }
      const [o1, o2, o3] = octets

      // 0.0.0.0/8 (Current network)
      if (o1 === 0) return false
      // 10.0.0.0/8 (Private)
      if (o1 === 10) return false
      // 100.64.0.0/10 (Carrier-grade NAT)
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return false
      // 127.0.0.0/8 (Loopback)
      if (o1 === 127) return false
      // 169.254.0.0/16 (Link-local / Cloud metadata)
      if (o1 === 169 && o2 === 254) return false
      // 172.16.0.0/12 (Private)
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return false
      // 192.0.0.0/24, 192.0.2.0/24 (Documentation / reserved)
      if (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) return false
      // 192.168.0.0/16 (Private)
      if (o1 === 192 && o2 === 168) return false
      // 198.18.0.0/15 (Benchmarking)
      if (o1 === 198 && (o2 === 18 || o2 === 19)) return false
      // 198.51.100.0/24, 203.0.113.0/24 (Documentation)
      if (o1 === 198 && o2 === 51 && o3 === 100) return false
      if (o1 === 203 && o2 === 0 && o3 === 113) return false
      // 224.0.0.0/4 (Multicast)
      if (o1 >= 224 && o1 <= 239) return false
      // 240.0.0.0/4 (Reserved)
      if (o1 >= 240) return false

      return true
    }

    // 5. IPv6 checks
    if (ipType === 6 || hostname.includes(':')) {
      const cleanIpv6 = hostname.replace(/^\[|\]$/g, '').toLowerCase()

      // Loopback / Unspecified
      if (cleanIpv6 === '::1' || cleanIpv6 === '::' || cleanIpv6 === '0:0:0:0:0:0:0:1') {
        return false
      }
      // Link-local (fe80::/10)
      if (cleanIpv6.startsWith('fe8') || cleanIpv6.startsWith('fe9') || cleanIpv6.startsWith('fea') || cleanIpv6.startsWith('feb')) {
        return false
      }
      // Unique Local Addresses (fc00::/7)
      if (cleanIpv6.startsWith('fc') || cleanIpv6.startsWith('fd')) {
        return false
      }
      // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1, ::ffff:169.254.169.254, etc.)
      if (cleanIpv6.startsWith('::ffff:') || cleanIpv6.startsWith('0:0:0:0:0:ffff:')) {
        const tail = cleanIpv6.replace(/^(?:0:0:0:0:0:ffff:|::ffff:)/, '')
        if (tail.includes('.')) {
          return isSafeUpstreamUrl(`http://${tail}`)
        }
        const parts = tail.split(':')
        if (parts.length === 2) {
          const high = parseInt(parts[0], 16)
          const low = parseInt(parts[1], 16)
          const o1 = (high >> 8) & 0xff
          const o2 = high & 0xff
          const o3 = (low >> 8) & 0xff
          const o4 = low & 0xff
          return isSafeUpstreamUrl(`http://${o1}.${o2}.${o3}.${o4}`)
        }
        return false
      }
      const ipv4PartMatch = cleanIpv6.match(/:(\d+\.\d+\.\d+\.\d+)$/)
      if (ipv4PartMatch) {
        return isSafeUpstreamUrl(`http://${ipv4PartMatch[1]}`)
      }
      if (cleanIpv6.includes('169.254.') || cleanIpv6.includes('127.0.0.')) {
        return false
      }

      return true
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
