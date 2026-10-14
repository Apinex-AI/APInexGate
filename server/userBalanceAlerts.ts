export function maybeNotifyUserLowBalance(_userId: string) {}
export function onUserBalanceCredited(_userId: string) {}
export function clearUserLowBalanceNotice(_userId: string) {}
export function getUserLowBalanceSettings(_userId: string) {
  return { enabled: false, levels: [], budgetBaseTokens: 0, balanceTokens: 0, spentPercent: 0, notifiedLevel: 0 }
}
export function setUserLowBalanceSettings(_userId: string, _settings: { enabled?: boolean }) {
  return { enabled: false, levels: [], budgetBaseTokens: 0, balanceTokens: 0, spentPercent: 0, notifiedLevel: 0 }
}
