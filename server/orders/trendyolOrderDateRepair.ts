// TRENDYOL `orders.order_date` GEÇMİŞ VERİ ONARIM ÇEKİRDEĞİ.
//
// ═══ NEDEN "−3 SAAT" YASAK ═══════════════════════════════════════════════
//
// Üretim denetimi (500 satır): 475 DRIFTED_BY_OFFSET, 25 ALREADY_CORRECT.
// Yani satırların BİR KISMI ZATEN DOĞRU. Toplu bir
//
//   UPDATE orders SET order_date = order_date - interval '3 hours'
//
// o 25 satırı 3 saat GERİYE bozar ve ikinci çalıştırmada TÜM tabloyu bir kez
// daha bozar (idempotent DEĞİL). Bu yüzden onarım kayıtlı değerden DEĞİL,
// HAM SAĞLAYICI YÜKÜNDEN türetilir:
//
//   raw_payload_encrypted.orderDate → normalizeTrendyolOrderDate → beklenen
//
// Kayıtlı değer YALNIZ karşılaştırma ve compare-and-set yüklemi için okunur.
//
// ═══ NEDEN KEYSET SAYFALAMA, `order_date` İLE DEĞİL `id` İLE ═════════════
//
// OFFSET sayfalama eşzamanlı insert/delete altında satır ATLAR ve TEKRARLAR.
// Dahası imleç `order_date` üzerine kurulsaydı, onarım tam da imleç kolonunu
// DEĞİŞTİRDİĞİ için imleç KENDİNİ GEÇERSİZ KILARDI. `orders.id` (uuid PK)
// onarımdan ETKİLENMEZ: sabit sıra, atlama yok, tekrar yok, devam edilebilir.
import { and, asc, eq, gt } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import { decryptOrderPayload } from './orderEncryption.ts'
import {
  classifyOrderDateDrift,
  type OrderDateDriftClassification,
  type OrderDateDriftVerdict,
} from './trendyolOrderDateDrift.ts'
import { TRENDYOL_ORDER_DATE_OFFSET_MINUTES } from '../marketplaces/trendyolOrderDate.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Sözleşme Trendyol'a ÖZELDİR; başka pazaryeri satırı ASLA seçilmez. */
export const TRENDYOL_MARKETPLACE = 'Trendyol'

/** APPLY için operatörün AÇIKÇA yazması gereken onay dizgisi. */
export const TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION = 'TRENDYOL_ORDERDATE_REPAIR'

/** Sınırlı yığın: tüm tablo TEK transaction'da AÇIK TUTULMAZ. */
export const DEFAULT_BATCH_SIZE = 200

export type OrderDateRepairAction =
  | 'UPDATE'
  | 'SKIP_ALREADY_CORRECT'
  | 'SKIP_RAW_UNAVAILABLE'
  | 'SKIP_RAW_UNPARSEABLE'
  | 'SKIP_UNEXPECTED'

/**
 * Ham yükten YALNIZ `orderDate` alanını okur; BAŞKA ALAN OKUNMAZ.
 * Çözülemezse `null` — TAHMİN YAPILMAZ (ve `null` onarım DIŞI bırakır).
 */
export function readRawOrderDate(encrypted: string | null): unknown {
  const raw = decryptOrderPayload(encrypted) as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') return null
  return (raw as { orderDate?: unknown }).orderDate ?? null
}

/**
 * SINIFLANDIRMA → EYLEM. Tek güvenlik kapısı burasıdır.
 *
 * YALNIZ `DRIFTED_BY_OFFSET` yazmaya aday olabilir; buna EK OLARAK sapmanın
 * TAM beklenen ofset olduğu ve düzeltilmiş değerin çözülebildiği BAĞIMSIZ
 * olarak yeniden doğrulanır. Sınıflandırıcı ileride genişletilirse bilinmeyen
 * her değer `SKIP_UNEXPECTED`e düşer — varsayılan YAZMAMAKTIR.
 */
