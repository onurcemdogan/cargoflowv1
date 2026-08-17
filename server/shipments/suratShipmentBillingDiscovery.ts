// GÖNDERİ-ÖNCELİKLİ FATURALAMA KANITI KEŞFİ — SALT OKUNUR, AĞSIZ.
//
// NEDEN SİPARİŞ DEĞİL GÖNDERİ: son 500 sipariş taraması
// `ORDER_SHIPMENT_JOIN_MISSING = 500` verdi. Yani en yeni siparişler henüz
// kargoya verilmemiş. Bu evren `whoPays` doğrulaması için UYGUN DEĞİL.
// Doğru evren, GERÇEKTEN taşıyıcı kaydı oluşmuş gönderilerdir.
//
// KANIT GÜCÜ SIRASI (tahmin YOK, şemadan türetildi):
//   1) `shipment_operations` — operationType=CREATE, status='succeeded',
//      carrier_create_called=true. Taşıyıcıya GERÇEKTEN gidildiğinin ve
//      başarıyla döndüğünün en güçlü kanıtı.
//   2) `shipments.tracking_number` — taşıyıcı numarası atanmış. Tek başına
//      "create başarılı" DEMEZ: ön-atanmış kodlar da bu alana yazılabilir.
//
// GARANTİLER: DB yazma 0 · ağ 0 · create 0 · print 0 · migration 0.
// PERFORMANS: sabit sayıda sorgu; sipariş/gönderi başına sorgu YOK.
// Şifreli yük YALNIZ sınırlı aday kümesi üzerinde çözülür.
import { and, desc, eq, inArray } from 'drizzle-orm'
import { orders, shipmentOperations, shipments } from '../db/schema.ts'
import { decryptShipmentPayload } from './shipmentEncryption.ts'
import { inspectTrendyolBillingSource } from './suratBillingParty.ts'
import { maskIdentifier, readOrderRawPayload } from './suratBillingScanner.ts'
import type { CarrierCreateStatus } from './suratBillingVerification.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

const text = (value: unknown): string => String(value ?? '').trim()

export const DEFAULT_SHIPMENT_SCAN_LIMIT = 500
export const MAX_SHIPMENT_SCAN_LIMIT = 1000
/** Şifreli yük çözülen EN FAZLA aday (tam tablo çözümü YASAK). */
export const MAX_CANDIDATE_PAYLOADS = 10

/** Sürat sağlayıcı adı — kayıtlarda farklı yazımlar görülebilir. */
export function isSuratProvider(value: unknown): boolean {
  return /surat|sürat/i.test(text(value))
}

export function resolveShipmentScanLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHIPMENT_SCAN_LIMIT
  return Math.min(Math.floor(parsed), MAX_SHIPMENT_SCAN_LIMIT)
}

/**
 * TEK GÖNDERİ İÇİN TAŞIYICI DURUMU — iki kanıt kaynağı birleştirilir.
 *
 * `succeeded` bir CREATE operasyonu varsa SUCCESS. Operasyon `failed` ise
 * FAILED. Operasyon kaydı hiç yoksa yalnız taşıyıcı numarasına bakılır ve
 * numara varsa sonuç UNKNOWN'dır — çünkü numaranın create'ten mi yoksa
 * ön-atamadan mı geldiği kayıttan ANLAŞILMAZ. Uydurma yapılmaz.
 */
export function classifyCarrierCreate(params: {
  operationStatus?: string | null
  carrierCreateCalled?: boolean | null
  trackingNumber?: unknown
}): CarrierCreateStatus {
  const status = text(params.operationStatus).toLowerCase()
  if (status === 'succeeded' && params.carrierCreateCalled === true) return 'SUCCESS'
  if (status === 'succeeded') return 'UNKNOWN'
  if (status === 'failed' || status === 'blocked') return 'FAILED'
  if (status === 'pending') return 'UNKNOWN'
  return text(params.trackingNumber) ? 'UNKNOWN' : 'NOT_STARTED'
}

