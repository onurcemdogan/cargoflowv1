// ETİKET İŞ KUYRUĞU — POSTGRES DESTEKLİ, ATOMİK TALEP.
//
// ═══ NEDEN REDIS/KAFKA YOK ═══════════════════════════════════════════════
//
// Bu kuyruğun tek gereksinimi "aynı paket için asla iki iş" ve "aynı işi
// asla iki worker". İkisi de Postgres'in ZATEN verdiği garantiler:
// benzersiz indeks + `FOR UPDATE SKIP LOCKED`. Yeni bir altyapı bileşeni
// eklemek, işletme yükünü artırır ve HİÇBİR güvence kazandırmaz.
//
// ═══ NEDEN VERİTABANI KISITI ═════════════════════════════════════════════
//
// Taşıyıcı etiketi GERİ ALINAMAZ. "Uygulama zaten kontrol ediyor" yeterli
// değildir: iki süreç, yeniden başlatma ya da webhook+stream aynı paketi
// aynı anda bulabilir. Tekillik VERİTABANINDA durur.
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm'
import { labelJobs } from '../db/schema.ts'

// Drizzle'ın akıcı sorgu kurucusu (`.from().where().limit()`) her adımda
// farklı bir jenerik tip döndürür ve burada elle yazılamaz. Depo kodunun
// geri kalanındaki (printZplItems, tenantBlockLoader) sözleşmeyle aynı
// biçimde, YALNIZ bu yerel `Db` şekli için kural gevşetilir.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = {
  execute: (query: unknown) => Promise<unknown>
  insert: (table: unknown) => any
  update: (table: unknown) => any
  select: (fields?: unknown) => any
}

export const LABEL_JOB_TYPE = 'LABEL_PREPARE'

/** Terminal durumlar — worker bunlara DOKUNMAZ. */
export const TERMINAL_JOB_STATUSES = [
  'READY', 'BLOCKED', 'UNKNOWN_AFTER_NETWORK',
] as const

export interface LabelJobRow {
  id: string
  organizationId: string
  marketplace: string
  carrier: string
  packageId: string
  status: string
  attemptCount: number
}

export interface EnqueueResult {
  enqueued: boolean
  reason: 'INSERTED' | 'ALREADY_QUEUED'
}

/**
 * İşi sıraya alır. AYNI paket için ikinci satır OLUŞMAZ.
 *
 * `onConflictDoNothing` benzersiz indekse dayanır: yarış durumunda
 * kaybeden taraf sessizce hiçbir şey yapmaz — hata fırlatmaz, çünkü
 * "zaten sırada" bir hata değildir.
 */
export async function enqueueLabelJob(
  db: Db,
  params: {
    organizationId: string
    marketplace: string
    carrier: string
    packageId: string
  },
): Promise<EnqueueResult> {
  const inserted = await db
    .insert(labelJobs)
    .values({
      organizationId: params.organizationId,
      marketplace: params.marketplace,
      carrier: params.carrier,
      packageId: params.packageId,
      jobType: LABEL_JOB_TYPE,
      status: 'QUEUED',
    })
    .onConflictDoNothing({
      target: [
        labelJobs.organizationId, labelJobs.marketplace,
        labelJobs.carrier, labelJobs.packageId, labelJobs.jobType,
      ],
    })
    .returning({ id: labelJobs.id })
  const rows = (inserted ?? []) as { id: string }[]
  return {
    enqueued: rows.length > 0,
    reason: rows.length > 0 ? 'INSERTED' : 'ALREADY_QUEUED',
  }
}

/**
 * ATOMİK TALEP — `FOR UPDATE SKIP LOCKED`.
 *
 * İki worker aynı anda çalışsa bile aynı satırı ALAMAZ: kilitli satırlar
 * atlanır, beklenmez. Bu, "iki worker aynı paket için iki gönderi yarattı"
 * senaryosunu YAPISAL OLARAK imkânsız kılar.
 */
