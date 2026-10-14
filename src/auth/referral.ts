import { getBrand } from '../lib/brand'

const REF_STORAGE_KEY = 'ref_code'
const REF_COOKIE = 'ref_code'
const REF_MAX_AGE = 60 * 60 * 24 * 30

const REF_RE = /^[A-Za-z0-9]{4,16}$/

function readCookie(name: string) {
  if (typeof document === 'undefined') return ''
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]!) : ''
}

export function buildReferralLink(code: string | null | undefined): string {
  const cleanCode = String(code ?? '').trim()
  const base = getBrand().siteUrl || (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base}/ref?=${cleanCode}`
}

/**
 * Extracts a referral code from a raw string or full referral URL.
 * Handles:
 * - Plain codes: "LJL5P5CN"
 * - Full links: "https://example.com/ref?=LJL5P5CN"
 * - Param links: "https://example.com/?ref=LJL5P5CN" or "?ref?=LJL5P5CN"
 */
export function sanitizeReferralInput(raw: string | null | undefined): string | null {
  const str = String(raw ?? '').trim()
  if (!str) return null

  // Check if it's already a clean code
  if (REF_RE.test(str)) {
    return str.toUpperCase()
  }

  // Check if it's a URL
  const match = str.match(/(?:[?&]ref\??=|\/ref\?=|\/ref\/)([A-Za-z0-9]{4,16})/i)
  if (match && match[1] && REF_RE.test(match[1])) {
    return match[1].toUpperCase()
  }

  try {
    const url = new URL(str, getBrand().siteUrl || 'http://127.0.0.1:5173')
    const params = url.searchParams
    const candidate = params.get('') || params.get('ref') || params.get('ref?') || params.get('r')
    if (candidate && REF_RE.test(candidate.trim())) {
      return candidate.trim().toUpperCase()
    }
  } catch {
    /* not a valid URL */
  }

  return null
}

export function persistReferralCode(raw: string | null | undefined, force = false): string | null {
  const existing = getStoredReferralCode()
  // Referral codes are immutable once locked in unless force is explicitly set
  if (existing && !force) {
    return existing
  }
  const code = sanitizeReferralInput(raw)
  if (!code || !REF_RE.test(code)) return null
  try {
    localStorage.setItem(REF_STORAGE_KEY, code)
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') {
    document.cookie = `${REF_COOKIE}=${encodeURIComponent(code)}; path=/; max-age=${REF_MAX_AGE}; SameSite=Lax`
  }
  return code
}

/**
 * Extracts referral code from window.location search / pathname.
 */
export function extractReferralCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const search = window.location.search || ''
  const pathname = window.location.pathname || ''
  const full = pathname + search

  // Match /ref?=CODE or ?ref?=CODE or ?ref=CODE
  const match = full.match(/(?:[?&]ref\??=|\/ref\?=|\/ref\/)([A-Za-z0-9]{4,16})/i)
  if (match && match[1] && REF_RE.test(match[1])) {
    return match[1].toUpperCase()
  }

  const params = new URLSearchParams(search)
  const candidate = params.get('') || params.get('ref') || params.get('ref?') || params.get('r')
  if (candidate && REF_RE.test(candidate.trim())) {
    return candidate.trim().toUpperCase()
  }

  if (pathname.replace(/\/$/, '') === '/ref') {
    const rawCode = search.replace(/^[?&=]+/, '').split('&')[0]
    if (rawCode && REF_RE.test(rawCode.trim())) {
      return rawCode.trim().toUpperCase()
    }
  }

  return null
}

/** Capture referral from the current URL into cookie + localStorage. */
export function captureReferralFromUrl(): string | null {
  const code = extractReferralCodeFromUrl()
  if (code) {
    return persistReferralCode(code)
  }
  return null
}

export function getStoredReferralCode(): string | null {
  try {
    const fromLs = localStorage.getItem(REF_STORAGE_KEY)?.trim()
    if (fromLs && REF_RE.test(fromLs)) return fromLs.toUpperCase()
  } catch {
    /* ignore */
  }
  const fromCookie = readCookie(REF_COOKIE).trim()
  if (fromCookie && REF_RE.test(fromCookie)) return fromCookie.toUpperCase()
  return null
}

export function clearStoredReferralCode() {
  try {
    localStorage.removeItem(REF_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') {
    document.cookie = `${REF_COOKIE}=; path=/; max-age=0; SameSite=Lax`
  }
}
