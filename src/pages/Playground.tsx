import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { userApi, type CustomerModel } from '../auth/userApi'
import { ProviderIcon } from '../components/ProviderIcon'
import './Playground.css'

type ChatModel = CustomerModel & { free: boolean; priceLabel: string }
type Attachment = { name: string; type: string; dataUrl: string; text?: string }
type PlaygroundMeta = { free?: boolean; costTokens?: number; chargedUsd?: number | null; latencyMs?: number }

type ChatTurn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: Attachment[]
  error?: { status: number; message: string } | null
  streaming?: boolean
  seconds?: number | null
  meta?: PlaygroundMeta | null
}

type SavedChat = {
  id: string
  title: string
  updatedAt: number
  model: string
  turns: ChatTurn[]
}

const HISTORY_KEY = 'playground.chats'

function formatSeconds(ms: number) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}

function isDecisionCatalogModel(model: Pick<CustomerModel, 'id' | 'provider'>) {
  const prov = model.provider.trim().toLowerCase()
  const id = model.id.trim().toLowerCase()
  return (
    prov === 'jev group' ||
    prov === 'jev' ||
    prov === 'decisions' ||
    id.includes('jev-') ||
    id.includes('drex') ||
    id.includes('subq') ||
    id.includes('decision')
  )
}

function splitPrices(model: CustomerModel) {
  const input = Number(model.inputDollarsPer1M ?? model.dollarsPer1M) || 0
  const isJev = isDecisionCatalogModel(model)
  const rawOut = model.outputDollarsPer1M
  const output =
    rawOut != null && Number.isFinite(Number(rawOut)) && (Number(rawOut) > 0 || isJev)
      ? Number(rawOut)
      : isJev
        ? 0
        : input
  return { input: Math.max(0, input), output: Math.max(0, output) }
}

function isFreeChatModel(model: CustomerModel) {
  const prices = splitPrices(model)
  return model.provider === 'Free' || model.id.startsWith('free/') || model.weight === 0 || (prices.input <= 0 && prices.output <= 0)
}

function money(dollars: number) {
  const digits = dollars < 0.01 ? 4 : 2
  return `$${dollars.toFixed(digits)}`
}

function priceLabel(model: CustomerModel) {
  const prices = splitPrices(model)
  if (prices.input <= 0 && prices.output <= 0) return 'Free'
  if (prices.input === prices.output) return `${money(prices.input)} / 1M`
  return `${money(prices.input)} in · ${money(prices.output)} out`
}

function loadHistory(): SavedChat[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsed = raw ? (JSON.parse(raw) as SavedChat[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveHistory(chats: SavedChat[]) {
  const slim = chats.slice(0, 30).map((chat) => ({
    ...chat,
    turns: chat.turns.map((turn) => ({
      ...turn,
      streaming: false,
      attachments: turn.attachments?.map((file) => ({
        name: file.name,
        type: file.type,
        text: file.text,
        dataUrl: file.dataUrl.startsWith('data:image/') ? file.dataUrl : '',
      })),
    })),
  }))
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(slim))
  } catch {
    /* quota */
  }
}

async function readError(response: Response): Promise<{ status: number; message: string }> {
  let message = response.statusText || 'Request failed'
  try {
    const data = (await response.json()) as { error?: { message?: string } | string; message?: string }
    if (typeof data.error === 'string' && data.error) message = data.error
    else if (data.error && typeof data.error === 'object' && data.error.message) message = data.error.message
    else if (data.message) message = data.message
  } catch {
    /* keep status text */
  }
  if (response.status === 402 && /insufficient|allowance|tokens used|top up|too low/i.test(message)) {
    return { status: 402, message: 'Insufficient balance — top up your account' }
  }
  return { status: response.status, message }
}

function useLiveSeconds(running: boolean) {
  const [seconds, setSeconds] = useState<number | null>(null)
  const started = useRef(0)
  useEffect(() => {
    if (!running) return
    started.current = performance.now()
    setSeconds(0)
    const timer = window.setInterval(() => setSeconds(performance.now() - started.current), 100)
    return () => window.clearInterval(timer)
  }, [running])
  return seconds
}

function isTextFile(file: File) {
  return file.type.startsWith('text/') || /\.(txt|md|json|csv|log|xml|yaml|yml)$/i.test(file.name)
}

function readAttachment(file: File) {
  return new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    if (isTextFile(file)) {
      reader.onload = () =>
        resolve({ name: file.name, type: file.type || 'text/plain', dataUrl: '', text: String(reader.result ?? '') })
      reader.readAsText(file)
      return
    }
    reader.onload = () =>
      resolve({ name: file.name, type: file.type || 'application/octet-stream', dataUrl: String(reader.result) })
    reader.readAsDataURL(file)
  })
}

