// ═══ ESKİ AÇIK KAYIT MUTABAKATI (BOUNDED STALE-OPEN RECONCILE) ════════════
//
// ÜRETİM BULGUSU (CASE OLD-B). Arka plan Trendyol turu tarih parametresi
// GÖNDERMEZ; `callTrendyolOrders` varsayılanı SON 7 GÜNDÜR. Manuel "Şimdi
// Yenile" ise 30 günlük pencere gönderir. Bu yüzden 7 günden eski, hâlâ
// operasyonel olarak AÇIK (LABEL_READY / LABEL_PRINTED) kayıtlar arka plan
// turunun kapsamına HİÇ girmez: pazaryeri statüleri Delivered olsa bile DB'de
// `Picking` kalır ve sipariş süresiz açık görünür.
//
// ÇÖZÜM: tüm geçmişi her turda çekmek DEĞİL. DB'den YALNIZ açık ve eskimiş
// adaylar SINIRLI bir batch hâlinde seçilir; her aday, KANITLI salt-okunur
// `orderNumber` sorgu sözleşmesiyle doğrulanır ve sonuç KANONİK zincire
// (normalizeTrendyolOrders → persistSyncResult) verilir.
//
// BU MODÜLDE İŞ KURALI YOKTUR:
//   · yeni statü eşlemesi YOK · yeni persistence YOK · yeni kolon YOK
//   · Sürat/SSP YOK · etiket/print YOK · retention politikası DEĞİŞMEZ
// Sorgu ve kalıcılaştırma DIŞARIDAN enjekte edilir.
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import { MARKETPLACE_FORWARD_STATUSES } from './orderRetention.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * OPERASYONEL OLARAK AÇIK sayılan canonical durumlar. Bunlar CargoFlow'un
 * "iş bitmedi" dediği kayıtlardır; pazaryeri statüsü terminal hâle geldiğinde
 * ilerlemeleri gerekir. Daha erken aşamalar (henüz etiket üretilmemiş) zaten
 * aktif pencerededir ve ana tur onları kapsar.
 */
export const OPEN_OPERATION_STATUSES = ['LABEL_READY', 'LABEL_PRINTED'] as const

/**
 * KANONİK "KARGOYA VERİLDİ" (yolda) kümesi — `src/utils/orderClassification.ts`
 * `marketplaceHandedToCargo` ile AYNI değerler. Bu statüler İLERİ ama TERMİNAL
 * DEĞİLDİR: paket hâlâ hareket hâlindedir ve Delivered'a ilerlemesi beklenir.
 */
export const IN_TRANSIT_MARKETPLACE_STATUSES = [
  'Shipped',
  'AtCollectionPoint',
] as const

/**
 * TERMİNAL statüler kanonik ileri kümeden TÜRETİLİR (üçüncü bir liste
 * YAZILMAZ): Delivered · Cancelled · Returned · UnDelivered · UnSupplied.
 * Bu kayıtlar için doğrulanacak bir şey kalmadığından ASLA aday olmazlar.
 */
export const TERMINAL_MARKETPLACE_STATUSES = MARKETPLACE_FORWARD_STATUSES.filter(
  (status) =>
    !(IN_TRANSIT_MARKETPLACE_STATUSES as readonly string[]).includes(status),
)

export interface StaleReconcilePolicy {
  enabled: boolean
  /**
   * KENDİ CADENCE'İ. Ana Trendyol turu 60 sn'ye kadar sıklaşabilir; bu geçiş
   * ONA BAĞLI DEĞİLDİR ve tabanı 5 dakikadır (istek yükü öngörülebilir kalsın).
   */
  intervalMs: number
  /** Bir turda doğrulanacak EN FAZLA aday sayısı. */
  batchSize: number
  /** Aynı anda kaç aday sorgulanır. */
  concurrency: number
  /** Bu yaştan ESKİ kayıtlar aday olur (ana turun penceresi dışı). */
  staleAfterMs: number
  /**
   * TEKRAR SORGU SOĞUMASI. Bir aday doğrulandığında (statüsü değişmese bile)
   * `marketplaceUpdateSet` `last_seen_at`i BUGÜNE çeker; bu alan burada
   * soğuma çapası olarak KULLANILIR. Böylece aynı terminal-olmayan kayıt her
   * 5 dakikada yeniden sorgulanmaz. Yeni kolon/migration GEREKMEZ.
   */
  cooldownMs: number
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

/**
 * YALNIZ açık onay etkinleştirir: 'true' | '1'. Diğer her şey KAPALI.
 * TRENDYOL_STATUS_SYNC_ENABLED=true olması bu geçişi AÇMAZ — dış API'ye ek
 * istek ürettiği için ayrı ve açık bir karar gerektirir.
 */
export function isStaleReconcileEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.TRENDYOL_STALE_RECONCILE_ENABLED ?? '')
    .trim()
    .toLowerCase()
  return raw === 'true' || raw === '1'
}

