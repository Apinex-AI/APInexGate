import { useEffect, useState } from 'react'
import { SITE_LINK_DEFAULTS, type SiteLinks } from '../../shared/siteLinks'

let cached: SiteLinks | null = null
let inflight: Promise<SiteLinks> | null = null

export function loadSiteLinks() {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = fetch('/api/public/links')
    .then(async (res) => {
      if (!res.ok) throw new Error('links unavailable')
      const data = (await res.json()) as Partial<SiteLinks>
      cached = {
        telegram: typeof data.telegram === 'string' ? data.telegram : SITE_LINK_DEFAULTS.telegram,
        x: typeof data.x === 'string' ? data.x : SITE_LINK_DEFAULTS.x,
        telegramSupport:
          typeof data.telegramSupport === 'string' ? data.telegramSupport : SITE_LINK_DEFAULTS.telegramSupport,
      }
      return cached
    })
    .catch(() => SITE_LINK_DEFAULTS)
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useSiteLinks() {
  const [links, setLinks] = useState<SiteLinks>(cached ?? SITE_LINK_DEFAULTS)
  useEffect(() => {
    let cancelled = false
    void loadSiteLinks().then((next) => {
      if (!cancelled) setLinks(next)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return links
}
