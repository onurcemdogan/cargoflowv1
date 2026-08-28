// KONTROLLÜ ÜRETİM KANARYASI — TEK İŞ, TEK CREATE.
//
// ═══ NEDEN AYRI BİR YOL ══════════════════════════════════════════════════
// `claimLabelJobs` bir TOPLU sorgudur: `status IN ('QUEUED',
// 'FAILED_SAFE_TO_RETRY')` koşuluna uyan HER satırı sırayla talep eder.
// Kanarya için bu YANLIŞ araçtır — worker kapalıyken sıraya girmiş ilgisiz
// işler de uyanırdı.
//
// Bu modül genel talep sorgusuna DOKUNMAZ ve onu KULLANMAZ. Yalnız TEK bir
// satırı, kimliğiyle, TEK bir atomik `UPDATE` ile talep eder.
//
// ═══ KAPILAR AÇILMADAN TAŞIYICIYA ÇIKILMAZ ═══════════════════════════════
// Her kapı taşıyıcı çağrısından ÖNCE değerlendirilir. Biri bile kapalıysa
// `CARRIER_CALLS=0` ile durulur ve HİÇBİR satır yazılmaz — talep bile
// edilmez, çünkü talep `attempt_count`'u artırır.
//
// ═══ KANARYA KAPSAMI DARDIR ══════════════════════════════════════════════
// Yalnız KANITLANMIŞ yol açıktır: pazaryeri ödemeli (TRENDYOL_PAYS →
// WhoPays 3 → PRIMARY_MARKETPLACE). SELLER_PAYS/COD siparişleri kapsam
// DIŞIDIR ve kapıda durur. Kanarya, kapsamını genişletmek için değil,
// tek bir paketi kanıtlamak için vardır.
//
// ═══ İKİNCİ CREATE İMKÂNSIZ ══════════════════════════════════════════════
// Taşıyıcı en fazla BİR KEZ çağrılır. Ağ geçildiyse sonuç belirsiz olsa
// bile TEKRAR DENENMEZ (`UNKNOWN_AFTER_NETWORK`). Deterministik ağ-öncesi
// ret `BLOCKED` yazar. Bu komut ASLA `FAILED_SAFE_TO_RETRY` bırakmaz:
// kendi kendine uyanan bir satır, kontrollü kanaryanın tam tersidir.

import { and, eq, sql } from 'drizzle-orm'
import { labelJobs, shipmentOperations, shipments } from '../db/schema.ts'
import { completeLabelJob, type LabelJobRow } from './labelJobQueue.ts'
import { resolveAutoLabelJobState } from './suratAutoLabelPolicy.ts'
import { preflightLabelJob } from './labelJobPreflight.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface LabelRunOutcome {
  labelReady: boolean
  networkCrossed: boolean
  blocked?: boolean
  errorCode?: string | null
  errorSummary?: string | null
  carrierCalls?: number
}

export interface SingleJobRunReport {
  readonly packageId: string
  readonly jobId: string | null
  readonly statusBefore: string | null
  readonly statusAfter: string | null
  readonly attemptCountBefore: number | null
  readonly attemptCountAfter: number | null

  readonly tenantDesi: number | null
  readonly resolvedDesi: number | null
  readonly suratBirimDesi: number | null

  readonly billingParty: string | null
  readonly expectedSuratWhoPays: number | null
  readonly credentialRole: string | null

  readonly carrierCallStarted: boolean
  readonly carrierCalled: boolean
  readonly carrierCreateAttempts: number
  readonly carrierCode: string | null
  readonly businessResult: string | null
  readonly trackingPresent: boolean
  readonly barcodePresent: boolean
  readonly zplPresent: boolean
  readonly zplLength: number
  /** Etiket OKUNAMADIYSA sebebi; "yok" ile karıştırılmaz. */
  readonly zplReadFailure: string | null

  readonly otherQueuedJobsTouched: number
  readonly totalCarrierCalls: 0 | 1
  readonly gatesPassed: boolean
  readonly blockers: readonly string[]
  readonly preflightFailureDetail: string | null
}

