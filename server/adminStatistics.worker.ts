import { parentPort, workerData } from 'node:worker_threads'

const payload = workerData as {
  kind?: 'overview' | 'models'
  input?: Record<string, string | undefined>
}

try {
  const input = payload.input ?? {}
  let data: unknown
  if (payload.kind === 'models') {
    const { buildModelUsageStats } = await import('./modelUsageStats.js')
    data = buildModelUsageStats(input)
  } else {
    const { buildAdminStatistics } = await import('./adminStatistics.js')
    data = await buildAdminStatistics(input)
  }
  parentPort?.postMessage({ ok: true, data })
} catch (reason) {
  parentPort?.postMessage({
    ok: false,
    error: reason instanceof Error ? reason.message : 'Could not load statistics',
  })
}
