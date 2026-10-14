import { createContext, useContext, type ReactNode } from 'react'
import type { CustomerUser } from '../auth/userApi'

type CustomerContextValue = {
  user: CustomerUser
  logout: () => Promise<void>
  refresh: (patchUser?: CustomerUser) => Promise<void>
}

export const CustomerContext = createContext<CustomerContextValue | null>(null)

export function CustomerProvider({
  value,
  children,
}: {
  value: CustomerContextValue
  children: ReactNode
}) {
  return <CustomerContext.Provider value={value}>{children}</CustomerContext.Provider>
}

export function useCustomer() {
  const ctx = useContext(CustomerContext)
  if (!ctx) throw new Error('useCustomer must be used within CustomerProvider')
  return ctx
}
