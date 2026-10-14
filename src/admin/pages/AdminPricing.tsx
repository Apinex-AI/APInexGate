import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from '../api'
import type { AdminModel } from '../types'
import { AdminPageHeader, EmptyState, useAdminMutation } from '../AdminShared'
import { ProviderIcon } from '../../components/ProviderIcon'
import { providerSlug } from '../../lib/providerStyle'
import './AdminPages.css'

export function AdminPricing() {
  const [models, setModels] = useState<AdminModel[]>([])
  const refresh = () => {
    adminApi.models().then((data) => setModels(data.models)).catch(() => undefined)
  }
  useEffect(refresh, [])
  const { run, busy } = useAdminMutation(refresh)

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Pricing"
        description={`${models.length} models · paid models have separate input and output $ / 1M · free models are FREE at x1`}
        actions={<span className="admin-chip admin-chip-green">$ / 1M</span>}
      />

      {models.length === 0 ? (
        <div className="admin-card">
          <EmptyState
            title="No models yet"
            description="Add models first, then set prices here."
            action={
              <Link className="btn btn-primary btn-sm" to="/admin/models">
                Go to models
              </Link>
            }
          />
        </div>
      ) : (
        <div className="admin-pricing-grid">
          {models.map((model) => (
            <PricingCard
              key={model.id}
              model={model}
              busy={busy}
              onSave={(value) =>
                void run(
                  () =>
                    adminApi.updatePricing(
                      model.id,
                      {
                            inputDollarsPer1M: value.inputDollarsPer1M ?? 0,
                            outputDollarsPer1M: value.outputDollarsPer1M ?? 0,
                          },
                    ),
                  'Saved',
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PricingCard({
  model,
  busy,
  onSave,
}: {
  model: AdminModel
  busy: boolean
  onSave: (value: { tokenWeight?: number; inputDollarsPer1M?: number; outputDollarsPer1M?: number }) => void
}) {
  const isFree = model.provider === 'Free'
  const storedInput = Math.max(0, Number(model.input_price_micros) || 0) / 1_000_000
  const storedOutputRaw = Math.max(0, Number(model.output_price_micros) || 0) / 1_000_000
  const storedOutput = storedOutputRaw > 0 ? storedOutputRaw : storedInput
  const [inputPrice, setInputPrice] = useState(priceField(storedInput))
  const [outputPrice, setOutputPrice] = useState(priceField(storedOutput))

  useEffect(() => {
    const nextInput = Math.max(0, Number(model.input_price_micros) || 0) / 1_000_000
    const nextOutputRaw = Math.max(0, Number(model.output_price_micros) || 0) / 1_000_000
    setInputPrice(priceField(nextInput))
    setOutputPrice(priceField(nextOutputRaw > 0 ? nextOutputRaw : nextInput))
  }, [model.id, model.provider, model.input_price_micros, model.output_price_micros])

  const parsedInput = Number(inputPrice)
  const parsedOutput = Number(outputPrice)

  return (
    <article className={`admin-card pricing-card pricing-card-${providerSlug(model.provider)}`}>
      <div className="pricing-card-head">
        <div>
          <span className={`provider-label provider-${providerSlug(model.provider)}`}>
            <ProviderIcon provider={model.provider} size={16} />
            {model.provider}
          </span>
          <h2>{model.name}</h2>
          <code className="mono">{model.id}</code>
        </div>
        <span className="admin-chip">{model.status}</span>
      </div>
      <div className="pricing-fields">
        {isFree ? (
          <div className="field">
            <label>FREE Token Weight</label>
            <p className="field-hint">Weight for free model accounting.</p>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`input-${model.id}`}>Input ($ / 1M)</label>
              <input
                id={`input-${model.id}`}
                className="input"
                inputMode="decimal"
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`output-${model.id}`}>Output ($ / 1M)</label>
              <input
                id={`output-${model.id}`}
                className="input"
                inputMode="decimal"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
              />
            </div>
          </>
        )}
      </div>
      <button
        className="btn btn-secondary btn-sm"
        type="button"
        disabled={busy || isFree}
        onClick={() => {
          if (isFree) return
          if (!Number.isFinite(parsedInput) || parsedInput < 0.01) return
          if (!Number.isFinite(parsedOutput) || parsedOutput < 0.01) return
          onSave({ inputDollarsPer1M: parsedInput, outputDollarsPer1M: parsedOutput })
        }}
      >
        Save
      </button>
    </article>
  )
}

function priceField(dollars: number) {
  if (!Number.isFinite(dollars) || dollars <= 0) return '0.00'
  const rounded = Math.round(dollars * 1000) / 1000
  return Number.isInteger(rounded) ? rounded.toFixed(2) : String(rounded)
}