export interface SuratShipmentCandidate {
  shipmentIdMasked: string
  packageIdMasked: string
  parcelIdentity: string | null
  carrierCreateStatus: CarrierCreateStatus
  orderJoin: 'RESOLVED' | 'MISSING' | 'AMBIGUOUS'
  expectedBillingParty: string
  expectedBillingPartySource: string
  actualAvailable: boolean
  actualSource: string | null
  accountFingerprint: string
  serviceMode: string
  createdAt: string | null
}

export interface SuratShipmentDiscoveryResult {
  organizationMasked: string
  shipmentsScanned: number
  suratShipments: number
  suratCreateSuccess: number
  suratCreateFailed: number
  suratCreateUnknown: number
  suratCreateNotStarted: number
  orderJoinResolved: number
  orderJoinMissing: number
  orderJoinAmbiguous: number
  expectedTrendyol: number
  expectedSeller: number
  expectedUnknown: number
  expectedSources: Record<string, number>
  actualAvailable: number
  actualUnavailable: number
  verifiedCount: number
  unverifiedCount: number
  mismatchCount: number
  distinctCredentialContexts: number
  serviceModeDistribution: Record<string, number>
  oldestSuccessAt: string | null
  newestSuccessAt: string | null
  goldenFound: boolean
  goldenCandidate: SuratShipmentCandidate | null
  candidates: SuratShipmentCandidate[]
  dbQueryCount: number
  payloadsDecrypted: number
}

/** Mail'den bilinen dış gerçek — Sürat getCargo whoPays=3 (TRENDYOL öder). */
export const GOLDEN_PARCEL = '7270035725579605'

/**
 * Kalıcı yükte GERÇEK Sürat `whoPays` alanı var mı.
 *
 * ALAN ADINDAN TAHMİN EDİLMEZ: yalnız bilinen tam anahtarlar aranır ve
 * hangisinde bulunduğu kaynak olarak raporlanır. Benzer isimli bir alanı
 * "herhalde budur" diye kabul etmek sessiz yanlış faturalama üretirdi.
 */
export const KNOWN_ACTUAL_WHO_PAYS_KEYS = ['whoPays', 'WhoPays', 'KimOder'] as const

export function findPersistedActualWhoPays(
  payload: unknown,
): { key: string; value: string } | null {
  if (payload === null || typeof payload !== 'object') return null
  for (const key of KNOWN_ACTUAL_WHO_PAYS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    const value = (payload as Record<string, unknown>)[key]
    if (value === null || value === undefined || text(value) === '') continue
    return { key, value: text(value) }
  }
  return null
}

/**
 * GÖNDERİ-ÖNCELİKLİ KEŞİF.
 *
 * Sorgu bütçesi SABİT: gönderiler (1) + create operasyonları (1) +
 * siparişler (1) = 3. Aday yükleri yalnız `MAX_CANDIDATE_PAYLOADS` kadar
 * çözülür.
 */