export function actionForVerdict(
  verdict: Pick<
    OrderDateDriftVerdict,
    'classification' | 'driftMinutes' | 'correctedOrderDate'
  >,
): OrderDateRepairAction {
  switch (verdict.classification) {
    case 'ALREADY_CORRECT':
      return 'SKIP_ALREADY_CORRECT'
    case 'RAW_UNAVAILABLE':
      return 'SKIP_RAW_UNAVAILABLE'
    case 'RAW_UNPARSEABLE':
      return 'SKIP_RAW_UNPARSEABLE'
    case 'DRIFTED_BY_OFFSET':
      // İKİNCİ, BAĞIMSIZ DOĞRULAMA — sınıf etiketine tek başına güvenilmez.
      if (
        verdict.driftMinutes !== TRENDYOL_ORDER_DATE_OFFSET_MINUTES ||
        !verdict.correctedOrderDate
      ) {
        return 'SKIP_UNEXPECTED'
      }
      return 'UPDATE'
    default:
      return 'SKIP_UNEXPECTED'
  }
}

export interface OrderDateRepairCandidate {
  orderId: string
  organizationId: string
  marketplace: string
  packageId: string | null
  orderNumber: string | null
  /** Kayıtlı değer — compare-and-set yükleminin GÖZLENEN değeri. */
  currentOrderDate: Date | string | null
  rawOrderDate: unknown
}

export interface OrderDateRepairPlanRow {
  orderId: string
  organizationId: string
  marketplace: string
  packageId: string | null
  orderNumber: string | null
  currentOrderDate: string | null
  rawOrderDate: unknown
  correctedOrderDate: string | null
  driftMinutes: number | null
  classification: OrderDateDriftClassification
  action: OrderDateRepairAction
}

/**
 * SAF PLANLAYICI — DB'YE DOKUNMAZ, YAZMAZ.
 *
 * Planlama ve mutasyon AYRIDIR: bu fonksiyon dry-run ile apply'ın ORTAK
 * karar noktasıdır, böylece dry-run'ın gösterdiği ile apply'ın yaptığı
 * AYNI koddan doğar.
 */
export function planOrderDateRepairRow(
  candidate: OrderDateRepairCandidate,
): OrderDateRepairPlanRow {
  const verdict = classifyOrderDateDrift({
    storedOrderDate:
      candidate.currentOrderDate instanceof Date
        ? candidate.currentOrderDate
        : (candidate.currentOrderDate ?? null),
    rawOrderDate: candidate.rawOrderDate,
  })
  const current =
    candidate.currentOrderDate instanceof Date
      ? candidate.currentOrderDate.toISOString()
      : candidate.currentOrderDate
        ? String(candidate.currentOrderDate)
        : null
  return {
    orderId: candidate.orderId,
    organizationId: candidate.organizationId,
    marketplace: candidate.marketplace,
    packageId: candidate.packageId,
    orderNumber: candidate.orderNumber,
    currentOrderDate: current,
    rawOrderDate: candidate.rawOrderDate,
    correctedOrderDate: verdict.correctedOrderDate,
    driftMinutes: verdict.driftMinutes,
    classification: verdict.classification,
    action: actionForVerdict(verdict),
  }
}

export interface OrderDateTally {
  scanned: number
  update: number
  alreadyCorrect: number
  rawUnavailable: number
  rawUnparseable: number
  unexpected: number
}

function emptyTally(): OrderDateTally {
  return {
    scanned: 0,
    update: 0,
    alreadyCorrect: 0,
    rawUnavailable: 0,
    rawUnparseable: 0,
    unexpected: 0,
  }
}

function countAction(tally: OrderDateTally, action: OrderDateRepairAction): void {
  tally.scanned += 1
  if (action === 'UPDATE') tally.update += 1
  else if (action === 'SKIP_ALREADY_CORRECT') tally.alreadyCorrect += 1
  else if (action === 'SKIP_RAW_UNAVAILABLE') tally.rawUnavailable += 1
  else if (action === 'SKIP_RAW_UNPARSEABLE') tally.rawUnparseable += 1
  else tally.unexpected += 1
}

/** Trendyol + (varsa) tek kiracı filtresi. Kapsam GENİŞLETİLEMEZ. */
function scopeWhere(organizationId: string | null | undefined, afterId: string | null) {
  const clauses = [eq(orders.marketplace, TRENDYOL_MARKETPLACE)]
  if (organizationId) clauses.push(eq(orders.organizationId, organizationId))
  if (afterId) clauses.push(gt(orders.id, afterId))
  return and(...clauses)
}

