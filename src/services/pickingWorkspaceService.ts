import type {
  PickingQuery,
  PickingWorkspaceResult,
} from '../dashboard/pickingWorkspace'

/** Persisted canonical state only. This GET never syncs a provider or creates labels. */
export async function fetchPickingWorkspace(
  query: PickingQuery,
): Promise<PickingWorkspaceResult> {
  const params = new URLSearchParams({ page: String(query.page ?? 0) })
  if (query.search) params.set('search', query.search)
  if (query.stage) params.set('stage', query.stage)
  const response = await fetch(`/api/picking/products?${params}`, {
    credentials: 'include',
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok)
    throw new Error('Toplama listesi yüklenemedi.')
  return payload.result
}
