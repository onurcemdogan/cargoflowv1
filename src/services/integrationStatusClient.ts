// ENTEGRASYON DURUM PANOSU İSTEMCİSİ (PHASE2-E) — yalnız saklanmış durumu okur.
//
// Uç (`/api/integrations/catalog`) sağlayıcıya ÇAĞRI YAPMAZ. Üç alan ayrı
// gelir ve ayrı kalır: uygulama aşaması, yayın aşaması, bağlantı sağlığı.

export type ImplementationStage = 'production' | 'implemented' | 'in_development'
export type Availability = 'live' | 'internal_test' | 'in_development' | 'hidden'
export type ProviderKind = 'marketplace' | 'commerce_platform' | 'shipping'
export type ConnectionHealthState =
  | 'not_configured'
  | 'configured'
  | 'verified'
  | 'auth_error'
  | 'permission_error'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'disabled'
  | 'not_available'

export interface IntegrationStatusEntry {
  providerKey: string
  displayName: string
  kind: ProviderKind
  implementationStage: ImplementationStage
  rolloutStage: string
  availability: Availability
  health: {
    state: ConnectionHealthState
    configured: boolean
    verified: boolean
    lastVerifiedAt: string | null
    lastSuccessfulSyncAt: string | null
    accountCount: number
  }
}

export class IntegrationStatusUnavailableError extends Error {}

export async function fetchIntegrationStatus(): Promise<IntegrationStatusEntry[]> {
  let response: Response
  try {
    response = await fetch('/api/integrations/catalog', { credentials: 'include' })
  } catch {
    throw new IntegrationStatusUnavailableError('Entegrasyon durumu alınamadı.')
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    providers?: IntegrationStatusEntry[]
  } | null
  if (!response.ok || !payload?.ok || !Array.isArray(payload.providers)) {
    throw new IntegrationStatusUnavailableError('Entegrasyon durumu alınamadı.')
  }
  return payload.providers
}
