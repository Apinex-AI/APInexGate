import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { SpendChart } from '../components/SpendChart'
import { useCustomer } from '../auth/CustomerContext'
import { userApi, type CustomerStats } from '../auth/userApi'
import { formatFullTokenCount, formatTokenCount, formatUsdBalance, formatUsdExact, formatUsdFromTokens } from '../../shared/billing'
import { apiBase, siteName } from '../lib/brand'
import './Dashboard.css'

type SnippetLang = 'curl' | 'Python' | 'JavaScript' | 'TypeScript'

const RECENT_PAGE = 5

export function Dashboard() {
  const { toast } = useToast()
  const { user, refresh } = useCustomer()
  const location = useLocation()
  const [stats, setStats] = useState<CustomerStats | null>(null)
  const [lang, setLang] = useState<SnippetLang>('curl')
  const [recentVisible, setRecentVisible] = useState(RECENT_PAGE)
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false)
  const [copiedSnippet, setCopiedSnippet] = useState(false)
  const [promoOpen, setPromoOpen] = useState(false)
  const [promoCode, setPromoCode] = useState('')
  const [promoBusy, setPromoBusy] = useState(false)

  function loadRewards() {
    return userApi
      .rewards()
      .then(() => undefined)
      .catch(() => undefined)
  }

  useEffect(() => {
    let cancelled = false
    void refresh().catch(() => undefined)
    userApi
      .stats()
      .then((data) => {
        if (!cancelled) {
          setStats(data)
          setRecentVisible(RECENT_PAGE)
        }
      })
      .catch(() => undefined)
    void loadRewards()
    return () => {
      cancelled = true
    }
  }, [location.key, refresh])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const tab = params.get('tab')?.toLowerCase()
    if (
      tab === 'promo' ||
      params.get('promo') === '1' ||
      params.get('promo') === 'true' ||
      location.hash === '#promo'
    ) {
      setPromoOpen(true)
      const codeParam = params.get('code')
      if (codeParam) {
        setPromoCode(codeParam.toUpperCase())
      }
    }
  }, [location.search, location.hash])

  async function redeemPromo() {
    const code = promoCode.trim()
    if (!code) {
      toast('Enter a promo code', 'error')
      return
    }
    setPromoBusy(true)
    try {
      const data = await userApi.redeemPromo({ code })
      if (data.type === 'topup_bonus') {
        toast(`+${data.bonusPercent ?? ''}% bonus active`)
      } else if (data.type === 'free_reset') {
        toast('Daily free credit limit reset')
      } else if (data.type === 'subscription_offer') {
        toast(`${data.planLabel ?? 'Subscriptions discount'} is active`)
      } else if (data.type === 'subscription' || data.planLabel) {
        toast(`${data.planLabel ?? 'Promo'} unlocked`)
      } else {
        toast(`+${formatUsdExact(data.usd)} added to your balance`)
      }
      setPromoOpen(false)
      setPromoCode('')
      if (data.freeTier) {
        setStats((prev) => (prev ? { ...prev, freeTier: data.freeTier! } : prev))
      }
      if (data.user) {
        void refresh(data.user)
      } else {
        void refresh()
      }
      void userApi.stats().then((s) => setStats(s)).catch(() => undefined)
      void loadRewards()
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Could not redeem promo', 'error')
    } finally {
      setPromoBusy(false)
    }
  }

  const freeTier = stats?.freeTier ?? null
  const freeTierPaid = Boolean(freeTier && freeTier.mode === 'subscription')
  const freeTierPlanLabel = freeTier ? (freeTier.mode === 'free' ? 'FREE' : (freeTier.planLabel || 'Subscription')) : '—'
  const freeTierPercent =
    freeTier && !freeTier.unlimited && (freeTier.limit ?? 0) > 0
      ? Math.min(100, Math.round((freeTier.used / (freeTier.limit ?? 1)) * 100))
      : 0
  const freeTierBarTone =
    freeTierPercent >= 90 ? 'is-danger' : freeTierPercent >= 70 ? 'is-warn' : ''

  const recentAll = stats?.recent ?? []
  const hasRecent = recentAll.length > 0
  const recentShown = recentAll.slice(0, recentVisible)

  const hasKey = (stats?.activeKeys ?? 0) > 0
  const hasTopup = Boolean(stats?.hasTopup)
  const hasUsage = (stats?.requestsTotal ?? 0) > 0
  const onboardingSteps = [
    {
      id: 'key',
      title: 'Create API key',
      done: hasKey,
      to: '/keys' as string | null,
      action: undefined as undefined | (() => void),
    },
    {
      id: 'topup',
      title: 'Top up balance',
      done: hasTopup || user.balanceTokens > 5_000_000,
      to: '/billing' as string | null,
      action: undefined as undefined | (() => void),
    },
    {
      id: 'request',
      title: 'First request',
      done: hasUsage,
      to: '/setup' as string | null,
      action: undefined as undefined | (() => void),
    },
  ]
  const onboardingDone = onboardingSteps.filter((step) => step.done).length
  const onboardingComplete = onboardingDone === onboardingSteps.length

  return (
    <div className="page dashboard dashboard-v2">
      {/* 1. Futuristic Mission Control Header */}
      <header className="ov-header">
        <div className="ov-header-main">
          <div className="ov-title-wrap">
            <h1 className="ov-title">Workspace Overview</h1>
            <p className="ov-subtitle">
              Universal OpenAI-compatible API gateway · One key for GPT, Claude, Gemini, DeepSeek, Grok & open weights.
            </p>
          </div>
        </div>

        <div className="ov-header-actions">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(apiBase())
              toast('Base URL copied')
              setCopiedBaseUrl(true)
              setTimeout(() => setCopiedBaseUrl(false), 1800)
            }}
          >
            {copiedBaseUrl ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.8">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            <span style={copiedBaseUrl ? { color: '#34d399' } : undefined}>
              {copiedBaseUrl ? 'Base URL Copied!' : 'Copy Base URL'}
            </span>
          </button>

          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => {
              setPromoOpen(true)
              const params = new URLSearchParams(window.location.search)
              params.set('tab', 'promo')
              window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4" />
              <path d="M4 6v12c0 1.1.9 2 2 2h14v-4" />
              <path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z" />
            </svg>
            <span>Redeem Voucher</span>
          </button>

          <Link to="/keys" className="btn btn-primary btn-sm">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Create API Key</span>
          </Link>
        </div>
      </header>

      {/* 2. Onboarding Tracker (if incomplete) as Sleek Studio Banner */}
      {!onboardingComplete ? (
        <section className="ov-onboard-strip" aria-label="Setup guide">
          <div className="ov-onboard-strip-header">
            <div className="ov-onboard-strip-info">
              <span className="ov-micro-tag">Activation Checklist</span>
              <div className="ov-onboard-strip-title-row">
                <h3>Workspace Quick Start</h3>
                <span className="ov-onboard-pill">{onboardingDone} of {onboardingSteps.length} complete</span>
              </div>
            </div>
            <div className="ov-onboard-progress-ring-wrap">
              <div
                className="ov-onboard-strip-fill"
                style={{ width: `${(onboardingDone / onboardingSteps.length) * 100}%` }}
              />
            </div>
          </div>

          <div className="ov-onboard-steps-grid">
            {onboardingSteps.map((step, idx) => {
              const content = (
                <div className="ov-onboard-step-card-inner">
                  <div className="ov-onboard-step-num-col">
                    <span className={`ov-onboard-step-badge ${step.done ? 'is-done' : ''}`}>
                      {step.done ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        `0${idx + 1}`
                      )}
                    </span>
                  </div>
                  <div className="ov-onboard-step-text-col">
                    <strong className="ov-onboard-step-name">{step.title}</strong>
                    <span className="ov-onboard-step-status">
                      {step.done ? 'Completed' : 'Action required →'}
                    </span>
                  </div>
                </div>
              )

              if (step.done) {
                return (
                  <div key={step.id} className="ov-onboard-step-card is-done">
                    {content}
                  </div>
                )
              }

              if (step.to) {
                return (
                  <Link key={step.id} to={step.to} className="ov-onboard-step-card">
                    {content}
                  </Link>
                )
              }

              return (
                <button
                  key={step.id}
                  type="button"
                  className="ov-onboard-step-card"
                  onClick={() => step.action?.()}
                >
                  {content}
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* 3. Asymmetric Studio Layout (Left Core: Wallet HUD + Quick Snippet, Right Core: Live Telemetry + Ingress Stream) */}
      <div className="ov-studio-deck">
        {/* LEFT COLUMN: Operations & Integration */}
        <div className="ov-deck-col ov-deck-left">
          {/* Unified Wallet & Quota HUD Cockpit */}
          <section className="ov-card ov-cockpit-card">
            <div className="ov-cockpit-glow" aria-hidden />

            <div className="ov-cockpit-top">
              <div className="ov-cockpit-balance-block">
                <div className="ov-cockpit-label-row">
                  <span className="ov-micro-tag">Universal Account Balance</span>
                </div>
                <div className="ov-cockpit-figure-row">
                  <strong className="ov-cockpit-balance-val">{formatUsdBalance(user.balanceTokens)}</strong>
                  <Link to="/billing" className="btn btn-primary ov-btn-topup-accent">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span>Top up</span>
                  </Link>
                </div>
                <p className="ov-cockpit-sub">Single pay-as-you-go balance for all commercial models & routing.</p>
              </div>
            </div>

            <div className="ov-cockpit-divider" />

            {/* Daily Free Tier or Subscription */}
            <div className="ov-cockpit-bottom">
              <div className="ov-cockpit-free-header">
                <div className="ov-cockpit-free-title">
                  <span className="ov-micro-tag ov-tag-accent">
                    {freeTierPaid ? 'Subscription' : 'Free Models Daily Pool'}
                  </span>
                  <span className={`badge ${freeTierPaid ? 'badge-green' : 'badge-muted'}`}>
                    {freeTierPlanLabel}
                  </span>
                </div>
                <Link to="/subscriptions" className="ov-cockpit-link">
                  {freeTierPaid ? 'Extend subscription' : 'Get a subscription'} →
                </Link>
              </div>

              {freeTier?.unlimited ? (
                <div className="ov-cockpit-unlimited">
                  <span className="ov-cockpit-unlimited-title">Unlimited Free Access Active</span>
                  <span className="ov-cockpit-unlimited-meta">
                    {formatFullTokenCount(freeTier.used)} free tokens processed this cycle
                  </span>
                </div>
              ) : (
                <div className="ov-cockpit-meter">
                  <div className="ov-cockpit-meter-row">
                    <div>
                      <small className="ov-meter-label">{freeTierPaid ? 'Remaining pool' : 'Remaining today'}</small>
                      <strong className="ov-meter-strong">
                        {freeTier ? formatFullTokenCount(freeTier.remaining ?? 0) : '—'}
                      </strong>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <small className="ov-meter-label">Consumption</small>
                      <span className="ov-meter-secondary">
                        {freeTier
                          ? `${formatFullTokenCount(freeTier.used)} / ${formatTokenCount(freeTier.limit ?? 0)}`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  {freeTier ? (
                    <div className="ov-cockpit-bar" role="progressbar" aria-valuenow={freeTierPercent}>
                      <div
                        className={`ov-cockpit-fill ${freeTierBarTone}`}
                        style={{ width: `${freeTierPercent}%` }}
                      />
                    </div>
                  ) : null}

                  <div className="ov-cockpit-reset-row">
                    <span>
                      {freeTier ? (
                        freeTier.mode === 'free'
                          ? 'Resets automatically at 00:00 UTC'
                          : 'Permanent pool · No expiration'
                      ) : (
                        'Loading limits…'
                      )}
                    </span>
                    <span>{freeTierPercent}% used</span>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Quick Integration Terminal (elevated) */}
          <section className="ov-card ov-terminal-card">
            <div className="ov-terminal-header">
              <div className="ov-terminal-title-group">
                <div className="ov-terminal-badge-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                </div>
                <div>
                  <h3 className="ov-terminal-heading">Quick Start Integration</h3>
                  <p className="ov-terminal-sub">OpenAI SDK compatible drop-in endpoint</p>
                </div>
              </div>

              <button
                className="ov-terminal-copy-btn"
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(quickStartSnippet(lang))
                  toast('Snippet copied')
                  setCopiedSnippet(true)
                  setTimeout(() => setCopiedSnippet(false), 1800)
                }}
              >
                {copiedSnippet ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.8">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
                <span style={copiedSnippet ? { color: '#34d399' } : undefined}>
                  {copiedSnippet ? 'Copied!' : 'Copy'}
                </span>
              </button>
            </div>

            <div className="ov-terminal-tabs" role="tablist">
              {SNIPPET_LANGS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  className={`ov-terminal-tab ${lang === item ? 'is-active' : ''}`}
                  aria-selected={lang === item}
                  onClick={() => setLang(item)}
                >
                  {item}
                </button>
              ))}
            </div>

            <div className="ov-terminal-codebox">
              <div className="ov-codebox-topbar">
                <div className="ov-codebox-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
                <span className="ov-codebox-file">
                  {lang === 'curl' ? 'request.sh' : lang === 'Python' ? 'main.py' : lang === 'TypeScript' ? 'index.ts' : 'index.js'}
                </span>
                <span className="ov-codebox-model">{QUICK_START_MODEL}</span>
              </div>
              <pre className="ov-codebox-pre">
                <code>{quickStartSnippet(lang)}</code>
              </pre>
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: Live Telemetry & Event Ingress Stream */}
        <div className="ov-deck-col ov-deck-right">
          {/* Usage Dynamics & 7-Day Curve */}
          <section className="ov-card ov-telemetry-card">
            <div className="ov-telemetry-header">
              <div className="ov-telemetry-title-block">
                <span className="ov-micro-tag">Usage Dynamics</span>
                <h3>7-Day Token Throughput</h3>
              </div>
              <Link to="/usage" className="ov-telemetry-link-btn">
                Analytics →
              </Link>
            </div>

            <div className="ov-telemetry-stat-pills">
              <div className="ov-telemetry-stat-pill">
                <small>Billed this month</small>
                <strong>{formatUsdFromTokens(stats?.spendMonthTokens ?? 0)}</strong>
              </div>
              <div className="ov-telemetry-stat-pill">
                <small>Total requests</small>
                <strong>{(stats?.requestsTotal ?? 0).toLocaleString()}</strong>
              </div>
              <div className="ov-telemetry-stat-pill">
                <small>Active keys</small>
                <strong>{stats?.activeKeys ?? 0}</strong>
              </div>
            </div>

            <div className="ov-telemetry-chart-wrap">
              <SpendChart
                points={stats?.weekly ?? []}
                emptyTitle="Telemetry Idle"
                emptyDescription="Waiting for inbound API requests. Spend velocity & curves will render here."
              />
            </div>
          </section>

          {/* Recent Requests Card */}
          <section className="ov-card ov-recent-card">
            <div className="ov-recent-header">
              <div className="ov-recent-title-group">
                <div className="ov-recent-icon" aria-hidden>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                </div>
                <div>
                  <h3>Recent Requests</h3>
                  <p>Latest completions through your keys</p>
                </div>
              </div>
              {hasRecent && (
                <span className="ov-recent-count">{recentAll.length} calls</span>
              )}
            </div>

            <div className="ov-recent-body">
              {hasRecent ? (
                <div
                  className="ov-recent-list"
                  onScroll={(event) => {
                    const el = event.currentTarget
                    if (el.scrollTop + el.clientHeight < el.scrollHeight - 24) return
                    setRecentVisible((prev) => Math.min(prev + RECENT_PAGE, recentAll.length))
                  }}
                >
                  {recentShown.map((item) => (
                    <div key={item.id} className="ov-recent-item">
                      <div className="ov-recent-main">
                        <div className="ov-recent-lead">
                          <span className={`ov-status-dot ${item.status === 'ok' ? 'is-ok' : 'is-err'}`} />
                          <strong className="ov-recent-model">
                            {item.modelId ?? item.provider ?? 'unknown model'}
                          </strong>
                        </div>
                        <div className="ov-recent-detail">
                          <span>{recentDetail(item)}</span>
                          <span className="ov-meta-dot">•</span>
                          <span>{item.provider}</span>
                        </div>
                      </div>

                      <div className="ov-recent-meta">
                        <strong className="ov-recent-cost">{recentCharge(item)}</strong>
                        <time className="ov-recent-time">{formatRelative(item.createdAt)}</time>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ov-recent-empty">
                  <div className="ov-recent-empty-icon" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <strong>No requests yet</strong>
                  <p>Create an API key and send a request to see activity here.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Promo Redeem Modal */}
      <Modal
        open={promoOpen}
        title="Redeem Promo Code"
        description="Enter a promo code or gift voucher to credit tokens to your workspace balance."
        onClose={() => {
          setPromoOpen(false)
          const params = new URLSearchParams(window.location.search)
          if (params.get('tab') === 'promo' || params.has('promo') || params.has('code')) {
            params.delete('tab')
            params.delete('promo')
            params.delete('code')
            const nextQuery = params.toString() ? `?${params.toString()}` : ''
            window.history.replaceState(
              null,
              '',
              `${window.location.pathname}${nextQuery}${window.location.hash === '#promo' ? '' : window.location.hash}`,
            )
          }
        }}
      >
        <div className="rewards-modal rewards-redeem-modal">
          <label className="rewards-link-field">
            <span>Promo code</span>
            <input
              className="input"
              value={promoCode}
              onChange={(event) => setPromoCode(event.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              maxLength={24}
              autoComplete="off"
            />
          </label>
          <button
            className="btn btn-primary rewards-submit-btn"
            type="button"
            disabled={promoBusy}
            onClick={() => void redeemPromo()}
          >
            {promoBusy ? 'Redeeming…' : 'Submit Code'}
          </button>
        </div>
      </Modal>
    </div>
  )
}

function recentCharge(item: { modelId: string | null; provider: string; costTokens: number; inputTokens: number; outputTokens: number }) {
  const id = (item.modelId ?? '').toLowerCase()
  const provider = item.provider.toLowerCase()
  const free = id.startsWith('free/') || provider === 'free'
  if (free) return formatTokenCount(item.costTokens > 0 ? item.costTokens : item.inputTokens + item.outputTokens)
  if (item.costTokens > 0) return formatUsdFromTokens(item.costTokens)
  return formatTokenCount(item.inputTokens + item.outputTokens)
}

function recentDetail(item: { provider: string; costTokens: number; inputTokens: number; outputTokens: number; latencyMs: number }) {
  const charged = item.provider === 'media' || item.costTokens > 0
  if (charged) return `${item.latencyMs} ms`
  return `${(item.inputTokens + item.outputTokens).toLocaleString()} tokens · ${item.latencyMs} ms`
}

function formatRelative(value: string) {
  const diff = Date.now() - new Date(value).getTime()
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value))
}

const SNIPPET_LANGS: SnippetLang[] = ['curl', 'Python', 'JavaScript', 'TypeScript']

const QUICK_START_MODEL = 'free/glm-5.3-flash'
const QUICK_START_KEY_PLACEHOLDER = '$APINEX_API_KEY'

function quickStartSnippet(lang: SnippetLang) {
  const token = QUICK_START_KEY_PLACEHOLDER
  const snippets: Record<SnippetLang, string> = {
    curl: `curl ${apiBase()}/chat/completions \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${QUICK_START_MODEL}",
    "messages": [{"role": "user", "content": "Hello ${siteName()}"}]
  }'`,
    Python: `from openai import OpenAI

client = OpenAI(
    api_key="${token}",
    base_url="${apiBase()}",
)

res = client.chat.completions.create(
    model="${QUICK_START_MODEL}",
    messages=[{"role": "user", "content": "Hello ${siteName()}"}],
)
print(res.choices[0].message.content)`,
    JavaScript: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${token}",
  baseURL: "${apiBase()}",
});

const res = await client.chat.completions.create({
  model: "${QUICK_START_MODEL}",
  messages: [{ role: "user", content: "Hello ${siteName()}" }],
});

console.log(res.choices[0].message.content);`,
    TypeScript: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${token}",
  baseURL: "${apiBase()}",
});

const res = await client.chat.completions.create({
  model: "${QUICK_START_MODEL}",
  messages: [{ role: "user", content: "Hello ${siteName()}" }],
});

console.log(res.choices[0]?.message?.content);`,
  }
  return snippets[lang]
}
