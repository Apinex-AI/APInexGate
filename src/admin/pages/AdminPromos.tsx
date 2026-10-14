import { useEffect, useMemo, useState } from 'react'
import { adminApi, type AdminSubscriptionPlan } from '../api'
import type { PromoCodeRow, PromoType } from '../types'
import {
  AdminPageHeader,
  ConfirmModal,
  EmptyState,
  formatDate,
  SearchField,
  StatusBadge,
  useAdminMutation,
} from '../AdminShared'
import { formatTokenCount, formatUsdExact } from '../../../shared/billing'
import { DEFAULT_SUBSCRIPTION_PLANS } from '../../../shared/subscriptions'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toast'
import './AdminPages.css'

type PromoStatus = 'active' | 'disabled'

function toDatetimeLocal(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function AdminPromos() {
  const { toast } = useToast()
  const [promos, setPromos] = useState<PromoCodeRow[]>([])
  const [plans, setPlans] = useState<AdminSubscriptionPlan[]>(
    DEFAULT_SUBSCRIPTION_PLANS.map((p) => ({
      ...p,
      priceCents: p.priceCents,
    })),
  )
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<PromoCodeRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PromoCodeRow | null>(null)
  const [type, setType] = useState<PromoType>('balance')
  const [planKey, setPlanKey] = useState('day1')
  const [customTokenLimit, setCustomTokenLimit] = useState('500000000')
  const [customDays, setCustomDays] = useState('30')
  const [discountMode, setDiscountMode] = useState<'percent' | 'usd'>('percent')
  const [discountPercent, setDiscountPercent] = useState('20')
  const [discountUsd, setDiscountUsd] = useState('2.00')
  const [offerUnit, setOfferUnit] = useState<'hours' | 'days'>('hours')
  const [offerAmount, setOfferAmount] = useState('24')
  const [bonusTarget, setBonusTarget] = useState<'both' | 'subscription' | 'topup'>('both')
  const [bonusPercent, setBonusPercent] = useState('20')
  const [bonusDurationUnit, setBonusDurationUnit] = useState<'minutes' | 'hours'>('hours')
  const [bonusDurationValue, setBonusDurationValue] = useState('2')
  const [code, setCode] = useState('')
  const [rewardUsd, setRewardUsd] = useState('1.00')
  const [maxUses, setMaxUses] = useState('100')
  const [expiresEnabled, setExpiresEnabled] = useState(false)
  const [expiresLocal, setExpiresLocal] = useState('')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<PromoStatus>('active')

  const refresh = () => {
    void adminApi
      .promos()
      .then((data) => {
        setPromos(data.promos)
        if (data.plans && data.plans.length > 0) {
          setPlans(data.plans)
        }
      })
      .catch(() => undefined)
  }

  useEffect(refresh, [])
  const { run, busy } = useAdminMutation(refresh)

  const filtered = useMemo(
    () =>
      promos.filter((row) =>
        `${row.code} ${row.note} ${row.status} ${row.type} ${row.plan_label ?? ''} ${row.plan_key ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
      ),
    [promos, query],
  )

  function fillForm(row?: PromoCodeRow | null) {
    const t = row?.type ?? 'balance'
    setType(t)
    setPlanKey(row?.plan_key || plans[0]?.key || 'day1')
    setCustomDays(String(row?.custom_days ?? 30))
    setCustomTokenLimit(String(row?.custom_token_limit ?? 500000000))
    const dMode = row?.discount_mode === 'usd' ? 'usd' : 'percent'
    setDiscountMode(dMode)
    setDiscountPercent(String(dMode === 'percent' ? (row?.discount_value ?? 20) : 20))
    setDiscountUsd(dMode === 'usd' ? ((row?.discount_value ?? 200) / 100).toFixed(2) : '2.00')
    setOfferUnit(row?.offer_unit === 'days' ? 'days' : 'hours')
    setOfferAmount(String(row?.offer_amount ?? 24))
    setBonusTarget(row?.bonus_target ?? 'both')
    setBonusPercent(String(row?.bonus_percent ?? 20))
    setBonusDurationUnit(row?.bonus_duration_unit ?? 'hours')
    setBonusDurationValue(String(row?.bonus_duration_value ?? 2))
    setCode(row?.code ?? '')
    setRewardUsd(((row?.reward_cents ?? 100) / 100).toFixed(2))
    setMaxUses(String(row?.max_uses ?? 100))
    setExpiresEnabled(Boolean(row?.expires_at))
    setExpiresLocal(toDatetimeLocal(row?.expires_at ?? null))
    setNote(row?.note ?? '')
    setStatus(row?.status === 'disabled' ? 'disabled' : 'active')
  }

  function openCreate() {
    setEditing(null)
    fillForm(null)
    setEditorOpen(true)
  }

  function openEdit(row: PromoCodeRow) {
    setEditing(row)
    fillForm(row)
    setEditorOpen(true)
  }

  async function rollCode() {
    try {
      const data = await adminApi.generatePromoCode()
      setCode(data.code)
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Could not generate code', 'error')
    }
  }

  function copyPromoCode(promoCode: string) {
    void navigator.clipboard?.writeText(promoCode).then(
      () => toast('Promo code copied'),
      () => toast('Could not copy promo code', 'error'),
    )
  }

  function savePromo() {
    if (!code.trim()) {
      toast('Enter or generate a promo code', 'error')
      return
    }
    const uses = Math.round(Number(maxUses))
    if (!Number.isFinite(uses) || uses < 1) {
      toast('Max uses must be at least 1', 'error')
      return
    }

    const usd = Number(rewardUsd)
    let tokensNum: number | null = null

    if (type === 'balance') {
      if (!Number.isFinite(usd) || usd < 0.01) {
        toast('Reward must be at least $0.01', 'error')
        return
      }
    } else if (type === 'topup_bonus') {
      const pct = Math.floor(Number(bonusPercent))
      if (!Number.isFinite(pct) || pct < 1 || pct > 1000) {
        toast('Bonus percent must be between 1 and 1000%', 'error')
        return
      }
      const dur = Math.floor(Number(bonusDurationValue))
      if (!Number.isFinite(dur) || dur < 1) {
        toast('Duration must be at least 1', 'error')
        return
      }
    } else if (type === 'subscription_offer') {
      const amt = Math.floor(Number(offerAmount))
      if (!Number.isFinite(amt) || amt < 1) {
        toast('Offer duration must be at least 1', 'error')
        return
      }
      if (discountMode === 'percent') {
        const pct = Math.floor(Number(discountPercent))
        if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
          toast('Percent discount must be between 1 and 99%', 'error')
          return
        }
      } else {
        const dUsd = Number(discountUsd)
        if (!Number.isFinite(dUsd) || dUsd < 0.01) {
          toast('Dollar discount must be at least $0.01', 'error')
          return
        }
      }
    } else if (type === 'subscription_custom') {
      const raw = customTokenLimit.trim().toLowerCase().replace(/[, ]/g, '')
      const match = /^(\d+(?:\.\d+)?)([mb])?$/.exec(raw)
      const amount = match ? Number(match[1]) : Number.NaN
      tokensNum = !match
        ? Number.NaN
        : match[2] === 'b'
          ? Math.round(amount * 1_000_000_000)
          : match[2] === 'm'
            ? Math.round(amount * 1_000_000)
            : Math.round(amount)
      if (!Number.isFinite(tokensNum) || tokensNum < 1) {
        toast('Enter how many subscription tokens to grant', 'error')
        return
      }
    } else if (type === 'free_reset') {
      // No extra fields required for resetting daily free limit
    }

    let expiresAt: string | null = null
    if (expiresEnabled) {
      if (!expiresLocal) {
        toast('Pick an expiration datetime', 'error')
        return
      }
      expiresAt = new Date(expiresLocal).toISOString()
    }

    const body = {
      code: code.trim(),
      type,
      planKey: type === 'subscription' ? planKey : null,
      customDays: type === 'subscription_custom' ? Math.max(1, Math.floor(Number(customDays) || 30)) : null,
      customTokenLimit: type === 'subscription_custom' ? tokensNum : null,
      discountMode: type === 'subscription_offer' ? discountMode : null,
      discountUsd: type === 'subscription_offer' && discountMode === 'usd' ? Number(discountUsd) : null,
      discountPercent: type === 'subscription_offer' && discountMode === 'percent' ? Math.floor(Number(discountPercent)) : null,
      offerUnit: type === 'subscription_offer' ? offerUnit : null,
      offerAmount: type === 'subscription_offer' ? Math.floor(Number(offerAmount)) : null,
      bonusTarget: type === 'topup_bonus' ? bonusTarget : null,
      bonusPercent: type === 'topup_bonus' ? Math.floor(Number(bonusPercent)) : null,
      bonusDurationUnit: type === 'topup_bonus' ? bonusDurationUnit : null,
      bonusDurationValue: type === 'topup_bonus' ? Math.floor(Number(bonusDurationValue)) : null,
      rewardUsd: type === 'balance' ? usd : 0,
      maxUses: uses,
      expiresAt,
      note,
      status,
    }

    void run(async () => {
      if (editing) {
        await adminApi.updatePromo(editing.id, body)
      } else {
        await adminApi.createPromo(body)
      }
      setEditorOpen(false)
      setEditing(null)
    }, editing ? 'Promo updated' : 'Promo created')
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Promo Codes"
        description="Create redeemable Balance (USD) or Subscription codes for customers."
        actions={
          <>
            <SearchField value={query} onChange={setQuery} placeholder="Search promos…" />
            <button className="btn btn-primary" type="button" onClick={openCreate}>
              Create promo
            </button>
          </>
        }
      />

      <div className="admin-card admin-table-wrap">
        {filtered.length === 0 ? (
          <EmptyState title="No promo codes" description="Create a code to start handing out rewards or subscriptions." />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Type / Reward</th>
                <th>Uses</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      type="button"
                      className="admin-promo-code-btn"
                      title="Copy code"
                      onClick={() => copyPromoCode(row.code)}
                    >
                      <code>{row.code}</code>
                      {row.note ? <small>{row.note}</small> : null}
                    </button>
                  </td>
                  <td>
                    {row.type === 'subscription' ? (
                      <span className="admin-badge admin-badge-green" title={row.plan_key ?? ''}>
                        Sub · {row.plan_label || row.plan_key || 'Plan'}
                      </span>
                    ) : row.type === 'topup_bonus' ? (
                      <span
                        className="admin-badge admin-badge-green"
                        title={row.plan_label ?? `+${row.bonus_percent}%`}
                      >
                        Bonus · +{row.bonus_percent}% (
                        {row.bonus_target === 'subscription'
                          ? 'Subs'
                          : row.bonus_target === 'topup'
                            ? 'Top up'
                            : 'Both'}
                        ) · {row.bonus_duration_value} {row.bonus_duration_unit}
                      </span>
                    ) : row.type === 'subscription_offer' ? (
                      <span className="admin-badge admin-badge-warn" title={row.plan_label ?? ''}>
                        Subscription offer · {row.plan_label || 'Limited'}
                      </span>
                    ) : row.type === 'free_reset' ? (
                      <span className="admin-badge admin-badge-green" title="Resets daily free tokens used today to 0">
                        Free Limit Reset
                      </span>
                    ) : row.type === 'subscription_custom' ? (
                      <span
                        className="admin-badge admin-badge-purple"
                        title={`${row.custom_days ?? 1}d · ${formatTokenCount(row.custom_token_limit ?? 0)} tokens`}
                      >
                        Custom Sub · {row.custom_days ?? 1}d ({formatTokenCount(row.custom_token_limit ?? 0)})
                      </span>
                    ) : (
                      formatUsdExact(row.reward_cents / 100)
                    )}
                  </td>
                  <td>
                    {row.used_count} / {row.max_uses}
                  </td>
                  <td>
                    {row.status === 'redeemed' || row.used_count >= row.max_uses ? (
                      <span className="admin-badge admin-badge-purple">Redeemed</span>
                    ) : (
                      <StatusBadge value={row.status === 'disabled' ? 'disabled' : 'active'} />
                    )}
                  </td>
                  <td>{row.expires_at ? formatDate(row.expires_at) : '—'}</td>
                  <td>{formatDate(row.created_at)}</td>
                  <td>
                    <div className="admin-row-actions">
                      <button
                        className="btn btn-ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => openEdit(row)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => setDeleteTarget(row)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={editorOpen}
        title={editing ? 'Edit promo' : 'Create promo'}
        description="Codes are 8–16 alphanumeric characters. Customers redeem from Overview."
        onClose={() => {
          setEditorOpen(false)
          setEditing(null)
        }}
        footer={
          <>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setEditorOpen(false)
                setEditing(null)
              }}
            >
              Cancel
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={savePromo}>
              {editing ? 'Save' : 'Create'}
            </button>
          </>
        }
      >
        <div className="admin-form-grid">
          <label className="admin-field">
            <span>Type</span>
            <select
              className="input"
              value={type}
              onChange={(event) => setType(event.target.value as PromoType)}
            >
              <option value="balance">Balance (USD)</option>
              <option value="free_reset">Daily Free Limit Reset</option>
              <option value="topup_bonus">Top Up / Sub Bonus (+%)</option>
              <option value="subscription_offer">Subscription Discount (% or $ off)</option>
              <option value="subscription_custom">Subscription (Custom Days & Tokens)</option>
              <option value="subscription">Subscription (Preset Plan)</option>
            </select>
          </label>

          <label className="admin-field">
            <span>Code</span>
            <div className="admin-inline-row">
              <input
                className="input"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                maxLength={24}
              />
              <button
                className="btn btn-secondary admin-dice-btn"
                type="button"
                aria-label="Generate code"
                title="Generate code"
                onClick={() => void rollCode()}
              >
                🎲
              </button>
            </div>
          </label>

          {type === 'free_reset' ? (
            <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
              <div className="admin-callout admin-callout-info" style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.25)', color: 'var(--text-primary)' }}>
                <strong>Daily Free Limit Reset:</strong> Resets the customer&apos;s daily free tokens used today to 0. Free-tier RPM and free models remain completely unchanged (no subscription is granted).
              </div>
            </div>
          ) : type === 'balance' ? (
            <label className="admin-field">
              <span>Reward (USD)</span>
              <input
                className="input"
                inputMode="decimal"
                value={rewardUsd}
                onChange={(event) => setRewardUsd(event.target.value)}
              />
            </label>
          ) : type === 'topup_bonus' ? (
            <>
              <label className="admin-field">
                <span>Applies to</span>
                <select
                  className="input"
                  value={bonusTarget}
                  onChange={(event) =>
                    setBonusTarget(event.target.value as 'both' | 'subscription' | 'topup')
                  }
                >
                  <option value="both">Both (Top up & Subscription)</option>
                  <option value="subscription">Only Subscription</option>
                  <option value="topup">Only Top Up</option>
                </select>
                <span className="field-hint">Choose where the +% bonus gets added.</span>
              </label>
              <label className="admin-field">
                <span>Bonus percent (+%)</span>
                <div className="admin-inline-row">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1000}
                    value={bonusPercent}
                    onChange={(event) => setBonusPercent(event.target.value)}
                    placeholder="20"
                  />
                  <span style={{ fontSize: 14, fontWeight: 700, paddingRight: 4 }}>%</span>
                </div>
                <span className="field-hint">
                  e.g. 20 adds +20% balance on top up and/or +20% tokens on subscription.
                </span>
              </label>
              <label className="admin-field">
                <span>Duration</span>
                <div className="admin-inline-row">
                  <select
                    className="input"
                    value={bonusDurationUnit}
                    onChange={(event) =>
                      setBonusDurationUnit(event.target.value as 'minutes' | 'hours')
                    }
                  >
                    <option value="hours">Hours</option>
                    <option value="minutes">Minutes</option>
                  </select>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={bonusDurationValue}
                    onChange={(event) => setBonusDurationValue(event.target.value)}
                    placeholder="2"
                  />
                </div>
                <span className="field-hint">Bonus active period starts when the customer redeems the code.</span>
              </label>
            </>
          ) : type === 'subscription_custom' ? (
            <>
            <label className="admin-field">
              <span>Duration (days)</span>
              <input
                className="input"
                inputMode="numeric"
                value={customDays}
                onChange={(event) => setCustomDays(event.target.value)}
                placeholder="30"
              />
            </label>
            <label className="admin-field">
              <span>Subscription tokens</span>
              <input
                className="input"
                value={customTokenLimit}
                onChange={(event) => setCustomTokenLimit(event.target.value)}
                placeholder="500M"
              />
              <span className="field-hint">
                {Number(customTokenLimit) > 0
                  ? `Grants ${formatTokenCount(Number(customTokenLimit))} tokens`
                  : 'Use 500M, 1B, or a raw token count'}
              </span>
            </label>
            </>
          ) : type === 'subscription_offer' ? (
            <>
              <label className="admin-field">
                <span>Discount mode</span>
                <select
                  className="input"
                  value={discountMode}
                  onChange={(event) => setDiscountMode(event.target.value as 'percent' | 'usd')}
                >
                  <option value="percent">Percent (% off)</option>
                  <option value="usd">Fixed USD ($ off)</option>
                </select>
              </label>
              {discountMode === 'percent' ? (
                <label className="admin-field">
                  <span>Discount (%)</span>
                  <div className="admin-inline-row">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={99}
                      value={discountPercent}
                      onChange={(event) => setDiscountPercent(event.target.value)}
                      placeholder="20"
                    />
                    <span style={{ fontSize: 14, fontWeight: 700, paddingRight: 4 }}>%</span>
                  </div>
                </label>
              ) : (
                <label className="admin-field">
                  <span>Discount (USD)</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={discountUsd}
                    onChange={(event) => setDiscountUsd(event.target.value)}
                    placeholder="2.00"
                  />
                </label>
              )}
              <label className="admin-field">
                <span>Offer duration</span>
                <div className="admin-inline-row">
                  <select
                    className="input"
                    value={offerUnit}
                    onChange={(event) => setOfferUnit(event.target.value as 'hours' | 'days')}
                  >
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={offerAmount}
                    onChange={(event) => setOfferAmount(event.target.value)}
                    placeholder="24"
                  />
                </div>
              </label>
            </>
          ) : (
            <label className="admin-field">
              <span>Subscription Plan</span>
              <select
                className="input"
                value={planKey}
                onChange={(event) => setPlanKey(event.target.value)}
              >
                {plans.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label} · {p.kind === 'unlimited' ? 'Unlimited' : `${formatTokenCount(p.tokenLimit)} tokens`}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="admin-field">
            <span>Max uses</span>
            <input
              className="input"
              inputMode="numeric"
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
            />
          </label>

          <label className="admin-field">
            <span>Status</span>
            <select
              className="input"
              value={status}
              onChange={(event) => setStatus(event.target.value === 'disabled' ? 'disabled' : 'active')}
            >
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>

          <label className="admin-check">
            <input
              type="checkbox"
              checked={expiresEnabled}
              onChange={(event) => setExpiresEnabled(event.target.checked)}
            />
            Expiration
          </label>
          {expiresEnabled ? (
            <label className="admin-field">
              <span>Expires at</span>
              <input
                className="input"
                type="datetime-local"
                value={expiresLocal}
                onChange={(event) => setExpiresLocal(event.target.value)}
              />
            </label>
          ) : null}

          <label className="admin-field">
            <span>Note</span>
            <input
              className="input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Optional internal note"
            />
          </label>
        </div>
      </Modal>

      {deleteTarget ? (
        <ConfirmModal
          title="Delete promo?"
          description={`Delete ${deleteTarget.code}? Redemption history for this code will also be removed.`}
          confirmLabel="Delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.id
            setDeleteTarget(null)
            void run(() => adminApi.deletePromo(id), 'Promo deleted')
          }}
        />
      ) : null}
    </div>
  )
}
