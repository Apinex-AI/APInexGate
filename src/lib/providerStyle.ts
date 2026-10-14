/** Normalize provider names to CSS slug keys. */
export function providerSlug(provider: string) {
  const raw = provider.trim().toLowerCase().replace(/\s+/g, '-')
  if (raw === 'free') return 'free'
  if (raw === 'codex' || raw === 'openai' || raw === 'gpt' || raw.startsWith('openai')) return 'openai'
  if (raw === 'google' || raw === 'gemini' || raw.startsWith('google')) return 'gemini'
  if (raw === 'claude' || raw === 'anthropic' || raw.startsWith('anthropic')) return 'anthropic'
  if (raw === 'kimi' || raw === 'moonshot' || raw.startsWith('moonshot')) return 'moonshot'
  if (raw === 'deepseek' || raw.startsWith('deepseek')) return 'deepseek'
  if (raw === 'zhipu' || raw === 'z-ai' || raw.includes('zhipu') || raw.includes('glm')) return 'zhipu'
  if (raw === 'xai' || raw === 'x-ai' || raw === 'grok' || raw.startsWith('grok') || raw.startsWith('xai')) return 'xai'
  if (raw === 'seedance' || raw.includes('seedance') || raw === 'bytedance' || raw.includes('bytedance')) return 'seedance'
  if (raw === 'tencent' || raw.includes('tencent') || raw === 'hunyuan') return 'tencent'
  if (raw === 'muse' || raw.includes('muse')) return 'muse'
  return raw.replace(/[^a-z0-9-]/g, '') || 'unknown'
}

/** Brand mark for known LLM providers (landing + dashboard + admin). */
export function providerBrandIcon(provider: string): string | null {
  switch (providerSlug(provider)) {
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
    default:
      return null
  }
}
