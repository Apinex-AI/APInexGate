import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { PROVIDER_ORDER } from '../../shared/providers'
import { officialPriceForModel } from '../../shared/officialPrices'
import { providerSlug } from '../lib/providerStyle'

import { ProviderIcon } from '../components/ProviderIcon'
import { userApi } from '../auth/userApi'
import { captureReferralFromUrl } from '../auth/referral'
import { useSiteLinks } from '../lib/siteLinks'
import { apiOrigin } from '../lib/brand'
import { BrandName } from '../components/BrandName'
import './Landing.css'

type PublicModel = {
  id: string
  provider: string
  name: string
  contextWindow: string
  weight: number
  dollarsPer1M: number
  inputDollarsPer1M?: number
  outputDollarsPer1M?: number
}

const LANDING_PROVIDERS = PROVIDER_ORDER.filter((name) => name !== 'Free')

const FALLBACK_PAID_MODELS: PublicModel[] = [
  { id: 'claude-opus-5.5', provider: 'Claude', name: 'Claude Opus', contextWindow: '200K', weight: 1, dollarsPer1M: 0.25 },
  { id: 'claude-3-7-sonnet', provider: 'Claude', name: 'Claude 3.7 Sonnet', contextWindow: '200K', weight: 1, dollarsPer1M: 0.25 },
  { id: 'gpt-6-sol', provider: 'GPT', name: 'GPT-6 Sol', contextWindow: '128K', weight: 1, dollarsPer1M: 0.25 },
  { id: 'gpt-6-astra', provider: 'GPT', name: 'GPT-6 Astra', contextWindow: '128K', weight: 1, dollarsPer1M: 0.25 },
  { id: 'deepseek-v4-pro', provider: 'DeepSeek', name: 'DeepSeek V4 Pro', contextWindow: '64K', weight: 1, dollarsPer1M: 0.25 },
  { id: 'kimi-k3', provider: 'Kimi', name: 'Kimi K3', contextWindow: '200K', weight: 1, dollarsPer1M: 0.25 },
  { id: 'gemini-3.1-pro', provider: 'Gemini', name: 'Gemini 3.1 Pro', contextWindow: '1M', weight: 1, dollarsPer1M: 0.25 },
  { id: 'grok-4.7', provider: 'Grok', name: 'Grok 4.7', contextWindow: '128K', weight: 1, dollarsPer1M: 0.25 },
]