export async function claimLabelJobs(
  db: Db,
  params: { workerId: string; limit: number; nowMs?: number },
): Promise<LabelJobRow[]> {
  const limit = Math.max(1, Math.min(Number(params.limit) || 1, 50))
  const claimed = await db.execute(sql`
    UPDATE ${labelJobs} AS j
       SET status = 'PREPARING',
           locked_at = now(),
           locked_by = ${params.workerId},
           attempt_count = j.attempt_count + 1,
           updated_at = now()
     WHERE j.id IN (
       SELECT c.id FROM ${labelJobs} AS c
        WHERE c.status IN ('QUEUED', 'FAILED_SAFE_TO_RETRY')
          AND c.available_at <= now()
        ORDER BY c.available_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING j.id, j.organization_id, j.marketplace, j.carrier,
              j.package_id, j.status, j.attempt_count
  `)
  const rows = (Array.isArray(claimed)
    ? claimed
    : (claimed as { rows?: unknown[] })?.rows ?? []) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    marketplace: String(row.marketplace),
    carrier: String(row.carrier),
    packageId: String(row.package_id),
    status: String(row.status),
    attemptCount: Number(row.attempt_count ?? 0),
  }))
}

/** Sonucu yazar. Terminal durumlar bir daha TALEP EDİLMEZ. */
export async function completeLabelJob(
  db: Db,
  params: {
    id: string
    status: string
    errorCode?: string | null
    errorSummary?: string | null
    retryDelayMs?: number
  },
): Promise<void> {
  const retryable = params.status === 'FAILED_SAFE_TO_RETRY'
  await db
    .update(labelJobs)
    .set({
      status: params.status,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: params.errorCode ?? null,
      lastErrorSummary: params.errorSummary ?? null,
      updatedAt: new Date(),
      // Yalnız GÜVENLE tekrarlanabilir işler ileri tarihlenir.
      ...(retryable
        ? {
            availableAt: new Date(
              Date.now() + Math.max(0, Number(params.retryDelayMs ?? 60_000)),
            ),
          }
        : {}),
    })
    .where(eq(labelJobs.id, params.id))
}

/**
 * Süresi geçmiş kilitleri serbest bırakır — ANCAK TAŞIYICI KANITIYLA.
 *
 * ═══ ÖLÇÜLEN GÜVENLİK AÇIĞI ═══════════════════════════════════════════
 * Bu fonksiyon YALNIZ SÜREYE bakıp `PREPARING → QUEUED` yapıyordu. Süreç
 * taşıyıcı çağrısının TAM ORTASINDA öldüyse (`carrier_create_called=true`,
 * sonuç bilinmiyor) satır sessizce kuyruğa dönüyor ve worker İKİNCİ bir
 * fiziksel gönderi yaratabiliyordu. Geçen süre, taşıyıcıya yeniden çıkma
 * İZNİ DEĞİLDİR; yalnız kilidin bayat olduğunu gösterir.
 *
 * Karar `classifyStalePreparing` ile verilir — bayat kurtarma CLI'ının
 * kullandığı AYNI kural. İkinci bir yorum YOKTUR.
 */
export async function releaseStaleLocks(
  db: Db, params: { olderThanMs: number; now?: () => number },
): Promise<number> {
  const now = params.now ?? (() => Date.now())
  const staleAfterMs = Math.max(1_000, params.olderThanMs)
  const cutoff = new Date(now() - staleAfterMs)

  const stale = (await db
    .select()
    .from(labelJobs)
    .where(and(
      eq(labelJobs.status, 'PREPARING'),
      or(lte(labelJobs.lockedAt, cutoff), sql`${labelJobs.lockedAt} IS NULL`),
    ))) as Record<string, unknown>[]
  if (stale.length === 0) return 0

  const [{ classifyStalePreparing }, { shipmentOperations, shipments }] =
    await Promise.all([
      import('./stalePreparingClassifier.ts'),
      import('../db/schema.ts'),
    ])

  let released = 0
  for (const job of stale) {
    const organizationId = String(job.organizationId ?? '')
    const packageId = String(job.packageId ?? '')

    const operations = (await db
      .select({ carrierCreateCalled: shipmentOperations.carrierCreateCalled })
      .from(shipmentOperations)
      .where(and(
        eq(shipmentOperations.organizationId, organizationId),
        eq(shipmentOperations.packageId, packageId),
      ))) as Record<string, unknown>[]
    const carrierCreateCalled = operations.some(
      (operation) => operation.carrierCreateCalled === true,
    )
    const artifacts = (await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.packageId, packageId),
      ))) as unknown[]

    const lockedAt = job.lockedAt ? new Date(String(job.lockedAt)) : null
    const classification = classifyStalePreparing({
      status: 'PREPARING',
      lockedAt,
      // Kilit alanı boşsa kilit sahipsizdir; bayat sayılır.
      lockAgeMs: lockedAt ? now() - lockedAt.getTime() : staleAfterMs,
      staleAfterMs,
      carrierCreateCalled,
      createCallCount: 0,
      carrierArtifactExists: artifacts.length > 0,
      readyLabelExists: false,
      unknownAfterNetworkEvidence: false,
      // Otomatik turda bağımlılık YENİDEN ÖLÇÜLMEZ: iş kuyruğa döner ve
      // hazırlık kapıları normal akışta zaten uygulanır.
      preparationValid: true,
    })
    if (!classification.targetStatus) continue
    // Ağ geçilmiş OLABİLİYORSA satır kuyruğa DÖNMEZ; belirsiz işaretlenir.
    const updated = await db
      .update(labelJobs)
      .set({
        status: classification.targetStatus,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(labelJobs.id, String(job.id)),
        eq(labelJobs.status, 'PREPARING'),
      ))
      .returning({ id: labelJobs.id })
    if ((updated as unknown[]).length === 1 && classification.targetStatus === 'QUEUED') {
      released += 1
    }
  }
  return released
}

