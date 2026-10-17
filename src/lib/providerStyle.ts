/** Normalize provider names to CSS slug keys. */
export function providerSlug(provider: string) {
  const raw = provider.trim().toLowerCase().replace(/\s+/g, '-')
  if (raw === 'free') return 'free'
  if (
    raw === 'jev' ||
    raw === 'jev-group' ||
    raw === 'decisions' ||
    raw === 'decision' ||
    raw === 'typesafe' ||
    raw === 'subq' ||
    raw.startsWith('jev-')
  ) {
    return 'jev'
  }
  if (raw === 'codex' || raw === 'openai' || raw === 'gpt' || raw.startsWith('openai')) return 'openai'
  if (raw === 'google' || raw === 'gemini' || raw.startsWith('google')) return 'gemini'
  if (raw === 'claude' || raw === 'anthropic' || raw.startsWith('anthropic')) return 'anthropic'
  if (raw === 'kimi' || raw === 'moonshot' || raw.startsWith('moonshot')) return 'moonshot'
  if (raw === 'deepseek' || raw.startsWith('deepseek')) return 'deepseek'
  if (raw === 'zhipu' || raw === 'z-ai' || raw.includes('zhipu') || raw.includes('glm')) return 'zhipu'
  if (raw === 'xai' || raw === 'x-ai' || raw === 'grok' || raw.startsWith('grok') || raw.startsWith('xai')) return 'xai'
  if (raw === 'seedance' || raw.includes('seedance') || raw === 'bytedance' || raw.includes('bytedance')) return 'seedance'
  if (raw === 'tencent' || raw.includes('tencent') || raw === 'hunyuan' || raw === 'hy4') return 'tencent'
  if (raw === 'muse' || raw.includes('muse')) return 'muse'
  return raw.replace(/[^a-z0-9-]/g, '') || 'unknown'
}

/** Brand mark for known LLM providers (landing + dashboard + admin). */
export function providerBrandIcon(provider: string, modelId?: string | null): string | null {
  const slug = providerSlug(provider)
  if (modelId && slug === 'jev') {
    const m = modelId.trim().toLowerCase()
    if (m.includes('drex') || m.startsWith('nace/')) return '/brand/nace.png'
    if (m.includes('subq')) return '/brand/subq.png'
    if (m.includes('jev')) return '/brand/jev.png'
    if (m.includes('gpt') || m.includes('luna')) return '/brand/gpt.png'
  }
  switch (slug) {
    case 'free':
      return '/brand/mark.png'
    case 'openai':
      return '/brand/codex.png'
    case 'anthropic':
      return '/brand/claude.png'
    case 'gemini':
      return '/brand/gemini.png'
    case 'moonshot':
      return '/brand/moonshot.png'
    case 'deepseek':
      return '/brand/deepseek.png'
    case 'zhipu':
      return '/brand/zhipu.svg'
    case 'xai':
      return '/brand/grok.png'
    case 'seedance':
      return '/brand/bytedance.svg'
    case 'tencent':
      return '/brand/tencent.svg'
    case 'muse':
      return '/brand/muse.svg'
    case 'jev':
      return '/brand/jev.png'
    default:
      return null
  }
}