function formatSpend(usd: number) {
  if (!Number.isFinite(usd)) return '—'
  if (usd >= 100) return `$${Math.round(usd).toLocaleString('en-US')}`
  if (usd >= 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(3)}`
}

function cheaperTimes(official: number, ours: number) {
  if (!(official > 0) || !(ours > 0) || official <= ours) return null
  const times = official / ours
  return times >= 10 ? Math.round(times) : Math.round(times * 10) / 10
}

function GatewayControlDeck({ models }: { models: PublicModel[] }) {
  const [modelOpen, setModelOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const modelPickRef = useRef<HTMLDivElement>(null)

  // Paid models only (strictly NO Free models)
  const options = useMemo(
    () =>
      models.filter(
        (model) =>
          model.provider !== 'Free' &&
          !model.id.startsWith('free/') &&
          Number(model.dollarsPer1M) > 0,
      ),
    [models],
  )
  const [modelId, setModelId] = useState('claude-opus-5.5')
  const [millions, setMillions] = useState(10)
  const filteredOptions = useMemo(() => {
    const list = options.length > 0 ? options : FALLBACK_PAID_MODELS
    const q = modelSearch.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    )
  }, [options, modelSearch])

  const selected = options.find((model) => model.id === modelId) ?? FALLBACK_PAID_MODELS.find((m) => m.id === modelId) ?? options[0] ?? FALLBACK_PAID_MODELS[0]

  useEffect(() => {
    const list = options.length > 0 ? options : FALLBACK_PAID_MODELS
    if (!selected && list[0]) setModelId(list[0].id)
  }, [options, selected])

  useEffect(() => {
    if (!modelOpen) return
    function handleOutside(event: Event) {
      if (modelPickRef.current && !modelPickRef.current.contains(event.target as Node)) {
        setModelOpen(false)
        setModelSearch('')
      }
    }
    document.addEventListener('pointerdown', handleOutside)
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    return () => {
      document.removeEventListener('pointerdown', handleOutside)
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
    }
  }, [modelOpen])

  const official = selected ? officialPriceForModel(selected.id) : null
  const selectedInput = selected ? Number(selected.inputDollarsPer1M ?? selected.dollarsPer1M) || 0 : 0
  const selectedOutput = selected ? Number(selected.outputDollarsPer1M ?? selected.dollarsPer1M) || selectedInput : 0
  const oursInput = selectedInput * millions
  const oursOutput = selectedOutput * millions
  const oursTotal = (oursInput + oursOutput) / 2
  const officialInput = official
    ? official.inputPer1M * millions
    : oursTotal * 1.5
  const officialOutput = official
    ? official.outputPer1M * millions
    : oursTotal * 3.5
  const officialAvg = (officialInput + officialOutput) / 2
  const savingsMult = cheaperTimes(officialAvg, oursTotal)
  const savingsPercent = officialAvg > 0 && oursTotal < officialAvg
    ? Math.round(((officialAvg - oursTotal) / officialAvg) * 100)
    : 0

  return (
    <div className="lp-console-card">
      {/* Window Titlebar */}
      <div className="lp-console-bar">
        <div className="lp-console-dots" aria-hidden>
          <span className="dot dot-red" />
          <span className="dot dot-amber" />
          <span className="dot dot-green" />
        </div>
        <div className="lp-console-host">
          <span className="live-pulse-dot" />
          <span>{apiOrigin().replace(/^https?:\/\//, '')} · 99.99%</span>
        </div>
      </div>

      <div className="lp-console-body">
        {/* Controls: Custom Model Picker & Volume Slider */}
        <div className="lp-deck-controls">
          <div className="lp-deck-field has-model-picker" ref={modelPickRef}>
            <label className="lp-deck-label">Target Model</label>
            <div className="lp-model-picker-wrap">
              <button
                type="button"
                className="lp-model-btn"
                onClick={() => setModelOpen((o) => !o)}
              >
                {selected ? (
                  <span className="lp-model-btn-lead">
                    <ProviderIcon provider={selected.provider} modelId={selected.id} size={18} />
                    <span className="lp-model-btn-name">{selected.name}</span>
                  </span>
                ) : (
                  <span>Select model</span>
                )}
                <div className="lp-model-btn-meta">
                  {selected ? (
                    <span className="lp-model-price-badge">
                      ${selectedInput.toFixed(2)} / ${selectedOutput.toFixed(2)}
                    </span>
                  ) : null}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`lp-chevron ${modelOpen ? 'is-open' : ''}`}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </button>

              {modelOpen && (
                <div className="lp-model-dropdown">
                  <div className="lp-model-dropdown-head">
                    <span>Available Models</span>
                    <span className="lp-model-count">{filteredOptions.length} models</span>
                  </div>
                  <div className="lp-model-search-wrap">
                    <input
                      type="text"
                      placeholder="Search model or provider…"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      className="lp-model-search-input"
                    />
                  </div>
                  <div className="lp-model-list">
                    {filteredOptions.map((m) => {
                      const isSelected = selected?.id === m.id
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={`lp-model-item ${isSelected ? 'is-active' : ''}`}
                          onClick={() => {
                            setModelId(m.id)
                            setModelOpen(false)
                            setModelSearch('')
                          }}
                        >
                          <div className="lp-model-item-lead">
                            <span className="lp-model-icon">
                              <ProviderIcon provider={m.provider} modelId={m.id} size={18} />
                            </span>
                            <div className="lp-model-item-text">
                              <span className="lp-model-title">{m.name}</span>
                              <code className="lp-model-code">{m.id}</code>
                            </div>
                          </div>
                          <span className="lp-model-cost">
                            ${(Number(m.inputDollarsPer1M ?? m.dollarsPer1M) || 0).toFixed(2)} / ${(Number(m.outputDollarsPer1M ?? m.dollarsPer1M) || Number(m.inputDollarsPer1M ?? m.dollarsPer1M) || 0).toFixed(2)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="lp-deck-field has-volume">
            <div className="lp-deck-vol-label">
              <span>Volume</span>
              <strong>{millions}M Tokens</strong>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={millions}
              onChange={(e) => setMillions(Number(e.target.value))}
              className="lp-deck-slider"
              style={{
                background: `linear-gradient(to right, #b388ff 0%, #818cf8 ${millions}%, rgba(255, 255, 255, 0.08) ${millions}%, rgba(255, 255, 255, 0.08) 100%)`,
              }}
            />
            <div className="lp-deck-preset-pills">
              {[5, 10, 25, 50, 100].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`lp-deck-pill ${millions === v ? 'is-active' : ''}`}
                  onClick={() => setMillions(v)}
                >
                  {v}M
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Pricing Comparison Duel Display */}
        <div className="lp-comparison-duel">
          <div className="lp-duel-card lp-duel-official">
            <div className="lp-duel-header">
              <span className="lp-duel-tag">Direct Vendor</span>
              <small>Official list price</small>
            </div>
            <div className="lp-duel-split-grid">
              <div className="lp-split-box">
                <span className="lp-split-name">Input</span>
                <strong className="lp-split-num">{formatSpend(officialInput)}</strong>
              </div>
              <div className="lp-split-divider" />
              <div className="lp-split-box">
                <span className="lp-split-name">Output</span>
                <strong className="lp-split-num">{formatSpend(officialOutput)}</strong>
              </div>
            </div>
          </div>

          <div className="lp-duel-card lp-duel-ours">
            <div className="lp-duel-header">
              <span className="lp-duel-tag is-ours"><BrandName /> Gateway</span>
              {savingsMult ? (
                <span className="lp-savings-badge">
                  {savingsMult}× cheaper
                </span>
              ) : null}
            </div>
            <div className="lp-duel-amount is-ours">
              <strong>{formatSpend(oursTotal)}</strong>
              {savingsPercent > 0 ? (
                <small className="lp-percent-badge">-{savingsPercent}%</small>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Modern Providers Ribbon */}
      <div className="lp-deck-providers-bar">
        <span className="lp-deck-prov-title">Upstream:</span>
        <div className="lp-deck-prov-list">
          {LANDING_PROVIDERS.map((name) => (
            <span key={name} className={`lp-deck-chip lp-deck-chip-${providerSlug(name)}`}>
              <ProviderIcon provider={name} size={15} />
              <span>{name}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Landing() {
  const reduce = useReducedMotion()
  const [loggedIn, setLoggedIn] = useState(false)
  const [models, setModels] = useState<PublicModel[]>([])
  const links = useSiteLinks()

  useEffect(() => {
    captureReferralFromUrl()
  }, [])

  useEffect(() => {
    userApi
      .me()
      .then((data) => {
        setLoggedIn(Boolean(data.user))
      })
      .catch(() => setLoggedIn(false))

    fetch('/api/public/models')
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as { models?: PublicModel[] }
        setModels(Array.isArray(data.models) ? data.models : [])
      })
      .catch(() => undefined)
  }, [])

  return (
    <div className="lp">
      {/* Cybernetic Atmosphere */}
      <div className="lp-atmosphere" aria-hidden>
        <div className="lp-orb lp-orb-a" />
        <div className="lp-orb lp-orb-b" />
        <div className="lp-grid" />
      </div>

      {/* Header */}
      <header className="lp-header">
        <div className="lp-header-inner">
          <a href="/" className="lp-brand" target="_blank" rel="noreferrer">
            <img src="/brand/mark.png" alt="" />
            <span><BrandName /></span>
          </a>
          <nav className="lp-nav">
            <a href="/models" target="_blank" rel="noreferrer">Models</a>
            <a href="/docs" target="_blank" rel="noreferrer">Documentation</a>
            <a href="/status" target="_blank" rel="noreferrer">Status</a>

          </nav>
          <div className="lp-header-actions">
            <div className="lp-social" aria-label="Community">
              {links.telegram ? (
              <a
                className="lp-social-btn lp-social-tg"
                href={links.telegram}
                target="_blank"
                rel="noreferrer"
                aria-label="Telegram"
                title="Telegram"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212-.07-.062-.174-.041-.249-.024-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                </svg>
              </a>
              ) : null}
              {links.x ? (
              <a
                className="lp-social-btn lp-social-x"
                href={links.x}
                target="_blank"
                rel="noreferrer"
                aria-label="Follow on X"
                title="X"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
                </svg>
              </a>
              ) : null}
            </div>
            {loggedIn ? (
              <a className="btn btn-primary" href="/overview" target="_blank" rel="noreferrer">
                Open dashboard
              </a>
            ) : (
              <>
                <a className="btn btn-ghost lp-btn-login" href="/login" target="_blank" rel="noreferrer">
                  Log in
                </a>
                <a className="btn btn-primary" href="/register" target="_blank" rel="noreferrer">
                  Register
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Single-Screen Main Section */}
      <section className="lp-hero">
        <div className="lp-hero-glow" aria-hidden />

        <motion.div
          className="lp-hero-copy"
          initial={reduce ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="lp-hero-headline">
            Every AI Model. <br />
            <span className="lp-hero-gradient-text">One Unified Balance.</span>
          </h1>

          <p className="lp-hero-desc">
            Access Claude, DeepSeek, GPT, and more models 10X cheaper than official rates. Connect through a single universal API key.
          </p>

          <div className="lp-metric-pill">
            <span className="lp-metric-dot" />
            <span className="lp-metric-label">Compute from</span>
            <strong className="lp-metric-num">$0.00</strong>
            <span className="lp-metric-unit">/ 1M tokens</span>
          </div>

          <div className="lp-hero-cta">
            <a className="btn btn-primary btn-lg lp-hero-btn-main" href={loggedIn ? '/overview' : '/register'} target="_blank" rel="noreferrer">
              {loggedIn ? 'Open dashboard' : 'Get free API key'}
            </a>
            <a className="btn btn-secondary btn-lg" href="/models" target="_blank" rel="noreferrer">
              Explore models
            </a>
          </div>
        </motion.div>

        <motion.div
          className="lp-hero-visual"
          initial={reduce ? false : { opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
        >
          <GatewayControlDeck models={models} />
        </motion.div>
      </section>
    </div>
  )
}
