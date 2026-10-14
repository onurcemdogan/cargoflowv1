// N11 OKUMA SENKRONU — hesap kapsamlı, SINIRLI, yalnız-okuma, uyarlanır aralık bölme.
//
// ═══ PENCERE / İMLEÇ MODELİ ═════════════════════════════════════════════
//
//   imleç (KANONİK depoda temsil edilen son pencere sonu) ──► SABİT üst sınır
//   Aralık imleçten başlayarak BOŞLUKSUZ ≤ 15 günlük pencerelere bölünür (en
//   eski önce; resmî pencere tavanı). Başlangıç ASLA "şimdi − 15 gün"e ileri
//   kırpılmaz — kırpma aradaki siparişleri kalıcı olarak atlardı. Koşu başına
//   en fazla N11_MAX_WINDOWS_PER_RUN pencere; kalan aralık `moreRemaining`.
//   `orderByField=true`: aralık paketin `lastModifiedDate`ine uygulanır
//   (güncellenen eski siparişler de okunur). Her istek `sender=ALL` taşır.
//
// ═══ SAYFA YÜRÜTME YOK — UYARLANIR ARALIK BÖLME ═════════════════════════
//
// Sağlayıcı veri kümesi okuma sırasında DEĞİŞİR. Sabit bir aralıkta page
// 0, 1, 2… yürümek güvensizdir: okunmuş sayfadaki bir kayıt değişip
// aralıktan çıkarsa sonraki kayıtlar bir sıra geri kayar ve sayfa sınırındaki
// kayıt HİÇ görülmeden pencere "tamam" sayılırdı.
//
// Bu yüzden her (statü, aralık) için YALNIZ page 0 istenir:
//   · totalPages ≤ 1 → aralığın TÜM sonucu tek yanıtta, tek anda → işlenir;
//   · totalPages > 1 → yanıt İŞLENMEZ (yazılmaz); aralık ikiye bölünür, önce
//     ESKİ yarı, sonra YENİ yarı (açık yığıt, en eski önce).
// Bölme N11_MIN_SPLIT_INTERVAL_MS'e kadar iner; o aralık hâlâ çok sayfalıysa
// (aynı zaman damgasında çok kayıt) PARTIAL `N11_DENSE_WINDOW_UNSPLITTABLE` —
// güvensiz sayfa yürütmeye DÜŞÜLMEZ, imleç o pencereden geçmez. Koşu başına
// istek tavanı N11_MAX_REQUESTS_PER_RUN; dolarsa PARTIAL
// `N11_REQUEST_BUDGET_EXHAUSTED`.
//
// Sınır anlamı (dahil/hariç) resmî olarak KANITLANMADI ve bölme sınır sayısını
// artırır: her istek aralık başından N11_BOUNDARY_OVERLAP_MS ÖNCE başlar, böylece
// tam sınır milisaniyesindeki kayıt hangi anlamda olursa olsun bir yarıda
// görülür; çift görülen kayıt paket kimliğiyle tekilleşir (kayıp değil).
//
// ═══ BELLEK ═════════════════════════════════════════════════════════════
//
// PR #15 dersi: tüm geçmiş bellekte BİRİKTİRİLMEZ. Her tek-sayfa yanıt
// normalize edilir, sahiplik denetlenir ve (kapı izin veriyorsa) hemen
// yazılır; bellekte yalnız sayaçlar, pencere içi paket kimliği kümesi ve
// derinliği log₂ ile sınırlı aralık yığıtı kalır.
//
// ═══ İMLEÇ DEĞİŞMEZİ ════════════════════════════════════════════════════
//
// İmleç YALNIZ tamamen işlenen pencere KANONİK depoda EKSİKSİZ temsil
// ediliyorsa o pencerenin sonuna ilerler — ve yalnız kesintisiz dayanıklı ön
// ek boyunca (bir pencere dayanıksızsa sonrakiler imleci taşıyamaz). HTTP 200,
// başarılı normalizasyon, gözlenen en büyük `lastModifiedDate` ya da
// `failed=0` TEK BAŞINA yeterli DEĞİLDİR (bkz. resolveN11CheckpointDurability).
//
// ═══ CANLI YAZMA KAPISI ═════════════════════════════════════════════════
//
// Kanonik yazım DB'den yüklenen HESAP doğrulamasıyla açılır. Karşılama
// rollout kapısı ayrı kalır; GMT+3 kanıtı yokken üretim imleci ilerlemez.
import { recordSyncState } from '../../onboarding/onboardingRepository.ts'
import { type LiveWriteGateResult } from '../liveWriteGate.ts'
import { accountOrdersReadPayload, getAccountOrdersReadGate, type OrdersReadGateResult } from '../accountOrdersReadGate.ts'
import { credentialFingerprint } from '../../integrations/credentialService.ts'
import {
  N11_MAX_PAGE_SIZE,
  N11_PACKAGE_STATUSES,
  N11_WINDOW_MS,
} from '../../marketplaces/n11/n11Contract.ts'
import { normalizeN11Orders, type NormalizedN11Order } from '../../marketplaces/n11/n11OrderSource.ts'
import { fetchN11Page, type N11ClientOptions, type N11ErrorClass } from './n11Client.ts'
import { N11_PROVIDER_KEY, configToStoredPayload, type N11ConnectorConfig } from './n11Config.ts'
import { bindN11Seller, findN11SellerConflict } from './n11ConnectionService.ts'
import {
  N11_CANONICAL_WRITE_BLOCKED,
  N11_DENSE_WINDOW_UNSPLITTABLE,
  N11_PERSIST_INCOMPLETE,
  N11_PERSIST_SKIPPED,
  N11_RECORD_IDENTITY_MISSING,
  N11_RECORD_NOT_PERSISTABLE,
  N11_REQUEST_BUDGET_EXHAUSTED,
  N11_SELLER_ALREADY_CONNECTED,
  N11_SELLER_MISMATCH,
} from './n11Health.ts'
import { countN11Unpersistable } from './n11Persistence.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const N11_SYNC_PAGE_SIZE = N11_MAX_PAGE_SIZE
/** Koşu başına 15 günlük pencere tavanı. */
export const N11_MAX_WINDOWS_PER_RUN = 4
/** İlk koşu (imleç yokken) geriye bakış: tek resmî pencere. */
export const N11_INITIAL_LOOKBACK_MS = N11_WINDOW_MS
/** Bölünebilecek en kısa aralık; bunun altında çok sayfalı aralık "yoğun" sayılır. */
export const N11_MIN_SPLIT_INTERVAL_MS = 1_000
/** Koşu başına mantıksal istek tavanı (tekrarlar hariç; resmî limit 1000/dk). */
export const N11_MAX_REQUESTS_PER_RUN = 1_500
/** Her istek aralık başından bu kadar önce başlar (sınır anlamı kanıtsız). */
export const N11_BOUNDARY_OVERLAP_MS = 1
/** Pencere dilimi: örtüşmeyle birlikte istek aralığı ≤ 15 gün kalır. */
const N11_WINDOW_SLICE_MS = N11_WINDOW_MS - N11_BOUNDARY_OVERLAP_MS

