import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { assertSafeUpstreamUrl, assertSafeUpstreamUrlAsync } from './upstreamFallback.js'

const PROXY_FILE = process.env.PROXY_FILE?.trim() || resolve(process.cwd(), 'proxy.txt')

let proxyUrls: string[] | null = null
const agents = new Map<number, ProxyAgent>()

function loadProxyUrls(): string[] {
  if (proxyUrls) return proxyUrls
  const proxyFilePath = process.env.PROXY_FILE?.trim() || PROXY_FILE
  try {
    const contents = readFileSync(proxyFilePath, 'utf8')
    proxyUrls = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    return proxyUrls
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * Validates a proxy URL before creating a ProxyAgent dispatcher.
 * Enforces http/https protocol and blocks internal cloud metadata targets.
 */
export function assertSafeProxyUrl(proxyUrl: string): void {
  if (!proxyUrl || typeof proxyUrl !== 'string') {
    throw new Error('Invalid provider proxy URL: must be a non-empty string')
  }
  let parsed: URL
  try {
    parsed = new URL(proxyUrl.trim())
  } catch {
    throw new Error(`Invalid provider proxy URL: ${proxyUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid provider proxy URL protocol: ${parsed.protocol}`)
  }
  const hostname = parsed.hostname.toLowerCase().trim()
  if (!hostname) {
    throw new Error('Invalid provider proxy URL: missing host')
  }
  // Block cloud metadata and internal instance data
  if (
    hostname === '169.254.169.254' ||
    hostname.startsWith('169.254.') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'instance-data' ||
    hostname.endsWith('.internal')
  ) {
    throw new Error(`Forbidden provider proxy URL target: ${hostname}`)
  }
  // Block IPv6 link-local metadata
  if (hostname.includes(':')) {
    const clean = hostname.replace(/^\[|\]$/g, '')
    if (
      clean.startsWith('fe8') ||
      clean.startsWith('fe9') ||
      clean.startsWith('fea') ||
      clean.startsWith('feb')
    ) {
      throw new Error(`Forbidden provider proxy URL target: ${hostname}`)
    }
  }
}

/** Returns a cached dispatcher for the persistent, one-based proxy assignment. */
export function dispatcherForProxyIndex(proxyIndex: number | null): Dispatcher | undefined {
  if (proxyIndex == null) return undefined
  if (!Number.isInteger(proxyIndex) || proxyIndex < 1) {
    throw new Error(`Invalid provider proxy index: ${proxyIndex}`)
  }
  const existing = agents.get(proxyIndex)
  if (existing) return existing

  const proxyUrl = loadProxyUrls()[proxyIndex - 1]
  if (!proxyUrl) {
    throw new Error(`Provider proxy #${proxyIndex} is not configured`)
  }
  assertSafeProxyUrl(proxyUrl)
  const agent = new ProxyAgent(proxyUrl)
  agents.set(proxyIndex, agent)
  return agent
}

export function configuredProxyCount(): number {
  return loadProxyUrls().length
}

const urlAgents = new Map<string, ProxyAgent>()

/** Dispatcher for a proxy URL stored on a provider row, not a proxy.txt slot. */
export function dispatcherForProxyUrl(proxyUrl: string): Dispatcher {
  const key = proxyUrl.trim()
  assertSafeProxyUrl(key)
  const existing = urlAgents.get(key)
  if (existing) return existing
  const agent = new ProxyAgent(key)
  urlAgents.set(key, agent)
  return agent
}

/**
 * Shared transport for every outbound provider call (gateway traffic, health
 * probes, balance and catalog synchronization) so one provider key always
 * leaves from one IP. Keys without an assignment keep the default transport.
 */
export const APINEX_GATE_SOURCE_HEADER = { src: 'gate' } as const

function withApinexSourceHeader(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('src', 'gate')
  return { ...init, headers }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key']
const MAX_REDIRECTS = 5

export async function proxiedFetchUrl(
  url: string,
  init: RequestInit = {},
  proxyUrl: string,
): Promise<Response> {
  assertSafeProxyUrl(proxyUrl)
  let currentUrl = url
  let currentInit = withApinexSourceHeader(init)
  const userRedirect = init.redirect
  const followRedirects = userRedirect !== 'manual' && userRedirect !== 'error'

  let redirectCount = 0

  while (true) {
    assertSafeUpstreamUrl(currentUrl)
    await assertSafeUpstreamUrlAsync(currentUrl)
    const dispatcher = dispatcherForProxyUrl(proxyUrl)

    const fetchInit = {
      ...(currentInit as Record<string, unknown>),
      redirect: 'manual' as const,
      dispatcher,
    }

    const res = (await undiciFetch(currentUrl, fetchInit as never)) as unknown as Response

    if (!REDIRECT_STATUSES.has(res.status) || !followRedirects) {
      if (REDIRECT_STATUSES.has(res.status) && userRedirect === 'error') {
        throw new Error(`Unexpected redirect (${res.status}) to ${res.headers.get('location')}`)
      }
      return res
    }

    redirectCount++
    if (redirectCount > MAX_REDIRECTS) {
      throw new Error(`Too many redirects (limit: ${MAX_REDIRECTS})`)
    }

    const location = res.headers.get('location')
    if (!location) {
      return res
    }

    const nextUrl = new URL(location, currentUrl).toString()
    assertSafeUpstreamUrl(nextUrl)
    await assertSafeUpstreamUrlAsync(nextUrl)

    const prevOrigin = new URL(currentUrl).origin
    const nextOrigin = new URL(nextUrl).origin
    const headers = new Headers(currentInit.headers)

    if (prevOrigin !== nextOrigin) {
      for (const h of SENSITIVE_HEADERS) {
        headers.delete(h)
      }
    }

    let nextMethod = currentInit.method || 'GET'
    let nextBody = currentInit.body

    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && nextMethod !== 'GET' && nextMethod !== 'HEAD')
    ) {
      nextMethod = 'GET'
      nextBody = undefined
    }

    currentUrl = nextUrl
    currentInit = {
      ...currentInit,
      method: nextMethod,
      body: nextBody,
      headers,
    }
  }
}

export async function proxiedFetch(
  url: string,
  init: RequestInit = {},
  proxyIndex: number | null = null,
): Promise<Response> {
  let currentUrl = url
  let currentInit = withApinexSourceHeader(init)
  const userRedirect = init.redirect
  const followRedirects = userRedirect !== 'manual' && userRedirect !== 'error'

  let redirectCount = 0

  while (true) {
    assertSafeUpstreamUrl(currentUrl)
    await assertSafeUpstreamUrlAsync(currentUrl)
    const dispatcher = dispatcherForProxyIndex(proxyIndex)

    const fetchInit = {
      ...(currentInit as Record<string, unknown>),
      redirect: 'manual' as const,
      dispatcher,
    }

    const res = dispatcher
      ? ((await undiciFetch(currentUrl, fetchInit as never)) as unknown as Response)
      : await globalThis.fetch(currentUrl, { ...(fetchInit as RequestInit), redirect: 'manual' })

    if (!REDIRECT_STATUSES.has(res.status) || !followRedirects) {
      if (REDIRECT_STATUSES.has(res.status) && userRedirect === 'error') {
        throw new Error(`Unexpected redirect (${res.status}) to ${res.headers.get('location')}`)
      }
      return res
    }

    redirectCount++
    if (redirectCount > MAX_REDIRECTS) {
      throw new Error(`Too many redirects (limit: ${MAX_REDIRECTS})`)
    }

    const location = res.headers.get('location')
    if (!location) {
      return res
    }

    const nextUrl = new URL(location, currentUrl).toString()
    assertSafeUpstreamUrl(nextUrl)
    await assertSafeUpstreamUrlAsync(nextUrl)

    const prevOrigin = new URL(currentUrl).origin
    const nextOrigin = new URL(nextUrl).origin
    const headers = new Headers(currentInit.headers)

    if (prevOrigin !== nextOrigin) {
      for (const h of SENSITIVE_HEADERS) {
        headers.delete(h)
      }
    }

    let nextMethod = currentInit.method || 'GET'
    let nextBody = currentInit.body

    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && nextMethod !== 'GET' && nextMethod !== 'HEAD')
    ) {
      nextMethod = 'GET'
      nextBody = undefined
    }

    currentUrl = nextUrl
    currentInit = {
      ...currentInit,
      method: nextMethod,
      body: nextBody,
      headers,
    }
  }
}
