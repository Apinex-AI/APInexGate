/**
 * Published standard API list prices, per 1M tokens.
 * This gateway bills one flat rate; these stay split into input and output.
 * Only ids with a matching public price list are included.
 *
 * Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * OpenAI standard short context: https://developers.openai.com/api/docs/pricing
 * Z.ai GLM-5.3 list price after the Sept 9 2026 launch discount: $1.40 / $4.40, Flash $0.15 / $0.50
 * xAI Grok 4.7 starting rate: https://x.ai/news/grok-4-7
 * Kimi K3: https://platform.kimi.ai/docs/pricing/chat-k3
 * Gemini paid tier through 2026-12-31: https://ai.google.dev/gemini-api/docs/pricing
 * DeepSeek cache-miss off-peak–peak: https://api-docs.deepseek.com/quick_start/pricing/
 */
export type OfficialTokenPrice = {
  inputPer1M: number
  outputPer1M: number
  inputPer1MMax?: number
  outputPer1MMax?: number
}

export const OFFICIAL_TOKEN_PRICES: Record<string, OfficialTokenPrice> = {
  'claude-opus-5.5': { inputPer1M: 4, outputPer1M: 20 },
  'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
  'claude-fable-5.1': { inputPer1M: 10, outputPer1M: 50 },
  'claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'gpt-6-astra': { inputPer1M: 10, outputPer1M: 50 },
  'gpt-6-sol': { inputPer1M: 2, outputPer1M: 10 },
  'gpt-6-luna': { inputPer1M: 0.1, outputPer1M: 0.5 },
  'gpt-5.6-terra': { inputPer1M: 2, outputPer1M: 12 },
  'gpt-5.6-sol': { inputPer1M: 4, outputPer1M: 20 },
  'glm-5.3-flash': { inputPer1M: 0.15, outputPer1M: 0.5 },
  'glm-5.3': { inputPer1M: 1.4, outputPer1M: 4.4 },
  'grok-4.7': { inputPer1M: 2, outputPer1M: 6 },
  'kimi-k3': { inputPer1M: 3, outputPer1M: 15 },
  'gemini-3.8-flash': { inputPer1M: 0.75, outputPer1M: 3.75 },
  'gemini-3.1-pro': { inputPer1M: 2, outputPer1M: 12, inputPer1MMax: 4, outputPer1MMax: 18 },
  'deepseek-v4.1-flash': { inputPer1M: 0.15, outputPer1M: 0.6, inputPer1MMax: 0.3, outputPer1MMax: 1.2 },
  'deepseek-v4-flash': { inputPer1M: 0.15, outputPer1M: 0.6, inputPer1MMax: 0.3, outputPer1MMax: 1.2 },
  'deepseek-v4-pro': { inputPer1M: 0.66, outputPer1M: 1.98, inputPer1MMax: 1.32, outputPer1MMax: 3.96 },
  'minimax-m3': { inputPer1M: 0.3, outputPer1M: 1.2 },
  'mimo-v2.6-pro': { inputPer1M: 0.435, outputPer1M: 0.87 },
  'mimo-v2.6-flash': { inputPer1M: 0.14, outputPer1M: 0.28 },
  'claude-sonnet-4.6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-opus-4.6': { inputPer1M: 5, outputPer1M: 25 },
  'hy4': { inputPer1M: 0.834, outputPer1M: 2.501 },
  'qwen-3.8-max': { inputPer1M: 1.65, outputPer1M: 4.951 },
  'muse-spark-1.3': { inputPer1M: 1.25, outputPer1M: 4.25 },
}

const OFFICIAL_PRICE_ALIASES: Record<string, string> = {
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
}

export function officialPriceForModel(id: string): OfficialTokenPrice | null {
  const raw = id.startsWith('free/') ? id.slice('free/'.length) : id
  const key = OFFICIAL_PRICE_ALIASES[raw] ?? raw
  return OFFICIAL_TOKEN_PRICES[key] ?? null
}
