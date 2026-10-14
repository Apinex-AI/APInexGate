import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const isTestRunner =
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.execArgv.includes('--test') ||
  process.argv.some((arg) => arg.includes('/tests/') || arg.endsWith('.test.ts'))
const envDbPath = process.env.DB_PATH
const useTempTestDb =
  isTestRunner && (!envDbPath || envDbPath.includes('gateway.sqlite'))
const rawDbPath = useTempTestDb
  ? join(tmpdir(), `gateway-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
  : (envDbPath ?? './data/gateway.sqlite')
export const dbPath = rawDbPath === ':memory:' ? ':memory:' : resolve(rawDbPath)
if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true })
}

/** Statistics workers only read. They must not rerun migrations or take a write lock. */
const statsWorker = process.env.STATS_WORKER === '1'
export const db = new Database(dbPath, statsWorker ? { readonly: true, fileMustExist: true } : {})

if (statsWorker) {
  db.pragma('busy_timeout = 3000')
  db.pragma('query_only = ON')
  const origPrepare = db.prepare.bind(db)
  const noopStmt = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: () => [],
  }
  db.exec = (() => db) as typeof db.exec
  db.transaction = (() => () => undefined) as unknown as typeof db.transaction
  db.prepare = ((sql: string) => {
    if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.trimStart())) return noopStmt as unknown as ReturnType<typeof origPrepare>
    return origPrepare(sql)
  }) as typeof db.prepare
} else {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  const checkpointTimer = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(PASSIVE)')
    } catch {
      /* a reader can delay truncation; the next pass retries */
    }
  }, 15_000)
  checkpointTimer.unref?.()
}

{
  // Both integrity_check and quick_check read the whole 1.6GB file. On a cold
  // page cache that blocks listen() for minutes, so nginx stays on 502.
  // Opt in with SQLITE_INTEGRITY_CHECK=quick or =full.
  const mode = process.env.SQLITE_INTEGRITY_CHECK
  const pragma = mode === 'full' ? 'integrity_check' : mode === 'quick' ? 'quick_check' : ''
  if (pragma) {
    const check = db.pragma(pragma, { simple: true }) as string
    if (check !== 'ok') {
      throw new Error(
        `SQLite ${pragma} failed for ${dbPath}: ${check}. ` +
          'Do not copy/overwrite a live .sqlite while the API is running; redeploy with a clean DB or restore a backup.',
      )
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );

  CREATE TABLE IF NOT EXISTS provider_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    secret_hint TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_catalog (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    context_window TEXT NOT NULL,
    input_price_micros INTEGER NOT NULL,
    output_price_micros INTEGER NOT NULL,
    status TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    upstream_id TEXT,
    upstream_provider TEXT NOT NULL DEFAULT 'apinex'
  );

  CREATE TABLE IF NOT EXISTS pricing_rules (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE,
    input_multiplier REAL NOT NULL,
    output_multiplier REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS balance_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    note TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    secret_hash TEXT,
    secret TEXT,
    spend_limit_cents INTEGER,
    spent_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    model_id TEXT,
    provider TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_keys (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    secret TEXT NOT NULL UNIQUE,
    secret_hint TEXT NOT NULL,
    balance_tokens INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    last_synced_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fcm_token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL DEFAULT 'android',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS notification_devices_user_idx ON notification_devices(user_id);

  CREATE TABLE IF NOT EXISTS notification_campaigns (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admin_users(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT,
    audience TEXT NOT NULL,
    target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crypto_payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    invoice_id TEXT,
    invoice_url TEXT,
    payment_id TEXT,
    pay_currency TEXT,
    pay_amount TEXT,
    order_id TEXT NOT NULL UNIQUE,
    raw_status TEXT,
    credited_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

const cryptoPaymentColumns = db.prepare('PRAGMA table_info(crypto_payments)').all() as Array<{ name: string }>
if (!cryptoPaymentColumns.some((column) => column.name === 'actually_paid')) {
  db.exec('ALTER TABLE crypto_payments ADD COLUMN actually_paid TEXT')
}
if (!cryptoPaymentColumns.some((column) => column.name === 'credited_usd_cents')) {
  db.exec('ALTER TABLE crypto_payments ADD COLUMN credited_usd_cents INTEGER')
}




const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
if (!userColumns.some((column) => column.name === 'password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT')
}
if (!userColumns.some((column) => column.name === 'email_verified_at')) {
  db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT')
  // Existing accounts are treated as already verified.
  db.exec(`UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL`)
}
if (!userColumns.some((column) => column.name === 'google_sub')) {
  db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT')
}
if (!userColumns.some((column) => column.name === 'display_id')) {
  db.exec('ALTER TABLE users ADD COLUMN display_id INTEGER')
  const ordered = db
    .prepare(`SELECT id FROM users ORDER BY datetime(created_at) ASC, id ASC`)
    .all() as Array<{ id: string }>
  const assign = db.prepare(`UPDATE users SET display_id = ? WHERE id = ?`)
  const tx = db.transaction(() => {
    ordered.forEach((row, index) => assign.run(index + 1, row.id))
  })
  tx()
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL`)

