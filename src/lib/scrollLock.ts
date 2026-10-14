let locks = 0
let scrollY = 0

function blockPageScroll(event: Event) {
  const target = event.target
  if (target instanceof Element && target.closest('.modal-panel, .mp-panel, .sidebar, #app-sidebar')) return
  event.preventDefault()
}

function blockPageKeys(event: KeyboardEvent) {
  const keys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']
  if (!keys.includes(event.key)) return
  const target = event.target
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], .modal-panel, .sidebar, #app-sidebar')) return
  event.preventDefault()
}

/**
 * Block background scrolling without changing overflow, position, width, or padding.
 * Any of those style writes shifts the sticky top bar by the scrollbar width.
 */
export function lockPageScroll() {
  locks += 1
  if (locks > 1) {
    return () => {
      locks = Math.max(0, locks - 1)
    }
  }
  scrollY = window.scrollY
  document.addEventListener('wheel', blockPageScroll, { passive: false })
  document.addEventListener('touchmove', blockPageScroll, { passive: false })
  document.addEventListener('keydown', blockPageKeys)
  return () => {
    locks = Math.max(0, locks - 1)
    if (locks > 0) return
    document.removeEventListener('wheel', blockPageScroll)
    document.removeEventListener('touchmove', blockPageScroll)
    document.removeEventListener('keydown', blockPageKeys)
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY)
  }
}
