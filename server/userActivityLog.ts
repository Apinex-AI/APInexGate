import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { db, nowIso } from './db.js'

/** Soft local cap before rotate + upload (user requested ≤ 5GB). */
const MAX_BYTES = Number(process.env.ACTIVITY_LOG_MAX_BYTES || 5 * 1024 * 1024 * 1024)
const CHECK_EVERY_WRITES = 200
const ROTATE_COOLDOWN_MS = 60_000

function dataRoot() {
  return resolve(process.env.DATA_DIR || join(process.cwd(), 'data'))
}

function logsDir() {
  return resolve(process.env.ACTIVITY_LOG_DIR || join(dataRoot(), 'activity-logs'))
}

function currentPath() {
  return join(logsDir(), 'current.ndjson')
}

function metaPath() {
  return join(logsDir(), 'current.meta.json')
}

type Meta = { startedAt: string; bytesApprox: number }

let writeCount = 0
let lastRotateAt = 0
let rotating = false
let lastWriteErrorAt = 0
let lastPermissionRecoveryAt = 0

/** Log a write failure at most once a minute so one broken file cannot flood the log. */
function reportWriteFailure(error: unknown) {
  const now = Date.now()
  if (now - lastWriteErrorAt < 60_000) return
  lastWriteErrorAt = now
  console.error('[activity-log] write failed', error)
}

function isPermissionError(error: unknown) {
  const code = (error as { code?: string } | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

/**
 * Recover from an unwritable `current.ndjson`.
 *
 * This happens when the file ends up owned by another user (for example a
 * rotation that ran as root), after which every append throws EACCES and all
 * activity is silently lost until someone intervenes by hand.
 *
 * Renaming needs write permission on the DIRECTORY, not the file, and the log
 * directory belongs to the deployment user — so the unwritable file can be moved
 * aside and replaced with a fresh one the process owns. The old file is kept for
 * inspection rather than deleted.
 */
function recoverUnwritableCurrent(): boolean {
  const now = Date.now()
  // Never loop on this: at most one attempt every 5 minutes.
  if (now - lastPermissionRecoveryAt < 5 * 60_000) return false
  lastPermissionRecoveryAt = now
  try {
    const path = currentPath()
    if (existsSync(path)) {
      renameSync(path, join(logsDir(), `current.unwritable-${stamp(nowIso())}.ndjson`))
    }
    writeFileSync(path, '', 'utf8')
    writeMeta({ startedAt: nowIso(), bytesApprox: 0 })
    console.warn('[activity-log] replaced an unwritable current.ndjson and resumed logging')
    return true
  } catch (error) {
    console.error('[activity-log] could not recover the log file', error)
    return false
  }
}

function ensureDir() {
  const dir = logsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(currentPath())) {
    writeFileSync(currentPath(), '', 'utf8')
  }
  if (!existsSync(metaPath())) {
    writeFileSync(
      metaPath(),
      JSON.stringify({ startedAt: nowIso(), bytesApprox: 0 } satisfies Meta),
      'utf8',
    )
  }
}

function readMeta(): Meta {
  ensureDir()
  try {
    const raw = JSON.parse(readFileSync(metaPath(), 'utf8')) as Meta
    return {
      startedAt: raw.startedAt || nowIso(),
      bytesApprox: Number(raw.bytesApprox) || 0,
    }
  } catch {
    return { startedAt: nowIso(), bytesApprox: 0 }
  }
}

function writeMeta(meta: Meta) {
  writeFileSync(metaPath(), JSON.stringify(meta), 'utf8')
}

function stamp(iso: string) {
  return iso.replace(/[:.]/g, '-').replace(/Z$/, 'Z')
}

function userIdentity(userId: string | null | undefined) {
  if (!userId) return { userId: null, email: null, wallet: null, domain: null, displayId: null }
  try {
    const row = db
      .prepare(
        `SELECT display_id, email
         FROM users WHERE id = ?`,
      )
      .get(userId) as
      | {
          display_id: number | null
          email: string | null
        }
      | undefined
    return {
      userId,
      displayId: row?.display_id ?? null,
      email: row?.email ?? null,
      wallet: null,
      domain: null,
    }
  } catch {
    return { userId, email: null, wallet: null, domain: null, displayId: null }
  }
}

export type ActivityAction =
  | 'user.login'
  | 'user.signup'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'api.request'
  | 'tool.request'
  | 'tokens.topup'
  | 'billing.invoice'
  | string

/**
 * Append one NDJSON activity line. Failures never break product flows.
 */
export function logUserActivity(input: {
  action: ActivityAction
  userId?: string | null
  target?: string | null
  meta?: Record<string, unknown>
}) {
  try {
    ensureDir()
    const when = nowIso()
    const identity = userIdentity(input.userId)
    const line =
      JSON.stringify({
        at: when,
        action: input.action,
        target: input.target ?? null,
        ...identity,
        meta: input.meta ?? {},
      }) + '\n'

    try {
      appendFileSync(currentPath(), line, 'utf8')
    } catch (error) {
      // An unwritable file is recoverable; retry once after replacing it.
      if (!isPermissionError(error) || !recoverUnwritableCurrent()) throw error
      appendFileSync(currentPath(), line, 'utf8')
    }
    const meta = readMeta()
    meta.bytesApprox = (Number(meta.bytesApprox) || 0) + Buffer.byteLength(line, 'utf8')
    writeMeta(meta)

    writeCount += 1
    if (writeCount % CHECK_EVERY_WRITES === 0) {
      void maybeRotateActivityLogs('size-check')
    }
  } catch (error) {
    reportWriteFailure(error)
  }
}

export function activityLogStatus() {
  ensureDir()
  const meta = readMeta()
  let size = 0
  try {
    size = statSync(currentPath()).size
  } catch {
    size = meta.bytesApprox
  }
  return {
    dir: logsDir(),
    currentFile: currentPath(),
    startedAt: meta.startedAt,
    bytes: size,
    maxBytes: MAX_BYTES,
    pct: Math.min(100, Math.round((size / MAX_BYTES) * 1000) / 10),
  }
}

/**
 * Rotate current NDJSON to local compressed archive (no external cloud/rclone uploads).
 * Safe to call from cron or when size exceeds the soft cap.
 */
export async function rotateActivityLogs(reason = 'manual') {
  ensureDir()
  if (rotating) return { ok: false, skipped: true, reason: 'already-rotating' }
  if (Date.now() - lastRotateAt < ROTATE_COOLDOWN_MS) {
    return { ok: false, skipped: true, reason: 'cooldown' }
  }

  const file = currentPath()
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    size = 0
  }
  if (size <= 0) {
    return { ok: true, skipped: true, reason: 'empty' }
  }

  rotating = true
  lastRotateAt = Date.now()
  try {
    const meta = readMeta()
    const endedAt = nowIso()
    const startStamp = stamp(meta.startedAt || endedAt)
    const endStamp = stamp(endedAt)
    const baseName = `activity-${startStamp}_to_${endStamp}`
    const dir = logsDir()
    const staged = join(dir, `${baseName}.ndjson`)
    const archive = join(dir, `${baseName}.ndjson.gz`)

    renameSync(file, staged)
    writeFileSync(file, '', 'utf8')
    writeMeta({ startedAt: endedAt, bytesApprox: 0 })

    // Compress using native Node.js async streams without blocking the event loop or spawning external processes
    try {
      const gzip = createGzip()
      const source = createReadStream(staged)
      const destination = createWriteStream(archive)
      await pipeline(source, gzip, destination)
      rmSync(staged, { force: true })
    } catch (compressErr) {
      // Put staged file back if compression fails
      try {
        if (!existsSync(file) || statSync(file).size === 0) {
          renameSync(staged, file)
          writeMeta(meta)
        }
      } catch {
        /* ignore */
      }
      throw compressErr
    }

    // Local cleanup of old archives
    const keepDays = Number(process.env.ACTIVITY_LOG_KEEP_DAYS || 14)
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ndjson.gz') && !name.endsWith('.tar.gz')) continue
        const p = join(dir, name)
        const ageMs = Date.now() - statSync(p).mtimeMs
        if (ageMs > keepDays * DAY_MS) rmSync(p, { force: true })
      }
    } catch {
      /* ignore */
    }

    console.info(`[activity-log] rotated ${baseName}.ndjson.gz (${reason})`)
    return { ok: true, skipped: false, name: baseName, trigger: reason, bytes: size }
  } catch (error) {
    console.error('[activity-log] rotate failed', error)
    return {
      ok: false,
      skipped: false,
      reason: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    rotating = false
  }
}