export function parseSafeInt(
  val: unknown,
  fallback: number,
  min: number = 0,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  if (val === undefined || val === null || val === '') return fallback
  const num = typeof val === 'number' ? val : Number(val)
  if (!Number.isFinite(num) || Number.isNaN(num)) return fallback
  const truncated = Math.trunc(num)
  if (!Number.isSafeInteger(truncated)) return fallback
  return Math.min(Math.max(truncated, min), max)
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_id ON users (display_id) WHERE display_id IS NOT NULL`)

db.prepare(`UPDATE users SET status = 'active' WHERE status = 'trial'`).run()

{
  const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'telegram_id')) {
    db.exec('ALTER TABLE users ADD COLUMN telegram_id TEXT')
  }
  if (!cols.some((column) => column.name === 'telegram_username')) {
    db.exec('ALTER TABLE users ADD COLUMN telegram_username TEXT')
  }
  if (!cols.some((column) => column.name === 'telegram_bonus_claimed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN telegram_bonus_claimed_at TEXT')
  }
  if (!cols.some((column) => column.name === 'telegram_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN telegram_verified_at TEXT')
  }
  if (!cols.some((column) => column.name === 'total_xp')) {
    db.exec('ALTER TABLE users ADD COLUMN total_xp INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.some((column) => column.name === 'xp_tier')) {
    db.exec(`ALTER TABLE users ADD COLUMN xp_tier TEXT NOT NULL DEFAULT 'Bronze'`)
  }
  // Customer wallet in Gateway tokens (legacy DBs may only have balance_cents).
  if (!cols.some((column) => column.name === 'balance_tokens')) {
    db.exec('ALTER TABLE users ADD COLUMN balance_tokens INTEGER NOT NULL DEFAULT 0')
    db.exec(
      `UPDATE users SET balance_tokens = CAST(COALESCE(balance_cents, 0) AS INTEGER) * 40000`,
    )
  }
  // In-flight holds for concurrent LLM requests (soft counter; source of truth is token_reservations).
  if (!cols.some((column) => column.name === 'reserved_tokens')) {
    db.exec('ALTER TABLE users ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0')
  }
  // Optional budget usage Telegram alerts (80/90/100% of current budget cycle).
  if (!cols.some((column) => column.name === 'low_balance_notified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN low_balance_notified_at TEXT')
  }
  if (!cols.some((column) => column.name === 'low_balance_alert_enabled')) {
    db.exec('ALTER TABLE users ADD COLUMN low_balance_alert_enabled INTEGER NOT NULL DEFAULT 0')
  }
  if (!cols.some((column) => column.name === 'low_balance_alert_levels')) {
    db.exec("ALTER TABLE users ADD COLUMN low_balance_alert_levels TEXT DEFAULT '30m,20m,10m,5m'")
  }
  // Legacy absolute threshold — kept for schema compatibility, unused by new % budget alerts.
  if (!cols.some((column) => column.name === 'low_balance_alert_tokens')) {
    db.exec('ALTER TABLE users ADD COLUMN low_balance_alert_tokens INTEGER')
  }
  if (!cols.some((column) => column.name === 'budget_base_tokens')) {
    db.exec('ALTER TABLE users ADD COLUMN budget_base_tokens INTEGER NOT NULL DEFAULT 0')
  }
  // Highest spent-% alert already sent in this budget cycle: 0 | 80 | 90 | 100
  if (!cols.some((column) => column.name === 'budget_alert_notified')) {
    db.exec('ALTER TABLE users ADD COLUMN budget_alert_notified INTEGER NOT NULL DEFAULT 0')
  }
  // Bits of USD balance alerts already sent: $5, $3, $1, $0. Cleared after a top-up above $5.
  if (!cols.some((column) => column.name === 'balance_alert_mask')) {
    db.exec('ALTER TABLE users ADD COLUMN balance_alert_mask INTEGER NOT NULL DEFAULT 15')
  }
  // Solana wallet address (optional).
  if (!cols.some((column) => column.name === 'solana_wallet')) {
    db.exec('ALTER TABLE users ADD COLUMN solana_wallet TEXT')
  }
  if (!cols.some((column) => column.name === 'auth_method')) {
    db.exec("ALTER TABLE users ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'email'")
  }

}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users (telegram_id) WHERE telegram_id IS NOT NULL`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_telegram_verified ON users (telegram_verified_at) WHERE telegram_verified_at IS NOT NULL`)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_solana_wallet ON users (solana_wallet) WHERE solana_wallet IS NOT NULL`)