export function resolveStaleReconcilePolicy(
  env: Record<string, string | undefined> = process.env,
): StaleReconcilePolicy {
  return {
    enabled: isStaleReconcileEnabled(env),
    // TABAN 5 DAKİKA. Ana tur 60 sn'ye inse bile bu geçiş sıklaşmaz; aksi
    // hâlde saatlik ek istek sayısı 12 katına çıkardı.
    intervalMs: Math.max(
      300_000,
      positiveInt(env.TRENDYOL_STALE_RECONCILE_INTERVAL_MS, 300_000),
    ),
    // Tavan SERT: tur başına istek sayısı öngörülebilir kalmalı.
    batchSize: Math.min(50, positiveInt(env.TRENDYOL_STALE_RECONCILE_BATCH, 10)),
    concurrency: Math.min(
      4,
      positiveInt(env.TRENDYOL_STALE_RECONCILE_CONCURRENCY, 2),
    ),
    // Ana tur son 7 günü kapsar; 6 gün eşiği 1 günlük GÜVENLİ örtüşme bırakır
    // (pencere sınırında kayıt kaçmasın).
    staleAfterMs: Math.max(
      24 * 60 * 60 * 1000,
      positiveInt(
        env.TRENDYOL_STALE_RECONCILE_AFTER_MS,
        6 * 24 * 60 * 60 * 1000,
      ),
    ),
    // Varsayılan 6 saat: aynı kayıt için günde en fazla ~4 doğrulama.
    cooldownMs: positiveInt(
      env.TRENDYOL_STALE_RECONCILE_COOLDOWN_MS,
      6 * 60 * 60 * 1000,
    ),
  }
}

export interface StaleOpenCandidate {
  id: string
  orderNumber: string
  packageId: string
  orderDate: Date
  marketplaceStatus: string | null
  operationStatus: string | null
}

/** Keyset (cursor) konumu: aynı adaylar her turda tekrar seçilmesin diye. */
export interface StaleCursor {
  orderDate: Date
  id: string
}

/**
 * ADAY YÜKLEMİ (SALT OKUMA):
 *   arşivlenmemiş
 *   AND operation_status ∈ {LABEL_READY, LABEL_PRINTED}
 *   AND (marketplace_status IS NULL OR ileri/terminal statülerden DEĞİL)
 *   AND order_date < staleBefore          (ana turun penceresi dışında)
 *   AND (order_date, id) > cursor         (keyset ilerleme)
 * Hesap kapsamı ana turla AYNIDIR; başka hesabın kaydı ASLA seçilmez.
 */
