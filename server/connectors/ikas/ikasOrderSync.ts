// IKAS SİPARİŞ MUTABAKATI — `updatedAt` EKSENİ, SABİT ÜST SINIR.
//
// ═══ DOĞRULUK MODELİ ═════════════════════════════════════════════════════
//
// ikas webhook imzası belgelenmediği için webhook YOKTUR; doğruluk YALNIZ
// yoklama mutabakatından gelir:
//
//   son başarılı imleç ──► SABİT üst sınır (koşu başında bir kez alınır)
//   listOrder(updatedAt ≥ imleç AND ≤ üst sınır)
//   hasNext bitene kadar TAM sayfalama
//   kararlı `order.id` ile tekilleştirme
//   YALNIZ TAM başarıda: imleç = üst sınır
//
// Sayfa başına "şimdi" KULLANILMAZ (pencere kayardı). Kısmi/başarısız koşu
// imleci İLERLETMEZ; önceki imleçteki sınır örtüşmesi tekilleştirmeyle
// zararsızdır. Sıralama dizgesi belgelenmediği için doğruluk sıralamaya
// DAYANMAZ.
//
// ═══ CANLI YAZMA KAPISI ══════════════════════════════════════════════════
//
// Kanonik yazım `liveWriteGate` ile YAYIN AŞAMASINDAN karar verilir —
// sağlayıcı adına bakılarak DEĞİL. `internal_test` canlı davranışı
// etkilemez: normalleştirme ve sağlık güncellenir, kanonik kalıcılaştırıcı
// ve karşılama (taşıyıcı/etiket/baskı) yan etkileri ÇAĞRILMAZ.
import { recordSyncState } from '../../onboarding/onboardingRepository.ts'
import { canPersistCanonicalOrders } from '../liveWriteGate.ts'
import {
  fetchIkasOrderPage,
  IKAS_MAX_PAGE_LIMIT,
  type IkasClientOptions,
  type IkasCredentials,
  type IkasErrorClass,
} from './ikasClient.ts'
import {
  normalizeIkasOrders,
  type IkasBatchNormalization,
} from './ikasOrderNormalizer.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const IKAS_PROVIDER_KEY = 'ikas'
/** Sayfa boyutu: sözleşme üst sınırı 200. */
export const IKAS_SYNC_PAGE_LIMIT = IKAS_MAX_PAGE_LIMIT
/** Sonsuz döngü koruması: 500 × 200 = 100.000 sipariş/koşu. */
export const IKAS_MAX_PAGES = 500

export type IkasFetchOutcome = 'SUCCESS' | 'PARTIAL' | 'FAILED'

export interface IkasFetchAllResult {
  outcome: IkasFetchOutcome
  rawOrders: Record<string, unknown>[]
  pagesFetched: number
  errorClass: IkasErrorClass | null
}

/**
 * Pencere içindeki TÜM sayfaları çeker.
 *
 * Korumalar: sayfa numarası yanıtta AYNI olmalı; `hasNext` doğruyken boş
 * veya YALNIZ tekrar içeren sayfa İLERLEMEZ → kısmi sayfalama hatası;
 * sayfa sayısı SINIRLIDIR.
 */
export async function fetchAllIkasOrders(
  credentials: IkasCredentials,
  window: { fromMs: number | null; upperBoundMs: number },
  options: IkasClientOptions & { pageLimit?: number; maxPages?: number },
): Promise<IkasFetchAllResult> {
  const limit = Math.min(IKAS_MAX_PAGE_LIMIT, Math.max(1, options.pageLimit ?? IKAS_SYNC_PAGE_LIMIT))
  const maxPages = Math.max(1, options.maxPages ?? IKAS_MAX_PAGES)
  const rawOrders: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const partial = (errorClass: IkasErrorClass, pagesFetched: number): IkasFetchAllResult => ({
    outcome: pagesFetched > 0 ? 'PARTIAL' : 'FAILED',
    rawOrders,
    pagesFetched,
    errorClass,
  })

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchIkasOrderPage(
      credentials,
      {
        page,
        limit,
        updatedAt: {
          ...(window.fromMs !== null ? { gte: window.fromMs } : {}),
          lte: window.upperBoundMs,
        },
      },
      options,
    )
    if (!result.ok) return partial(result.errorClass, page - 1)
    if (result.data.page !== page) return partial('PARTIAL_PAGINATION', page - 1)

    let fresh = 0
    for (const row of result.data.data) {
      const id = String(row?.id ?? '').trim()
      if (id !== '' && seen.has(id)) continue
      if (id !== '') seen.add(id)
      rawOrders.push(row)
      fresh += 1
    }
    if (!result.data.hasNext) {
      return { outcome: 'SUCCESS', rawOrders, pagesFetched: page, errorClass: null }
    }
    // Devam var dendi ama sayfa İLERLEMEDİ (boş ya da yalnız tekrar).
    if (fresh === 0) return partial('PARTIAL_PAGINATION', page)
  }
  return partial('PARTIAL_PAGINATION', maxPages)
}

