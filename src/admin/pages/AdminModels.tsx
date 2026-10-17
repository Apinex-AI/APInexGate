import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../components/Modal'
import { adminApi } from '../api'
import type { AdminModel, CatalogModelOption } from '../types'
import {
  AdminPageHeader,
  ConfirmModal,
  EmptyState,
  SearchField,
  StatusBadge,
  useAdminMutation,
} from '../AdminShared'
import { IconPencil, IconPlus, IconRefresh } from '../Icons'
import { ProviderIcon } from '../../components/ProviderIcon'
import { providerSlug } from '../../lib/providerStyle'
import {
  PROVIDER_ORDER,
  sortProviders,
  isUpstreamProvider,
  UPSTREAM_PROVIDER_LABELS,
  type UpstreamProvider,
} from '../../../shared/providers'
import './AdminPages.css'

const CATEGORIES = PROVIDER_ORDER
type UpstreamId = UpstreamProvider
type EditableRoute = { upstreamProvider: UpstreamId; upstreamId: string }

function suggestApiId(upstreamId: string) {
  const trimmed = upstreamId.trim()
  if (!trimmed.includes('/')) return trimmed
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function priceDraft(dollars: number) {
  if (!Number.isFinite(dollars) || dollars <= 0) return '0.00'
  const rounded = Math.round(dollars * 1000) / 1000
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function formatSplitPrice(model: AdminModel) {
  const input = Math.max(0, Number(model.input_price_micros) || 0) / 1_000_000
  const outputRaw = Math.max(0, Number(model.output_price_micros) || 0) / 1_000_000
  const isJev = model.provider === 'Jev Group' || /jev|drex|subq|decision/i.test(model.id)
  const output = outputRaw > 0 ? outputRaw : isJev ? 0 : input
  const label = (value: number) => {
    const milli = Math.round(value * 1000)
    return `$${milli % 10 !== 0 ? value.toFixed(3) : value.toFixed(2)}`
  }
  return `${label(input)} / ${label(output)}`
}

function upstreamProviderLabel(provider: string | null | undefined) {
  const value = provider?.trim() || 'apinex'
  return isUpstreamProvider(value) ? UPSTREAM_PROVIDER_LABELS[value] : value
}

export function AdminModels() {
  const [models, setModels] = useState<AdminModel[]>([])
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AdminModel | null>(null)
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('GPT')
  const [upstreamProvider, setUpstreamProvider] = useState<UpstreamId>('apinex')
  const [catalog, setCatalog] = useState<CatalogModelOption[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiId, setApiId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<AdminModel | null>(null)
  const [healthOverrideByModel, setHealthOverrideByModel] = useState<Record<string, 'live' | 'partial' | 'unavailable' | 'auto'>>({})
  const [priceTarget, setPriceTarget] = useState<AdminModel | null>(null)
  const [priceWeight, setPriceWeight] = useState('1')
  const [priceInput, setPriceInput] = useState('0.00')
  const [priceOutput, setPriceOutput] = useState('0.00')
  const [contextWindow, setContextWindow] = useState('')
  const [editRoutes, setEditRoutes] = useState<EditableRoute[]>([])
  const [activeRoute, setActiveRoute] = useState(0)
  const [statusRefreshing, setStatusRefreshing] = useState<Set<string>>(new Set())

  const refresh = () => {
    adminApi.models()
      .then((data) => {
        setModels(data.models)
        setHealthOverrideByModel(
          Object.fromEntries(
            data.models
              .filter((model) => model.healthOverride)
              .map((model) => [model.id, model.healthOverride as 'live' | 'partial' | 'unavailable']),
          ),
        )
      })
      .catch(() => undefined)
  }
  useEffect(refresh, [])
  const { run, busy } = useAdminMutation(refresh)

  async function refreshModelStatus(model: AdminModel) {
    setStatusRefreshing((prev) => new Set(prev).add(model.id))
    try {
      const result = await adminApi.refreshModelStatus(model.id)
      setModels((current) => current.map((item) => item.id === model.id ? { ...item, health: result.health, healthCheckedAt: result.healthCheckedAt } : item))
      // Keep the pinned override visible; only refresh the resolved status.
      setHealthOverrideByModel((prev) => ({ ...prev }))
    } catch (reason) {
      // Keep the current row status visible when a probe fails.
      console.warn(reason)
    } finally {
      setStatusRefreshing((prev) => {
        const next = new Set(prev)
        next.delete(model.id)
        return next
      })
    }
  }

  const filtered = useMemo(
    () =>
      models.filter(
        (model) =>
          `${model.name} ${model.id} ${model.upstream_id ?? ''} ${model.provider}`
            .toLowerCase()
            .includes(query.toLowerCase().trim()) &&
          (provider === 'all' || model.provider === provider),
      ),
    [models, query, provider],
  )

  const providers = sortProviders([...new Set(models.map((model) => model.provider))])
  const selected = catalog.find((item) => item.id === selectedModelId) ?? null
  const formOpen = createOpen || Boolean(editTarget)
  const editingFallback = Boolean(editTarget && activeRoute > 0)
  const activeRouteValue = editTarget ? editRoutes[activeRoute] : null

  function canMove(model: AdminModel, direction: 'up' | 'down') {
    if (query.trim()) return false
    const list = provider === 'all' ? models : models.filter((item) => item.provider === model.provider)
    const index = list.findIndex((item) => item.id === model.id)
    if (index < 0) return false
    return direction === 'up' ? index > 0 : index < list.length - 1
  }

  useEffect(() => {
    if (!formOpen) return
    let cancelled = false
    setCatalogLoading(true)
    setCatalogError('')
    setCatalog([])
    if (!editTarget) {
      setSelectedModelId('')
      setDisplayName('')
      setApiId('')
      setPriceWeight('1')
      setContextWindow('')
    }
    // Load the whole upstream model catalog without filtering, so any model can be selected.
    adminApi
      .catalogModels('Free', upstreamProvider)
      .then((data) => {
        if (cancelled) return
        const configuredId = activeRouteValue?.upstreamId
        setCatalog(
          configuredId && !data.models.some((model) => model.id === configuredId)
            ? [{ id: configuredId, name: configuredId, provider: category, contextWindow: '—', inputPrice: 0, outputPrice: 0 }, ...data.models]
            : data.models,
        )
      })
      .catch((reason) => {
        if (cancelled) return
        setCatalogError(reason instanceof Error ? reason.message : 'Unable to load models')
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeRoute, activeRouteValue?.upstreamId, category, formOpen, editTarget, upstreamProvider])

  async function saveModel() {
    if (!apiId.trim()) return
    const isFree = category === 'Free' || apiId.trim().startsWith('free/')
    const body = {
      id: apiId.trim(),
      upstreamId: selected?.id || editTarget?.upstream_id || apiId.trim(),
      upstreamProvider,
      name: displayName.trim() || selected?.name || editTarget?.name || apiId.trim(),
      provider: isFree ? 'Free' : category,
      contextWindow: contextWindow.trim() || '—',
      ...(isFree
        ? {
            inputPrice: 0,
            outputPrice: 0,
            tokenWeight: Number(priceWeight) > 0 ? Number(priceWeight) : (selected?.tokenWeight || 3),
          }
        : {
            inputPrice: selected?.inputPrice && selected.inputPrice > 0 ? selected.inputPrice : 0.1,
            outputPrice:
              selected?.outputPrice !== undefined && selected.outputPrice >= 0
                ? selected.outputPrice
                : category === 'Jev Group'
                  ? 0
                  : 0.1,
            tokenWeight: 0,
          }),
      ...(editTarget ? { upstreamRoutes: editRoutes.filter((route) => route.upstreamId) } : {}),
    }
    const ok = await run(
      () => editTarget ? adminApi.updateModel(editTarget.id, body) : adminApi.createModel(body),
      editTarget ? 'Model updated' : 'Model created',
    )
    if (!ok) return
    setCreateOpen(false)
    setEditTarget(null)
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Models"
        description={`${models.length} text models`}
        actions={
          <>
            <SearchField value={query} onChange={setQuery} placeholder="Search models…" />
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => adminApi.importApinexModels(),
                  'Imported all APInex models & pricing',
                )
              }
            >
              <IconRefresh size={15} />
              Import all APInex models
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                setEditTarget(null)
                setDisplayName('')
                setApiId('')
                setPriceWeight(provider.toLowerCase() === 'free' ? '3' : '1.00')
                setContextWindow('')
                setSelectedModelId('')
                setUpstreamProvider('apinex')
                setCategory(provider !== 'all' ? (provider as (typeof CATEGORIES)[number]) : 'GPT')
                setEditRoutes([{ upstreamProvider: 'apinex', upstreamId: '' }])
                setActiveRoute(0)
                setCreateOpen(true)
              }}
            >
              <IconPlus size={15} />
              Add model
            </button>
          </>
        }
      />

      <div className="admin-toolbar">
        <div className="admin-tabs">
          <button className={provider === 'all' ? 'is-active' : ''} type="button" onClick={() => setProvider('all')}>
            All
          </button>
          {providers.map((item) => (
            <button
              key={item}
              className={provider === item ? 'is-active' : ''}
              type="button"
              onClick={() => setProvider(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <span className="admin-result-count">{filtered.length}</span>
      </div>

      <div className="admin-card admin-table-wrap">
        {filtered.length === 0 ? (
            <EmptyState
              title={models.length === 0 ? 'No models yet' : 'No matches'}
              description={models.length === 0 ? 'Import the full APInex catalog in one click or add a single model.' : 'Try another filter.'}
              action={
                models.length === 0 ? (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => adminApi.importApinexModels(),
                          'Imported all APInex models & pricing',
                        )
                      }
                    >
                      Import all APInex models
                    </button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => setCreateOpen(true)}>
                      Add model
                    </button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th className="order-col">Order</th>
                  <th>Model</th>
                  <th>Category</th>
                  <th>Context</th>
                  <th>Input / Output $ / 1M</th>
                  <th>Status</th>
                  <th className="model-health-col">Health</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((model) => {
                  const slug = providerSlug(model.provider)
                  const upstream = model.upstream_id && model.upstream_id !== model.id ? model.upstream_id : null
                  return (
                    <tr key={model.id}>
                      <td className="order-col">
                        <div className="order-controls">
                          <button
                            className="btn btn-secondary btn-sm order-btn"
                            type="button"
                            aria-label="Move up"
                            disabled={busy || !canMove(model, 'up')}
                            onClick={() =>
                              void run(() => adminApi.reorderModel(model.id, 'up', provider === 'all' ? undefined : provider), 'Order updated')
                            }
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m18 15-6-6-6 6" />
                            </svg>
                          </button>
                          <button
                            className="btn btn-secondary btn-sm order-btn"
                            type="button"
                            aria-label="Move down"
                            disabled={busy || !canMove(model, 'down')}
                            onClick={() =>
                              void run(() => adminApi.reorderModel(model.id, 'down', provider === 'all' ? undefined : provider), 'Order updated')
                            }
                          >
                            ↓
                          </button>
                        </div>
                      </td>
                      <td>
                        <div className="table-person">
                          <span className={`provider-logo provider-${slug}`}>
                            <ProviderIcon provider={model.provider} modelId={model.id} size={22} />
                          </span>
                          <div>
                            <strong>{model.name}</strong>
                            <small className="table-code">{model.id}</small>
                            {upstream ? (
                              <small className="table-code muted-code model-source-line">
                                <span className="model-source-id">src {upstream}</span>
                                <span className="model-source-provider">({upstreamProviderLabel(model.upstream_provider)})</span>
                              </small>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`provider-label provider-${slug}`}>
                          <ProviderIcon provider={model.provider} modelId={model.id} size={14} />
                          {model.provider}
                        </span>
                      </td>
                      <td className="mono">{model.context_window}</td>
                      <td>
                        <div className="admin-model-price">
                          <div className="admin-model-price-text">
                            <strong className={`mono${model.provider === 'Free' ? ' admin-model-price-free' : ''}`}>
                              {model.provider === 'Free' ? 'FREE' : formatSplitPrice(model)}
                            </strong>
                          </div>
                          {model.provider === 'Free' ? null : (
                          <button
                            className="btn btn-ghost btn-sm admin-price-edit-btn"
                            type="button"
                            aria-label={`Edit price for ${model.name}`}
                            disabled={busy}
                            onClick={() => {
                              setPriceTarget(model)
                              const input = Math.max(0, Number(model.input_price_micros) || 0) / 1_000_000
                              const outputRaw = Math.max(0, Number(model.output_price_micros) || 0) / 1_000_000
                              const isJev = model.provider === 'Jev Group' || /jev|drex|subq|decision/i.test(model.id)
                              setPriceInput(priceDraft(input))
                              setPriceOutput(priceDraft(outputRaw > 0 ? outputRaw : isJev ? 0 : input))
                            }}
                          >
                            <IconPencil size={14} />
                          </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <StatusBadge value={model.status} />
                      </td>
                      <td className="model-health-cell">
                        <div className="model-health-control">
                          <select
                            className={`admin-mini-select model-health-select model-health-${model.health ?? 'no_data'}`}
                            value={healthOverrideByModel[model.id] ?? 'auto'}
                            disabled={busy}
                            aria-label={`Health status for ${model.name}`}
                            onChange={(event) => {
                              const value = event.target.value as 'auto' | 'live' | 'partial' | 'unavailable'
                              setHealthOverrideByModel((prev) => ({ ...prev, [model.id]: value }))
                              void run(
                                () => adminApi.setModelHealthStatus(model.id, value),
                                value === 'auto' ? 'Health set to automatic' : `Health pinned to ${value}`,
                              )
                            }}
                          >
                            <option value="auto">Auto</option>
                            <option value="live">Live</option>
                            <option value="partial">Partial</option>
                            <option value="unavailable">Down</option>
                          </select>
                          <button
                            className={`btn btn-ghost btn-sm model-health-refresh${statusRefreshing.has(model.id) ? ' is-loading' : ''}`}
                            type="button"
                            aria-label={`Refresh health for ${model.name}`}
                            title={`Refresh health for ${model.name}`}
                            disabled={busy || statusRefreshing.has(model.id)}
                            onClick={() => void refreshModelStatus(model)}
                          >
                            <IconRefresh size={14} />
                          </button>
                        </div>
                      </td>
                      <td className="table-actions">
                        <select
                          className="admin-mini-select"
                          value={model.status}
                          disabled={busy}
                          onChange={(event) =>
                            void run(
                              () => adminApi.updateModel(model.id, { status: event.target.value }),
                              'Updated',
                            )
                          }
                        >
                          <option value="active">Active</option>
                          <option value="paused">Paused</option>
                        </select>
                        <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => {
                          setEditTarget(model)
                          setCreateOpen(false)
                          setCategory(model.provider as (typeof CATEGORIES)[number])
                          const routes = model.upstream_routes?.length
                            ? model.upstream_routes.map((route) => ({ upstreamProvider: route.upstream_provider as UpstreamId, upstreamId: route.upstream_id }))
                            : [{ upstreamProvider: ((model.upstream_provider as UpstreamId) || 'apinex'), upstreamId: model.upstream_id || model.id }]
                          setEditRoutes(routes)
                          setActiveRoute(0)
                          setUpstreamProvider(routes[0].upstreamProvider)
                          setSelectedModelId(routes[0].upstreamId)
                          setApiId(model.id)
                          setDisplayName(model.name)
                          setPriceWeight(String(model.token_weight ?? model.inputMultiplier ?? 1))
                          setContextWindow(model.context_window || '')
                        }}>
                          <IconPencil size={14} /> Edit
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          type="button"
                          disabled={busy}
                          onClick={() => setDeleteTarget(model)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
      </div>

      <Modal
        open={formOpen}
        onClose={() => { setCreateOpen(false); setEditTarget(null) }}
        title={editTarget ? `Edit ${editTarget.name}` : 'Add model'}
        wide
        footer={
          <>
            <button className="btn btn-secondary" type="button" onClick={() => { setCreateOpen(false); setEditTarget(null) }}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || (!selected && !editTarget) || !apiId.trim() || catalogLoading}
              onClick={() => void saveModel()}
            >
              Save model
            </button>
          </>
        }
      >
        <div className="form-stack">
          {!editingFallback ? (
            <div className="field">
              <label htmlFor="model-category">Public family</label>
              <select
                id="model-category"
                className="select"
                value={category}
                onChange={(event) => setCategory(event.target.value as (typeof CATEGORIES)[number])}
              >
                {CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="model-pick">Provider model</label>
            <select
              id="model-pick"
              className="select"
              value={selectedModelId}
              disabled={catalogLoading || !!catalogError || catalog.length === 0}
              onChange={(event) => {
                const next = event.target.value
                setSelectedModelId(next)
                const match = catalog.find((item) => item.id === next)
                if (editTarget) {
                  setEditRoutes((routes) => {
                    const nextRoutes = routes.slice()
                    nextRoutes[activeRoute] = { upstreamProvider, upstreamId: next }
                    return nextRoutes
                  })
                } else {
                  setDisplayName(match?.name ?? '')
                  setApiId(match ? (match.id.startsWith('free/') ? match.id : suggestApiId(match.id)) : '')
                  if (match?.contextWindow) setContextWindow(match.contextWindow)
                  if (match?.provider && CATEGORIES.includes(match.provider as (typeof CATEGORIES)[number])) {
                    setCategory(match.provider as (typeof CATEGORIES)[number])
                  }
                  if (match?.tokenWeight) {
                    setPriceWeight(String(match.tokenWeight))
                  }
                }
              }}
            >
              <option value="">
                {catalogLoading ? 'Loading…' : catalogError ? 'Unavailable' : 'Select model'}
              </option>
              {catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id}
                </option>
              ))}
            </select>
            {catalogError ? <span className="field-hint warn-hint">{catalogError}</span> : null}
            {selected ? (
              <span className="field-hint">
                {upstreamProviderLabel(upstreamProvider)} id: {selected.id}
              </span>
            ) : null}
          </div>
          {!editingFallback ? <>
          <div className="field">
            <label htmlFor="model-api-id">API model id</label>
            <input
              id="model-api-id"
              className="input"
              value={apiId}
              onChange={(event) => setApiId(event.target.value)}
              disabled={!selected && !editTarget}
              placeholder="gpt-5.6-sol"
            />
            <span className="field-hint">Clients send this in `model`. Letters, numbers, `.` `_` `:` `/` `-` allowed.</span>
          </div>
          <div className="field">
            <label htmlFor="model-name">Display name</label>
            <input
              id="model-name"
              className="input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={!selected && !editTarget}
            />
          </div>
          {selected || editTarget ? (
            <div className="field">
              <label htmlFor="model-context-window">Context window</label>
              <input
                id="model-context-window"
                className="input"
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                placeholder="1M, 128K, 200K…"
              />
              <span className="field-hint">Display context limit shown in UI and docs (e.g. 1M, 128K, 200K).</span>
            </div>
          ) : null}
          </> : null}
        </div>
      </Modal>

      {deleteTarget ? (
        <ConfirmModal
          title={`Delete ${deleteTarget.name}?`}
          description={`API id “${deleteTarget.id}” will be removed from the catalog and pricing.`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget
            setDeleteTarget(null)
            void run(() => adminApi.deleteModel(target.id), 'Model deleted')
          }}
          confirmLabel="Delete model"
        />
      ) : null}

      {/* Chat Model Price Modal */}
      <Modal
        open={!!priceTarget}
        onClose={() => setPriceTarget(null)}
        title={priceTarget ? `Price · ${priceTarget.name}` : 'Price'}
        description="Set retail input and output prices per 1M tokens in USD. Input and output are billed separately. Free models draw the free-token allowance at x1."
        footer={
          <>
            <button className="btn btn-secondary" type="button" onClick={() => setPriceTarget(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !priceTarget}
              onClick={() => {
                if (!priceTarget) return
                const input = Number(priceInput)
                const output = Number(priceOutput)
                const isJev = priceTarget.provider === 'Jev Group' || /jev|drex|subq|decision/i.test(priceTarget.id)
                if (!Number.isFinite(input) || input < 0.01 || !Number.isFinite(output) || output < (isJev ? 0 : 0.01)) return
                void run(async () => {
                  await adminApi.updatePricing(priceTarget.id, {
                    inputDollarsPer1M: input,
                    outputDollarsPer1M: output,
                  })
                  setPriceTarget(null)
                }, 'Price saved')
              }}
            >
              Save price
            </button>
          </>
        }
      >
        <div className="form-stack">
              <div className="field">
                <label htmlFor="model-input-price">Input ($ / 1M tokens)</label>
                <input
                  id="model-input-price"
                  className="input"
                  inputMode="decimal"
                  value={priceInput}
                  onChange={(event) => setPriceInput(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="model-output-price">Output ($ / 1M tokens)</label>
                <input
                  id="model-output-price"
                  className="input"
                  inputMode="decimal"
                  value={priceOutput}
                  onChange={(event) => setPriceOutput(event.target.value)}
                />
              </div>
              <span className="field-hint">
                1M input + 1M output = ${((Number(priceInput) || 0) + (Number(priceOutput) || 0)).toFixed(2)}
              </span>
        </div>
      </Modal>
    </div>
  )
}
