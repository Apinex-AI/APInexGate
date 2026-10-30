/**
 * Model ID & Model Name validation and defense-in-depth sanitization.
 * Implements H-01 remediation points 5 & 6.
 */

/**
 * Valid model ID pattern:
 * - Length: 1 to 128 characters
 * - Starts with an alphanumeric character [a-zA-Z0-9]
 * - Followed by up to 127 characters from [a-zA-Z0-9._:/-]
 */
export const MODEL_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/

export function isValidModelId(id: unknown): id is string {
  return typeof id === 'string' && MODEL_ID_REGEX.test(id)
}

/**
 * Characters strictly forbidden in model names to prevent command injection,
 * shell expansion, subshell execution, script breakout, and control sequence injection:
 * - $ (dollar / command substitution: $(cmd), ${VAR})
 * - ` (backtick / command substitution: `cmd`)
 * - ; (semicolon / command separator)
 * - | (pipe / pipeline separator)
 * - & (ampersand / background, conditional operator)
 * - < (less-than / input redirection)
 * - > (greater-than / output redirection)
 * - \ (backslash / escaping, line continuation)
 * - " (double quote / shell quoting breakout)
 * - \x00-\x1F, \x7F-\x9F (ASCII & Latin-1 control characters, null byte, newlines \r \n)
 * - \u2028, \u2029 (Unicode line & paragraph separators)
 */
export const FORBIDDEN_NAME_CHARS_REGEX = /[\$`;&|<>\\"\x00-\x1F\x7F-\x9F\u2028\u2029]/
export const FORBIDDEN_NAME_CHARS_GLOBAL_REGEX = /[\$`;&|<>\\"\x00-\x1F\x7F-\x9F\u2028\u2029]/g

/**
 * Validates a model name.
 * - Must be a non-empty string between 1 and 128 characters (after trimming).
 * - Must not contain control characters, newlines, null bytes, or dangerous shell metacharacters:
 *   $, `, ;, |, &, <, >, \, "
 */
export function isValidModelName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 128) return false
  if (FORBIDDEN_NAME_CHARS_REGEX.test(name)) return false
  return true
}

/**
 * Derives a human-readable display name from a model ID.
 * Produces clean, safe titles (letters, numbers, spaces).
 */
export function displayNameFromId(modelId: string): string {
  const leaf = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId
  const safeLeaf = leaf.replace(/[^a-zA-Z0-9._:-]/g, '')
  return safeLeaf
    .split('-')
    .map((part) => (part.length <= 2 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .trim() || 'Unnamed Model'
}

/**
 * Sanitizes an untrusted model name (e.g. from an upstream catalog response):
 * - Replaces newlines/carriage returns/tabs with spaces
 * - Strips dangerous shell metacharacters and control characters
 * - Normalizes consecutive whitespace
 * - Clamps to max 128 characters
 * - Falls back to displayNameFromId(fallbackModelId) or 'Unnamed Model' if the resulting name is empty
 */
export function sanitizeModelName(rawName: unknown, fallbackModelId?: string): string {
  const fallback = fallbackModelId ? displayNameFromId(fallbackModelId) : 'Unnamed Model'
  if (typeof rawName !== 'string') return fallback

  const noNewlines = rawName.replace(/[\r\n\t]+/g, ' ')
  const stripped = noNewlines.replace(FORBIDDEN_NAME_CHARS_GLOBAL_REGEX, '')
  const cleaned = stripped.replace(/\s+/g, ' ').trim()
  if (!cleaned) return fallback

  const clamped = cleaned.slice(0, 128).trim()
  return clamped || fallback
}