export type N11FetchOutcome = 'SUCCESS' | 'PARTIAL' | 'FAILED'

export interface N11Window {
  startMs: number
  endMs: number
}

/** Okuma pencereleri. Saf ve deterministik; en eski önce, boşluksuz, ileri kırpma YOK. */
export function planN11Windows(params: {
  fromMs: number | null
  upperBoundMs: number
  maxWindows?: number
}): { windows: N11Window[]; moreRemaining: boolean } {
  const upper = params.upperBoundMs
  const from = params.fromMs ?? upper - N11_INITIAL_LOOKBACK_MS
  const maxWindows = Math.max(1, params.maxWindows ?? N11_MAX_WINDOWS_PER_RUN)
  const windows: N11Window[] = []
  let start = Math.min(from, upper)
  while (start < upper && windows.length < maxWindows) {
    const end = Math.min(start + N11_WINDOW_SLICE_MS, upper)
    windows.push({ startMs: start, endMs: end })
    start = end
  }
  return { windows, moreRemaining: start < upper }
}

export interface N11PersistSummary {
  persisted: number
  failed: number
  skippedTotal: number
  /** Yazıcı en az bir kez geçerli sonuç döndürmedi → kanıt YOK. */
  resultMissing: boolean
}

/**
 * İMLEÇ DEĞİŞMEZİ — tek saf karar. Pencere yalnız şu koşulların HEPSİ
 * sağlanıyorsa dayanıklıdır: pencere tamamen okundu, satıcı çakışması /
 * uyuşmazlığı yok, kimliksiz kayıt yok, yazılamaz kayıt yok, kapı ALLOWED,
 * ve ya pencere GERÇEKTEN boş ya da yazıcı çalıştı: atlanan 0, başarısız 0,
 * yazılan == beklenen. Ham kayıt normalizasyonda düştüyse pencere BOŞ değildir.
 */