{
  const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'referral_code')) {
    db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT')
  }
  if (!cols.some((column) => column.name === 'referred_by')) {
    db.exec('ALTER TABLE users ADD COLUMN referred_by TEXT')
  }
}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users (referral_code) WHERE referral_code IS NOT NULL`,
)
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users (referred_by)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS referral_rewards (
    referee_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    referrer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payment_id TEXT NOT NULL,
    referrer_tokens INTEGER NOT NULL,
    referee_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards (referrer_user_id);

  CREATE TABLE IF NOT EXISTS promo_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    reward_tokens INTEGER NOT NULL,
    reward_cents INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    type TEXT NOT NULL DEFAULT 'balance',
    plan_key TEXT,
    custom_days INTEGER,
    custom_token_limit INTEGER
  );

  CREATE TABLE IF NOT EXISTS promo_redemptions (
    promo_id TEXT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (promo_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions (user_id);
`)

{
  const promoRedeemCols = db.prepare('PRAGMA table_info(promo_redemptions)').all() as Array<{ name: string }>
  if (!promoRedeemCols.some((column) => column.name === 'usd_cents')) {
    db.exec(`ALTER TABLE promo_redemptions ADD COLUMN usd_cents INTEGER NOT NULL DEFAULT 0`)
  }
}

