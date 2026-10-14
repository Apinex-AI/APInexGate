import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { lockPageScroll } from '../lib/scrollLock'
import './Modal.css'

type ModalProps = {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  panelClassName?: string
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  panelClassName,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockPageScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="modal-root is-open" role="presentation">
      <button className="modal-backdrop" type="button" aria-label="Close dialog" onClick={onClose} />
      <div
        className={`modal-panel ${wide ? 'modal-wide' : ''} ${panelClassName || ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="btn btn-ghost btn-icon modal-close" type="button" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}
