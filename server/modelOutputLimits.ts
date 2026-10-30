const LUNA_MAX_OUTPUT_TOKENS = 128_000
const DEFAULT_MAX_OUTPUT_TOKENS = 1_048_576
const DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS = 393_216
const DEFAULT_MAX_INPUT_TOKENS = 1_000_000
const LUNA_MAX_INPUT_TOKENS = 900_000
const OUTPUT_TOKEN_FIELDS = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'] as const
const MIN_REASONING_OUTPUT_TOKENS = 1024

type UpstreamPath = 'chat/completions' | 'responses'

function isLunaModel(modelIds: readonly string[]) {
  return modelIds.some((modelId) => {
    const value = modelId.toLowerCase()
    return value === 'gpt/5.6-luna' || value.endsWith('/gpt-5.6-luna')
  })
}

function isReasoningModel(modelIds: readonly string[]) {
  return modelIds.some((modelId) => modelId.toLowerCase().includes('glm-5.3-flash'))
}

function maxOutputTokensForModel(modelIds: readonly string[]) {
  return modelIds.some((modelId) => modelId.toLowerCase().includes('deepseek-v4-pro'))
    ? DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS
    : DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * Reject output budgets that the selected upstream model cannot accept. This
 * keeps malformed client requests local instead of turning them into upstream
 * failures and operational alerts.
 */
export function validateModelOutputLimits(body: Record<string, unknown>, modelIds: readonly string[]) {
  const maxAllowed = maxOutputTokensForModel(modelIds)
  for (const field of OUTPUT_TOKEN_FIELDS) {
    if (!(field in body)) continue
    const value = Number(body[field])
    if (Number.isFinite(value) && value > maxAllowed) {
      return `${field}=${Math.floor(value)} exceeds this model's maximum output limit of ${maxAllowed}. Request fewer output tokens.`
    }
  }
  return null
}

function textCharCount(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textCharCount(item), 0)
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + textCharCount(item), 0)
  return 0
}

/**
 * Conservative local guard for model context windows. We reserve room for the
 * requested completion and tokenizer differences, so oversized prompts never
 * reach an upstream provider.
 */
export function validateModelInputLimits(body: Record<string, unknown>, modelIds: readonly string[]) {
  const maxAllowed = isLunaModel(modelIds) ? LUNA_MAX_INPUT_TOKENS : DEFAULT_MAX_INPUT_TOKENS
  const inputChars =
    textCharCount(body.messages) +
    textCharCount(body.input) +
    textCharCount(body.prompt) +
    textCharCount(body.state) +
    textCharCount(body.system) +
    (body.questions ? (typeof body.questions === 'string' ? body.questions.length : JSON.stringify(body.questions).length) : 0)
  const estimatedTokens = Math.ceil(inputChars / 4)
  if (estimatedTokens > maxAllowed) {
    return `The request is too large for this model. Shorten the conversation to stay within its ${maxAllowed.toLocaleString('en-US')}-token input limit.`
  }
  return null
}

/** Replace provider internals with an actionable, API-compatible client message. */
export function clientSafeUpstreamError(status: number, message: string) {
  const value = (message ?? '').toLowerCase()

  if (status === 400) {
    if (value.includes('contextwindowexceeded') || value.includes('input tokens exceed') || value.includes('maximum context length')) {
      return 'The request is too large for this model. Shorten the conversation or reduce max_tokens, then retry.'
    }
    if (value.includes('max_tokens') || value.includes('max output')) {
      return 'The requested output token limit is not supported by this model. Reduce max_tokens and retry.'
    }
    return 'The request is invalid for the selected model. Check its parameters and retry.'
  }

  // Every non-400 failure (rate limits, auth/quota, 5xx, provider internals such
  // as Google RESOURCE_EXHAUSTED JSON) gets the same generic client message:
  // upstream details never reach the caller.
  return 'The model is temporarily unavailable. Please try again later.'
}

function removeOutputLimits(payload: Record<string, unknown>) {
  let changed = false
  for (const field of OUTPUT_TOKEN_FIELDS) {
    if (field in payload) {
      delete payload[field]
      changed = true
    }
  }
  return changed
}

function applyLunaNativeOutputLimit(payload: Record<string, unknown>, path: UpstreamPath) {
  removeOutputLimits(payload)
  if (path === 'responses') payload.max_output_tokens = LUNA_MAX_OUTPUT_TOKENS
  else payload.max_tokens = LUNA_MAX_OUTPUT_TOKENS
  return payload
}

/**
 * Luna can spend a large part of its declared output budget on internal
 * reasoning and then return HTTP 400 instead of a truncated completion. Give
 * every Luna route its advertised native 128K output budget. Reservation and
 * billing still use the caller's original limit because normalization happens
 * only after token reservation.
 */
export function normalizeModelOutputLimits(
  payload: Record<string, unknown>,
  modelIds: readonly string[],
  path: UpstreamPath,
) {
  if (isLunaModel(modelIds)) applyLunaNativeOutputLimit(payload, path)

  // GLM Flash can spend the whole tiny client budget on internal reasoning,
  // returning content:null with finish_reason=length. Keep short completion
  // requests useful by reserving enough output budget for visible text. This is
  if (isReasoningModel(modelIds)) {
    for (const field of OUTPUT_TOKEN_FIELDS) {
      if (!(field in payload)) continue
      const value = Number(payload[field])
      if (Number.isFinite(value) && value > 0 && value < MIN_REASONING_OUTPUT_TOKENS) {
        payload[field] = MIN_REASONING_OUTPUT_TOKENS
      }
    }
  }
  return payload
}

export function isOutputLimitCompatibilityError(status: number, message: string) {
  if (status !== 400) return false
  const value = message.toLowerCase()
  return (
    value.includes('max_tokens or model output limit was reached') ||
    (value.includes('max_tokens') && value.includes('higher max_tokens'))
  )
}

/**
 * Retry other free models without a client output cap when upstream explicitly
 * says that cap was exhausted. Paid models retain their pre-authorized cap.
 */
export function isReasoningExhaustedResponse(data: Record<string, unknown>) {
  const warnings = data.warnings
  const hasWarning =
    Array.isArray(warnings) &&
    warnings.some(
      (warning) =>
        warning &&
        typeof warning === 'object' &&
        String((warning as Record<string, unknown>).code ?? '').toLowerCase() === 'reasoning_exhausted',
    )
  if (!hasWarning || !Array.isArray(data.choices) || data.choices.length === 0) return false

  return data.choices.some((choice) => {
    if (!choice || typeof choice !== 'object') return false
    const row = choice as Record<string, unknown>
    const message = row.message
    const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : undefined
    return (row.finish_reason === 'length' || row.finish_reason === 'max_tokens') && content == null
  })
}

export function raiseReasoningOutputLimit(payload: Record<string, unknown>) {
  let changed = false
  for (const field of OUTPUT_TOKEN_FIELDS) {
    if (!(field in payload)) continue
    const value = Number(payload[field])
    if (!Number.isFinite(value) || value < MIN_REASONING_OUTPUT_TOKENS * 2) {
      payload[field] = MIN_REASONING_OUTPUT_TOKENS * 2
      changed = true
    }
  }
  if (!changed && !OUTPUT_TOKEN_FIELDS.some((field) => field in payload)) {
    payload.max_tokens = MIN_REASONING_OUTPUT_TOKENS * 2
    changed = true
  }
  return changed
}

export function removeOutputLimitsForFreeRetry(
  payload: Record<string, unknown>,
  freeModel: boolean,
) {
  return freeModel && removeOutputLimits(payload)
}
