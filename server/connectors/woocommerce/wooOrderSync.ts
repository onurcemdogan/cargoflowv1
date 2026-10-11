// WOOCOMMERCE SİPARİŞ SENKRONU — MEVCUT İMLEÇ SİSTEMİNİ KULLANIR.
//
// ═══ İKİNCİ SENKRON GEÇMİŞİ SİSTEMİ YOK ══════════════════════════════════
//
// `integration_sync_state` + `recordSyncState` ZATEN doğru sözleşmeye
// sahiptir: yalnız `success` `last_successful_sync_at`i ilerletir;
// `partial`/`failed` onu EZMEZ. Yeni bir tablo/akış AÇILMAZ.
//
// ═══ İMLECİN GERÇEK ANLAMI — ABARTILMAZ ══════════════════════════════════
//
// Kabul edilen sözleşme paketi `modified_after` parametresini DOĞRULAYAMADI
// (`checkpointFilter.modifiedAfterVerified: false`). Bu yüzden Woo yoklaması
// YALNIZ `after`/`before` ile, yani OLUŞTURMA TARİHİ ekseninde yapılır.
//
// Sonuç — açıkça söylenir: yoklama tek başına KEYFİ ESKİ bir siparişin
// güncellendiğini YAKALAYAMAZ. Üç ay önce oluşmuş bir sipariş bugün
// değişirse, oluşturma ekseni onu bugünkü pencereye SOKMAZ.
//
// Bu yüzden:
//   · GÜNCELLEME birincil sinyali WEBHOOK'tur (order.updated)
//   · yoklama, AÇIKÇA çekilen oluşturma penceresi İÇİNDE doğruluk yardımıdır
//
// İmleç "bu ana kadar her şey güncel" DEMEZ; "bu üst sınıra kadar olan
// OLUŞTURMA penceresi çekildi" der.
import { recordSyncState } from '../../onboarding/onboardingRepository.ts'
import { canPersistCanonicalOrders } from '../liveWriteGate.ts'
import {
  fetchWooOrders,
  type WooClientOptions,
  type WooCredentials,
  type WooFetchOutcome,
} from './wooClient.ts'
import {
  normalizeWooOrders,
  type WooBatchNormalization,
} from './wooOrderNormalizer.ts'
import { WOO_PROVIDER_KEY } from './wooConnectionService.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** `recordSyncState` sözleşmesindeki statüler. */
const OUTCOME_TO_STATUS: Record<WooFetchOutcome, 'success' | 'partial' | 'failed'> = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
}

export interface WooSyncWindow {
  /** ISO8601 — `after` (oluşturma ekseni, KAPSAYICI ALT SINIR). */
  after?: string
  /** ISO8601 — `before` (oluşturma ekseni, ÜST SINIR = imleç adayı). */
  before: string
}

export interface WooSyncResult {
  outcome: WooFetchOutcome
  normalization: WooBatchNormalization
  /** İmleç İLERLEDİ Mİ — yalnız SUCCESS'te true olabilir. */
  checkpointAdvanced: boolean
  /** Kanonik yazım yapıldı mı — yayın aşaması kapısı. */
  canonicalPersisted: boolean
  liveWriteReason: string
  pagesFetched: number
  errorClass: string | null
}

export type WooCanonicalPersister = (
  normalization: WooBatchNormalization,
) => Promise<void>

/**
 * Bir Woo hesabının siparişlerini çeker, normalleştirir ve durumu yazar.
 *
 * KANONİK YAZIM YAYIN AŞAMASINA BAĞLIDIR: `internal_test`te normalleştirme
 * YAPILIR ama kanonik kalıcılaştırıcı ÇAĞRILMAZ. Karar burada sağlayıcı
 * adına bakılarak DEĞİL, `liveWriteGate` ile verilir.
 */
export async function syncWooOrdersForAccount(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    credentials: WooCredentials
    window: WooSyncWindow
    perPage?: number
    /**
     * Kanonik kalıcılaştırıcı — YALNIZ yayın aşaması canlıysa çağrılır.
     * Hermetik testler bu bağdaştırıcıyı AÇIKÇA ayrı çalıştırabilir.
     */
    persistCanonical?: WooCanonicalPersister
  },
  options: WooClientOptions & { maxPages?: number },
): Promise<WooSyncResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('organizationId ve marketplaceAccountId zorunludur.')
  }

  const fetched = await fetchWooOrders(
    params.credentials,
    {
      after: params.window.after,
      before: params.window.before,
      perPage: params.perPage,
      order: 'asc',
      orderby: 'date',
    },
    options,
  )

  const normalization = normalizeWooOrders(fetched.rawOrders)

  // ═══ CANLI YAZMA KAPISI ════════════════════════════════════════════
  const gate = canPersistCanonicalOrders(WOO_PROVIDER_KEY)
  let canonicalPersisted = false
  if (gate.decision === 'ALLOWED' && params.persistCanonical) {
    await params.persistCanonical(normalization)
    canonicalPersisted = true
  }

  // ═══ İMLEÇ — YALNIZ TAM BAŞARIDA İLERLER ═══════════════════════════
  //
  // PARTIAL/FAILED'de ilerletmek, çekilemeyen aralığı BİR DAHA sormamak
  // demektir: kalıcı eksik sipariş. `recordSyncState` zaten yalnız
  // `success`te `last_successful_sync_at` yazar; burada da üst sınır
  // SADECE başarıda verilir.
  const status = OUTCOME_TO_STATUS[fetched.outcome]
  const checkpointAdvanced = status === 'success'
  const beforeMs = Date.parse(params.window.before)
  await recordSyncState(db, organizationId, {
    provider: WOO_PROVIDER_KEY,
    resource: 'orders',
    status,
    fetchedCount: normalization.orders.length,
    errorCode: fetched.errorClass ?? null,
    marketplaceAccountId,
    // Üst sınır = ÇEKİLEN PENCERENİN sınırı, `now` DEĞİL.
    successfulSyncAt:
      checkpointAdvanced && Number.isFinite(beforeMs) ? new Date(beforeMs) : null,
  })

  return {
    outcome: fetched.outcome,
    normalization,
    checkpointAdvanced,
    canonicalPersisted,
    liveWriteReason: gate.reasonCode,
    pagesFetched: fetched.pagesFetched,
    errorClass: fetched.errorClass,
  }
}

/**
 * MUTABAKAT EKSİKLİĞİ — RAPORLANIR, GİZLENMEZ.
 *
 * Bu sabit, "Woo yoklaması her güncellemeyi yakalar" iddiasının YANLIŞ
 * olduğunu kodda görünür kılar. Sözleşme paketi `modified_after`ı
 * doğrulamadığı için mutabakat OLUŞTURMA ekseninde sınırlıdır.
 */
export const WOO_RECONCILIATION_LIMITATION = {
  completeness: 'PARTIAL_BY_VERIFIED_CONTRACT',
  axis: 'date_created (after/before)',
  modifiedAfterVerified: false,
  primaryUpdateSignal: 'webhook:order.updated',
  note:
    'Yoklama, çekilen OLUŞTURMA penceresi içinde doğruluk yardımıdır; keyfi ' +
    'eski bir siparişin güncellenmesini TEK BAŞINA yakalayamaz.',
} as const
