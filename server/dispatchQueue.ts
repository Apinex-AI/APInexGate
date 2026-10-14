import { getGatewayFairnessSettings } from './gatewayFairness.js'
import { getAccountRpm } from './rpmPlans.js'

/**
 * Fairness dispatch queue for upstream requests.
 *
 * Free users acquire a dispatch slot through a FIFO queue; subscribers skip to
 * the front. Slots are cheap (this is not upstream concurrency control) — the
 * queue only arbitrates dispatch order so that when the upstream pool is
 * saturated, subscribers' requests are submitted first instead of being stuck
 * behind a burst of free requests. A request that has already been dispatched
 * is never interrupted.
 *
 * Waiting is capped by a timeout so free requests fail fast (429 with
 * Retry-After) instead of hanging behind an endless subscriber stream.
 */

type Waiter = {
  userId: string
  priority: boolean
  resolve: () => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  enqueuedAt: number
}

const MAX_QUEUE_WAIT_MS = 15_000

let queue: Waiter[] = []
let activeSlots = 0
/** Tuned so the queue only matters when the upstream is genuinely saturated. */
const MAX_CONCURRENT = 40

function drainLocked() {
  while (activeSlots < MAX_CONCURRENT && queue.length > 0) {
    // Priority (subscriber) waiters jump ahead of free waiters. Within the
    // same class, dispatch order is FIFO — first come, first served.
    let index = queue.findIndex((waiter) => waiter.priority)
    if (index === -1) index = 0
    const [waiter] = queue.splice(index, 1)
    activeSlots += 1
    clearTimeout(waiter.timer)
    waiter.resolve()
  }
}

export async function acquireDispatchSlot(userId: string, opts?: { waitTimeoutMs?: number; priority?: boolean }): Promise<{ waited: boolean; timedOut: boolean }> {
  const settings = getGatewayFairnessSettings()
  if (activeSlots < MAX_CONCURRENT && queue.length === 0) {
    activeSlots += 1
    return { waited: false, timedOut: false }
  }

  const hasPaidRpm = getAccountRpm(userId).source !== 'free'
  const priority = opts?.priority ?? (settings.subscriberPriority ? hasPaidRpm : false)

  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      userId,
      priority,
      resolve: () => resolve({ waited: true, timedOut: false }),
      reject,
      timer: setTimeout(() => {
        const index = queue.indexOf(waiter)
        if (index === -1) return
        queue.splice(index, 1)
        resolve({ waited: true, timedOut: true })
      }, opts?.waitTimeoutMs ?? MAX_QUEUE_WAIT_MS),
      enqueuedAt: Date.now(),
    }
    queue.push(waiter)
    // A waiter may have been enqueued behind a drained slot window.
    drainLocked()
  })
}

export function releaseDispatchSlot() {
  if (activeSlots > 0) activeSlots -= 1
  drainLocked()
}

/** Test/ops visibility: current queue depth and split. */
export function dispatchQueueStats() {
  return {
    active: activeSlots,
    maxConcurrent: MAX_CONCURRENT,
    waiting: queue.length,
    waitingPriority: queue.filter((waiter) => waiter.priority).length,
    oldestWaitMs: queue.length > 0 ? Date.now() - queue[0].enqueuedAt : 0,
  }
}

/** Test hook: reset all queue state. */
export function resetDispatchQueueForTests() {
  for (const waiter of queue) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error('queue reset'))
  }
  queue = []
  activeSlots = 0
}
