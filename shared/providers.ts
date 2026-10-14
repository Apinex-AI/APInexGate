/** Preferred provider order for customer Models UI, landing, and admin filters. */
export const PROVIDER_ORDER = [
  'Free',
  'GPT',
  'Claude',
  'Gemini',
  'Kimi',
  'DeepSeek',
  'GLM',
  'Grok',
  'Tencent',
  'Muse',
] as const

export function normalizeProviderName(provider: string) {
  const raw = provider.trim()
  const slug = raw.toLowerCase()
  if (slug === 'free') return 'Free'
  if (slug === 'grok' || slug === 'xai' || slug.startsWith('xai') || slug.startsWith('grok')) return 'Grok'
  if (slug === 'google' || slug.startsWith('google')) return 'Gemini'
  if (slug === 'openai' || slug === 'gpt' || slug.startsWith('openai')) return 'GPT'
  if (slug === 'anthropic' || slug === 'claude' || slug.startsWith('anthropic')) return 'Claude'
  if (slug === 'moonshot' || slug === 'kimi' || slug.startsWith('moonshot')) return 'Kimi'
  if (slug === 'z-ai' || slug === 'zhipu' || slug.includes('zhipu') || slug.includes('glm')) return 'GLM'
  if (slug.includes('deepseek')) return 'DeepSeek'
  if (slug === 'tencent' || slug.includes('tencent') || slug === 'hunyuan') return 'Tencent'
  if (slug === 'muse' || slug.includes('muse')) return 'Muse'
  const ordered = PROVIDER_ORDER.find((name) => name.toLowerCase() === slug)
  return ordered ?? raw
}

export function providerSortIndex(provider: string) {
  const normalized = normalizeProviderName(provider)
  const exact = PROVIDER_ORDER.indexOf(normalized as (typeof PROVIDER_ORDER)[number])
  if (exact >= 0) return exact
  const slug = provider.trim().toLowerCase()
  const bySlug = PROVIDER_ORDER.findIndex((name) => name.toLowerCase() === slug)
  if (bySlug >= 0) return bySlug
  return 999
}

export function sortProviders(providers: string[]) {
  return [...providers].sort((a, b) => {
    const diff = providerSortIndex(a) - providerSortIndex(b)
    return diff !== 0 ? diff : a.localeCompare(b)
  })
}

/** Upstream provider types stored in admin (internal LLM providers only). */
export const UPSTREAM_PROVIDERS = [
  'apinex',
] as const

export const ALL_UPSTREAM_PROVIDERS = ['apinex'] as const

export type UpstreamProvider = string

export function isUpstreamProvider(value: string): value is 'apinex' {
  return value === 'apinex'
}

export const UPSTREAM_PROVIDER_LABELS: Record<string, string> = {
  apinex: 'APInex',
}