{
  const cols = db.prepare('PRAGMA table_info(promo_codes)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'status')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`)
  }
  if (!cols.some((column) => column.name === 'reward_cents')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN reward_cents INTEGER NOT NULL DEFAULT 0`)
    // Backfill: legacy reward_tokens were USD-denominated at 4,000,000 tokens per $1.
    db.exec(`UPDATE promo_codes SET reward_cents = CAST(ROUND(reward_tokens / 4000000.0 * 100) AS INTEGER) WHERE reward_cents = 0`)
  }
  if (!cols.some((column) => column.name === 'type')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN type TEXT NOT NULL DEFAULT 'balance'`)
  }
  if (!cols.some((column) => column.name === 'plan_key')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN plan_key TEXT`)
  }
  if (!cols.some((column) => column.name === 'redeemed_at')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN redeemed_at TEXT`)
  }
  if (!cols.some((column) => column.name === 'redeemed_by_user_id')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN redeemed_by_user_id TEXT`)
  }
  if (!cols.some((column) => column.name === 'custom_days')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN custom_days INTEGER`)
  }
  if (!cols.some((column) => column.name === 'custom_token_limit')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN custom_token_limit INTEGER`)
  }
  if (!cols.some((column) => column.name === 'discount_mode')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN discount_mode TEXT`)
  }
  if (!cols.some((column) => column.name === 'discount_value')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN discount_value INTEGER`)
  }
  if (!cols.some((column) => column.name === 'offer_unit')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN offer_unit TEXT`)
  }
  if (!cols.some((column) => column.name === 'offer_amount')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN offer_amount INTEGER`)
  }
  if (!cols.some((column) => column.name === 'bonus_target')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN bonus_target TEXT`)
  }
  if (!cols.some((column) => column.name === 'bonus_percent')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN bonus_percent INTEGER`)
  }
  if (!cols.some((column) => column.name === 'bonus_duration_unit')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN bonus_duration_unit TEXT`)
  }
  if (!cols.some((column) => column.name === 'bonus_duration_value')) {
    db.exec(`ALTER TABLE promo_codes ADD COLUMN bonus_duration_value INTEGER`)
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS user_promo_bonuses (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    promo_id TEXT,
    target TEXT NOT NULL,
    bonus_percent INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS user_subscription_offers (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    promo_id TEXT,
    discount_mode TEXT NOT NULL,
    discount_value INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_link_user ON telegram_link_tokens (user_id, created_at);
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_chats (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    user_id TEXT,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    blocked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_chats_username ON telegram_chats (username);
  CREATE INDEX IF NOT EXISTS idx_telegram_chats_user ON telegram_chats (user_id);

  CREATE TABLE IF NOT EXISTS telegram_broadcasts (
    id TEXT PRIMARY KEY,
    audience TEXT NOT NULL,
    target TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    last_error TEXT
  );
`)


{
  const cols = db.prepare('PRAGMA table_info(model_catalog)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'token_weight')) {
    db.exec('ALTER TABLE model_catalog ADD COLUMN token_weight REAL NOT NULL DEFAULT 1')
    db.exec(`
      UPDATE model_catalog
      SET token_weight = COALESCE(
        (SELECT p.input_multiplier FROM pricing_rules p WHERE p.model_id = model_catalog.id),
        1
      )
    `)
  }
  if (!cols.some((column) => column.name === 'sort_order')) {
    db.exec('ALTER TABLE model_catalog ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    const rows = db
      .prepare(`SELECT id FROM model_catalog ORDER BY provider ASC, name ASC`)
      .all() as Array<{ id: string }>
    const update = db.prepare(`UPDATE model_catalog SET sort_order = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      rows.forEach((row, index) => update.run((index + 1) * 10, row.id))
    })
    tx()
  }
  // Free models are available to every account. Drop the old subscription gate.
  if (cols.some((column) => column.name === 'allow_free')) {
    db.exec('ALTER TABLE model_catalog DROP COLUMN allow_free')
  }
  // Admin-pinned health status. NULL/'' = automatic (telemetry + status pages).
  if (!cols.some((column) => column.name === 'health_override')) {
    db.exec("ALTER TABLE model_catalog ADD COLUMN health_override TEXT NOT NULL DEFAULT ''")
  }
  // Provider label: Grok models are under the xAI provider brand.
  db.prepare(`UPDATE model_catalog SET provider = 'Grok' WHERE lower(provider) IN ('grok', 'xai')`).run()
  db.prepare(`UPDATE model_catalog SET provider = 'GPT' WHERE provider IN ('OpenAI', 'GPT') AND provider != 'GPT'`).run()
  db.prepare(`UPDATE model_catalog SET provider = 'Claude' WHERE provider = 'Anthropic'`).run()
  db.prepare(`UPDATE model_catalog SET provider = 'Kimi' WHERE provider = 'Moonshot'`).run()
  db.prepare(`UPDATE model_catalog SET provider = 'GLM' WHERE provider IN ('Zhipu', 'Z.ai')`).run()
  db.prepare(`UPDATE model_catalog SET provider = 'Grok' WHERE provider = 'xAI'`).run()
}


{
  const cols = db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'allowance_weight')) {
    db.exec('ALTER TABLE usage_events ADD COLUMN allowance_weight REAL NOT NULL DEFAULT 0')
  }
  if (!cols.some((column) => column.name === 'cost_tokens')) {
    db.exec('ALTER TABLE usage_events ADD COLUMN cost_tokens INTEGER NOT NULL DEFAULT 0')
    db.exec(`UPDATE usage_events SET cost_tokens = CAST(cost_cents AS INTEGER) * 40000`)
  }
}

