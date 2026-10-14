import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

const PROXY_FILE = process.env.PROXY_FILE?.trim() || resolve(process.cwd(), 'proxy.txt')

let proxyUrls: string[] | null = null
const agents = new Map<number, ProxyAgent>()

function loadProxyUrls() {
  if (proxyUrls) return proxyUrls
  const contents = readFileSync(PROXY_FILE, 'utf8')
  proxyUrls = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return proxyUrls
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
  const agent = new ProxyAgent(proxyUrl)
  agents.set(proxyIndex, agent)
  return agent
}

export function configuredProxyCount() {
  return loadProxyUrls().length
}

const urlAgents = new Map<string, ProxyAgent>()

/** Dispatcher for a proxy URL stored on a provider row, not a proxy.txt slot. */
export function dispatcherForProxyUrl(proxyUrl: string): Dispatcher {
  const key = proxyUrl.trim()
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

export async function proxiedFetchUrl(url: string, init: RequestInit, proxyUrl: string): Promise<Response> {
  const dispatcher = dispatcherForProxyUrl(proxyUrl)
  const nextInit = withApinexSourceHeader(init)
  return (await undiciFetch(url, { ...(nextInit as Record<string, unknown>), dispatcher } as never)) as unknown as Response
}

export async function proxiedFetch(
  url: string,
  init: RequestInit,
  proxyIndex: number | null,
): Promise<Response> {
  const nextInit = withApinexSourceHeader(init)
  const dispatcher = dispatcherForProxyIndex(proxyIndex)
  if (!dispatcher) return globalThis.fetch(url, nextInit)
  return (await undiciFetch(url, { ...(nextInit as Record<string, unknown>), dispatcher } as never)) as unknown as Response
}