export async function findStaleOpenCandidates(
  db: Db,
  input: {
    organizationId: string
    marketplaceAccountId: string | null
    limit: number
    staleBefore: Date
    /** Bu andan ÖNCE görülmüş kayıtlar aday olur (soğuma çapası). */
    seenBefore: Date
    cursor?: StaleCursor | null
  },
): Promise<StaleOpenCandidate[]> {
  const accountScope =
    input.marketplaceAccountId == null
      ? isNull(orders.marketplaceAccountId)
      : eq(orders.marketplaceAccountId, input.marketplaceAccountId)
  const clauses = [
    eq(orders.organizationId, input.organizationId),
    accountScope,
    isNull(orders.archivedAt),
    // İKİ ADAY SINIFI (biri VEYA diğeri):
    //
    //  1) AÇIK OPERASYON: CargoFlow etiketi hazır/basılmış ama pazaryeri
    //     statüsü hâlâ ileri DEĞİL (klasik "iş bitmedi" kaydı).
    //
    //  2) YOLDA: pazaryeri statüsü Shipped/AtCollectionPoint — yani ileri ama
    //     TERMİNAL DEĞİL. Bu sınıf `operation_status`tan BAĞIMSIZDIR: üretimde
    //     `operation_status = NULL` + `Shipped` kalan eski kayıtlar (golden
    //     4019554630) HİÇBİR periyodik yazarın kapsamına girmiyordu — ana tur
    //     yalnız son 7 günü, sınıf 1 ise yalnız LABEL_READY/LABEL_PRINTED'i
    //     görüyordu.
    //
    // Terminal statüler (Delivered/Cancelled/Returned/UnDelivered/UnSupplied)
    // İKİ SINIFA DA girmez → bir kayıt terminale ulaştığında sonraki turlarda
    // aday olmaktan çıkar (backlog erir, starvation yok).
    or(
      and(
        sql`${orders.operationStatus} in ${OPEN_OPERATION_STATUSES}`,
        sql`(${orders.marketplaceStatus} is null or ${orders.marketplaceStatus} not in ${MARKETPLACE_FORWARD_STATUSES})`,
      )!,
      // SINIF 2 — TERMİNAL OLMAYAN pazaryeri kaydı. Küme SAYILMAZ, TÜRETİLİR:
      // "bilinen bir statü var VE terminal değil". Böylece Created/Picking/
      // Invoiced (golden 4028055254: Picking + NEW) ve Shipped/
      // AtCollectionPoint kendiliğinden kapsanır; yeni bağımsız liste YOK.
      // `Unknown` ve boş/yer tutucu statüler AÇIKÇA dışlanır (kör sorgu yok).
      and(
        sql`${orders.marketplaceStatus} is not null`,
        sql`trim(${orders.marketplaceStatus}) <> ''`,
        sql`${orders.marketplaceStatus} <> 'Unknown'`,
        sql`${orders.marketplaceStatus} not in ${TERMINAL_MARKETPLACE_STATUSES}`,
      )!,
    )!,
    lt(orders.orderDate, input.staleBefore),
    // SOĞUMA: son görülme damgası taze olan kayıt yeniden sorgulanmaz.
    or(
      isNull(orders.lastSeenAt),
      lt(orders.lastSeenAt, input.seenBefore),
    )!,
  ]
  if (input.cursor) {
    clauses.push(
      or(
        gt(orders.orderDate, input.cursor.orderDate),
        and(
          eq(orders.orderDate, input.cursor.orderDate),
          gt(orders.id, input.cursor.id),
        ),
      )!,
    )
  }
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      packageId: orders.packageId,
      orderDate: orders.orderDate,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
    })
    .from(orders)
    .where(and(...clauses))
    .orderBy(asc(orders.orderDate), asc(orders.id))
    .limit(Math.max(1, input.limit))
  return rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    orderNumber: String(row.orderNumber ?? ''),
    packageId: String(row.packageId ?? ''),
    orderDate: row.orderDate as Date,
    marketplaceStatus: (row.marketplaceStatus as string | null) ?? null,
    operationStatus: (row.operationStatus as string | null) ?? null,
  }))
}

/**
 * Bir sonraki turun başlangıç konumu. Batch dolmadıysa (liste bitti) cursor
 * SIFIRLANIR → sıradaki tur baştan başlar. Böylece Trendyol hâlâ `Picking`
 * diyen bir aday kuyruğun başında TAKILI KALIP diğerlerini AÇ BIRAKMAZ.
 */
export function advanceCursor(
  candidates: readonly StaleOpenCandidate[],
  batchSize: number,
): StaleCursor | null {
  if (candidates.length === 0 || candidates.length < batchSize) return null
  const last = candidates[candidates.length - 1]
  return { orderDate: last.orderDate, id: last.id }
}