/**
 * BAĞIMLILIK SINIFI ENGELLER — otomatik canlanmaya UYGUN kodlar.
 *
 * Bu kodların ortak özelliği: engelin sebebi İŞİN DIŞINDA bir durumdur ve
 * o durum değişince iş aynen geçerlidir. Taşıyıcıya çıkılmış olma ihtimali
 * TAŞIMAZLAR (hepsi ağdan öncedir).
 */
export const DEPENDENCY_BLOCKED_CODES: readonly string[] = [
  'SURAT_PREFLIGHT_DESI_MISSING',
  'SURAT_CREDENTIAL_CONFIG_INVALID',
  'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
  // Trendyol paketi Created iken bloke edildi; Picking'e geçince iş
  // yeniden geçerlidir. Bu kod olmadan paket KALICI OLARAK sıkışırdı.
  'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  'TRENDYOL_PICKING_UPDATE_FAILED',
]

/**
 * TEK PAKET İÇİN bağımlılık engelini kaldırır — AYNI iş satırı.
 *
 * ═══ ÖLÇÜLEN OPERASYONEL ÇIKMAZ ═══════════════════════════════════════
 * `Created` statüsündeki paket `TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS` ile
 * BLOKE ediliyordu. Paket sonra `Picking`e geçtiğinde üretici yeniden
 * çalışıyor, ama `enqueueLabelJob` benzersizlik çakışmasıyla
 * `ALREADY_QUEUED` dönüyordu ve BLOKE satır hiç uyanmıyordu. Paket
 * KALICI OLARAK sıkışıyordu — operatörün elle müdahalesi olmadan çıkış YOK.
 *
 * FAIL-CLOSED: yalnız `BLOCKED` ve yalnız bağımlılık sınıfı kodlar. READY,
 * UNKNOWN_AFTER_NETWORK ve PREPARING satırlar DOKUNULMAZ. Yeni iş
 * YARATILMAZ; `attempt_count` KORUNUR.
 */
export async function reactivateDependencyBlockedJob(
  db: Db,
  params: {
    organizationId: string
    marketplace: string
    carrier: string
    packageId: string
  },
): Promise<boolean> {
  // ═══ DERİNLEMESİNE SAVUNMA — TAŞIYICI KANITI BURADA DA SORULUR ═══════
  //
  // Çağıranın kapıları doğru olsa bile bu ilkel fonksiyon KENDİ BAŞINA
  // güvenli olmalıdır: taşıyıcıya gidilmiş ya da artefaktı olan bir paket
  // hiçbir çağırandan canlandırılamaz.
  const { shipmentOperations, shipments } = await import('../db/schema.ts')
  const operations = (await db
    .select({ carrierCreateCalled: shipmentOperations.carrierCreateCalled })
    .from(shipmentOperations)
    .where(and(
      eq(shipmentOperations.organizationId, params.organizationId),
      eq(shipmentOperations.packageId, params.packageId),
    ))) as Record<string, unknown>[]
  if (operations.some((operation) => operation.carrierCreateCalled === true)) {
    return false
  }
  const artifacts = (await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(and(
      eq(shipments.organizationId, params.organizationId),
      eq(shipments.packageId, params.packageId),
    ))) as unknown[]
  if (artifacts.length > 0) return false

  // Koşul GÜNCELLEMENİN İÇİNDEDİR: eşzamanlı iki kaynak aynı satırı
  // görse bile YALNIZ BİRİ geçiş yapar (diğeri 0 satır döner).
  const updated = await db
    .update(labelJobs)
    .set({
      status: 'QUEUED',
      availableAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.marketplace, params.marketplace),
        eq(labelJobs.carrier, params.carrier),
        eq(labelJobs.packageId, params.packageId),
        eq(labelJobs.status, 'BLOCKED'),
        inArray(labelJobs.lastErrorCode, [...DEPENDENCY_BLOCKED_CODES]),
      ),
    )
    .returning({ id: labelJobs.id })
  return ((updated ?? []) as unknown[]).length === 1
}

