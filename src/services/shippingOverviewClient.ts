// KARGO OPERASYONLARI + GÖNDERİLER İSTEMCİSİ — yalnız saklanmış durumu okur.
//
// Uçlar (`/api/shipping/pipeline`, `/api/shipping/shipments`) taşıyıcıya veya
// pazaryerine ÇAĞRI YAPMAZ ve hiçbir şey yazmaz. Hata SAHTE "0" ile
// gizlenmez: çağıran `ShippingOverviewUnavailableError` alır ve açıkça yazar.

export class ShippingOverviewUnavailableError extends Error {}

export interface PipelineAttentionRow {
  kind: 'BLOCKED' | 'UNKNOWN_AFTER_NETWORK' | 'OPERATION_FAILED' | 'OPERATION_UNCERTAIN' | 'UNVERIFIED'
  orderId: string | null
  orderNumber: string
  packageId: string
  marketplace: string
  reason: string
  updatedAt: string | null
}

export interface PipelineRecentRow {
  orderId: string | null
  orderNumber: string
  packageId: string
  marketplace: string
  carrier: string
  stage: string
  stageTone: 'success' | 'warning' | 'danger' | 'neutral'
  labelState: 'ready' | 'printed' | 'none'
  trackingNumber: string | null
  updatedAt: string | null
  canReprint: boolean
  hasShipment: boolean
}

export interface ShippingPipeline {
  summary: {
    queued: number
    preparing: number
    labelReady: number
    needsAttention: number
    createdToday: number
    handedToday: number
  }
  worker: {
    backgroundEnabled: boolean
    workspaceEnabled: boolean
    counts: Record<'QUEUED' | 'PREPARING' | 'READY' | 'BLOCKED' | 'UNKNOWN_AFTER_NETWORK' | 'FAILED_SAFE_TO_RETRY', number>
    lastPreparedAt: string | null
    averagePrepSeconds: number | null
    sampleSize: number
  }
  attention: PipelineAttentionRow[]
  recent: PipelineRecentRow[]
}

export type ShipmentTab = 'all' | 'label_ready' | 'in_transit' | 'delivered' | 'attention'

export interface ShipmentLedgerRow {
  shipmentId: string
  orderId: string | null
  orderNumber: string
  packageId: string
  marketplace: string
  carrier: string
  trackingNumber: string | null
  lifecycle: Exclude<ShipmentTab, 'all'> | 'created'
  lifecycleLabel: string
  labelState: 'ready' | 'printed' | 'none'
  payer: string
  carrierAccount: string | null
  createdAt: string | null
  lastActivityAt: string | null
  canReprint: boolean
}

export interface ShipmentLedgerQuery {
  tab?: ShipmentTab
  provider?: string
  marketplace?: string
  labelState?: 'ready' | 'printed' | 'none' | ''
  search?: string
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

export interface ShipmentLedgerResult {
  rows: ShipmentLedgerRow[]
  total: number
  counts: Record<ShipmentTab, number>
  page: number
  pageSize: number
}

async function getJson<T>(url: string, fallbackMessage: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'include' })
  } catch {
    throw new ShippingOverviewUnavailableError(fallbackMessage)
  }
  const payload = (await response.json().catch(() => null)) as (T & { ok?: boolean; message?: string }) | null
  if (!response.ok || !payload || payload.ok === false) {
    throw new ShippingOverviewUnavailableError(String(payload?.message ?? fallbackMessage))
  }
  return payload
}

export function fetchShippingPipeline(): Promise<ShippingPipeline> {
  return getJson<ShippingPipeline>('/api/shipping/pipeline', 'Kargo operasyon özeti yüklenemedi.')
}

export function fetchShipmentLedger(query: ShipmentLedgerQuery = {}): Promise<ShipmentLedgerResult> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const suffix = params.toString()
  return getJson<ShipmentLedgerResult>(`/api/shipping/shipments${suffix ? `?${suffix}` : ''}`, 'Gönderiler yüklenemedi.')
}