function userContent(text: string, files: Attachment[]): string | Array<Record<string, unknown>> {
  if (files.length === 0) return text
  const parts: Array<Record<string, unknown>> = []
  for (const file of files) {
    if (file.text != null) parts.push({ type: 'text', text: `Attached file ${file.name}:\n${file.text}` })
    else if (file.type.startsWith('image/') && file.dataUrl) parts.push({ type: 'image_url', image_url: { url: file.dataUrl } })
    else parts.push({ type: 'text', text: `Attached file ${file.name}` })
  }
  if (text) parts.push({ type: 'text', text })
  return parts
}

function markdownToHtml(raw: string) {
  const fences: string[] = []
  let html = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  html = html.replace(/```[a-z0-9]*\n?([\s\S]*?)```/gi, (_match, code: string) => {
    fences.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
    return `\u0000${fences.length - 1}\u0000`
  })
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  html = html.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (list) => `<ul>${list}</ul>`)
  html = html
    .split(/\n{2,}/)
    .map((part) => (part.startsWith('<h') || part.startsWith('<ul') || part.startsWith('<pre') ? part : `<p>${part.replace(/\n/g, '<br>')}</p>`))
    .join('')
  return html.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => fences[Number(index)] ?? '')
}

function ErrorText({ message }: { message: string }) {
  const navigate = useNavigate()
  const cleaned = message.replace(
    /Buy a subscription at https?:\/\/example\.com\/subscriptions to use it\.?/i,
    'Buy a subscription to use it.',
  )
  const marker = 'Buy a subscription to use it.'
  const at = cleaned.indexOf(marker)
  if (at < 0) return <>{message}</>
  return (
    <>
      {cleaned.slice(0, at)}
      <button type="button" className="playground-error-link" onClick={() => navigate('/subscriptions')}>
        {marker}
      </button>
      {cleaned.slice(at + marker.length)}
    </>
  )
}