const DAY_MS = 86_400_000

export function maybeRotateActivityLogs(reason = 'size-check') {
  try {
    ensureDir()
    let size = 0
    try {
      size = statSync(currentPath()).size
    } catch {
      return { ok: true, skipped: true, reason: 'missing' }
    }
    if (size < MAX_BYTES) return { ok: true, skipped: true, reason: 'under-cap', bytes: size }
    return rotateActivityLogs(reason)
  } catch (error) {
    console.error('[activity-log] maybeRotate failed', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let timer: ReturnType<typeof setInterval> | null = null

/** Hourly size check + optional force daily rotate near midnight UTC. */
export function startActivityLogMaintenance() {
  if (timer) return
  ensureDir()
  timer = setInterval(() => {
    void maybeRotateActivityLogs('hourly')
    // Force rotate around 00:05–00:15 UTC if file has content and started yesterday.
    const now = new Date()
    if (now.getUTCHours() === 0 && now.getUTCMinutes() >= 5 && now.getUTCMinutes() < 15) {
      try {
        const meta = readMeta()
        const startedDay = String(meta.startedAt || '').slice(0, 10)
        const today = now.toISOString().slice(0, 10)
        if (startedDay && startedDay < today) {
          void rotateActivityLogs('daily')
        }
      } catch {
        /* ignore */
      }
    }
  }, 10 * 60_000)
  timer.unref?.()
}

// Touch meta path on import so folder exists early.
try {
  ensureDir()
} catch {
  /* ignore until writable */
}
