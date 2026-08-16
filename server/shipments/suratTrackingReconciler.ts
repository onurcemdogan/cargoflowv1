import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { orders, shipments } from '../db/schema.ts'
import { refreshOrderProjectionFragment } from '../orders/orderFilterProjectionRepository.ts'
import { mapSuratCarrierStatus } from '../../src/utils/shipmentStatus.ts'

// ═══ SÜRAT TAKİP MUTABAKATI — FİZİKSEL KABUL SONRASI DURUM YAKALAMA ═══════
//
// ÜRETİM PROBLEMİ (kod düzeyinde kanıtlandı): paket SSP'de fiziksel olarak
// okutulup kabul edildikten sonra CargoFlow siparişi "Etiket Basıldı"da
// kalıyordu.
//
// KÖK NEDEN — POLLING/RECONCILIATION EKSİKLİĞİ, mapping DEĞİL:
//   · `trackShipments` YALNIZ iki yerden çağrılıyor (src/App.tsx) ve ikisi de
//     KULLANICININ ELLE tetiklediği aksiyon.
//   · "Şimdi Yenile" pazaryeri sync'i yapar, TAŞIYICI sorgusu YAPMAZ.
//   · Tek otomatik taşıyıcı doğrulaması `runAutomaticSuratTrackingVerification`
//     ve o da SADECE create anında bir kez çalışır — yani SSP kabulünden ÖNCE.
//   ⇒ Sipariş, create anındaki taşıyıcı fotoğrafında donuyor.
//
// BU MODÜL YENİ DURUM HARİTASI YAZMAZ. Mevcut kanonik
// `mapSuratCarrierStatus` (src/utils/shipmentStatus.ts) OLDUĞU GİBİ kullanılır:
//   KargonunDurumuSayi 1  → PREPARING (shipped=false) → "Etiket Basıldı" KALIR
//   KargonunDurumuSayi 2,3,4,5,7,11 → shipped=true    → Kargoya Verildi
//   6/13/14 → teslim · 9 → iade
//
// NEGATİF SÖZLEŞME (asla ihlal edilmez):
//   shipment oluşturuldu            ≠ kargoya verildi
//   Gonderiler.length > 0 TEK BAŞINA ≠ kargoya verildi
//   LABEL_READY / LABEL_PRINTED     ≠ kargoya verildi
//   KargonunDurumuSayi = 1          ≠ kargoya verildi

/** Pazaryeri ileri/terminal statüleri: bunlar taşıyıcı sorgusuna GİRMEZ. */
const MARKETPLACE_TERMINAL_STATUSES = [
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
] as const

/**
 * SORGU ADAYLARI — etiketi hazır VEYA basılmış siparişler.
 *
 * KRİTİK AYRIM: bu liste YALNIZ "taşıyıcıya sorulur mu?" sorusunu yanıtlar.
 * "Kargoya Verildi" sonucunu ÜRETMEZ — o yalnız doğrulanmış taşıyıcı
 * kabul/shipped kanıtından doğar (bkz. decideFromCarrierSnapshot).
 *
 * Etiket hazır olup henüz basılmamış bir paket de SSP'de okutulabilir;
 * bu yüzden LABEL_READY de aday kümededir.
 */
const CANDIDATE_OPERATION_STATUSES = ['LABEL_READY', 'LABEL_PRINTED'] as const