function FileChips({
  files,
  onRemove,
  onPreview,
}: {
  files: Attachment[]
  onRemove?: (file: Attachment) => void
  onPreview?: (src: string) => void
}) {
  if (files.length === 0) return null
  return (
    <div className="playground-files">
      {files.map((file) => {
        const image = file.type.startsWith('image/') && file.dataUrl
        return (
          <span key={`${file.name}-${file.dataUrl.slice(0, 24)}`} className="playground-file-static">
            {image ? (
              <button type="button" className="playground-thumb" onClick={() => onPreview?.(file.dataUrl)}>
                <img src={file.dataUrl} alt={file.name} />
              </button>
            ) : (
              <span>{file.name}</span>
            )}
            {onRemove ? (
              <button type="button" className="playground-file-x" aria-label="Remove" onClick={() => onRemove(file)}>
                ×
              </button>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}

export function Playground() {
  const [chatModels, setChatModels] = useState<ChatModel[]>([])
  const [chatModel, setChatModel] = useState('')
  const [loadError, setLoadError] = useState('')
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [chatId, setChatId] = useState<string>(() => crypto.randomUUID())
  const [historyOpen, setHistoryOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [history, setHistory] = useState<SavedChat[]>(() => loadHistory())
  const live = useLiveSeconds(busy)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const modelPickRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const chat = await userApi.models()
        if (cancelled) return
        const chats = chat.models
          .map((model) => {
            const free = isFreeChatModel(model)
            return { ...model, free, priceLabel: free ? 'Free' : priceLabel(model) }
          })
          .sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name))
        setChatModels(chats)
        setChatModel((current) => current || chats.find((item) => item.id === 'free/glm-5.3-flash')?.id || chats[0]?.id || '')
      } catch (reason) {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : 'Could not load models')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const html = document.documentElement
    const prevHtml = html.style.overflow
    const prevBody = document.body.style.overflow
    html.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      html.style.overflow = prevHtml
      document.body.style.overflow = prevBody
    }
  }, [])

  useEffect(() => {
    if (!modelOpen) return
    const close = (event: MouseEvent) => {
      if (!modelPickRef.current?.contains(event.target as Node)) setModelOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [modelOpen])

  useEffect(() => {
    const el = scroller.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [turns, live])

  function persist(nextTurns: ChatTurn[], id = chatId, model = chatModel) {
    const visible = nextTurns.filter((turn) => turn.role === 'user' || turn.text || turn.error)
    if (visible.length === 0) return
    const title = visible.find((turn) => turn.role === 'user')?.text.slice(0, 64) || 'New chat'
    const next = [{ id, title, updatedAt: Date.now(), model, turns: visible }, ...history.filter((chat) => chat.id !== id)]
    setHistory(next)
    saveHistory(next)
  }

  function newChat() {
    persist(turns)
    setTurns([])
    setChatId(crypto.randomUUID())
    setPrompt('')
    setFiles([])
    if (areaRef.current) areaRef.current.style.height = 'auto'
  }

  function openChat(chat: SavedChat) {
    persist(turns)
    setChatId(chat.id)
    setTurns(chat.turns)
    if (chat.model) setChatModel(chat.model)
    setHistoryOpen(false)
  }

  async function onFiles(list: File[]) {
    const next = await Promise.all(list.map(readAttachment))
    setFiles((prev) => [...prev, ...next])
  }

  async function sendChat() {
    const text = prompt.trim()
    if ((!text && files.length === 0) || !chatModel || busy) return
    const content = userContent(text, files)
    const historyMessages = turns
      .filter((turn) => !turn.error && (turn.text || turn.attachments?.length))
      .map((turn) => ({
        role: turn.role,
        content: turn.role === 'user' && turn.attachments?.length ? userContent(turn.text, turn.attachments) : turn.text,
      }))
    const requestBody = { model: chatModel, stream: true, messages: [...historyMessages, { role: 'user', content }] }
    const userId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const nextTurns: ChatTurn[] = [
      ...turns,
      { id: userId, role: 'user', text, attachments: files },
      { id: assistantId, role: 'assistant', text: '', streaming: true, seconds: 0 },
    ]
    stickToBottom.current = true
    setTurns(nextTurns)
    setPrompt('')
    setFiles([])
    if (areaRef.current) areaRef.current.style.height = 'auto'
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    const started = performance.now()
    const finish = (patch: Partial<ChatTurn>) => {
      setTurns((prev) => {
        const updated = prev.map((turn) => (turn.id === assistantId ? { ...turn, ...patch } : turn))
        persist(updated)
        return updated
      })
    }
    try {
      const selectedItem = chatModels.find((item) => item.id === chatModel)
      const isDecision = selectedItem ? isDecisionCatalogModel(selectedItem) : /jev-|drex|subq|decision/i.test(chatModel)
      if (isDecision) {
        const response = await fetch('/v1/decisions/playground', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ model: chatModel, messages: [{ role: 'user', content }] }),
          signal: controller.signal,
        })
        if (!response.ok) {
          finish({ streaming: false, error: await readError(response), seconds: performance.now() - started })
          return
        }
        const json = (await response.json()) as { answers?: unknown; usageMeta?: PlaygroundMeta }
        const formatted = `\`\`\`json\n${JSON.stringify(json.answers ?? json, null, 2)}\n\`\`\``
        finish({
          streaming: false,
          text: formatted,
          meta: json.usageMeta ?? null,
          seconds: json.usageMeta?.latencyMs ?? performance.now() - started,
        })
        return
      }

      const response = await fetch('/v1/chat/completions/playground', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        finish({ streaming: false, error: await readError(response), seconds: performance.now() - started })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let meta: PlaygroundMeta | null = null
      let assembled = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''
        for (const chunk of chunks) {
          let event = 'message'
          const dataLines: string[] = []
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          }
          const data = dataLines.join('\n')
          if (!data || data === '[DONE]') continue
          if (event === 'playground') {
            try {
              meta = JSON.parse(data) as PlaygroundMeta
            } catch {
              /* ignore */
            }
            continue
          }
          try {
            const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; usageMeta?: PlaygroundMeta }
            if (json.usageMeta) meta = json.usageMeta
            const piece = json.choices?.[0]?.delta?.content
            if (piece) {
              assembled += piece
              const snapshot = assembled
              setTurns((prev) => prev.map((turn) => (turn.id === assistantId ? { ...turn, text: snapshot } : turn)))
            }
          } catch {
            /* keepalive */
          }
        }
      }
      finish({ streaming: false, text: assembled, meta, seconds: meta?.latencyMs ?? performance.now() - started })
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        finish({ streaming: false, seconds: performance.now() - started })
      } else {
        finish({
          streaming: false,
          seconds: performance.now() - started,
          error: { status: 0, message: reason instanceof Error ? reason.message : 'Network error' },
        })
      }
    } finally {
      setBusy(false)
    }
  }

  function stopGeneration() {
    abortRef.current?.abort()
  }

  const selected = chatModels.find((item) => item.id === chatModel)

  return (
    <div className="playground">
      <header className="playground-head">
        <div className="playground-head-row">
          <div className="playground-title-group">
            <h1>Playground</h1>
          </div>

          <div className="playground-head-actions">
            <button
              type="button"
              className="btn btn-secondary playground-action-btn"
              aria-label="History"
              onClick={() => setHistoryOpen(true)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 15" />
              </svg>
              <span>History</span>
              {history.length > 0 && <span className="playground-history-count">{history.length}</span>}
            </button>

            <button
              type="button"
              className="btn btn-primary playground-action-btn playground-new-btn"
              aria-label="New chat"
              onClick={newChat}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>New chat</span>
            </button>
          </div>
        </div>
      </header>
      {loadError ? <div className="playground-error">{loadError}</div> : null}
      <div
        className={`playground-thread ${turns.length === 0 ? 'is-empty' : ''}`}
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {turns.length === 0 ? (
          <div className="playground-welcome">
            <div className="playground-welcome-icon" aria-hidden>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h2>What would you like to explore?</h2>
            <div className="playground-suggestions">
              <button
                type="button"
                className="playground-suggest-card"
                onClick={() => setPrompt('Write a clean Python script using OpenAI SDK to stream chat completions.')}
              >
                <div className="suggest-card-top">
                  <span className="suggest-cat">Code</span>
                  <span className="suggest-arrow">→</span>
                </div>
                <span className="suggest-title">Write Python streaming script</span>
              </button>
              <button
                type="button"
                className="playground-suggest-card"
                onClick={() => setPrompt('Explain quantum computing principles in simple terms with an example.')}
              >
                <div className="suggest-card-top">
                  <span className="suggest-cat">Theory</span>
                  <span className="suggest-arrow">→</span>
                </div>
                <span className="suggest-title">Explain quantum computing</span>
              </button>
              <button
                type="button"
                className="playground-suggest-card"
                onClick={() => setPrompt('Help me debug and optimize an asynchronous Node.js function with memory leaks.')}
              >
                <div className="suggest-card-top">
                  <span className="suggest-cat">Debug</span>
                  <span className="suggest-arrow">→</span>
                </div>
                <span className="suggest-title">Debug async Node.js code</span>
              </button>
              <button
                type="button"
                className="playground-suggest-card"
                onClick={() => setPrompt('Design a resilient microservices architecture for an AI proxy gateway.')}
              >
                <div className="suggest-card-top">
                  <span className="suggest-cat">Architecture</span>
                  <span className="suggest-arrow">→</span>
                </div>
                <span className="suggest-title">Design AI Gateway architecture</span>
              </button>
            </div>
          </div>
        ) : (
          turns.map((turn) => (
            <article key={turn.id} className={`playground-msg playground-msg-${turn.role}`}>
              <header>{turn.role === 'user' ? 'You' : 'Assistant'}</header>
              {turn.role === 'user' ? (
                <>
                  {turn.attachments ? <FileChips files={turn.attachments} onPreview={setPreviewSrc} /> : null}
                  <pre>{turn.text}</pre>
                </>
              ) : turn.error ? (
                <div className="playground-error">
                  {turn.error.status ? `${turn.error.status} · ` : ''}
                  <ErrorText message={turn.error.message} />
                </div>
              ) : (
                <div className="playground-md" dangerouslySetInnerHTML={{ __html: markdownToHtml(turn.text) }} />
              )}
              {turn.role === 'assistant' ? (
                <footer>
                  <span>{turn.streaming ? formatSeconds(live ?? 0) : turn.seconds != null ? formatSeconds(turn.seconds) : ''}</span>
                  {turn.meta?.free ? <span>{(turn.meta.costTokens ?? 0).toLocaleString('en-US')} tokens</span> : null}
                  {turn.meta && turn.meta.free === false && turn.meta.chargedUsd != null ? <span>${turn.meta.chargedUsd.toFixed(6)} charged</span> : null}
                </footer>
              ) : null}
            </article>
          ))
        )}
      </div>
      <form
        className="playground-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void sendChat()
        }}
      >
        <div className="playground-box">
          <FileChips files={files} onRemove={(file) => setFiles((prev) => prev.filter((item) => item !== file))} onPreview={setPreviewSrc} />
          <textarea
            ref={areaRef}
            rows={1}
            value={prompt}
            placeholder="Ask anything"
            onChange={(event) => setPrompt(event.target.value)}
            onInput={(event) => {
              const el = event.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 192)}px`
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendChat()
              }
            }}
            onPaste={(event) => {
              const list = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
              if (list.length === 0) return
              event.preventDefault()
              void onFiles(list)
            }}
          />
          <div className="playground-composer-bar">
            <button type="button" className="playground-icon-btn" aria-label="Attach" onClick={() => fileRef.current?.click()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
              </svg>
            </button>
            <div className="playground-model-pick" ref={modelPickRef}>
              <button type="button" className="playground-model-btn" onClick={() => setModelOpen((open) => !open)}>
                {selected && (
                  <span className="playground-model-btn-icon" aria-hidden>
                    <ProviderIcon provider={selected.provider} modelId={selected.id} size={15} />
                  </span>
                )}
                <span className="playground-model-name">{selected?.name || 'Model'}</span>
                {selected ? <span className="playground-model-badge">{selected.free ? 'Free' : selected.priceLabel}</span> : null}
              </button>
              {modelOpen ? (
                <div className="playground-model-menu">
                  <div className="playground-menu-header">
                    <span>Select Model</span>
                    <span className="menu-header-count">{chatModels.length} models</span>
                  </div>
                  <div className="playground-menu-list">
                    {chatModels.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`playground-menu-item ${item.id === chatModel ? 'is-active' : ''}`}
                        onClick={() => {
                          setChatModel(item.id)
                          setModelOpen(false)
                        }}
                      >
                        <div className="menu-item-lead">
                          <span className="menu-item-icon" aria-hidden>
                            <ProviderIcon provider={item.provider} modelId={item.id} size={16} />
                          </span>
                          <div className="menu-item-info">
                            <span className="menu-item-name">{item.name}</span>
                            <code className="menu-item-code">{item.id}</code>
                          </div>
                        </div>
                        <span className={`menu-item-badge ${item.free ? 'is-free' : ''}`}>
                          {item.free ? 'Free' : item.priceLabel}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept="image/*,.pdf,.txt,.md,.json,.csv"
              onChange={(event) => {
                const list = Array.from(event.target.files ?? [])
                event.target.value = ''
                void onFiles(list)
              }}
            />
            {busy ? (
              <button type="button" className="playground-send playground-stop" aria-label="Stop generation" onClick={stopGeneration}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect width="12" height="12" rx="2" fill="currentColor" />
                </svg>
                <span>Stop</span>
              </button>
            ) : (
              <button type="submit" className="playground-send" disabled={!chatModel}>
                <span>Send</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
      {previewSrc ? (
        <div className="playground-lightbox" onClick={() => setPreviewSrc(null)}>
          <button type="button" className="playground-lightbox-close" aria-label="Close" onClick={() => setPreviewSrc(null)}>
            ×
          </button>
          <img src={previewSrc} alt="" onClick={(event) => event.stopPropagation()} />
        </div>
      ) : null}
      <Modal
        open={historyOpen}
        title="Chat History"
        description="Past conversations saved locally in your browser"
        onClose={() => setHistoryOpen(false)}
      >
        {history.length === 0 ? (
          <div className="playground-empty-history">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <polyline points="12 7 12 12 15 15" />
            </svg>
            <p>No saved conversations yet.</p>
          </div>
        ) : (
          <ul className="playground-history">
            {history.map((chat) => (
              <li key={chat.id}>
                <button type="button" className="playground-history-item" onClick={() => openChat(chat)}>
                  <div className="playground-history-main">
                    <div className="playground-history-icon" aria-hidden>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div className="playground-history-text">
                      <strong>{chat.title}</strong>
                      <div className="playground-history-sub">
                        {chat.model ? <span className="history-model-tag">{chat.model}</span> : null}
                        <time>{new Date(chat.updatedAt).toLocaleString()}</time>
                      </div>
                    </div>
                  </div>
                  <span className="playground-history-arrow" aria-hidden>→</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  )
}