{
  const cols = db.prepare('PRAGMA table_info(balance_transactions)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'amount_tokens')) {
    db.exec('ALTER TABLE balance_transactions ADD COLUMN amount_tokens INTEGER NOT NULL DEFAULT 0')
    db.exec(`UPDATE balance_transactions SET amount_tokens = CAST(amount_cents AS INTEGER) * 40000`)
  }
}

export function nextUserDisplayId() {
  const row = db.prepare(`SELECT COALESCE(MAX(display_id), 0) + 1 AS n FROM users`).get() as { n: number }
  return row.n
}

db.exec(`
  CREATE TABLE IF NOT EXISTS email_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_codes_lookup
    ON email_codes (email, purpose, created_at);
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_emails (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT 'multiaccount',
    created_at TEXT NOT NULL
  );
  DROP TABLE IF EXISTS signup_ip_claims;
  DROP TABLE IF EXISTS request_ip_accounts;
`)


const apiKeyColumns = db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>
const apiKeyColumnNames = new Set(apiKeyColumns.map((column) => column.name))
if (!apiKeyColumnNames.has('secret_hash')) {
  db.exec('ALTER TABLE api_keys ADD COLUMN secret_hash TEXT')
}
if (!apiKeyColumnNames.has('secret')) {
  db.exec('ALTER TABLE api_keys ADD COLUMN secret TEXT')
}
if (!apiKeyColumnNames.has('spend_limit_cents')) {
  db.exec('ALTER TABLE api_keys ADD COLUMN spend_limit_cents INTEGER')
}
if (!apiKeyColumnNames.has('spent_cents')) {
  db.exec('ALTER TABLE api_keys ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0')
}

{
  const cols = db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'spent_tokens')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN spent_tokens INTEGER NOT NULL DEFAULT 0')
    db.exec(`UPDATE api_keys SET spent_tokens = CAST(COALESCE(spent_cents, 0) AS INTEGER) * 40000`)
  }
  if (!cols.some((column) => column.name === 'spend_limit_tokens')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN spend_limit_tokens INTEGER')
    db.exec(
      `UPDATE api_keys SET spend_limit_tokens = CAST(spend_limit_cents AS INTEGER) * 40000
       WHERE spend_limit_cents IS NOT NULL`,
    )
  }
  if (!cols.some((column) => column.name === 'reserved_tokens')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0')
  }
}

// Pre-authorization holds for concurrent LLM (and future tool) billing.
db.exec(`
  CREATE TABLE IF NOT EXISTS token_reservations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    model_id TEXT,
    path TEXT,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    charged_tokens INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_token_reservations_user_open
    ON token_reservations (user_id, status);
  CREATE INDEX IF NOT EXISTS idx_token_reservations_key_open
    ON token_reservations (api_key_id, status);
  CREATE INDEX IF NOT EXISTS idx_token_reservations_expires
    ON token_reservations (status, expires_at);
`)

// Model/tool usage analytics scan by time window and group by model.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events (created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_events_created_user ON usage_events (created_at, user_id);
  CREATE INDEX IF NOT EXISTS idx_usage_events_api_key ON usage_events (api_key_id);
  CREATE INDEX IF NOT EXISTS idx_usage_events_model_created ON usage_events (model_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events (user_id, created_at);
`)

// Keep usage model ids after catalog deletes (historical activity labels).
const usageFk = db.prepare(`PRAGMA foreign_key_list(usage_events)`).all() as Array<{ table: string; from: string }>
if (usageFk.some((fk) => fk.table === 'model_catalog' && fk.from === 'model_id')) {
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE usage_events__mig (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
      model_id TEXT,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_cents INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO usage_events__mig
      (id, user_id, api_key_id, model_id, provider, input_tokens, output_tokens, cost_cents, latency_ms, status, created_at)
    SELECT id, user_id, api_key_id, model_id, provider, input_tokens, output_tokens, cost_cents, latency_ms, status, created_at
    FROM usage_events;
    DROP TABLE usage_events;
    ALTER TABLE usage_events__mig RENAME TO usage_events;
  `)
  db.pragma('foreign_keys = ON')
}

