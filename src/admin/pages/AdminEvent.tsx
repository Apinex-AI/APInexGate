import { useEffect, useMemo, useRef, useState } from 'react'
import { adminApi } from '../api'
import { AdminPageHeader } from '../AdminShared'
import { formatEventTokenLabel, formatFullTokenCount } from '../../../shared/billing'
import { useToast } from '../../components/Toast'
import './AdminPages.css'

type ModelRow = { modelId: string; discountPct: string }
type CatalogItem = { id: string; name: string; provider: string }

const PHASE_LABEL: Record<string, string> = {
  off: 'Not scheduled',
  upcoming: 'Starts later',
  live: 'Live',
  cooldown: 'Paused for 2 minutes',
  ended: 'Ended',
}

function utcInputValue(iso: string) {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function utcIsoFromInput(value: string) {
  if (!value) return ''
  const date = new Date(`${value}:00Z`)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function parseTokenInput(value: string) {
  const digits = value.replace(/[^\d]/g, '')
  if (!digits) return 0
  const n = Number(digits)
  return Number.isFinite(n) ? n : 0
}

function formatTokenInput(value: string) {
  const n = parseTokenInput(value)
  if (!n) return value.trim() === '' ? '' : '0'
  return formatFullTokenCount(n)
}

export function AdminEvent() {
  const { toast } = useToast()
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [phase, setPhase] = useState('off')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [tokenLimit, setTokenLimit] = useState('1,000,000')
  const [tokensUsed, setTokensUsed] = useState('0')
  const [minTopup, setMinTopup] = useState('5')
  const [models, setModels] = useState<ModelRow[]>([{ modelId: '', discountPct: '90' }])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'setup' | 'access'>('setup')
  const [grantEmail, setGrantEmail] = useState('')
  const [granting, setGranting] = useState(false)
  const usedDirty = useRef(false)
  const [liveUsed, setLiveUsed] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    adminApi
      .promoEvent()
      .then((data) => {
        if (cancelled) return
        setCatalog(data.catalog)
        setPhase(data.phase)
        if (data.event) {
          setStartsAt(utcInputValue(data.event.startsAt))
          setEndsAt(utcInputValue(data.event.endsAt))
          setTokenLimit(formatFullTokenCount(data.event.tokenLimit))
          setTokensUsed(formatFullTokenCount(data.event.tokensUsed))
          setLiveUsed(data.event.tokensUsed)
          usedDirty.current = false
          setMinTopup(String(data.event.minTopupUsd))
          setModels(
            data.event.models.length
              ? data.event.models.map((row) => ({ modelId: row.modelId, discountPct: String(row.discountPct) }))
              : [{ modelId: '', discountPct: '90' }],
          )
        }
      })
      .catch((error) => {
        toast(error instanceof Error ? error.message : 'Could not load the event', 'error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [toast])

  useEffect(() => {
    const timer = window.setInterval(() => {
      adminApi
        .promoEvent()
        .then((data) => {
          if (!data.event) return
          setLiveUsed(data.event.tokensUsed)
          setPhase(data.phase)
          if (!usedDirty.current) setTokensUsed(formatFullTokenCount(data.event.tokensUsed))
        })
        .catch(() => undefined)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])

  const limitN = parseTokenInput(tokenLimit)
  const usedN = parseTokenInput(tokensUsed)
  const remaining = Math.max(0, limitN - usedN)
  const limitPreview = useMemo(() => formatEventTokenLabel(limitN), [limitN])
  const usedPreview = useMemo(() => formatEventTokenLabel(usedN), [usedN])
  const groups = useMemo(() => {
    const byProvider = new Map<string, CatalogItem[]>()
    for (const model of catalog) {
      const list = byProvider.get(model.provider) ?? []
      list.push(model)
      byProvider.set(model.provider, list)
    }
    return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [catalog])
  const taken = new Set(models.map((row) => row.modelId).filter(Boolean))

  async function save() {
    setSaving(true)
    try {
      await adminApi.savePromoEvent({
        startsAt: utcIsoFromInput(startsAt),
        endsAt: utcIsoFromInput(endsAt),
        tokenLimit: limitN,
        tokensUsed: usedN,
        minTopupUsd: Number(minTopup),
        models: models.map((row) => ({ modelId: row.modelId, discountPct: Math.round(Number(row.discountPct)) })),
      })
      const fresh = await adminApi.promoEvent()
      setPhase(fresh.phase)
      if (fresh.event) {
        setLiveUsed(fresh.event.tokensUsed)
        setTokensUsed(formatFullTokenCount(fresh.event.tokensUsed))
        usedDirty.current = false
      }
      toast('Event saved')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save the event', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Event"
        description="One limited-time discount. Times are UTC. A balance top-up during the window unlocks the rates until the pool or the end time runs out."
      />

      <div className="event-tabs">
        <button className={`btn ${tab === 'setup' ? 'btn-primary' : 'btn-secondary'}`} type="button" onClick={() => setTab('setup')}>
          Event
        </button>
        <button className={`btn ${tab === 'access' ? 'btn-primary' : 'btn-secondary'}`} type="button" onClick={() => setTab('access')}>
          Grant access
        </button>
      </div>

      {tab === 'access' ? (
        <section className="admin-card event-admin">
          <div className="admin-card-header">
            <div>
              <h2>Grant discount access</h2>
              <p>The user can call discounted models. Their balance does not change.</p>
            </div>
          </div>
          <form
            className="event-grant"
            onSubmit={(event) => {
              event.preventDefault()
              setGranting(true)
              adminApi
                .grantPromoAccess(grantEmail)
                .then((result) => {
                  toast(`${result.email} can use the event discounts`)
                  setGrantEmail('')
                })
                .catch((error) => {
                  toast(error instanceof Error ? error.message : 'Could not grant access', 'error')
                })
                .finally(() => setGranting(false))
            }}
          >
            <label className="admin-field">
              User email
              <input
                className="input"
                type="email"
                required
                value={grantEmail}
                placeholder="user@email.com"
                onChange={(event) => setGrantEmail(event.target.value)}
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={granting || loading}>
              {granting ? 'Granting…' : 'Grant access'}
            </button>
          </form>
        </section>
      ) : (
      <>
      <section className="admin-card event-admin">
        <div className="admin-card-header">
          <div>
            <h2>Schedule and pool</h2>
            <p>The banner uses the short token preview. Uneven amounts stay fully written.</p>
          </div>
          <span className={`event-phase event-phase-${phase}`}>{loading ? 'Loading' : PHASE_LABEL[phase] || phase}</span>
        </div>

        <div className="event-stats">
          <div>
            <span>Remaining</span>
            <strong>{formatEventTokenLabel(remaining)}</strong>
            <small>{formatFullTokenCount(remaining)} tokens</small>
          </div>
          <div>
            <span>Pool</span>
            <strong>{limitPreview}</strong>
            <small>{usedPreview} used</small>
          </div>
          <div>
            <span>Unlock</span>
            <strong>${Number(minTopup || 0).toFixed(2)}+</strong>
            <small>balance top-up</small>
          </div>
        </div>

        <div className="event-grid">
          <label className="admin-field">
            Start
            <input className="input" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
            <small className="admin-hint">UTC</small>
          </label>
          <label className="admin-field">
            End
            <input className="input" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
            <small className="admin-hint">UTC</small>
          </label>
          <label className="admin-field">
            Token pool
            <input
              className="input"
              inputMode="numeric"
              value={tokenLimit}
              onChange={(event) => setTokenLimit(formatTokenInput(event.target.value))}
            />
            <small className="admin-hint">Shows as {limitPreview}</small>
          </label>
          <label className="admin-field">
            Already used
            <input
              className="input"
              inputMode="numeric"
              value={tokensUsed}
              onChange={(event) => {
                usedDirty.current = true
                setTokensUsed(formatTokenInput(event.target.value))
              }}
            />
            <small className="admin-hint">
              Live now {liveUsed == null ? '—' : formatFullTokenCount(liveUsed)}
              {liveUsed != null ? ` · ${formatEventTokenLabel(liveUsed)}` : ''}
            </small>
          </label>
          <label className="admin-field">
            Minimum top-up
            <input className="input" inputMode="decimal" value={minTopup} onChange={(event) => setMinTopup(event.target.value)} />
            <small className="admin-hint">USD on the balance, during the window</small>
          </label>
        </div>
      </section>

      <section className="admin-card event-admin">
        <div className="admin-card-header">
          <div>
            <h2>Discounted models</h2>
            <p>100% shows as FREE. Other rates strike the old price and charge the new one.</p>
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => setModels((current) => [...current, { modelId: '', discountPct: '90' }])}
          >
            Add model
          </button>
        </div>

        <div className="event-models">
          {models.map((row, index) => {
            const pct = Math.round(Number(row.discountPct))
            const label = !Number.isFinite(pct) ? '—' : pct >= 100 ? 'FREE' : `${pct}% off`
            return (
              <div className="event-model-row" key={index}>
                <label className="admin-field">
                  Model
                  <select
                    className="input"
                    value={row.modelId}
                    onChange={(event) =>
                      setModels((current) => current.map((item, i) => (i === index ? { ...item, modelId: event.target.value } : item)))
                    }
                  >
                    <option value="">Choose a model</option>
                    {groups.map(([provider, items]) => (
                      <optgroup key={provider} label={provider}>
                        {items.map((model) => (
                          <option key={model.id} value={model.id} disabled={taken.has(model.id) && model.id !== row.modelId}>
                            {model.name} · {model.id}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="admin-field event-discount">
                  Discount
                  <span className="event-discount-input">
                    <input
                      className="input"
                      inputMode="numeric"
                      aria-label="Discount percent"
                      value={row.discountPct}
                      onChange={(event) =>
                        setModels((current) =>
                          current.map((item, i) => (i === index ? { ...item, discountPct: event.target.value.replace(/[^\d]/g, '') } : item)),
                        )
                      }
                    />
                    <span>%</span>
                  </span>
                  <small className="admin-hint">{label}</small>
                </label>
                <button
                  className="btn btn-secondary event-remove"
                  type="button"
                  disabled={models.length === 1}
                  onClick={() => setModels((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>

        <div className="event-save">
          <button className="btn btn-primary" type="button" disabled={saving || loading} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save event'}
          </button>
        </div>
      </section>
      </>
      )}
    </div>
  )
}