export type IkasCanonicalPersister = (normalization: IkasBatchNormalization) => Promise<void>

export interface IkasSyncResult {
  outcome: IkasFetchOutcome
  normalization: IkasBatchNormalization
  checkpointAdvanced: boolean
  canonicalPersisted: boolean
  liveWriteReason: string
  pagesFetched: number
  errorClass: IkasErrorClass | null
  window: { fromMs: number | null; upperBoundMs: number }
}

const STATUS: Record<IkasFetchOutcome, 'success' | 'partial' | 'failed'> = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
}

/**
 * Bir ikas hesabının mutabakat koşusu.
 *
 * `upperBoundMs` ÇAĞIRAN tarafından koşu başında sabitlenir; imleç yalnız
 * TAM başarıda o değere ilerler (`recordSyncState` sözleşmesi zaten yalnız
 * `success`te `last_successful_sync_at` yazar).
 */
export async function syncIkasOrdersForAccount(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    merchantId: string
    credentials: IkasCredentials
    window: { fromMs: number | null; upperBoundMs: number }
    persistCanonical?: IkasCanonicalPersister
  },
  options: IkasClientOptions & { pageLimit?: number; maxPages?: number },
): Promise<IkasSyncResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('organizationId ve marketplaceAccountId zorunludur.')
  }
  if (!Number.isSafeInteger(params.window.upperBoundMs) || params.window.upperBoundMs <= 0) {
    throw new Error('upperBoundMs geçerli bir epoch milisaniye olmalıdır.')
  }

  const fetched = await fetchAllIkasOrders(params.credentials, params.window, options)
  const normalization = normalizeIkasOrders(fetched.rawOrders, params.merchantId)

  // Başka mağazanın siparişi dönmüşse koşu BAŞARILI SAYILMAZ.
  const merchantMismatch = normalization.rejected.some((entry) => entry.reason === 'MERCHANT_MISMATCH')
  const outcome: IkasFetchOutcome =
    fetched.outcome === 'SUCCESS' && merchantMismatch ? 'PARTIAL' : fetched.outcome
  const errorClass: IkasErrorClass | null =
    fetched.errorClass ?? (merchantMismatch ? 'MERCHANT_MISMATCH' : null)

  // ═══ CANLI YAZMA KAPISI (aşama kararı) ═════════════════════════════
  const gate = canPersistCanonicalOrders(IKAS_PROVIDER_KEY)
  let canonicalPersisted = false
  if (gate.decision === 'ALLOWED' && outcome === 'SUCCESS' && params.persistCanonical) {
    await params.persistCanonical(normalization)
    canonicalPersisted = true
  }

  // ═══ İMLEÇ — YALNIZ TAM BAŞARIDA, SABİT ÜST SINIRA ═════════════════
  const status = STATUS[outcome]
  const checkpointAdvanced = status === 'success'
  await recordSyncState(db, organizationId, {
    provider: IKAS_PROVIDER_KEY,
    resource: 'orders',
    status,
    fetchedCount: normalization.orders.length,
    errorCode: errorClass,
    marketplaceAccountId,
    successfulSyncAt: checkpointAdvanced ? new Date(params.window.upperBoundMs) : null,
  })

  return {
    outcome,
    normalization,
    checkpointAdvanced,
    canonicalPersisted,
    liveWriteReason: gate.reasonCode,
    pagesFetched: fetched.pagesFetched,
    errorClass,
    window: params.window,
  }
}
