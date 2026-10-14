/** Consumer mailbox domains allowed for self-serve registration. */
export const ALLOWED_EMAIL_DOMAINS = [
  // Google
  'gmail.com',
  'googlemail.com',
  // Proton
  'proton.me',
  'protonmail.com',
  'pm.me',
  // Microsoft
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Yahoo
  'yahoo.com',
  'ymail.com',
  // QQ / NetEase (CN)
  'qq.com',
  '163.com',
  '126.com',
  // Mail.ru
  'mail.ru',
  'inbox.ru',
  'bk.ru',
  'list.ru',
  // Yandex
  'yandex.ru',
  'yandex.com',
  'ya.ru',
  // Others
  'gmx.com',
  'gmx.net',
  'aol.com',
  'tutanota.com',
  'tuta.com',
] as const

const allowedSet = new Set<string>(ALLOWED_EMAIL_DOMAINS)

export function emailDomain(email: string) {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return null
  return email.slice(at + 1).trim().toLowerCase()
}

export function isAllowedEmailDomain(email: string) {
  const domain = emailDomain(email)
  return domain !== null && allowedSet.has(domain)
}

export const ALLOWED_EMAIL_DOMAINS_HINT =
  'Use a personal inbox like Gmail, Proton, Outlook, iCloud, Yahoo, QQ, Mail.ru, etc.'
