// HEPSIBURADA OKUMA SENKRONU — hesap kapsamlı, SINIRLI, yalnız-okuma.
//
// ═══ PENCERE MODELİ ══════════════════════════════════════════════════════
//
//   imleç (KANONİK depoya yazılmış son pencere sonu) ──► SABİT üst sınır
//   Aralık, imleçten başlayarak boşluksuz dilimlere bölünür (en eski önce):
//     PAKET ailesi ≤ 24 saat (resmî uyarı), SİPARİŞ ailesi ≤ 7 gün
//     (savunmacı tavan; sözleşme üst sınır kanıtlamaz). Koşu başına en fazla
//     HEPSIBURADA_MAX_WINDOWS_PER_RUN dilim; kalan aralık sonraki koşuda
//     işlenir. Başlangıç ASLA ileri kırpılmaz — kırpma imleç ile kırpılmış
//     başlangıç arasını kalıcı olarak atlardı.
//   Her pencerede offset/limit, pencere başına SINIRLI sayfa.
//
// İmleç "bu ana kadar KANONİK depoda" demektir: YALNIZ tam okuma + kanonik
// yazım tamamlandığında ilerler. Kısmi/başarısız koşu ve kanonik yazımın
// KAPALI olduğu koşu (iç test) imleci İLERLETMEZ; aksi halde aşama açıldığında
// iç testte okunmuş pencereler bir daha istenmez (kalıcı eksik sipariş).
//
// ═══ CANLI YAZMA KAPISI ══════════════════════════════════════════════════
//
// Kanonik yazım `liveWriteGate` ile YAYIN AŞAMASINDAN karar verilir.
// Hepsiburada `internal_test`tir: okuma, normalizasyon ve sağlık çalışır;
// kanonik sipariş yazımı ve karşılama yan etkileri (etiket/taşıyıcı/baskı)
// canlı doğrulama + aşama kararı olmadan ÇAĞRILMAZ.
import { recordSyncState } from '../../onboarding/onboardingRepository.ts'
import { canPersistCanonicalOrders, type LiveWriteGateResult } from '../liveWriteGate.ts'
import { HB_CANONICAL_WRITE_BLOCKED, HB_PERSIST_INCOMPLETE } from './hepsiburadaHealth.ts'
import {
  HEPSIBURADA_DEFAULT_ORDER_WINDOW_MS,
  HEPSIBURADA_MAX_LIMIT,
  HEPSIBURADA_PACKAGE_WINDOW_MAX_MS,
  hasNextHepsiburadaPage,
  normalizeHepsiburadaOrders,
  type NormalizedHepsiburadaOrder,
} from '../../marketplaces/hepsiburada/hepsiburadaOrderSource.ts'
import {
  fetchHepsiburadaPage,
  type HepsiburadaClientOptions,
  type HepsiburadaErrorClass,
} from './hepsiburadaClient.ts'
import {
  HEPSIBURADA_PROVIDER_KEY,
  resolveReadFamily,
  type HepsiburadaConnectorConfig,
  type HepsiburadaFamily,
} from './hepsiburadaConfig.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const HEPSIBURADA_SYNC_PAGE_LIMIT = HEPSIBURADA_MAX_LIMIT
/** Pencere başına sayfa tavanı: 50 × 100 = 5.000 kayıt/pencere. */
export const HEPSIBURADA_MAX_PAGES_PER_WINDOW = 50
/** Koşu başına 24 saatlik dilim tavanı (paket ailesi). */
export const HEPSIBURADA_MAX_WINDOWS_PER_RUN = 7
/** İlk koşu (imleç yokken) geriye bakış. */
export const HEPSIBURADA_INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

export type HepsiburadaFetchOutcome = 'SUCCESS' | 'PARTIAL' | 'FAILED'

export interface HepsiburadaWindow {
  startMs: number
  endMs: number
}

/**
 * Okuma pencereleri. Saf ve deterministik: aynı girdi AYNI dilimleri verir.
 */
export function planHepsiburadaWindows(params: {
  family: HepsiburadaFamily
  fromMs: number | null
  upperBoundMs: number
  maxWindows?: number
}): { windows: HepsiburadaWindow[]; moreRemaining: boolean } {
  const upper = params.upperBoundMs
  const from = params.fromMs ?? upper - HEPSIBURADA_INITIAL_LOOKBACK_MS
  const sliceMs = params.family === 'PACKAGES'
    ? HEPSIBURADA_PACKAGE_WINDOW_MAX_MS
    : HEPSIBURADA_DEFAULT_ORDER_WINDOW_MS
  const maxWindows = Math.max(1, params.maxWindows ?? HEPSIBURADA_MAX_WINDOWS_PER_RUN)
  const windows: HepsiburadaWindow[] = []
  let start = Math.min(from, upper)
  while (start < upper && windows.length < maxWindows) {
    const end = Math.min(start + sliceMs, upper)
    windows.push({ startMs: start, endMs: end })
    start = end
  }
  if (windows.length === 0) windows.push({ startMs: upper - 1, endMs: upper })
  return { windows, moreRemaining: start < upper }
}