/** Operasyonel sayaçlar — PII/sır YOK. */
/**
 * BLOKE isleri yeniden etkinlestirir — BAGIMLILIK DEGISTIGINDE.
 *
 * Deterministik agdan-onceki engeller (desi eksik, kimlik yapilandirmasi
 * gecersiz) otomatik tekrar DENENMEZ; aksi halde her worker turunda
 * `attempt_count` artar ve hicbir sey degismez.
 *
 * Ilgili kiracı ayarı degistiginde bu fonksiyon cagrilir: AYNI mantiksal is
 * yeniden kuyruga alinir. YENI is YARATILMAZ → mukerrer gonderi imkansiz.
 *
 * Yalniz BLOCKED isler ve yalniz verilen kod kumesi hedeflenir; taşıyıcıya
 * gidilmis (UNKNOWN_AFTER_NETWORK) veya biten (READY) isler DOKUNULMAZ.
 */
export async function reactivateBlockedLabelJobs(
  db: Db,
  params: { organizationId: string; errorCodes: readonly string[] },
): Promise<number> {
  const codes = params.errorCodes.filter(Boolean)
  if (codes.length === 0) return 0

  // ═══ TOPLU KOŞULSUZ GÜNCELLEME KALDIRILDI ══════════════════════════
  //
  // ÖLÇÜLEN KUSUR: bu fonksiyon YALNIZ `status=BLOCKED` ve hata koduna
  // bakıp TEK BİR `UPDATE` ile hepsini kuyruğa alıyordu. Taşıyıcı kanıtı,
  // artefakt ve GÜNCEL pazaryeri yaşam döngüsü SORULMUYORDU. Bu, üreticide
  // ölçülen çalkantının kardeşidir: kiracı ayar kaydettiğinde `Shipped`
  // ya da `Created` bir paket de uyanabilirdi.
  //
  // Artık her satır TEK canlandırma ilkelinden geçer ve ancak GÜNCEL
  // paylaşılan hazırlık GEÇERLİYSE uyanır. Hazırlık geçersizse HİÇBİR
  // yazım olmaz: `updated_at` bile değişmez, `attempt_count` sabit kalır.
  const candidates = (await db
    .select({
      marketplace: labelJobs.marketplace,
      carrier: labelJobs.carrier,
      packageId: labelJobs.packageId,
    })
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.status, 'BLOCKED'),
        inArray(labelJobs.lastErrorCode, [...codes]),
      ),
    )) as Record<string, unknown>[]
  if (candidates.length === 0) return 0

  const { prepareLabelJob } = await import('./labelJobPreparation.ts')
  let revived = 0
  for (const candidate of candidates) {
    const packageId = String(candidate.packageId ?? '')
    const marketplace = String(candidate.marketplace ?? 'Trendyol')
    const prepared = await prepareLabelJob(db, {
      organizationId: params.organizationId, packageId, marketplace,
    })
    // BAĞIMLILIK HÂLÂ ÇÖZÜLMEDİYSE SATIR BLOKE KALIR.
    if (!prepared.ok) continue
    const ok = await reactivateDependencyBlockedJob(db, {
      organizationId: params.organizationId,
      marketplace,
      carrier: String(candidate.carrier ?? 'surat'),
      packageId,
    })
    if (ok) revived += 1
  }
  return revived
}

export async function labelJobStats(
  db: Db, organizationId?: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: labelJobs.status, total: sql<number>`count(*)::int` })
    .from(labelJobs)
    .where(organizationId ? eq(labelJobs.organizationId, organizationId) : sql`true`)
    .groupBy(labelJobs.status)
  const stats: Record<string, number> = {}
  for (const row of (rows ?? []) as { status: string; total: number }[]) {
    stats[row.status] = Number(row.total ?? 0)
  }
  return stats
}