const modelColumns = db.prepare('PRAGMA table_info(model_catalog)').all() as Array<{ name: string }>
if (!modelColumns.some((column) => column.name === 'upstream_id')) {
  db.exec('ALTER TABLE model_catalog ADD COLUMN upstream_id TEXT')
  db.exec('UPDATE model_catalog SET upstream_id = id WHERE upstream_id IS NULL')
}
if (!modelColumns.some((column) => column.name === 'upstream_provider')) {
  db.exec(`ALTER TABLE model_catalog ADD COLUMN upstream_provider TEXT NOT NULL DEFAULT 'apinex'`)
}

// Up to five ordered upstream routes per public model: primary + four fallbacks.
db.exec(`
  CREATE TABLE IF NOT EXISTS model_upstream_routes (
    model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
    upstream_provider TEXT NOT NULL,
    upstream_id TEXT NOT NULL,
    PRIMARY KEY (model_id, position)
  );
  CREATE INDEX IF NOT EXISTS idx_model_upstream_routes_model ON model_upstream_routes(model_id, position);
`)

// If existing table had CHECK(position BETWEEN 1 AND 3), migrate to 1 AND 5
try {
  const schemaRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='model_upstream_routes'`).get() as { sql?: string } | undefined
  if (schemaRow?.sql && schemaRow.sql.includes('BETWEEN 1 AND 3')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE model_upstream_routes_v5 (
          model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
          upstream_provider TEXT NOT NULL,
          upstream_id TEXT NOT NULL,
          PRIMARY KEY (model_id, position)
        );
        INSERT INTO model_upstream_routes_v5 SELECT * FROM model_upstream_routes;
        DROP TABLE model_upstream_routes;
        ALTER TABLE model_upstream_routes_v5 RENAME TO model_upstream_routes;
        CREATE INDEX IF NOT EXISTS idx_model_upstream_routes_model ON model_upstream_routes(model_id, position);
      `)
    })()
  }
} catch (err) {
  console.error('[db] Error migrating model_upstream_routes CHECK constraint:', err)
}

try {
  db.exec(`
    DELETE FROM model_upstream_routes WHERE upstream_provider != 'apinex';
    UPDATE model_catalog SET upstream_provider = 'apinex' WHERE upstream_provider IS NOT NULL AND upstream_provider != 'apinex';
  `)
} catch (err) {
}

// Initialize default primary upstreams and routes only when not already set.
// User changes made via admin panel are preserved across restarts and deploys.
if (getSetting('model_routes_initialized_v2') !== '1') {
  const updateRoute = db.prepare(`
    UPDATE model_catalog
    SET upstream_provider = ?, upstream_id = ?
    WHERE id = ? AND (upstream_provider IS NULL OR upstream_provider = 'apinex')
  `)


  db.exec(`
    INSERT OR IGNORE INTO model_upstream_routes (model_id, position, upstream_provider, upstream_id)
    SELECT id, 1, COALESCE(upstream_provider, 'apinex'), COALESCE(upstream_id, id)
    FROM model_catalog;
  `)
  const setRoutes = db.transaction((modelId: string, primary: [string, string], fallbacks: Array<[string, string]>) => {
    const exists = db.prepare('SELECT 1 FROM model_catalog WHERE id = ?').get(modelId)
    if (!exists) return
    const upsert = db.prepare(`
      INSERT INTO model_upstream_routes (model_id, position, upstream_provider, upstream_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(model_id, position) DO NOTHING
    `)
    upsert.run(modelId, 1, primary[0], primary[1])
    fallbacks.forEach((route, index) => upsert.run(modelId, index + 2, route[0], route[1]))
  })
  setSetting('model_routes_initialized_v2', '1')
}