export async function discoverSuratShipmentBillingEvidence(
  db: Db,
  organization: { id: string; name: string },
  options: { limit?: number } = {},
): Promise<SuratShipmentDiscoveryResult> {
  const limit = resolveShipmentScanLimit(options.limit)
  let dbQueryCount = 0
  let payloadsDecrypted = 0

  // (1) Gönderiler — TEK sorgu, en yeniden eskiye, SQL LIMIT ile sınırlı.
  const shipmentRows = (await db
    .select()
    .from(shipments)
    .where(eq(shipments.organizationId, organization.id))
    .orderBy(desc(shipments.createdAt), desc(shipments.id))
    .limit(limit)) as Record<string, unknown>[]
  dbQueryCount += 1

  const suratRows = shipmentRows.filter((row) => isSuratProvider(row.provider))
  const packageIds = [
    ...new Set(suratRows.map((row) => text(row.packageId)).filter(Boolean)),
  ]

  // (2) CREATE operasyonları — TEK toplu sorgu (gönderi başına sorgu YOK).
  const operationRows = packageIds.length
    ? ((await db
        .select()
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, organization.id),
            eq(shipmentOperations.operationType, 'CREATE'),
            inArray(shipmentOperations.packageId, packageIds),
          ),
        )) as Record<string, unknown>[])
    : []
  if (packageIds.length) dbQueryCount += 1

  const operationByPackage = new Map<string, Record<string, unknown>>()
  for (const row of operationRows) {
    const key = text(row.packageId)
    const existing = operationByPackage.get(key)
    // En güçlü kanıt tercih edilir: succeeded > diğer.
    if (!existing || text(row.status) === 'succeeded') {
      operationByPackage.set(key, row)
    }
  }

  // (3) Siparişler — TEK toplu sorgu; ters join için.
  const orderRows = packageIds.length
    ? ((await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, organization.id),
            inArray(orders.packageId, packageIds),
          ),
        )) as Record<string, unknown>[])
    : []
  if (packageIds.length) dbQueryCount += 1

  const orderByPackage = new Map<string, Record<string, unknown>>()
  const orderCountByPackage = new Map<string, number>()
  for (const row of orderRows) {
    const key = text(row.packageId)
    orderCountByPackage.set(key, (orderCountByPackage.get(key) ?? 0) + 1)
    if (!orderByPackage.has(key)) orderByPackage.set(key, row)
  }

  const result: SuratShipmentDiscoveryResult = {
    organizationMasked: maskIdentifier(organization.id),
    shipmentsScanned: shipmentRows.length,
    suratShipments: suratRows.length,
    suratCreateSuccess: 0,
    suratCreateFailed: 0,
    suratCreateUnknown: 0,
    suratCreateNotStarted: 0,
    orderJoinResolved: 0,
    orderJoinMissing: 0,
    orderJoinAmbiguous: 0,
    expectedTrendyol: 0,
    expectedSeller: 0,
    expectedUnknown: 0,
    expectedSources: {},
    actualAvailable: 0,
    actualUnavailable: 0,
    verifiedCount: 0,
    unverifiedCount: 0,
    mismatchCount: 0,
    distinctCredentialContexts: 0,
    serviceModeDistribution: {},
    oldestSuccessAt: null,
    newestSuccessAt: null,
    goldenFound: false,
    goldenCandidate: null,
    candidates: [],
    dbQueryCount,
    payloadsDecrypted,
  }

  const successTimestamps: string[] = []
  const credentialContexts = new Set<string>()
  const scored: {
    row: Record<string, unknown>
    packageKey: string
    carrierCreateStatus: CarrierCreateStatus
  }[] = []

  for (const row of suratRows) {
    const packageKey = text(row.packageId)
    const operation = operationByPackage.get(packageKey)
    const carrierCreateStatus = classifyCarrierCreate({
      operationStatus: operation ? text(operation.status) : null,
      carrierCreateCalled: operation
        ? Boolean(operation.carrierCreateCalled)
        : null,
      trackingNumber: row.trackingNumber,
    })
    if (carrierCreateStatus === 'SUCCESS') {
      result.suratCreateSuccess += 1
      const stamp = row.createdAt ? new Date(String(row.createdAt)).toISOString() : ''
      if (stamp) successTimestamps.push(stamp)
    } else if (carrierCreateStatus === 'FAILED') result.suratCreateFailed += 1
    else if (carrierCreateStatus === 'UNKNOWN') result.suratCreateUnknown += 1
    else result.suratCreateNotStarted += 1

    const orderCount = orderCountByPackage.get(packageKey) ?? 0
    if (carrierCreateStatus === 'SUCCESS') {
      if (orderCount === 0) result.orderJoinMissing += 1
      else if (orderCount === 1) result.orderJoinResolved += 1
      else result.orderJoinAmbiguous += 1
    }
    scored.push({ row, packageKey, carrierCreateStatus })
  }

  if (successTimestamps.length > 0) {
    successTimestamps.sort()
    result.oldestSuccessAt = successTimestamps[0]
    result.newestSuccessAt = successTimestamps[successTimestamps.length - 1]
  }

  // BEKLENEN TARAF — mevcut Trendyol sözleşme mapper'ı; yeni kural YOK.
  for (const entry of scored) {
    if (entry.carrierCreateStatus !== 'SUCCESS') continue
    const orderRow = orderByPackage.get(entry.packageKey)
    if (!orderRow) {
      result.expectedUnknown += 1
      continue
    }
    const { rawOrder, rawPayloadAvailability } = readOrderRawPayload(orderRow)
    const inspection = inspectTrendyolBillingSource(
      { rawOrder },
      { rawPayloadAvailability },
    )
    if (inspection.billingParty === 'TRENDYOL') result.expectedTrendyol += 1
    else if (inspection.billingParty === 'SELLER') result.expectedSeller += 1
    else result.expectedUnknown += 1
    result.expectedSources[inspection.source] =
      (result.expectedSources[inspection.source] ?? 0) + 1
  }

  // ADAYLAR — SINIRLI yük çözümü YALNIZ burada.
  const candidatePool = scored
    .filter((entry) => entry.carrierCreateStatus === 'SUCCESS')
    .slice(0, MAX_CANDIDATE_PAYLOADS)
  for (const entry of candidatePool) {
    const { row, packageKey } = entry
    let parcelIdentity = ''
    let actual: { key: string; value: string } | null = null
    let serviceMode = 'UNKNOWN'
    let payload: Record<string, unknown> | null
    try {
      payload = decryptShipmentPayload(
        (row.carrierPayloadEncrypted as string | null) ?? null,
      ) as Record<string, unknown> | null
      payloadsDecrypted += 1
    } catch {
      payload = null
    }
    if (payload) {
      parcelIdentity = text(payload.ozelKargoTakipNo)
      actual = findPersistedActualWhoPays(payload)
      serviceMode = text(payload.serviceMode) || text(payload.serviceType) || 'UNKNOWN'
    }
    const orderRow = orderByPackage.get(packageKey)
    if (!parcelIdentity && orderRow) {
      parcelIdentity = text(orderRow.cargoTrackingNumber)
    }
    const orderCount = orderCountByPackage.get(packageKey) ?? 0

    let expectedParty = 'UNKNOWN'
    let expectedSource = 'UNKNOWN'
    if (orderRow) {
      const { rawOrder, rawPayloadAvailability } = readOrderRawPayload(orderRow)
      const inspection = inspectTrendyolBillingSource(
        { rawOrder },
        { rawPayloadAvailability },
      )
      expectedParty = inspection.billingParty
      expectedSource = inspection.source
    }

    const accountFingerprint = maskIdentifier(row.senderNumber ?? row.trackingNumber)
    credentialContexts.add(`${accountFingerprint}::${serviceMode}`)
    result.serviceModeDistribution[serviceMode] =
      (result.serviceModeDistribution[serviceMode] ?? 0) + 1
    if (actual) result.actualAvailable += 1
    else result.actualUnavailable += 1

    const candidate: SuratShipmentCandidate = {
      shipmentIdMasked: maskIdentifier(row.id),
      packageIdMasked: maskIdentifier(row.packageId),
      parcelIdentity: parcelIdentity || null,
      carrierCreateStatus: entry.carrierCreateStatus,
      orderJoin:
        orderCount === 0 ? 'MISSING' : orderCount === 1 ? 'RESOLVED' : 'AMBIGUOUS',
      expectedBillingParty: expectedParty,
      expectedBillingPartySource: expectedSource,
      actualAvailable: actual !== null,
      actualSource: actual ? `persistedCarrierPayload.${actual.key}` : null,
      accountFingerprint,
      serviceMode,
      createdAt: row.createdAt ? new Date(String(row.createdAt)).toISOString() : null,
    }
    result.candidates.push(candidate)
    if (parcelIdentity === GOLDEN_PARCEL) {
      result.goldenFound = true
      result.goldenCandidate = candidate
    }
  }

  // DOĞRULAMA HUNİSİ — gerçek taraf yoksa VERIFIED/MISMATCH UYDURULMAZ.
  result.unverifiedCount = result.candidates.filter(
    (candidate) =>
      candidate.expectedBillingParty !== 'UNKNOWN' && !candidate.actualAvailable,
  ).length
  result.distinctCredentialContexts = credentialContexts.size
  result.dbQueryCount = dbQueryCount
  result.payloadsDecrypted = payloadsDecrypted
  return result
}