const SELECTION = {
  id: orders.id,
  organizationId: orders.organizationId,
  marketplace: orders.marketplace,
  packageId: orders.packageId,
  orderNumber: orders.orderNumber,
  orderDate: orders.orderDate,
  rawPayloadEncrypted: orders.rawPayloadEncrypted,
}

async function readBatch(
  db: Db,
  organizationId: string | null | undefined,
  afterId: string | null,
  batchSize: number,
): Promise<Record<string, unknown>[]> {
  return db
    .select(SELECTION)
    .from(orders)
    .where(scopeWhere(organizationId, afterId))
    .orderBy(asc(orders.id))
    .limit(batchSize)
}

function toCandidate(row: Record<string, unknown>): OrderDateRepairCandidate {
  let rawOrderDate: unknown
  try {
    rawOrderDate = readRawOrderDate((row.rawPayloadEncrypted as string | null) ?? null)
  } catch {
    // Çözülemeyen yük TAHMİN EDİLMEZ; `null` onarım DIŞI bırakır.
    rawOrderDate = null
  }
  return {
    orderId: String(row.id),
    organizationId: String(row.organizationId),
    marketplace: String(row.marketplace),
    packageId: row.packageId ? String(row.packageId) : null,
    orderNumber: row.orderNumber ? String(row.orderNumber) : null,
    currentOrderDate: (row.orderDate as Date | null) ?? null,
    rawOrderDate,
  }
}

export interface OrderDateScanOptions {
  organizationId?: string | null
  batchSize?: number
  /** Devam ettirme imleci: bu id'den BÜYÜK id'ler taranır. */
  startAfterId?: string | null
  /** Örnek satır sayısı (PII YOK). */
  sampleSize?: number
}

export interface OrderDateScanResult {
  tally: OrderDateTally
  /** Kiracı kırılımı: YALNIZ organizationId (uuid) — isim/PII YOK. */
  byOrganization: Record<string, OrderDateTally>
  samples: OrderDateRepairPlanRow[]
  /** Devam imleci; `complete` false ise buradan sürdürülür. */
  lastId: string | null
  batches: number
  complete: boolean
}

/**
 * TAM KAPSAM DENETİMİ — SALT OKUNUR, YAZMA YOK.
 *
 * Tüm satırlar BELLEĞE ALINMAZ: sabit boyutlu yığınlar hâlinde keyset ile
 * ilerlenir ve yalnız sayaçlar + sınırlı örnek tutulur.
 */
export async function scanTrendyolOrderDates(
  db: Db,
  options: OrderDateScanOptions = {},
): Promise<OrderDateScanResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const sampleSize = Math.max(0, options.sampleSize ?? 5)
  const tally = emptyTally()
  const byOrganization: Record<string, OrderDateTally> = {}
  const samples: OrderDateRepairPlanRow[] = []
  let afterId: string | null = options.startAfterId ?? null
  let batches = 0

  for (;;) {
    const rows = await readBatch(db, options.organizationId, afterId, batchSize)
    if (rows.length === 0) break
    batches += 1
    for (const row of rows) {
      const plan = planOrderDateRepairRow(toCandidate(row))
      countAction(tally, plan.action)
      const orgTally = (byOrganization[plan.organizationId] ??= emptyTally())
      countAction(orgTally, plan.action)
      if (samples.length < sampleSize) samples.push(plan)
      afterId = plan.orderId
    }
    if (rows.length < batchSize) break
  }

  return { tally, byOrganization, samples, lastId: afterId, batches, complete: true }
}

export interface OrderDateRepairApplyOptions {
  /** ZORUNLU: kiracı kapsamı. Yokluğunda apply BAŞLAMAZ (fail-closed). */
  organizationId: string
  /** ZORUNLU: `TRENDYOL_ORDERDATE_REPAIR`. */
  confirmation: string
  batchId: string
  batchSize?: number
  startAfterId?: string | null
  startedAt?: string
  completedAt?: string
}

export interface OrderDateRepairAuditSummary {
  batchId: string
  organizationId: string
  marketplace: string
  startedAt: string
  completedAt: string
  batches: number
  scanned: number
  updated: number
  alreadyCorrect: number
  conflicts: number
  rawUnavailable: number
  rawUnparseable: number
  unexpected: number
  failed: number
  lastId: string | null
}