export interface StaleReconcileReport {
  scanned: number
  queried: number
  persisted: number
  failed: number
  skipped: number
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
 * SINIRLI bir mutabakat turu.
 *
 * `queryCandidate` KANONİK salt-okunur Trendyol `orderNumber` sorgusudur ve
 * HAM paket kayıtlarını döner. `persistPackages` KANONİK zincirdir
 * (normalizeTrendyolOrders → persistSyncResult, aktif hesap kapsamıyla).
 * Bu modül İKİSİNİ DE UYGULAMAZ — yalnız sırayı ve sınırı yönetir.
 *
 * FAIL-OPEN: bir adayın sorgusu/kalıcılaştırması başarısız olursa O KAYIT
 * DEĞİŞMEZ ve tur diğer adaylarla DEVAM eder.
 */
export async function reconcileStaleOpenOrders(
  policy: StaleReconcilePolicy,
  candidates: readonly StaleOpenCandidate[],
  queryCandidate: (candidate: StaleOpenCandidate) => Promise<unknown[]>,
  persistPackages: (packages: unknown[]) => Promise<void>,
): Promise<StaleReconcileReport> {
  if (!policy.enabled || candidates.length === 0) {
    return { scanned: 0, queried: 0, persisted: 0, failed: 0, skipped: 0 }
  }
  const usable = candidates.filter((candidate) => candidate.orderNumber)
  const outcomes = await mapWithConcurrency(
    usable,
    policy.concurrency,
    async (candidate) => {
      try {
        const packages = await queryCandidate(candidate)
        if (!Array.isArray(packages) || packages.length === 0) return 'skipped'
        await persistPackages(packages)
        return 'persisted'
      } catch {
        return 'failed'
      }
    },
  )
  return {
    scanned: candidates.length,
    queried: usable.length,
    persisted: outcomes.filter((value) => value === 'persisted').length,
    failed: outcomes.filter((value) => value === 'failed').length,
    // orderNumber taşımayan aday sorgulanamaz; sessizce atlanır.
    skipped:
      outcomes.filter((value) => value === 'skipped').length +
      (candidates.length - usable.length),
  }
}

// ═══ BAĞIMSIZ ZAMANLAYICI ═════════════════════════════════════════════════
//
// Ana Trendyol turundan AYRI timer ve AYRI overlap guard'ı vardır. Ana tur
// TRENDYOL_STATUS_SYNC_INTERVAL_MS=60000 ile çalışsa bile bu geçiş kendi
// (tabanı 5 dakika olan) cadence'ini kullanır.

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false
let stopping = false

export interface StaleSchedulerHandle {
  started: boolean
  reason: 'disabled' | 'started'
  stop: () => void
}

export function startStaleReconcileScheduler(options: {
  policy?: StaleReconcilePolicy
  runCycle: () => Promise<StaleReconcileReport>
  log?: (report: StaleReconcileReport) => void
  onError?: (error: unknown) => void
}): StaleSchedulerHandle {
  stopStaleReconcileScheduler()
  stopping = false
  const policy = options.policy ?? resolveStaleReconcilePolicy()

  // ACTIVATION GUARD — tek karar noktası.
  if (!policy.enabled) {
    return {
      started: false,
      reason: 'disabled',
      stop: stopStaleReconcileScheduler,
    }
  }

  const emit = (report: StaleReconcileReport) => {
    if (options.log) {
      options.log(report)
      return
    }
    // PII YOK: yalnız aggregate sayımlar.
    console.log(
      `[trendyol-stale] scanned=${report.scanned} queried=${report.queried} ` +
        `persisted=${report.persisted} failed=${report.failed} ` +
        `skipped=${report.skipped}`,
    )
  }

  const cycle = async (): Promise<void> => {
    // ÖRTÜŞME YOK: önceki tur bitmeden yenisi başlamaz. Ana senkronun
    // guard'ından BAĞIMSIZDIR.
    if (cycleRunning || stopping) return
    cycleRunning = true
    try {
      emit(await options.runCycle())
    } catch (error) {
      // TUR HATASI UYGULAMAYI DÜŞÜRMEZ.
      if (options.onError) options.onError(error)
      else
        console.error('[trendyol-stale] cycle failed:', (error as Error)?.message)
    } finally {
      cycleRunning = false
    }
  }

  void cycle()
  timer = setInterval(() => {
    void cycle()
  }, policy.intervalMs)
  timer.unref?.()

  return { started: true, reason: 'started', stop: stopStaleReconcileScheduler }
}

export function stopStaleReconcileScheduler(): void {
  stopping = true
  if (timer) clearInterval(timer)
  timer = null
}

export function isStaleReconcileActive(): boolean {
  return timer !== null
}
