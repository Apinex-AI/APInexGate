export type ModelHealthStatus = 'live' | 'partial' | 'unavailable' | 'no_data'

export function setModelHealthOverride(_modelId: string, _status: ModelHealthStatus | null) {}

export function matchStatuses(
  _parsed: Array<{ name: string; status: ModelHealthStatus }>,
  _catalog: Array<{ id: string; upstream_id?: string | null; name: string }>,
) {
  return { byModelId: {} as Record<string, ModelHealthStatus>, matched: 0 }
}

export async function refreshAllModelStatuses(_force = false) {}
export async function refreshModelStatuses(_force = false) {}

export function rematchCachedStatuses() {}
export function getTelemetryModelStatuses(): Record<string, ModelHealthStatus> {
  return {}
}
export function getModelStatusMap(): Record<string, ModelHealthStatus> {
  return {}
}
export function getModelStatusMeta() {
  return { checkedAt: null as string | null, source: null as string | null, rawCount: 0, matchedCount: 0 }
}
export function startModelStatusPoller() {}