{
  const cols = db.prepare('PRAGMA table_info(provider_keys)').all() as Array<{ name: string }>
  const names = new Set(cols.map((c) => c.name))
  if (!names.has('provider')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN provider TEXT NOT NULL DEFAULT 'apinex'`)
  }
  if (!names.has('balance_usd_cents')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN balance_usd_cents INTEGER NOT NULL DEFAULT 0`)
  }
  if (!names.has('low_balance_notified_at')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN low_balance_notified_at TEXT`)
  }
  // Extra provider metadata stored as JSON.
  if (!names.has('meta_json')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'`)
  }
  if (!names.has('priority')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN priority INTEGER NOT NULL DEFAULT 100`)
  }
  if (!names.has('proxy_index')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN proxy_index INTEGER`)
  }
  try {
  } catch {}


  if (!names.has('low_balance_notified_json')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN low_balance_notified_json TEXT NOT NULL DEFAULT '{}'`)
  }
  // Permanent per-key marker: an exhausted upstream key must alert only once.
  if (!names.has('exhausted_notified_at')) {
    db.exec(`ALTER TABLE provider_keys ADD COLUMN exhausted_notified_at TEXT`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys (provider)`)
  db.exec(`UPDATE provider_keys SET provider = 'apinex' WHERE provider IS NULL OR provider = ''`)
}


// Customer sessions persist until logout. Rewrite only rows that still have an old expiry,
// otherwise every boot rewrites the whole table and delays listen on the production DB.
db.prepare(
  `UPDATE user_sessions
   SET expires_at = '9999-12-31T23:59:59.000Z'
   WHERE expires_at IS NULL OR expires_at < '9999-12-31T23:59:59.000Z'`,
).run()

export function nowIso() {
  return new Date().toISOString()
}

export function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

const DEFAULT_MIN_TOPUP_CENTS = 100

export function getSetting(key: string, fallback = '') {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? fallback
}

export function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso())
}

if (!getSetting('min_topup_cents')) {
  setSetting('min_topup_cents', String(DEFAULT_MIN_TOPUP_CENTS))
}

// Retail pricing moved from $0.05 to $0.25 per 1M tokens at weight 1. The
// token unit therefore changes from 20M to 4M per USD. Preserve the USD value
// of existing wallets, API limits, and in-flight holds exactly once.
if (getSetting('token_unit_4m_per_usd_v1') !== '1') {
  db.transaction(() => {
    const scale = (table: string, column: string, where = '') => {
      db.exec(`UPDATE ${table} SET ${column} = CAST(ROUND(COALESCE(${column}, 0) / 5.0) AS INTEGER)${where}`)
    }
    scale('users', 'balance_tokens')
    scale('users', 'reserved_tokens')
    const userColumns = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((row) => row.name))
    if (userColumns.has('restricted_tokens')) scale('users', 'restricted_tokens')
    scale('api_keys', 'spent_tokens')
    scale('api_keys', 'reserved_tokens')
    scale('api_keys', 'spend_limit_tokens', ' WHERE spend_limit_tokens IS NOT NULL')
    scale('token_reservations', 'reserved_tokens')
    scale('token_reservations', 'charged_tokens')
    const reservationColumns = new Set((db.prepare('PRAGMA table_info(token_reservations)').all() as Array<{ name: string }>).map((row) => row.name))
    if (reservationColumns.has('reserved_restricted_tokens')) scale('token_reservations', 'reserved_restricted_tokens')

    setSetting('token_unit_4m_per_usd_v1', '1')
  })()
}