export class OrderDateRepairRefusedError extends Error {}

/**
 * APPLY — AÇIK OPERATÖR NİYETİ ŞART.
 *
 * FAIL-CLOSED: `organizationId` yoksa ya da onay dizgisi birebir eşleşmiyorsa
 * HİÇBİR yığın okunmaz. TÜM KİRACI genelinde apply bu ilk onarımda YOKTUR —
 * kapsam her zaman TEK organizasyondur.
 *
 * COMPARE-AND-SET: her satır YALNIZ `order_date` planlama anında GÖZLENEN
 * değerdeyken güncellenir. Arada canlı senkron satırı değiştirdiyse yüklem
 * tutmaz, satır `conflicts` sayılır ve YENİ değer EZİLMEZ.
 *
 * YIGIN BAŞINA TRANSACTION: tablo boyunca TEK transaction açık tutulmaz.
 * Satır hatası SAVEPOINT ile yalıtılır ve `failed` altında HESABA KATILIR.
 *
 * DOKUNULMAYAN KOLONLAR: yalnız `order_date` yazılır. `updated_at`,
 * `user_label_activated_at`, `operation_status`, `last_operational_activity_at`
 * ve yaşam döngüsü alanları DEĞİŞMEZ (metadata onarımı ≠ operasyon olayı).
 */
export async function applyTrendyolOrderDateRepair(
  db: Db,
  options: OrderDateRepairApplyOptions,
): Promise<OrderDateRepairAuditSummary> {
  if (!options.organizationId || !String(options.organizationId).trim()) {
    throw new OrderDateRepairRefusedError(
      'APPLY için --org zorunludur; tüm kiracılar genelinde onarım bu görevde YASAKTIR.',
    )
  }
  if (options.confirmation !== TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION) {
    throw new OrderDateRepairRefusedError(
      `APPLY için onay dizgisi zorunludur: --confirm ${TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION}`,
    )
  }

  const organizationId = options.organizationId
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const startedAt = options.startedAt ?? new Date().toISOString()
  const tally = emptyTally()
  let updated = 0
  let conflicts = 0
  let failed = 0
  let batches = 0
  let afterId: string | null = options.startAfterId ?? null

  for (;;) {
    const rows = await readBatch(db, organizationId, afterId, batchSize)
    if (rows.length === 0) break
    batches += 1

    const plans = rows.map((row) => planOrderDateRepairRow(toCandidate(row)))
    for (const plan of plans) {
      countAction(tally, plan.action)
      afterId = plan.orderId
    }
    const eligible = plans.filter((plan) => plan.action === 'UPDATE')

    if (eligible.length > 0) {
      await db.transaction(async (tx: Db) => {
        for (const plan of eligible) {
          try {
            // SAVEPOINT: tek satırın hatası yığının tamamını düşürmesin.
            const changed = await tx.transaction(async (inner: Db) =>
              inner
                .update(orders)
                .set({ orderDate: new Date(String(plan.correctedOrderDate)) })
                .where(
                  and(
                    eq(orders.id, plan.orderId),
                    eq(orders.marketplace, TRENDYOL_MARKETPLACE),
                    eq(orders.organizationId, organizationId),
                    // GÖZLENEN DEĞER HÂLÂ AYNI MI? Değilse yazma YOK.
                    eq(orders.orderDate, new Date(String(plan.currentOrderDate))),
                  ),
                )
                .returning({ id: orders.id }),
            )
            if (Array.isArray(changed) && changed.length > 0) updated += 1
            else conflicts += 1
          } catch {
            // SESSİZ GEÇİLMEZ: hesaba katılır ve özet raporda görünür.
            failed += 1
          }
        }
      })
    }

    if (rows.length < batchSize) break
  }

  return {
    batchId: options.batchId,
    organizationId,
    marketplace: TRENDYOL_MARKETPLACE,
    startedAt,
    completedAt: options.completedAt ?? new Date().toISOString(),
    batches,
    scanned: tally.scanned,
    updated,
    alreadyCorrect: tally.alreadyCorrect,
    conflicts,
    rawUnavailable: tally.rawUnavailable,
    rawUnparseable: tally.rawUnparseable,
    unexpected: tally.unexpected,
    failed,
    lastId: afterId,
  }
}