/** Kayıt tekilleştirme anahtarı: paket önce, yoksa sipariş kimliği. */
function recordKey(row: Record<string, unknown>): string {
  return String(row.packageNumber ?? '').trim()
    || String(row.orderId ?? '').trim()
    || String(row.orderNumber ?? '').trim()
}

export interface HepsiburadaFetchAllResult {
  outcome: HepsiburadaFetchOutcome
  rawRecords: Record<string, unknown>[]
  pagesFetched: number
  networkCalls: number
  errorClass: HepsiburadaErrorClass | null
  reasonCode: string | null
  /** Tamamen işlenen son pencerenin sonu (imleç adayı). */
  completedThroughMs: number | null
}

export async function fetchAllHepsiburadaRecords(
  config: HepsiburadaConnectorConfig,
  family: HepsiburadaFamily,
  windows: HepsiburadaWindow[],
  options: HepsiburadaClientOptions & { pageLimit?: number; maxPagesPerWindow?: number },
): Promise<HepsiburadaFetchAllResult> {
  const limit = Math.min(HEPSIBURADA_MAX_LIMIT, Math.max(1, options.pageLimit ?? HEPSIBURADA_SYNC_PAGE_LIMIT))
  const maxPages = Math.max(1, options.maxPagesPerWindow ?? HEPSIBURADA_MAX_PAGES_PER_WINDOW)
  const rawRecords: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let pagesFetched = 0
  let networkCalls = 0
  let completedThroughMs: number | null = null

  const stop = (errorClass: HepsiburadaErrorClass, reasonCode: string): HepsiburadaFetchAllResult => ({
    outcome: pagesFetched > 0 ? 'PARTIAL' : 'FAILED',
    rawRecords,
    pagesFetched,
    networkCalls,
    errorClass,
    reasonCode,
    completedThroughMs,
  })

  for (const window of windows) {
    let offset = 0
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) return stop('PROVIDER_UNAVAILABLE', 'HB_PAGE_LIMIT_REACHED')
      const result = await fetchHepsiburadaPage(
        config,
        { family, offset, limit, startMs: window.startMs, endMs: window.endMs },
        options,
      )
      networkCalls += result.networkCalls
      if (!result.ok) return stop(result.errorClass, result.reasonCode)
      pagesFetched += 1
      for (const row of result.rows) {
        const key = recordKey(row)
        if (key !== '' && seen.has(key)) continue
        if (key !== '') seen.add(key)
        rawRecords.push(row)
      }
      if (!hasNextHepsiburadaPage({ returnedCount: result.rows.length, limit })) break
      offset += limit
    }
    completedThroughMs = window.endMs
  }
  return {
    outcome: 'SUCCESS', rawRecords, pagesFetched, networkCalls,
    errorClass: null, reasonCode: null, completedThroughMs,
  }
}

export type HepsiburadaCanonicalPersister = (orders: NormalizedHepsiburadaOrder[]) => Promise<unknown>

export interface HepsiburadaSyncResult {
  outcome: HepsiburadaFetchOutcome
  family: HepsiburadaFamily | null
  errorClass: HepsiburadaErrorClass | null
  reasonCode: string | null
  networkCalls: number
  pagesFetched: number
  windows: HepsiburadaWindow[]
  moreRemaining: boolean
  fetchedCount: number
  normalizedCount: number
  merchantMismatchCount: number
  canonicalWrite: LiveWriteGateResult['decision']
  canonicalPersisted: boolean
  persistResult: unknown
  checkpointAdvanced: boolean
  checkpointMs: number | null
}

const STATUS: Record<HepsiburadaFetchOutcome, 'success' | 'partial' | 'failed'> = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
}

/**
 * Bir Hepsiburada hesabının okuma koşusu.
 *
 * `upperBoundMs` çağıran tarafından koşu başında SABİTLENİR. Yol/kimlik
 * yoksa ağ çağrısı YAPILMAZ ve durum `failed` olarak kaydedilir.
 */