export function resolveN11CheckpointDurability(input: {
  windowCompleted: boolean
  sellerConflict: boolean
  sellerMismatchCount: number
  invalidIdentityCount: number
  unpersistableCount: number
  gateAllowed: boolean
  hasPersister: boolean
  expectedCanonical: number
  persist: N11PersistSummary | null
}): { durable: true; reasonCode: null } | { durable: false; reasonCode: string } {
  const incomplete = (reasonCode: string) => ({ durable: false as const, reasonCode })
  if (!input.windowCompleted) return incomplete(N11_PERSIST_INCOMPLETE)
  if (input.sellerConflict) return incomplete(N11_SELLER_ALREADY_CONNECTED)
  if (input.sellerMismatchCount > 0) return incomplete(N11_SELLER_MISMATCH)
  if (input.invalidIdentityCount > 0) return incomplete(N11_RECORD_IDENTITY_MISSING)
  if (input.unpersistableCount > 0) return incomplete(N11_RECORD_NOT_PERSISTABLE)
  if (!input.gateAllowed) return incomplete(N11_CANONICAL_WRITE_BLOCKED)
  if (input.expectedCanonical === 0) return { durable: true, reasonCode: null }
  if (!input.hasPersister) return incomplete(N11_CANONICAL_WRITE_BLOCKED)
  if (!input.persist || input.persist.resultMissing) return incomplete(N11_PERSIST_INCOMPLETE)
  if (input.persist.skippedTotal > 0) return incomplete(N11_PERSIST_SKIPPED)
  if (input.persist.failed !== 0) return incomplete(N11_PERSIST_INCOMPLETE)
  if (input.persist.persisted !== input.expectedCanonical) return incomplete(N11_PERSIST_INCOMPLETE)
  return { durable: true, reasonCode: null }
}

export type N11CanonicalPersister = (orders: NormalizedN11Order[]) => Promise<unknown>

/** Yazıcı sonucunu kanıta çevirir; okunamayan sonuç `resultMissing`. */
function readPersistResult(result: unknown): { persisted: number; failed: number; skippedTotal: number } | null {
  if (!result || typeof result !== 'object') return null
  const value = result as { persisted?: unknown; failed?: unknown; skipped?: unknown }
  const persisted = Number(value.persisted)
  const failed = Number(value.failed ?? 0)
  if (!Number.isFinite(persisted) || !Number.isFinite(failed)) return null
  const skippedTotal = value.skipped && typeof value.skipped === 'object'
    ? Object.values(value.skipped as Record<string, unknown>).reduce<number>((sum, entry) => sum + (Number(entry) || 0), 0)
    : 0
  return { persisted, failed, skippedTotal }
}

