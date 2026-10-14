import { providerBrandIcon, providerSlug } from '../lib/providerStyle'

type ProviderIconProps = {
  provider: string
  size?: number
  className?: string
}

/** Renders the brand mark for known providers, or null. */
export function ProviderIcon({ provider, size = 20, className = '' }: ProviderIconProps) {
  const src = providerBrandIcon(provider)
  if (!src) return null
  const slug = providerSlug(provider)
  return (
    <img
      className={`provider-brand-icon provider-brand-icon-${slug} ${className}`.trim()}
      src={src}
      alt={provider}
      width={size}
      height={size}
      draggable={false}
    />
  )
}