export async function syncHepsiburadaOrdersForAccount(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    config: HepsiburadaConnectorConfig
    fromMs: number | null
    upperBoundMs: number
    persistCanonical?: HepsiburadaCanonicalPersister
    /** Test/aşama enjeksiyonu; varsayılan yayın aşaması kapısı. */
    liveWriteGate?: (providerKey: string) => LiveWriteGateResult
    maxWindows?: number
  },
  options: HepsiburadaClientOptions & { pageLimit?: number; maxPagesPerWindow?: number },
): Promise<HepsiburadaSyncResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('organizationId ve marketplaceAccountId zorunludur.')
  }
  if (!Number.isSafeInteger(params.upperBoundMs) || params.upperBoundMs <= 0) {
    throw new Error('upperBoundMs geçerli bir epoch milisaniye olmalıdır.')
  }
  const gateFn = params.liveWriteGate ?? canPersistCanonicalOrders
  const gate = gateFn(HEPSIBURADA_PROVIDER_KEY)
  const family = resolveReadFamily(params.config)

  const base = {
    family,
    networkCalls: 0,
    pagesFetched: 0,
    windows: [] as HepsiburadaWindow[],
    moreRemaining: false,
    fetchedCount: 0,
    normalizedCount: 0,
    merchantMismatchCount: 0,
    canonicalWrite: gate.decision,
    canonicalPersisted: false,
    persistResult: null as unknown,
    checkpointAdvanced: false,
    checkpointMs: null as number | null,
  }

  // FAIL-CLOSED: yol yoksa İSTEK KURULMAZ.
  if (!family) {
    await recordSyncState(db, organizationId, {
      provider: HEPSIBURADA_PROVIDER_KEY,
      resource: 'orders',
      status: 'failed',
      fetchedCount: 0,
      errorCode: 'HB_ENDPOINT_CONFIG_REQUIRED',
      marketplaceAccountId,
      successfulSyncAt: null,
    })
    return { ...base, outcome: 'FAILED', errorClass: 'ENDPOINT_CONFIG_REQUIRED', reasonCode: 'HB_ENDPOINT_PATH_UNVERIFIED' }
  }

  const plan = planHepsiburadaWindows({
    family,
    fromMs: params.fromMs,
    upperBoundMs: params.upperBoundMs,
    maxWindows: params.maxWindows,
  })
  const fetched = await fetchAllHepsiburadaRecords(params.config, family, plan.windows, options)
  const normalization = normalizeHepsiburadaOrders(fetched.rawRecords)

  // Başka satıcının kaydı dönmüşse YAZILMAZ ve koşu başarılı SAYILMAZ.
  const ownOrders = normalization.orders.filter(
    (order) => order.merchantId === '' || order.merchantId === params.config.merchantId,
  )
  const merchantMismatchCount = normalization.orders.length - ownOrders.length
  let outcome: HepsiburadaFetchOutcome = fetched.outcome
  let errorClass = fetched.errorClass
  let reasonCode = fetched.reasonCode
  if (outcome === 'SUCCESS' && merchantMismatchCount > 0) {
    outcome = 'PARTIAL'
    errorClass = 'REQUEST_REJECTED'
    reasonCode = 'HB_MERCHANT_MISMATCH'
  }

  // Kısmi okumada çekilen kayıtlar da YAZILABİLİR: `complete:false` olduğu
  // için hiçbir mevcut sipariş arşivlenmez; upsert idempotenttir.
  let canonicalPersisted = false
  let persistResult: unknown = null
  if (gate.decision === 'ALLOWED' && params.persistCanonical && ownOrders.length > 0 && outcome !== 'FAILED') {
    persistResult = await params.persistCanonical(ownOrders)
    canonicalPersisted = true
  }

  // İmleç yalnız okunan aralık KANONİK depoya eksiksiz yazıldıysa ilerler.
  // `recordSyncState` imleci yalnız `success`te yazar (yoksa `now`!); bu
  // yüzden yazılmamış başarılı okuma `partial` + sebep koduyla kaydedilir.
  const persistFailed = Number((persistResult as { failed?: unknown } | null)?.failed ?? 0)
  const durable =
    gate.decision === 'ALLOWED' &&
    fetched.completedThroughMs !== null &&
    (ownOrders.length === 0 || (canonicalPersisted && persistFailed === 0))
  let status = STATUS[outcome]
  let stateErrorCode = reasonCode
  if (status === 'success' && !durable) {
    status = 'partial'
    stateErrorCode = gate.decision === 'ALLOWED' && params.persistCanonical
      ? HB_PERSIST_INCOMPLETE
      : HB_CANONICAL_WRITE_BLOCKED
  }
  const checkpointAdvanced = status === 'success'
  await recordSyncState(db, organizationId, {
    provider: HEPSIBURADA_PROVIDER_KEY,
    resource: 'orders',
    status,
    fetchedCount: ownOrders.length,
    errorCode: stateErrorCode,
    marketplaceAccountId,
    successfulSyncAt: checkpointAdvanced ? new Date(fetched.completedThroughMs as number) : null,
  })

  return {
    outcome,
    family,
    errorClass,
    reasonCode,
    networkCalls: fetched.networkCalls,
    pagesFetched: fetched.pagesFetched,
    windows: plan.windows,
    moreRemaining: plan.moreRemaining,
    fetchedCount: fetched.rawRecords.length,
    normalizedCount: ownOrders.length,
    merchantMismatchCount,
    canonicalWrite: gate.decision,
    canonicalPersisted,
    persistResult,
    checkpointAdvanced,
    checkpointMs: checkpointAdvanced ? fetched.completedThroughMs : null,
  }
}
