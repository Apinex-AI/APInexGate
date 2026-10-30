import { useState, type ReactNode } from 'react'
import { apiBase, apiOrigin } from '../lib/brand'

export { apiBase as API_BASE, apiOrigin as API_ORIGIN }

export type ParamRow = {
  name: string
  type: string
  required?: boolean
  default?: string
  description: ReactNode
}

export function CodeBlock({
  code,
  title = 'Example',
  language = 'bash',
}: {
  code: string
  title?: string
  language?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="ref-term">
      <div className="ref-term-bar">
        <div className="ref-term-meta">
          <span className="ref-term-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span className="ref-term-lang">{language}</span>
          <strong>{title}</strong>
        </div>
        <button type="button" className="ref-term-copy" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function ParamTable({ rows, showRequirements = true }: { rows: ParamRow[]; showRequirements?: boolean }) {
  return (
    <div className="ref-fields">
      {rows.map((row) => (
        <article key={row.name} className="ref-field">
          <header>
            <code>{row.name}</code>
            <span className="ref-field-type">{row.type}</span>
            {showRequirements ? (
              <em className={row.required ? 'is-req' : 'is-opt'}>{row.required ? 'required' : 'optional'}</em>
            ) : null}
          </header>
          <p>
            {row.description}
            {row.default ? (
              <>
                {' '}
                Default is <code>{row.default}</code>.
              </>
            ) : null}
          </p>
        </article>
      ))}
    </div>
  )
}

export function Callout({
  title,
  children,
  tone = 'info',
}: {
  title: string
  children: ReactNode
  tone?: 'info' | 'warn' | 'ok'
}) {
  return (
    <div className={`ref-note ${tone === 'warn' ? 'is-warn' : tone === 'ok' ? 'is-ok' : ''}`}>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  )
}

export function EndpointBadge({ method, path }: { method: string; path: string }) {
  return (
    <div className="ref-route">
      <span className={`ref-verb ref-verb-${method.toLowerCase()}`}>{method}</span>
      <code>{path}</code>
    </div>
  )
}

export function PageHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow?: string
  title: string
  lead?: ReactNode
}) {
  return (
    <header className="ref-head">
      <div>
        {eyebrow ? <span className="ref-kicker">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </div>
    </header>
  )
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="ref-card" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export function DevScreenshotFrame({
  src,
  alt,
  title,
}: {
  src: string
  alt: string
  title: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" className="ref-shot" onClick={() => setOpen((prev) => !prev)} aria-expanded={open}>
        <span>{title}</span>
        <small>{open ? 'Hide' : 'Open'}</small>
      </button>
      {open ? (
        <div className="ref-shot-body">
          <img src={src} alt={alt} loading="lazy" />
        </div>
      ) : null}
    </div>
  )
}