// Wallet unit is now $1 = 1,000,000 ledger units. The previous unit was
// 4,000,000 tokens per dollar, so every dollar-denominated integer is divided
// by 4 exactly once. Free-allowance and extra-token counters are raw tokens
// and are intentionally left alone. Paid model prices move out of token_weight
// into input/output_price_micros ($ per 1M tokens).
if (getSetting('wallet_micros_per_usd_v1') !== '1') {
  db.transaction(() => {
    const tableExists = (table: string) =>
      Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table))
    const scale = (table: string, column: string, where = '') => {
      if (!tableExists(table)) return
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some((row) => row.name === column)) return
      db.exec(`UPDATE ${table} SET ${column} = CAST(ROUND(COALESCE(${column}, 0) / 4.0) AS INTEGER)${where}`)
    }
    scale('users', 'balance_tokens')
    scale('users', 'reserved_tokens')
    scale('users', 'restricted_tokens')
    scale('api_keys', 'spent_tokens')
    scale('api_keys', 'reserved_tokens')
    scale('api_keys', 'spend_limit_tokens', ' WHERE spend_limit_tokens IS NOT NULL')
    scale('token_reservations', 'reserved_tokens')
    scale('token_reservations', 'reserved_restricted_tokens')
    scale('token_reservations', 'charged_tokens')
    scale('balance_transactions', 'amount_tokens')
    scale('usage_events', 'cost_tokens')
    scale('referral_rewards', 'referrer_tokens')
    scale('referral_rewards', 'referee_tokens')
    // Balance promos only. extra_tokens redemptions store a raw token grant, not wallet units.
    scale('promo_codes', 'reward_tokens', ` WHERE COALESCE(type, 'balance') = 'balance'`)
    if (tableExists('promo_redemptions') && tableExists('promo_codes')) {
      db.exec(`
        UPDATE promo_redemptions
        SET tokens = CAST(ROUND(COALESCE(tokens, 0) / 4.0) AS INTEGER)
        WHERE promo_id IN (SELECT id FROM promo_codes WHERE COALESCE(type, 'balance') = 'balance')
      `)
    }

    const catalogCols = db.prepare('PRAGMA table_info(model_catalog)').all() as Array<{ name: string }>
    if (catalogCols.some((column) => column.name === 'token_weight')) {
      db.exec(`
        UPDATE model_catalog
        SET input_price_micros = CAST(ROUND(COALESCE(token_weight, 1) * 250000) AS INTEGER),
            output_price_micros = CAST(ROUND(COALESCE(token_weight, 1) * 250000) AS INTEGER)
        WHERE lower(provider) != 'free'
          AND id NOT LIKE 'free/%'
          AND COALESCE(token_weight, 0) > 0
      `)
      db.exec(`
        UPDATE model_catalog
        SET token_weight = 0,
            input_price_micros = 0,
            output_price_micros = 0
        WHERE lower(provider) = 'free' OR id LIKE 'free/%'
      `)
    }
    setSetting('wallet_micros_per_usd_v1', '1')
  })()
}

if (getSetting('model_catalog_global_order') !== '1') {
  const featuredRow =
    (db.prepare(`SELECT id FROM model_catalog WHERE id = 'grok/4.6'`).get() as { id: string } | undefined) ??
    (db.prepare(`SELECT id FROM model_catalog WHERE id = 'grok/4.20'`).get() as { id: string } | undefined)
  const rest = db
    .prepare(
      `SELECT id FROM model_catalog
       WHERE id != ?
       ORDER BY COALESCE(sort_order, 0) ASC, name ASC`,
    )
    .all(featuredRow?.id ?? '') as Array<{ id: string }>
  const ordered = featuredRow ? [featuredRow, ...rest] : rest
  const update = db.prepare(`UPDATE model_catalog SET sort_order = ? WHERE id = ?`)
  db.transaction(() => {
    ordered.forEach((row, index) => update.run((index + 1) * 10, row.id))
  })()
  setSetting('model_catalog_global_order', '1')
}

// Migrate paid models from 'provider/model' to 'provider-model' (e.g. gpt/6-astra -> gpt-6-astra).
// Free models ('free/...') remain unchanged.
const slashPaidModels = db
  .prepare(`SELECT id FROM model_catalog WHERE provider != 'Free' AND id LIKE '%/%'`)
  .all() as Array<{ id: string }>

if (slashPaidModels.length > 0) {
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    for (const { id } of slashPaidModels) {
      const newId = id.replace('/', '-')
      db.prepare(`UPDATE OR IGNORE model_catalog SET id = ? WHERE id = ?`).run(newId, id)
      db.prepare(`UPDATE OR IGNORE model_upstream_routes SET model_id = ? WHERE model_id = ?`).run(newId, id)
      db.prepare(`UPDATE OR IGNORE pricing_rules SET model_id = ? WHERE model_id = ?`).run(newId, id)
      db.prepare(`DELETE FROM model_catalog WHERE id = ?`).run(id)
    }
  })()
  db.pragma('foreign_keys = ON')
}

export function getMinTopupCents() {
  const raw = Number(getSetting('min_topup_cents', String(DEFAULT_MIN_TOPUP_CENTS)))
  if (!Number.isFinite(raw) || raw < 100) return DEFAULT_MIN_TOPUP_CENTS
  return Math.round(raw)
}

export function touchUserLastSeen(userId: string) {
  if (!userId) return
  try {
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowIso(), userId)
  } catch {
    /* ignore */
  }
}