export interface TrackingReconcilePolicy {
  intervalMs: number
  batchSize: number
  concurrency: number
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

/**
 * Varsayılanlar mevcut altyapıyla uyumlu seçildi:
 *   · batch 50   — labelBundlePreparer RECONCILE_SCAN_LIMIT=200'den DAHA
 *                  muhafazakâr; her aday bir DIŞ taşıyıcı çağrısı demek.
 *   · concurrency 2 — mevcut Sürat çağrıları seri + gecikmeli yapılıyor
 *                  (interStatusDelayMs); PREPARE_CONCURRENCY=4 yerel iş içindi.
 *   · interval 5 dk — fiziksel kabulün makul sürede yakalanması için.
 */
export function resolveTrackingReconcilePolicy(
  env: Record<string, string | undefined> = process.env,
): TrackingReconcilePolicy {
  return {
    intervalMs: Math.max(
      60_000,
      positiveInt(env.SURAT_TRACKING_RECONCILE_INTERVAL_MS, 5 * 60_000),
    ),
    batchSize: Math.min(
      200,
      positiveInt(env.SURAT_TRACKING_RECONCILE_BATCH_SIZE, 50),
    ),
    concurrency: Math.min(
      4,
      positiveInt(env.SURAT_TRACKING_RECONCILE_CONCURRENCY, 2),
    ),
  }
}

export interface TrackingCandidate {
  orderId: string
  organizationId: string
  marketplace: string
  packageId: string
  /**
   * SERENDIP SORGU ANAHTARI. Sürat create isteği `WebSiparisKodu` alanına
   * SİPARİŞ NUMARASINI yazar (server/index.mjs requestFieldMapping:
   * WebSiparisKodu=orderNumber, ReferansNo=packageId). Takip ucu YALNIZ
   * WebSiparisKodu kabul ettiği için sorgu bu değerle yapılmalıdır.
   *
   * ÜRETİM HATASI (golden 4065907241): sorgu packageId ile yapılıyordu →
   * carrierQuerySucceeded=false, Gonderiler=0. Kayıt Serendip'te VARDI.
   */
  orderNumber: string
  /** Çapraz doğrulama için kalıcı taşıyıcı kimlikleri. */
  trackingNumber?: string | null
  carrierBarcode?: string | null
}

type Db = Record<string, unknown>

/**
 * ADAY SORGUSU — kaynak DB'dir (bellek içi liste DEĞİL), bu yüzden PM2
 * restart sonrası adaylar yeniden bulunur. Keyset (orders.id ASC) ile
 * sınırlı ilerler.
 *
 *   operation_status = LABEL_PRINTED
 *   AND archived_at IS NULL
 *   AND marketplace_status ileri/terminal DEĞİL
 *   AND aynı (org, marketplace, packageId) ile YEREL SÜRAT GÖNDERİSİ VAR
 */
export async function findTrackingReconcileCandidates(
  db: Db,
  policy: TrackingReconcilePolicy,
  cursor?: string,
): Promise<TrackingCandidate[]> {
  const database = db as unknown as {
    select: (fields?: unknown) => {
      from: (table: unknown) => {
        where: (clause: unknown) => {
          orderBy: (order: unknown) => {
            limit: (n: number) => Promise<TrackingCandidate[]>
          }
        }
      }
    }
  }
  const base = and(
    inArray(orders.operationStatus, [...CANDIDATE_OPERATION_STATUSES]),
    isNull(orders.archivedAt),
    sql`(${orders.marketplaceStatus} is null or ${orders.marketplaceStatus} not in ${MARKETPLACE_TERMINAL_STATUSES})`,
    // YEREL SÜRAT GÖNDERİSİ + GEÇERLİ TAŞIYICI KİMLİĞİ ŞART.
    // Takip numarası (T.No) veya taşıyıcı barkodu olmayan kayda sorgu YOK:
    // kimliksiz sorgu yanlış gönderiye bağlanma riski taşır.
    sql`exists (select 1 from ${shipments} where ${shipments.organizationId} = ${orders.organizationId} and ${shipments.marketplace} = ${orders.marketplace} and ${shipments.packageId} = ${orders.packageId} and (coalesce(${shipments.trackingNumber}, '') <> '' or coalesce(${shipments.barcode}, '') <> ''))`,
  )
  return database
    .select({
      orderId: orders.id,
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
      // Serendip sorgu anahtarı (WebSiparisKodu).
      orderNumber: orders.orderNumber,
      // Çapraz doğrulama için kalıcı taşıyıcı takip numarası.
      trackingNumber: sql<string | null>`(select ${shipments.trackingNumber} from ${shipments} where ${shipments.organizationId} = ${orders.organizationId} and ${shipments.marketplace} = ${orders.marketplace} and ${shipments.packageId} = ${orders.packageId} limit 1)`,
    })
    .from(orders)
    .where(cursor ? and(base, gt(orders.id, cursor)) : base)
    .orderBy(asc(orders.id))
    .limit(policy.batchSize)
}

/** Taşıyıcı sorgusunun DÖNDÜRDÜĞÜ teknik alanlar (PII YOK). */
export interface CarrierTrackingSnapshot {
  ok: boolean
  gonderilerLength: number
  kargonunDurumuSayi?: string | number | null
  /** Kimlik doğrulaması: sorgunun hangi gönderiye ait olduğu. */
  trackingNumber?: string | null
  sonHareketTarihi?: string | null
}

export type CarrierTrackingQuery = (
  candidate: TrackingCandidate,
) => Promise<CarrierTrackingSnapshot | null>

export interface TrackingDecision {
  orderId: string
  /** TENANT KAPSAMI: karar üretildiği adayın organizasyonu (tahmin YOK). */
  organizationId: string
  /** Kanonik haritadan türeyen sonuç; YENİ eşleme YOK. */
  handedToCargo: boolean
  delivered: boolean
  returning: boolean
  carrierStatusCode: string
  applied: boolean
  reason:
    | 'no_response'
    | 'identity_mismatch'
    | 'no_shipment_record'
    | 'unknown_status'
    | 'not_shipped_yet'
    | 'handed_to_cargo'
    | 'delivered'
    | 'returning'
}

/**
 * TEK ADAYIN KARARI — SAF. Mevcut `mapSuratCarrierStatus` dışında hiçbir
 * kural yoktur; bilinmeyen/eksik durum FAIL-SAFE olarak "değişiklik yok"tur.
 */
export function decideFromCarrierSnapshot(
  candidate: TrackingCandidate,
  snapshot: CarrierTrackingSnapshot | null,
): TrackingDecision {
  const base = {
    orderId: candidate.orderId,
    organizationId: candidate.organizationId,
    handedToCargo: false,
    delivered: false,
    returning: false,
    carrierStatusCode: '',
    applied: false,
  }
  if (!snapshot || !snapshot.ok) {
    return { ...base, reason: 'no_response' }
  }
  // Gönderi kaydı yoksa fiziksel kabul KANITI da yoktur.
  if (!(Number(snapshot.gonderilerLength) > 0)) {
    return { ...base, reason: 'no_shipment_record' }
  }
  // KİMLİK ÇAPRAZ DOĞRULAMASI: taşıyıcı bir takip numarası döndürdüyse ve
  // elimizde kalıcı T.No varsa UYUŞMALIDIR. Uyuşmuyorsa YANLIŞ gönderiye
  // bakıyoruz demektir → hiçbir güncelleme yapılmaz.
  const returned = String(snapshot.trackingNumber ?? '').replace(/\D/g, '')
  const persisted = String(candidate.trackingNumber ?? '').replace(/\D/g, '')
  if (returned && persisted && returned !== persisted) {
    return { ...base, reason: 'identity_mismatch' }
  }
  const code = String(snapshot.kargonunDurumuSayi ?? '').trim()
  const mapped = mapSuratCarrierStatus(code)
  if (!mapped) {
    // Bilinmeyen kod → FAIL-SAFE: mevcut durum KORUNUR.
    return { ...base, carrierStatusCode: code, reason: 'unknown_status' }
  }
  if (mapped.delivered) {
    return {
      ...base,
      delivered: true,
      carrierStatusCode: code,
      applied: true,
      reason: 'delivered',
    }
  }
  if (mapped.returning) {
    return {
      ...base,
      returning: true,
      carrierStatusCode: code,
      applied: true,
      reason: 'returning',
    }
  }
  if (mapped.shipped) {
    return {
      ...base,
      handedToCargo: true,
      carrierStatusCode: code,
      applied: true,
      reason: 'handed_to_cargo',
    }
  }
  // KargonunDurumuSayi = 1 (Gönderi Hazırlanıyor) buraya düşer:
  // fiziksel kabul KANITI değildir → "Etiket Basıldı" KALIR.
  return { ...base, carrierStatusCode: code, reason: 'not_shipped_yet' }
}

export interface TrackingReconcileReport {
  scanned: number
  queried: number
  handedToCargo: number
  delivered: number
  returning: number
  unchanged: number
  failed: number
  nextCursor?: string
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const current = index
      index += 1
      if (current >= items.length) return
      results[current] = await worker(items[current])
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * SINIRLI bir mutabakat turu. Taşıyıcı sorgusu DIŞARIDAN verilir
 * (test edilebilirlik + bu modülün ağ katmanına bağımlı olmaması).
 *
 * Bir adayın sorgusu başarısız olursa o kayıt DEĞİŞMEZ ve tur DEVAM eder;
 * diğer adaylar etkilenmez.
 */
export async function reconcileSuratTracking(
  db: Db,
  policy: TrackingReconcilePolicy,
  queryCarrier: CarrierTrackingQuery,
  applyDecision: (decision: TrackingDecision) => Promise<void>,
  cursor?: string,
): Promise<TrackingReconcileReport> {
  const candidates = await findTrackingReconcileCandidates(db, policy, cursor)
  if (candidates.length === 0) {
    return {
      scanned: 0,
      queried: 0,
      handedToCargo: 0,
      delivered: 0,
      returning: 0,
      unchanged: 0,
      failed: 0,
    }
  }
  const decisions = await mapWithConcurrency(
    candidates,
    policy.concurrency,
    async (candidate) => {
      try {
        const snapshot = await queryCarrier(candidate)
        return decideFromCarrierSnapshot(candidate, snapshot)
      } catch {
        return decideFromCarrierSnapshot(candidate, null)
      }
    },
  )

  let handedToCargo = 0
  let delivered = 0
  let returning = 0
  let unchanged = 0
  let failed = 0
  for (const decision of decisions) {
    if (!decision.applied) {
      if (decision.reason === 'no_response') failed += 1
      else unchanged += 1
      continue
    }
    try {
      await applyDecision(decision)
      if (decision.handedToCargo) handedToCargo += 1
      else if (decision.delivered) delivered += 1
      else if (decision.returning) returning += 1
    } catch {
      failed += 1
    }
  }

  return {
    scanned: candidates.length,
    queried: decisions.length,
    handedToCargo,
    delivered,
    returning,
    unchanged,
    failed,
    nextCursor:
      candidates.length === policy.batchSize
        ? candidates[candidates.length - 1].orderId
        : undefined,
  }
}

/**
 * KANONİK KALICI YAZIM. Yeni paralel durum deposu YOKTUR:
 * mevcut `orders.operation_status` alanı güncellenir ve
 * `last_operational_activity_at` gerçek operasyon ilerlemesi olarak damgalanır.
 *
 * `marketplace_status` ASLA DEĞİŞTİRİLMEZ — Trendyol hâlâ Picking ise Picking
 * kalır; taşıyıcı gerçeği ayrı provenance olarak operation_status'te durur.
 */
export async function applyTrackingDecision(
  db: Db,
  decision: TrackingDecision,
  now: Date = new Date(),
): Promise<void> {
  if (!decision.applied) return
  const operationStatus = decision.handedToCargo
    ? 'HANDED_TO_CARGO'
    : decision.delivered
      ? 'DELIVERED'
      : 'RETURNING'
  const database = db as unknown as {
    update: (table: unknown) => {
      set: (values: unknown) => { where: (clause: unknown) => Promise<unknown> }
    }
  }
  await database
    .update(orders)
    .set({
      operationStatus,
      lastOperationalActivityAt: now,
      updatedAt: now,
    })
    .where(
      and(
        // TENANT KAPSAMI: yalnız kararın ait olduğu organizasyon.
        eq(orders.organizationId, decision.organizationId),
        eq(orders.id, decision.orderId),
        // NO-REGRESS: teslim/iade/kargoya verilmiş kayıt geriye çekilmez.
        notInArray(orders.operationStatus, [
          'DELIVERED',
          'DELIVERED_SPECIAL',
          'RETURNING',
          'HANDED_TO_CARGO',
        ]),
      ),
    )
  // PROJEKSİYON BAKIMI: mutasyondan SONRA ORDER parçası mevcut DB durumundan
  // yeniden türetilir. NO-REGRESS nedeniyle UPDATE eşleşmese bile yenileme
  // IDEMPOTENT'tir (aynı token'lar yazılır) ve projeksiyon ASLA bayat kalmaz.
  // Yeni taşıyıcı/ağ çağrısı YOK; decrypt YOK; hata YUTULMAZ.
  await refreshOrderProjectionFragment(database, decision.organizationId, [
    decision.orderId,
  ])
}