interface JobSnapshot {
  id: string
  packageId: string
  status: string
  attemptCount: number
}

async function snapshotJobs(
  db: Db, organizationId: string,
): Promise<JobSnapshot[]> {
  const rows = await db
    .select({
      id: labelJobs.id,
      packageId: labelJobs.packageId,
      status: labelJobs.status,
      attemptCount: labelJobs.attemptCount,
    })
    .from(labelJobs)
    .where(eq(labelJobs.organizationId, organizationId))
  return (rows as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    packageId: String(row.packageId),
    status: String(row.status),
    attemptCount: Number(row.attemptCount ?? 0),
  }))
}

/**
 * TEK İŞ ÇALIŞTIRICI.
 *
 * `runLabel` ENJEKTE edilir: üretimde bu, worker'ın kullandığı ile AYNI
 * create orkestrasyonudur (`runLabelJobViaCreateHandler`). Burada ikinci
 * bir create yolu YAZILMAZ — yalnız kapılar ve tek satır muhasebesi vardır.
 */
export async function runSingleLabelJob(
  db: Db,
  params: {
    organizationId: string
    packageId: string
    marketplace?: string
    workerId: string
    runLabel: (job: LabelJobRow) => Promise<LabelRunOutcome>
    /** Verilirse çözülen desi BUNA EŞİT olmalıdır; değilse kapı kapanır. */
    expectedDesi?: number | null
    /**
     * AÇIKÇA verilmedikçe `QUEUED` iş İŞLENMEZ.
     *
     * Zımnî bir gevşetme DEĞİLDİR: bayrak yoksa davranış aynen korunur.
     * Bayrak verildiğinde bile YALNIZ istenen tek satır, `status='QUEUED'`
     * VE `attempt_count=0` koşullarıyla, kimliğiyle talep edilir.
     */
    allowQueuedCanary?: boolean
  },
): Promise<SingleJobRunReport> {
  const blockers: string[] = []
  const before = await snapshotJobs(db, params.organizationId)
  const targets = before.filter((job) => job.packageId === params.packageId)

  // ── KAPI: TAM OLARAK BİR İŞ SATIRI ─────────────────────────────────
  if (targets.length === 0) blockers.push('IS_BULUNAMADI')
  if (targets.length > 1) blockers.push('MUKERRER_IS')
  const target = targets.length === 1 ? targets[0] : null

  // ── KAPI: DURUM ─────────────────────────────────────────────────────
  //
  // Yalnız `BLOCKED` kabul edilir. `QUEUED` satırlar BİLEREK reddedilir:
  // worker kapalıyken sıraya girmiş ilgisiz işler bu komutla İŞLENMEZ.
  // `READY` ve `UNKNOWN_AFTER_NETWORK` zaten taşıyıcı tarafında sonuç
  // doğurmuş olabilir; onlara ikinci create YAPILMAZ.
  const queuedCanary = params.allowQueuedCanary === true
  const acceptedStatuses = queuedCanary ? ['BLOCKED', 'QUEUED'] : ['BLOCKED']
  if (target && !acceptedStatuses.includes(target.status)) {
    blockers.push(`IS_DURUMU_UYGUN_DEGIL(${target.status})`)
  }
  // Kuyruk kanaryası YALNIZ HİÇ DENENMEMİŞ işte açılır. Denenmiş bir
  // QUEUED satır, taşıyıcıya gidilmiş olabileceği anlamına gelir.
  if (
    target &&
    target.status === 'QUEUED' &&
    queuedCanary &&
    target.attemptCount !== 0
  ) {
    blockers.push(`KUYRUK_KANARYASI_DENENMIS(${target.attemptCount})`)
  }

  // ── KAPI: TAŞIYICI ARTEFAKTI VE KAYITLI ÇAĞRI ──────────────────────
  const operations = await db
    .select({
      carrierCreateCalled: shipmentOperations.carrierCreateCalled,
      createCallCount: shipmentOperations.createCallCount,
    })
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, params.organizationId),
        eq(shipmentOperations.packageId, params.packageId),
      ),
    )
  const carrierCallRecorded = (operations as Record<string, unknown>[]).some(
    (operation) => operation.carrierCreateCalled === true,
  )
  if (carrierCallRecorded) blockers.push('TASIYICI_CAGRISI_KAYITLI')

  // ── KAPI: ÖN KONTROL (desi, faturalama, kimlik) ────────────────────
  //
  // Aynı paylaşılan salt-okunur hazırlık; ikinci bir yorum YOK.
  const preflight = await preflightLabelJob(db, {
    organizationId: params.organizationId,
    packageId: params.packageId,
    marketplace: params.marketplace,
  })
  for (const blocker of preflight.blockers) blockers.push(blocker)
  if (!preflight.preflightValid) blockers.push('ON_KONTROL_GECERSIZ')

  if (
    preflight.resolvedDesi == null ||
    preflight.tenantDesi == null ||
    preflight.resolvedDesi !== preflight.tenantDesi
  ) {
    // Kiracı ayarı ile çözülen desi ayrışıyorsa fiyat YANLIŞ olurdu.
    blockers.push('DESI_KIRACI_AYARIYLA_UYUSMUYOR')
  }
  if (preflight.suratBirimDesi !== preflight.resolvedDesi) {
    blockers.push('BIRIM_DESI_COZULEN_DESIDEN_FARKLI')
  }
  if (
    params.expectedDesi != null &&
    preflight.resolvedDesi !== params.expectedDesi
  ) {
    blockers.push(
      `DESI_BEKLENENDEN_FARKLI(beklenen=${params.expectedDesi} `
      + `cozulen=${String(preflight.resolvedDesi)})`,
    )
  }

  // ── KAPI: FATURALAMA — KANARYA YALNIZ KANITLANMIŞ YOLDA ────────────
  if (preflight.billingParty !== 'TRENDYOL_PAYS') {
    blockers.push(`KANARYA_KAPSAMI_DISI(${String(preflight.billingParty)})`)
  }
  if (preflight.expectedSuratWhoPays !== 3) blockers.push('WHOPAYS_BEKLENEN_3_DEGIL')
  if (preflight.credentialRole !== 'PRIMARY_MARKETPLACE') {
    blockers.push('KIMLIK_ROLU_BEKLENEN_DEGIL')
  }
  if (!preflight.credentialResolved) blockers.push('KIMLIK_COZULMEDI')

  const failed = (extra?: Partial<SingleJobRunReport>): SingleJobRunReport => ({
    packageId: params.packageId,
    jobId: target?.id ?? null,
    statusBefore: target?.status ?? null,
    statusAfter: target?.status ?? null,
    attemptCountBefore: target?.attemptCount ?? null,
    attemptCountAfter: target?.attemptCount ?? null,
    tenantDesi: preflight.tenantDesi,
    resolvedDesi: preflight.resolvedDesi,
    suratBirimDesi: preflight.suratBirimDesi,
    billingParty: preflight.billingParty,
    expectedSuratWhoPays: preflight.expectedSuratWhoPays,
    credentialRole: preflight.credentialRole,
    carrierCallStarted: false,
    carrierCalled: false,
    carrierCreateAttempts: 0,
    carrierCode: null,
    businessResult: 'GATE_BLOCKED',
    trackingPresent: false,
    barcodePresent: false,
    zplPresent: false,
    zplLength: 0,
    zplReadFailure: null,
    otherQueuedJobsTouched: 0,
    totalCarrierCalls: 0,
    gatesPassed: false,
    blockers: [...new Set(blockers)],
    preflightFailureDetail: preflight.failureDetail,
    ...extra,
  })

  // KAPI KAPALIYSA HİÇBİR ŞEY YAZILMAZ — talep bile edilmez.
  if (blockers.length > 0 || !target) return failed()

  // ═══ ATOMİK TEK SATIR TALEBİ ═══════════════════════════════════════
  //
  // Toplu sorgu DEĞİL: satır KİMLİĞİYLE hedeflenir ve durum koşulu
  // güncellemenin İÇİNDEDİR. Bu komut başka hiçbir satıra dokunamaz;
  // yarış durumunda ikinci çalıştırma 0 satır döner ve durur.
  //
  // KUYRUK KANARYASI: koşul `status='QUEUED' AND attempt_count=0` olarak
  // DARALTILIR. `LIMIT` yoktur, `IN` listesi yoktur, sıra taraması yoktur —
  // yalnız BU satır. Bayrak verilmediyse koşul `BLOCKED` olarak kalır.
  const claimed =
    target.status === 'QUEUED'
      ? await db.execute(sql`
    UPDATE ${labelJobs} AS j
       SET status = 'PREPARING',
           locked_at = now(),
           locked_by = ${params.workerId},
           attempt_count = j.attempt_count + 1,
           updated_at = now()
     WHERE j.id = ${target.id}
       AND j.organization_id = ${params.organizationId}
       AND j.package_id = ${params.packageId}
       AND j.status = 'QUEUED'
       AND j.attempt_count = 0
    RETURNING j.id, j.organization_id, j.marketplace, j.carrier,
              j.package_id, j.status, j.attempt_count
  `)
      : await db.execute(sql`
    UPDATE ${labelJobs} AS j
       SET status = 'PREPARING',
           locked_at = now(),
           locked_by = ${params.workerId},
           attempt_count = j.attempt_count + 1,
           updated_at = now()
     WHERE j.id = ${target.id}
       AND j.organization_id = ${params.organizationId}
       AND j.package_id = ${params.packageId}
       AND j.status = 'BLOCKED'
    RETURNING j.id, j.organization_id, j.marketplace, j.carrier,
              j.package_id, j.status, j.attempt_count
  `)
  const claimedRows = (Array.isArray(claimed)
    ? claimed
    : (claimed as { rows?: unknown[] })?.rows ?? []) as Record<string, unknown>[]
  if (claimedRows.length !== 1) {
    blockers.push('ATOMIK_TALEP_BASARISIZ')
    return failed()
  }
  const row = claimedRows[0]
  const job: LabelJobRow = {
    id: String(row.id),
    organizationId: String(row.organization_id),
    marketplace: String(row.marketplace),
    carrier: String(row.carrier),
    packageId: String(row.package_id),
    status: String(row.status),
    attemptCount: Number(row.attempt_count ?? 0),
  }

  // ═══ TAŞIYICI SINIRI — EN FAZLA BİR CREATE ═════════════════════════
  let outcome: LabelRunOutcome
  try {
    outcome = await params.runLabel(job)
  } catch (error) {
    // İstisna "ağa çıkılmadı" KANITI DEĞİLDİR: belirsiz sayılır ve
    // create TEKRARLANMAZ — worker'ın yaptığının aynısı.
    outcome = {
      labelReady: false,
      networkCrossed: true,
      errorCode: 'SINGLE_JOB_RUNNER_EXCEPTION',
      errorSummary: String((error as Error)?.message ?? error).slice(0, 300),
    }
  }

  const resolved = resolveAutoLabelJobState({
    networkCrossed: outcome.networkCrossed === true,
    labelReady: outcome.labelReady === true,
    blocked: outcome.blocked === true,
    errorCode: outcome.errorCode ?? null,
  })
  // KANARYA ASLA KENDİ KENDİNE UYANAN SATIR BIRAKMAZ.
  const finalStatus =
    resolved.state === 'FAILED_SAFE_TO_RETRY' ? 'BLOCKED' : resolved.state
  await completeLabelJob(db, {
    id: job.id,
    status: finalStatus,
    errorCode: outcome.errorCode ?? null,
    errorSummary: outcome.errorSummary ?? null,
  })

  // ═══ SONUÇ — KALICI ARTEFAKTTAN OKUNUR, TAHMİNDEN DEĞİL ════════════
  const operationsAfter = await db
    .select({
      carrierCreateCalled: shipmentOperations.carrierCreateCalled,
      createCallCount: shipmentOperations.createCallCount,
      errorCode: shipmentOperations.errorCode,
      status: shipmentOperations.status,
    })
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, params.organizationId),
        eq(shipmentOperations.packageId, params.packageId),
      ),
    )
  const operationRows = operationsAfter as Record<string, unknown>[]
  const carrierCalled = operationRows.some(
    (operation) => operation.carrierCreateCalled === true,
  )
  const carrierCreateAttempts = operationRows.reduce(
    (total, operation) => total + Number(operation.createCallCount ?? 0),
    0,
  )

  const shipmentRows = await db
    .select({
      trackingNumber: shipments.trackingNumber,
      barcode: shipments.barcode,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, params.organizationId),
        eq(shipments.packageId, params.packageId),
      ),
    )
  const shipment = (shipmentRows as Record<string, unknown>[])[0] ?? null

  let zpl = ''
  let zplReadFailure: string | null = null
  try {
    const [repository, persistence] = await Promise.all([
      import('../orders/orderRepository.ts'),
      import('../orders/orderPersistenceService.ts'),
    ])
    const orderRow = await repository.findOrderByPackageId(
      db, params.organizationId, job.marketplace, params.packageId,
    )
    if (orderRow) {
      const label = await persistence.resolvePersistedLabel(
        db, params.organizationId, String((orderRow as { id: string }).id),
      )
      zpl = String(label?.zpl ?? '')
    }
  } catch (error) {
    // Etiket okunamadıysa RAPOR eksik kalır; iş durumu DEĞİŞMEZ.
    // SEBEP YUTULMAZ: rapora taşınır, yoksa "ZPL yok" ile "ZPL okunamadı"
    // ayırt edilemez ve teşhis yanlış yöne gider.
    zpl = ''
    zplReadFailure = error instanceof Error ? error.message : String(error)
  }

  const after = await snapshotJobs(db, params.organizationId)
  const afterById = new Map(after.map((snapshot) => [snapshot.id, snapshot]))
  const otherQueuedJobsTouched = before.filter((snapshot) => {
    if (snapshot.id === job.id) return false
    const now = afterById.get(snapshot.id)
    return (
      !now ||
      now.status !== snapshot.status ||
      now.attemptCount !== snapshot.attemptCount
    )
  }).length

  const targetAfter = afterById.get(job.id) ?? null
  const totalCarrierCalls: 0 | 1 = Number(outcome.carrierCalls ?? 0) > 0 ? 1 : 0

  return {
    packageId: params.packageId,
    jobId: job.id,
    statusBefore: target.status,
    statusAfter: targetAfter?.status ?? finalStatus,
    attemptCountBefore: target.attemptCount,
    attemptCountAfter: targetAfter?.attemptCount ?? job.attemptCount,
    tenantDesi: preflight.tenantDesi,
    resolvedDesi: preflight.resolvedDesi,
    suratBirimDesi: preflight.suratBirimDesi,
    billingParty: preflight.billingParty,
    expectedSuratWhoPays: preflight.expectedSuratWhoPays,
    credentialRole: preflight.credentialRole,
    // Talep edildi ve `runLabel` çağrıldı: taşıyıcı sınırına GİDİLDİ.
    carrierCallStarted: true,
    carrierCalled,
    carrierCreateAttempts,
    carrierCode: outcome.errorCode ?? null,
    businessResult: finalStatus,
    trackingPresent: Boolean(String(shipment?.trackingNumber ?? '').trim()),
    barcodePresent: Boolean(String(shipment?.barcode ?? '').trim()),
    zplPresent: zpl.length > 0,
    zplLength: zpl.length,
    zplReadFailure,
    otherQueuedJobsTouched,
    totalCarrierCalls,
    gatesPassed: true,
    blockers: [],
    preflightFailureDetail: preflight.failureDetail,
  }
}
