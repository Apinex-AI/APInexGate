export type BroadcastNode =
  | { type: 'text'; text: string }
  | { type: 'el'; tag: string; children: BroadcastNode[] }

const FORMAT: Record<string, string> = {
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  u: 'u',
  s: 's',
  strike: 's',
  del: 's',
  code: 'code',
  pre: 'pre',
}

function isBr(node: BroadcastNode) {
  return node.type === 'el' && node.tag.toLowerCase() === 'br'
}

/** Turn the editor DOM into the message we send, keeping every space and line break. */
export function serializeBroadcastNodes(nodes: BroadcastNode[]): string {
  let out = ''
  const walk = (node: BroadcastNode) => {
    if (node.type === 'text') {
      out += node.text.replace(/\u200b/g, '').replace(/\r/g, '')
      return
    }
    const tag = node.tag.toLowerCase()
    if (tag === 'br') {
      out += '\n'
      return
    }
    if (tag === 'div' || tag === 'p') {
      if (out.length > 0 && !out.endsWith('\n')) out += '\n'
      const blank = node.children.length === 0 || (node.children.length === 1 && isBr(node.children[0]))
      if (blank) {
        out += '\n'
        return
      }
      for (const child of node.children) walk(child)
      return
    }
    const fmt = FORMAT[tag]
    if (fmt) out += `<${fmt}>`
    for (const child of node.children) walk(child)
    if (fmt) out += `</${fmt}>`
  }
  for (const node of nodes) walk(node)
  return out
}

export function serializeBroadcastDom(root: HTMLElement): string {
  const convert = (node: Node): BroadcastNode | null => {
    if (node.nodeType === Node.TEXT_NODE) return { type: 'text', text: node.textContent ?? '' }
    if (!(node instanceof HTMLElement)) return null
    const children = [...node.childNodes].map(convert).filter((child): child is BroadcastNode => child != null)
    return { type: 'el', tag: node.tagName, children }
  }
  return serializeBroadcastNodes(
    [...root.childNodes].map(convert).filter((child): child is BroadcastNode => child != null),
  )
}