interface WindowStats {
  outcome: N11FetchOutcome
  errorClass: N11ErrorClass | null
  reasonCode: string | null
  pagesFetched: number
  networkCalls: number
  /** Çok sayfalı yanıt yüzünden bölünen aralık sayısı. */
  splitCount: number
  rawCount: number
  ownCount: number
  duplicateRemovedCount: number
  invalidIdentityCount: number
  sellerMismatchCount: number
  unpersistable: { NO_PACKAGE_ID: number; NO_ORDER_DATE: number }
  expectedCanonical: number
  persist: N11PersistSummary | null
}

interface SellerState {
  bound: string | null
  candidate: string | null
  conflict: boolean
  ambiguous: boolean
}

export interface N11SyncResult {
  outcome: N11FetchOutcome | 'UP_TO_DATE'
  errorClass: N11ErrorClass | null
  reasonCode: string | null
  networkCalls: number
  pagesFetched: number
  /** Çok sayfalı yanıt yüzünden bölünen aralık sayısı (yanıtları işlenmedi). */
  splitCount: number
  windows: N11Window[]
  windowsProcessed: number
  windowsDurable: number
  /** İmleç (çalışma sonrası) üst sınıra ulaşmadıysa true — kalan aralık VAR. */
  moreRemaining: boolean
  fetchedCount: number
  normalizedCount: number
  duplicateRemovedCount: number
  invalidIdentityCount: number
  sellerMismatchCount: number
  unpersistable: { NO_PACKAGE_ID: number; NO_ORDER_DATE: number }
  sellerId: string | null
  sellerConflict: boolean
  canonicalWrite: OrdersReadGateResult['decision']
  ordersReadReasonCode: string
  canonicalPersisted: boolean
  persisted: { persisted: number; failed: number; skippedTotal: number }
  checkpointAdvanced: boolean
  checkpointMs: number | null
  /** İlk dayanıksız pencerenin kararlı sebebi (imleç orada durdu). */
  durabilityReasonCode: string | null
}

/**
 * Bir n11 hesabının okuma koşusu. `upperBoundMs` çağıran tarafından koşu
 * başında SABİTLENİR. Kimlik eksikse ağ çağrısı YAPILMAZ.
 */
