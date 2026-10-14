/** Models hidden from the admin catalog picker. */
export const CATALOG_MODEL_BLACKLIST = new Set<string>([
  // Anthropic
  'anthropic/claude-3-7-sonnet-20250219',
  'anthropic/claude-opus-4-1-20250805',
  'anthropic/claude-opus-4-5-20251101',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-opus-4-7',
  'anthropic/claude-sonnet-4-5-20250929',
  // OpenAI models outside the supported versioned GPT catalog
  'openai/o1',
  'openai/o1',
  'openai/o1-2024-12-17',
  'openai/o3',
  'openai/o3-2025-04-16',
  'openai/o3-mini',
  'openai/o3-mini-2025-01-31',
  'openai/o4-mini',
  'openai/o4-mini-2025-04-16',
  'openai/whisper-1',
  // xAI
  'xai/grok-4.5',
  // Google non-Gemini model families
  'google/gemma-3-12b-it',
  'google/gemma-3-27b-it',
  'google/gemma-3-4b-it',
  'google/gemma-4-26b-a4b-it',
  'google/gemma-4-31b-it',
])
