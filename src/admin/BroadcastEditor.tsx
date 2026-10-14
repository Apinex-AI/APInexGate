import { memo, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react'
import { serializeBroadcastDom } from './broadcastMarkup'

export const BROADCAST_SHORTCUTS = [
  { keys: '⌘/Ctrl+B', label: 'bold', code: 'b', tag: 'b' },
  { keys: '⌘/Ctrl+I', label: 'italic', code: 'i', tag: 'i' },
  { keys: '⌘/Ctrl+U', label: 'underline', code: 'u', tag: 'u' },
  { keys: 'Alt/⌥/Ctrl+X', label: 'strikethrough', code: 'x', tag: 's', alt: true },
  { keys: 'Alt/⌥/Ctrl+K', label: 'monospace', code: 'k', tag: 'code', alt: true },
  { keys: 'Alt/⌥/Ctrl+P', label: 'code block', code: 'p', tag: 'pre', alt: true },
] as const

const EXEC: Record<string, string> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
  s: 'strikeThrough',
}

function closestTag(node: Node | null, tag: string, root: HTMLElement) {
  const name = tag.toUpperCase()
  let current: Node | null = node
  while (current && current !== root) {
    if (current instanceof HTMLElement && current.tagName === name) return current
    current = current.parentNode
  }
  return null
}

function unwrap(el: HTMLElement) {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}

function placeCaret(node: Node, offset: number) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

function applyTag(root: HTMLElement, tag: string) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  if (!root.contains(sel.anchorNode)) return
  const command = EXEC[tag]
  if (command) {
    document.execCommand('styleWithCSS', false, 'false')
    document.execCommand(command)
    return
  }
  const existing = closestTag(sel.anchorNode, tag, root)
  if (existing && existing === closestTag(sel.focusNode, tag, root)) {
    unwrap(existing)
    return
  }
  const range = sel.getRangeAt(0)
  const el = document.createElement(tag)
  if (range.collapsed) {
    const marker = document.createTextNode('\u200b')
    el.appendChild(marker)
    range.insertNode(el)
    placeCaret(marker, 1)
    return
  }
  try {
    range.surroundContents(el)
  } catch {
    el.appendChild(range.extractContents())
    range.insertNode(el)
  }
  placeCaret(el, el.childNodes.length)
}

export const BroadcastEditor = memo(function BroadcastEditor({
  editorRef,
}: {
  editorRef: RefObject<HTMLDivElement | null>
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      document.execCommand('insertText', false, '\n')
      return
    }
    const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase()
    const root = editorRef.current
    if (!root || event.shiftKey) return
    if (event.altKey || event.ctrlKey) {
      const altShortcut = BROADCAST_SHORTCUTS.find((item) => 'alt' in item && item.alt && item.code === letter)
      if (altShortcut) {
        event.preventDefault()
        applyTag(root, altShortcut.tag)
        return
      }
    }
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (!mod) return
    const shortcut = BROADCAST_SHORTCUTS.find((item) => !('alt' in item && item.alt) && item.code === letter)
    if (!shortcut) return
    event.preventDefault()
    applyTag(root, shortcut.tag)
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  return (
    <div
      ref={editorRef}
      className="input admin-broadcast-input"
      contentEditable
      role="textbox"
      aria-multiline="true"
      spellCheck={false}
      data-placeholder="Message. Spaces and line breaks are sent as typed."
      suppressContentEditableWarning
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  )
})

export function readBroadcastEditor(editorRef: RefObject<HTMLDivElement | null>) {
  const root = editorRef.current
  return root ? serializeBroadcastDom(root) : ''
}
