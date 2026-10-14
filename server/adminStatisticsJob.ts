import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { dbPath } from './db.js'
import type { buildAdminStatistics } from './adminStatistics.js'
import type { buildModelUsageStats } from './modelUsageStats.js'

type JobKind = 'overview' | 'models'

type JobResult = {
  overview: Awaited<ReturnType<typeof buildAdminStatistics>>
  models: ReturnType<typeof buildModelUsageStats>
}

const FRESH_MS = 60_000
const STALE_MAX_MS = 10 * 60 * 1000

type CacheEntry = {
  data: unknown
  freshUntil: number
  staleUntil: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()
let statsChain: Promise<unknown> = Promise.resolve()

function workerUrl() {
  const js = new URL('./adminStatistics.worker.js', import.meta.url)
  if (existsSync(fileURLToPath(js))) return js
  return new URL('./adminStatistics.worker.ts', import.meta.url)
}

function runWorker<K extends JobKind>(kind: K, input: unknown): Promise<JobResult[K]> {
  const url = workerUrl()
  const execArgv = url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: { kind, input },
      execArgv,
      env: { ...process.env, DB_PATH: dbPath, STATS_WORKER: '1' },
    })
    let settled = false
    const finish = (error?: Error, data?: JobResult[K]) => {
      if (settled) return
      settled = true
      void worker.terminate()
      if (error) reject(error)
      else resolve(data as JobResult[K])
    }
    worker.once('message', (message: { ok?: boolean; data?: JobResult[K]; error?: string }) => {
      if (message?.ok) finish(undefined, message.data)
      else finish(new Error(message?.error || 'Could not load statistics'))
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new Error(`Statistics worker exited with code ${code}`))
    })
  })
}

function triggerBackgroundRefresh<K extends JobKind>(kind: K, input: unknown, key: string) {
  if (inflight.has(key)) return
  const job = new Promise<JobResult[K]>((resolve, reject) => {
    statsChain = statsChain
      .catch(() => undefined)
      .then(() => runWorker(kind, input))
      .then(resolve, reject)
  })
    .then((data) => {
      const now = Date.now()
      cache.set(key, { data, freshUntil: now + FRESH_MS, staleUntil: now + STALE_MAX_MS })
      return data
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, job)
}

function cached<K extends JobKind>(kind: K, input: unknown): Promise<JobResult[K]> {
  const key = `${kind}:${JSON.stringify(input ?? {})}`
  const now = Date.now()
  const hit = cache.get(key)

  if (hit) {
    if (now < hit.freshUntil) {
      return Promise.resolve(hit.data as JobResult[K])
    }
    if (now < hit.staleUntil) {
      triggerBackgroundRefresh(kind, input, key)
      return Promise.resolve(hit.data as JobResult[K])
    }
  }

  const pending = inflight.get(key)
  if (pending) return pending as Promise<JobResult[K]>

  triggerBackgroundRefresh(kind, input, key)
  return inflight.get(key) as Promise<JobResult[K]>
}

/** Heavy statistics scans run off the API thread and never take a write lock. */
export function buildAdminStatisticsOffThread(input: { q?: string; period?: string; from?: string; to?: string }) {
  return cached('overview', input)
}

export function buildModelUsageStatsOffThread(input: { window?: string }) {
  return cached('models', input)
}
