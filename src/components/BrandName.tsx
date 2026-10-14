import { useBrand } from '../lib/brand'

export function BrandName() {
  return <>{useBrand().name}</>
}