export async function syncN11OrdersForAccount(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    config: N11ConnectorConfig
    fromMs: number | null
    upperBoundMs: number
    persistCanonical?: N11CanonicalPersister
    /** Trusted hermetic test seam; HTTP never accepts this from a request body. */
    liveWriteGate?: (providerKey: string) => LiveWriteGateResult
    maxWindows?: number
  },
  options: N11ClientOptions & { pageSize?: number; minSplitIntervalMs?: number; maxRequestsPerRun?: number },
): Promise<N11SyncResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('organizationId ve marketplaceAccountId zorunludur.')
  }
  if (!Number.isSafeInteger(params.upperBoundMs) || params.upperBoundMs <= 0) {
    throw new Error('upperBoundMs geçerli bir epoch milisaniye olmalıdır.')
  }
  const scope = {
    organizationId, marketplaceAccountId, providerKey: N11_PROVIDER_KEY,
    expectedFingerprint: credentialFingerprint(accountOrdersReadPayload(N11_PROVIDER_KEY, configToStoredPayload(params.config))),
  }
  const readGate = (): Promise<OrdersReadGateResult> => params.liveWriteGate
    ? Promise.resolve(params.liveWriteGate(N11_PROVIDER_KEY))
    : getAccountOrdersReadGate(db, scope)
  let gate = await readGate()
  const gateAllowed = gate.decision === 'ALLOWED'
  const persister = gateAllowed && params.persistCanonical ? async (orders: NormalizedN11Order[]) => {
    gate = await readGate()
    if (gate.decision !== 'ALLOWED') return { persisted: 0, failed: orders.length, skipped: {} }
    return params.persistCanonical!(orders)
  } : undefined
  const plan = planN11Windows({ fromMs: params.fromMs, upperBoundMs: params.upperBoundMs, maxWindows: params.maxWindows })
  const pageSize = Math.min(N11_MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? N11_SYNC_PAGE_SIZE))
  const minSplitMs = Math.max(1, options.minSplitIntervalMs ?? N11_MIN_SPLIT_INTERVAL_MS)
  const maxRequests = Math.max(1, options.maxRequestsPerRun ?? N11_MAX_REQUESTS_PER_RUN)
  let requestsUsed = 0
  const seller: SellerState = { bound: params.config.boundSellerId, candidate: null, conflict: false, ambiguous: false }

  const result: N11SyncResult = {
    outcome: 'SUCCESS', errorClass: null, reasonCode: null, networkCalls: 0, pagesFetched: 0, splitCount: 0,
    windows: plan.windows, windowsProcessed: 0, windowsDurable: 0, moreRemaining: false,
    fetchedCount: 0, normalizedCount: 0, duplicateRemovedCount: 0, invalidIdentityCount: 0,
    sellerMismatchCount: 0, unpersistable: { NO_PACKAGE_ID: 0, NO_ORDER_DATE: 0 },
    sellerId: seller.bound, sellerConflict: false, canonicalWrite: gate.decision, canonicalPersisted: false,
    ordersReadReasonCode: gate.reasonCode,
    persisted: { persisted: 0, failed: 0, skippedTotal: 0 },
    checkpointAdvanced: false, checkpointMs: null, durabilityReasonCode: null,
  }
  if (plan.windows.length === 0) {
    return { ...result, outcome: 'UP_TO_DATE' }
  }

  /** Bir sayfanın kayıtlarından bu hesaba ait olanlar (satıcı denetimi). */
  const ownOrdersOf = async (orders: NormalizedN11Order[], stats: WindowStats): Promise<NormalizedN11Order[]> => {
    const own: NormalizedN11Order[] = []
    if (seller.bound !== null) {
      seller.conflict ||= await findN11SellerConflict(db, { organizationId, marketplaceAccountId, sellerId: seller.bound })
    }
    for (const order of orders) {
      const sellerId = order.sellerId
      if (sellerId === '') {
        // Kimliği satıcının kendi anahtarıyla doğrulanmış istekten geldi; boş
        // satıcı alanı aksini KANITLAMAZ (Hepsiburada emsali).
        own.push(order)
        continue
      }
      const effective = seller.bound ?? seller.candidate
      if (effective === null) {
        seller.candidate = sellerId
        seller.conflict = await findN11SellerConflict(db, { organizationId, marketplaceAccountId, sellerId })
        own.push(order)
        continue
      }
      if (sellerId === effective) own.push(order)
      else {
        stats.sellerMismatchCount += 1
        seller.ambiguous = true
      }
    }
    if (seller.bound === null && seller.candidate !== null && !seller.conflict && !seller.ambiguous) {
      // Claim the seller atomically before any canonical write; concurrent
      // sibling reads cannot both pass a separate check-then-bind sequence.
      const binding = await bindN11Seller(db, { organizationId, marketplaceAccountId, sellerId: seller.candidate, expectedFingerprint: scope.expectedFingerprint })
      seller.conflict = binding.reasonCode === N11_SELLER_ALREADY_CONNECTED
      if (binding.ok) seller.bound = seller.candidate
      else return []
    }
    // Aynı satıcı başka etkin hesaba bağlıysa HİÇBİR kayıt yazılmaz (mükerrer risk).
    return seller.conflict || (seller.bound === null && seller.ambiguous) ? [] : own
  }

  let prefixIntact = true
  for (const window of plan.windows) {
    const stats: WindowStats = {
      outcome: 'SUCCESS', errorClass: null, reasonCode: null, pagesFetched: 0, networkCalls: 0, splitCount: 0,
      rawCount: 0, ownCount: 0, duplicateRemovedCount: 0, invalidIdentityCount: 0, sellerMismatchCount: 0,
      unpersistable: { NO_PACKAGE_ID: 0, NO_ORDER_DATE: 0 }, expectedCanonical: 0, persist: null,
    }
    const seenPackageIds = new Set<string>()
    statusLoop: for (const status of N11_PACKAGE_STATUSES) {
      // Açık yığıt: en eski yarı ÜSTTE → en eski önce işlenir. Derinlik
      // log₂(pencere / en kısa aralık) ile sınırlı; bellek sabit kalır.
      const intervals: N11Window[] = [{ startMs: window.startMs, endMs: window.endMs }]
      while (intervals.length > 0) {
        const interval = intervals.pop() as N11Window
        if (requestsUsed >= maxRequests) {
          stats.outcome = 'PARTIAL'
          stats.reasonCode = N11_REQUEST_BUDGET_EXHAUSTED
          break statusLoop
        }
        requestsUsed += 1
        const fetched = await fetchN11Page(
          params.config,
          {
            status,
            page: 0,
            size: pageSize,
            startMs: interval.startMs - N11_BOUNDARY_OVERLAP_MS,
            endMs: interval.endMs,
          },
          options,
        )
        stats.networkCalls += fetched.networkCalls
        if (!fetched.ok) {
          stats.outcome = stats.pagesFetched > 0 || result.pagesFetched > 0 ? 'PARTIAL' : 'FAILED'
          stats.errorClass = fetched.errorClass
          stats.reasonCode = fetched.reasonCode
          break statusLoop
        }
        stats.pagesFetched += 1

        if (fetched.totalPages > 1) {
          // Çok sayfalı GENİŞ sonuç İŞLENMEZ (sayfa ofseti değişken veride kayar).
          const span = interval.endMs - interval.startMs
          if (span <= minSplitMs) {
            // Aynı zaman diliminde tek sayfaya sığmayan yoğunluk: güvenli bölme
            // yok, sayfa yürütmeye de DÜŞÜLMEZ → imleç bu pencereden geçmez.
            stats.outcome = 'PARTIAL'
            stats.reasonCode = N11_DENSE_WINDOW_UNSPLITTABLE
            break statusLoop
          }
          const mid = interval.startMs + Math.floor(span / 2)
          intervals.push({ startMs: mid, endMs: interval.endMs })
          intervals.push({ startMs: interval.startMs, endMs: mid })
          stats.splitCount += 1
          continue
        }
        stats.rawCount += fetched.entries.length

        // Tek anlık tam yanıt işlenir ve bırakılır: normalize → sahiplik → hazırlık → yazım.
        const normalization = normalizeN11Orders(fetched.entries, seenPackageIds)
        stats.duplicateRemovedCount += normalization.duplicateRemovedCount
        stats.invalidIdentityCount += normalization.invalidIdentityCount
        const own = await ownOrdersOf(normalization.orders, stats)
        stats.ownCount += own.length
        const unpersistable = countN11Unpersistable(own)
        stats.unpersistable.NO_PACKAGE_ID += unpersistable.NO_PACKAGE_ID
        stats.unpersistable.NO_ORDER_DATE += unpersistable.NO_ORDER_DATE
        if (persister && own.length > 0) {
          const read = readPersistResult(await persister(own))
          result.canonicalPersisted = true
          stats.expectedCanonical += own.length
          const summary = stats.persist ?? { persisted: 0, failed: 0, skippedTotal: 0, resultMissing: false }
          if (read === null) summary.resultMissing = true
          else {
            summary.persisted += read.persisted
            summary.failed += read.failed
            summary.skippedTotal += read.skippedTotal
          }
          stats.persist = summary
        } else if (own.length > 0) {
          stats.expectedCanonical += own.length
        }
      }
    }

    // Koşu toplamları.
    result.windowsProcessed += 1
    result.networkCalls += stats.networkCalls
    result.pagesFetched += stats.pagesFetched
    result.splitCount += stats.splitCount
    result.fetchedCount += stats.rawCount
    result.normalizedCount += stats.ownCount
    result.duplicateRemovedCount += stats.duplicateRemovedCount
    result.invalidIdentityCount += stats.invalidIdentityCount
    result.sellerMismatchCount += stats.sellerMismatchCount
    result.unpersistable.NO_PACKAGE_ID += stats.unpersistable.NO_PACKAGE_ID
    result.unpersistable.NO_ORDER_DATE += stats.unpersistable.NO_ORDER_DATE
    if (stats.persist) {
      result.persisted.persisted += stats.persist.persisted
      result.persisted.failed += stats.persist.failed
      result.persisted.skippedTotal += stats.persist.skippedTotal
    }

    gate = await readGate()
    result.canonicalWrite = gate.decision
    result.ordersReadReasonCode = gate.reasonCode
    let decision = stats.outcome !== 'SUCCESS'
      ? { durable: false as const, reasonCode: stats.reasonCode ?? N11_PERSIST_INCOMPLETE }
      : resolveN11CheckpointDurability({
        windowCompleted: true,
        sellerConflict: seller.conflict,
        sellerMismatchCount: stats.sellerMismatchCount,
        invalidIdentityCount: stats.invalidIdentityCount,
        unpersistableCount: stats.unpersistable.NO_PACKAGE_ID + stats.unpersistable.NO_ORDER_DATE,
        gateAllowed: gate.decision === 'ALLOWED',
        hasPersister: Boolean(persister),
        expectedCanonical: stats.expectedCanonical,
        persist: stats.persist,
      })
    // Read authentication does not prove the provider's timezone/boundary semantics.
    if (decision.durable && 'checkpointBlocker' in gate && gate.checkpointBlocker) {
      decision = { durable: false, reasonCode: gate.checkpointBlocker }
    }

    if (decision.durable && prefixIntact) {
      // Dayanıklı ön ek bu pencereyle uzar: imleç pencere sonuna (kalıcı ilerleme).
      result.checkpointMs = window.endMs
      result.checkpointAdvanced = true
      result.windowsDurable += 1
      await recordSyncState(db, organizationId, {
        provider: N11_PROVIDER_KEY,
        resource: 'orders',
        status: 'success',
        fetchedCount: stats.ownCount,
        errorCode: null,
        marketplaceAccountId,
        successfulSyncAt: new Date(window.endMs),
      })
    } else if (prefixIntact) {
      prefixIntact = false
      result.durabilityReasonCode = decision.reasonCode
    }

    if (stats.outcome !== 'SUCCESS') {
      result.outcome = stats.outcome
      result.errorClass = stats.errorClass
      result.reasonCode = stats.reasonCode
      break
    }
  }

  // Dayanıklı ön ek tüm pencereleri kapsamadıysa durum `partial`/`failed`
  // kaydedilir — `lastSuccessfulSyncAt` bu yazımda DEĞİŞMEZ.
  if (!prefixIntact) {
    await recordSyncState(db, organizationId, {
      provider: N11_PROVIDER_KEY,
      resource: 'orders',
      status: result.outcome === 'FAILED' ? 'failed' : 'partial',
      fetchedCount: result.normalizedCount,
      errorCode: result.durabilityReasonCode,
      marketplaceAccountId,
      successfulSyncAt: null,
    })
  }

  // Satıcı kimliği bağlanır: yalnız tek ve çakışmasız satıcı gözlendiyse.
  if (seller.bound === null && seller.candidate !== null && !seller.conflict && !seller.ambiguous) {
    await bindN11Seller(db, { organizationId, marketplaceAccountId, sellerId: seller.candidate, expectedFingerprint: scope.expectedFingerprint })
  }
  result.sellerId = seller.bound ?? seller.candidate
  result.sellerConflict = seller.conflict
  const cursorAfter = result.checkpointMs ?? params.fromMs ?? params.upperBoundMs - N11_INITIAL_LOOKBACK_MS
  result.moreRemaining = cursorAfter < params.upperBoundMs
  return result
}