/** Rapor satırları — PII YOK, kimlik bilgisi YOK. */
export function formatShipmentDiscoveryReport(
  result: SuratShipmentDiscoveryResult,
): string[] {
  const lines = [
    `ORGANIZATION                  ${result.organizationMasked}`,
    `DB_QUERY_COUNT                ${result.dbQueryCount}`,
    `PAYLOADS_DECRYPTED            ${result.payloadsDecrypted}`,
    '',
    'CARRIER_CREATE_SUCCESS_SOURCE  shipment_operations(CREATE, succeeded,',
    '                               carrier_create_called=true)',
    '  (tracking_number TEK BASINA yeterli SAYILMAZ — on-atanmis kod olabilir)',
    '',
    `SHIPMENTS_SCANNED             ${result.shipmentsScanned}`,
    `SURAT_SHIPMENTS               ${result.suratShipments}`,
    `SURAT_CREATE_SUCCESS          ${result.suratCreateSuccess}`,
    `SURAT_CREATE_FAILED           ${result.suratCreateFailed}`,
    `SURAT_CREATE_UNKNOWN          ${result.suratCreateUnknown}`,
    `SURAT_CREATE_NOT_STARTED      ${result.suratCreateNotStarted}`,
    '',
    `SURAT_SUCCESS_ORDER_JOIN_RESOLVED   ${result.orderJoinResolved}`,
    `SURAT_SUCCESS_ORDER_JOIN_MISSING    ${result.orderJoinMissing}`,
    `SURAT_SUCCESS_ORDER_JOIN_AMBIGUOUS  ${result.orderJoinAmbiguous}`,
    '',
    `SURAT_SUCCESS_EXPECTED_TRENDYOL     ${result.expectedTrendyol}`,
    `SURAT_SUCCESS_EXPECTED_SELLER       ${result.expectedSeller}`,
    `SURAT_SUCCESS_EXPECTED_UNKNOWN      ${result.expectedUnknown}`,
  ]
  for (const [source, count] of Object.entries(result.expectedSources)) {
    lines.push(`  EXPECTED_SOURCE_${source.padEnd(32)}${count}`)
  }
  lines.push(
    '',
    `ACTUAL_AVAILABLE              ${result.actualAvailable}`,
    `ACTUAL_UNAVAILABLE            ${result.actualUnavailable}`,
    `VERIFIED                      ${result.verifiedCount}`,
    `UNVERIFIED                    ${result.unverifiedCount}`,
    `MISMATCH                      ${result.mismatchCount}`,
    '  (gercek taraf okunmadan VERIFIED/MISMATCH URETILMEZ)',
    '',
    `DISTINCT_SURAT_CREDENTIAL_CONTEXTS  ${result.distinctCredentialContexts}`,
  )
  for (const [mode, count] of Object.entries(result.serviceModeDistribution)) {
    lines.push(`  SERVICE_MODE_${mode.padEnd(28)}${count}`)
  }
  lines.push(
    '',
    `OLDEST_SURAT_SUCCESS_AT       ${result.oldestSuccessAt ?? '—'}`,
    `NEWEST_SURAT_SUCCESS_AT       ${result.newestSuccessAt ?? '—'}`,
    '',
    `GOLDEN_${GOLDEN_PARCEL}_FOUND  ${result.goldenFound ? 'YES' : 'NO'}`,
  )
  lines.push('', 'CANDIDATES (en fazla 10 · maskeli)')
  if (result.candidates.length === 0) lines.push('  —')
  result.candidates.forEach((candidate, index) => {
    lines.push(
      `  CANDIDATE_${index + 1}  parcel=${candidate.parcelIdentity ?? '—'}` +
        `  shipment=${candidate.shipmentIdMasked}` +
        `  package=${candidate.packageIdMasked}` +
        `  create=${candidate.carrierCreateStatus}` +
        `  orderJoin=${candidate.orderJoin}` +
        `  expected=${candidate.expectedBillingParty}` +
        `  source=${candidate.expectedBillingPartySource}` +
        `  actual=${candidate.actualAvailable ? candidate.actualSource : 'UNAVAILABLE'}` +
        `  account=${candidate.accountFingerprint}` +
        `  mode=${candidate.serviceMode}` +
        `  at=${candidate.createdAt ?? '—'}`,
    )
  })
  return lines
}
