// SURAT_CREATE_UNKNOWN KÖK NEDEN FORENSİĞİ — SALT OKUNUR, AĞSIZ.
//
// ÜRETİM BULGUSU: 300 kalıcı Sürat gönderisinin HEPSİ `UNKNOWN` sınıflandı.
// Bu "300 gönderi oluşturulmadı" DEMEK DEĞİLDİR — güçlü kanıt kaynağı
// (`shipment_operations`) bu kayıtları sınıflandıramıyor demektir. Bu modül
// NEDENİNİ sayarak kanıtlar.
//
// GARANTİLER: DB yazma 0 · ağ 0 · create 0 · print 0 · migration 0.
// Şifreli yük YALNIZ ≤10 temsilci örnek için çözülür.
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { orders, shipmentOperations, shipments } from '../db/schema.ts'
import { decryptShipmentPayload } from './shipmentEncryption.ts'
import { inspectTrendyolBillingSource } from './suratBillingParty.ts'
import { maskIdentifier, readOrderRawPayload } from './suratBillingScanner.ts'
import {
  classifyCreateEvidence,
  classifyUnknownReason,
  findPersistedActualWhoPays,
  GOLDEN_PARCEL,
  classifyPersistedCarrierResponse,
  isCreateOperationType,
  isSuratProvider,
  CARGOFLOW_ORIGIN_PAYER_KEYS,
  resolveShipmentScanLimit,

  OPERATION_TRACKING_INTRODUCED,
  type CreateEvidenceClass,
  type PersistedResponseOutcome,
  type UnknownReason,
} from './suratShipmentBillingDiscovery.ts'

/** Faz 4C: kanit sinifi homojenlestigi icin ornek genisletildi. */
export const MAX_FORENSIC_PAYLOADS = 20

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

const text = (value: unknown): string => String(value ?? '').trim()
const iso = (value: unknown): string =>
  value ? new Date(String(value)).toISOString() : ''

/** Gönderi satırında create kanıtı taşıyabilecek DÜZ (şifresiz) alanlar. */
export const SHIPMENT_EVIDENCE_FIELDS = [
  'trackingNumber',
  'senderNumber',
  'barcode',
  'trackingLink',
  'carrierPayloadEncrypted',
] as const

export interface CreateEvidenceForensics {
  organizationMasked: string
  totalSuratShipmentsInScope: number
  queryLimitRequested: number
  queryLimitEffective: number
  shipmentsScanned: number

  unknownReasonBreakdown: Record<string, number>
  auxiliaryFlags: Record<string, number>

  shipmentsWithAnyOperation: number
  shipmentsWithoutAnyOperation: number
  shipmentsWithCreateOperation: number
  shipmentsWithoutCreateOperation: number
  createSucceeded: number
  createFailed: number
  createOtherStatus: number
  carrierCreateCalledTrue: number
  carrierCreateCalledFalse: number
  carrierCreateCalledMissing: number

  oldestShipmentAt: string | null
  newestShipmentAt: string | null
  shipmentsBeforeOperationTracking: number
  shipmentsAfterOperationTracking: number

  fieldPresence: Record<string, number>
  sourceDistribution: Record<string, number>
  serviceModeDistribution: Record<string, number>

  orderJoinResolved: number
  orderJoinMissing: number
  orderJoinAmbiguous: number
  expectedTrendyol: number
  expectedSeller: number
  expectedUnknown: number

  createEvidence: Record<CreateEvidenceClass, number>
  persistedResponseSuccess: number
  persistedResponseFailure: number
  persistedResponseUnknown: number
  responseSuccessOperationPending: number
  responseFailureOperationPending: number
  responseUnknownOperationPending: number
  realCreateSuccessProven: number
  operationPayloadsDecrypted: number

  operationTypeDistribution: Record<string, { count: number; statuses: Record<string, number>; called: Record<string, number> }>
  payloadsDecrypted: number
  payloadsWithActualPayer: number
  actualPayerFieldNames: string[]
  cargoflowOriginPayerKeysSeen: string[]
  senderCodeAvailableCount: number
  distinctSenderCodes: number
  payloadFieldInventory: string[]
  actualWhoPaysFieldFound: boolean
  actualWhoPaysProvenance: string | null

  goldenSearchOrder: boolean
  goldenSearchShipment: boolean
  goldenSearchPayload: boolean

  candidates: {
    shipmentIdMasked: string
    packageIdMasked: string
    trackingIdentityMasked: string
    createdAt: string | null
    source: string
    serviceMode: string
    operationEvidence: string
    createEvidence: CreateEvidenceClass
    unknownReason: UnknownReason | null
    orderJoin: string
    expectedBillingParty: string
    actualWhoPaysAvailable: boolean
  }[]

  dbQueryCount: number
}

export async function analyzeSuratCreateEvidence(
  db: Db,
  organization: { id: string; name: string },
  options: { limit?: number } = {},
): Promise<CreateEvidenceForensics> {
  const requested = Number(options.limit) || 0
  const limit = resolveShipmentScanLimit(options.limit)
  let dbQueryCount = 0

  // (1) KAPSAMDAKİ GERÇEK TOPLAM — `300` sayısı sınır mı yoksa gerçek mi?
  const totalRows = (await db
    .select({ value: count() })
    .from(shipments)
    .where(eq(shipments.organizationId, organization.id))) as { value: number }[]
  dbQueryCount += 1
  const totalInScope = Number(totalRows[0]?.value ?? 0)

  // (2) Gönderiler — TEK sorgu, SQL LIMIT ile sınırlı.
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

  // (3) TÜM operasyonlar (yalnız CREATE değil) — kapsama ölçümü için.
  const operationRows = packageIds.length
    ? ((await db
        .select()
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, organization.id),
            inArray(shipmentOperations.packageId, packageIds),
          ),
        )) as Record<string, unknown>[])
    : []
  if (packageIds.length) dbQueryCount += 1

  const anyOperationByPackage = new Map<string, Record<string, unknown>[]>()
  const operationTypeDistribution: CreateEvidenceForensics['operationTypeDistribution'] =
    {}
  for (const row of operationRows) {
    const key = text(row.packageId)
    const list = anyOperationByPackage.get(key) ?? []
    list.push(row)
    anyOperationByPackage.set(key, list)

    // GERÇEK operasyon tipi dağılımı: "300 kayıtta operasyon var ama CREATE
    // yok" çelişkisini ancak bu tablo açıklar.
    const type = text(row.operationType) || 'UNKNOWN'
    const entry = operationTypeDistribution[type] ?? {
      count: 0,
      statuses: {},
      called: {},
    }
    entry.count += 1
    const status = text(row.status) || 'UNKNOWN'
    entry.statuses[status] = (entry.statuses[status] ?? 0) + 1
    const called =
      row.carrierCreateCalled === true
        ? 'true'
        : row.carrierCreateCalled === false
          ? 'false'
          : 'missing'
    entry.called[called] = (entry.called[called] ?? 0) + 1
    operationTypeDistribution[type] = entry
  }

  // (4) Siparişler — ters join.
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

  const result: CreateEvidenceForensics = {
    organizationMasked: maskIdentifier(organization.id),
    totalSuratShipmentsInScope: totalInScope,
    queryLimitRequested: requested,
    queryLimitEffective: limit,
    shipmentsScanned: shipmentRows.length,
    unknownReasonBreakdown: {},
    auxiliaryFlags: {},
    shipmentsWithAnyOperation: 0,
    shipmentsWithoutAnyOperation: 0,
    shipmentsWithCreateOperation: 0,
    shipmentsWithoutCreateOperation: 0,
    createSucceeded: 0,
    createFailed: 0,
    createOtherStatus: 0,
    carrierCreateCalledTrue: 0,
    carrierCreateCalledFalse: 0,
    carrierCreateCalledMissing: 0,
    oldestShipmentAt: null,
    newestShipmentAt: null,
    shipmentsBeforeOperationTracking: 0,
    shipmentsAfterOperationTracking: 0,
    fieldPresence: {},
    sourceDistribution: {},
    serviceModeDistribution: {},
    orderJoinResolved: 0,
    orderJoinMissing: 0,
    orderJoinAmbiguous: 0,
    expectedTrendyol: 0,
    expectedSeller: 0,
    expectedUnknown: 0,
    createEvidence: {
      CREATE_PROVEN_STRONG: 0,
      CREATE_PROVEN_CARRIER_RESPONSE: 0,
      CREATE_PROVEN_PERSISTED_LOCAL: 0,
      CREATE_POSSIBLE: 0,
      CREATE_UNKNOWN: 0,
    },
    operationTypeDistribution,
    persistedResponseSuccess: 0,
    persistedResponseFailure: 0,
    persistedResponseUnknown: 0,
    responseSuccessOperationPending: 0,
    responseFailureOperationPending: 0,
    responseUnknownOperationPending: 0,
    realCreateSuccessProven: 0,
    operationPayloadsDecrypted: 0,
    payloadsDecrypted: 0,
    payloadsWithActualPayer: 0,
    actualPayerFieldNames: [],
    cargoflowOriginPayerKeysSeen: [],
    senderCodeAvailableCount: 0,
    distinctSenderCodes: 0,
    payloadFieldInventory: [],
    actualWhoPaysFieldFound: false,
    actualWhoPaysProvenance: null,
    goldenSearchOrder: false,
    goldenSearchShipment: false,
    goldenSearchPayload: false,
    candidates: [],
    dbQueryCount,
  }

  let operationPayloadsDecrypted = 0
  const stamps: string[] = []
  const analysed: {
    row: Record<string, unknown>
    createOperation: Record<string, unknown> | undefined
    unknownReason: UnknownReason | null
    evidence: CreateEvidenceClass
  }[] = []

  for (const row of suratRows) {
    const key = text(row.packageId)
    const operations = anyOperationByPackage.get(key) ?? []
    const createOperations = operations.filter(
      (operation) => isCreateOperationType(operation.operationType),
    )
    // En güçlü kanıt tercih edilir.
    const createOperation =
      createOperations.find((operation) => text(operation.status) === 'succeeded') ??
      createOperations[0]

    if (operations.length > 0) result.shipmentsWithAnyOperation += 1
    else result.shipmentsWithoutAnyOperation += 1
    if (createOperations.length > 0) result.shipmentsWithCreateOperation += 1
    else result.shipmentsWithoutCreateOperation += 1

    if (createOperation) {
      const status = text(createOperation.status).toLowerCase()
      if (status === 'succeeded') result.createSucceeded += 1
      else if (status === 'failed' || status === 'blocked') result.createFailed += 1
      else result.createOtherStatus += 1
      const called = createOperation.carrierCreateCalled
      if (called === true) result.carrierCreateCalledTrue += 1
      else if (called === false) result.carrierCreateCalledFalse += 1
      else result.carrierCreateCalledMissing += 1
    }

    const createdAt = iso(row.createdAt)
    if (createdAt) {
      stamps.push(createdAt)
      if (createdAt < OPERATION_TRACKING_INTRODUCED.date) {
        result.shipmentsBeforeOperationTracking += 1
      } else result.shipmentsAfterOperationTracking += 1
    }

    for (const field of SHIPMENT_EVIDENCE_FIELDS) {
      if (text(row[field])) {
        result.fieldPresence[field] = (result.fieldPresence[field] ?? 0) + 1
      }
    }
    const source = text(row.source) || 'UNKNOWN'
    result.sourceDistribution[source] = (result.sourceDistribution[source] ?? 0) + 1

    // KALICI TAŞIYICI YANITI. Operasyon yükü ŞİFRELİDİR; çözüm taranan
    // küme ile SINIRLIDIR (`--limit`), tam tablo çözümü YOKTUR. Bu adım
    // "audit durumu pending" ile "taşıyıcı gerçekten oluşturdu"yu ayırır.
    let persistedResponse: PersistedResponseOutcome = 'UNKNOWN'
    if (createOperation?.responsePayloadEncrypted) {
      try {
        persistedResponse = classifyPersistedCarrierResponse(
          decryptShipmentPayload(
            createOperation.responsePayloadEncrypted as string | null,
          ),
        )
        operationPayloadsDecrypted += 1
      } catch {
        persistedResponse = 'UNKNOWN'
      }
    }
    if (persistedResponse === 'SUCCESS') result.persistedResponseSuccess += 1
    else if (persistedResponse === 'FAILURE') result.persistedResponseFailure += 1
    else result.persistedResponseUnknown += 1

    // DEĞİŞMEZ İHLALİ SAYAÇLARI: taşıyıcı yanıtı ile audit durumu ayrışmışsa
    // bu ayrı bir veri kalitesi sorunudur ve GÖRÜNÜR kalmalıdır.
    const operationPending =
      createOperation !== undefined &&
      text(createOperation.status).toLowerCase() === 'pending'
    if (operationPending) {
      if (persistedResponse === 'SUCCESS') result.responseSuccessOperationPending += 1
      else if (persistedResponse === 'FAILURE') {
        result.responseFailureOperationPending += 1
      } else result.responseUnknownOperationPending += 1
    }

    const evidence = classifyCreateEvidence({
      operationStatus: createOperation ? text(createOperation.status) : null,
      carrierCreateCalled: createOperation
        ? (createOperation.carrierCreateCalled as boolean | null)
        : null,
      source: row.source,
      trackingNumber: row.trackingNumber,
      persistedResponse,
    })
    result.createEvidence[evidence] += 1
    if (
      evidence === 'CREATE_PROVEN_STRONG' ||
      evidence === 'CREATE_PROVEN_CARRIER_RESPONSE'
    ) {
      result.realCreateSuccessProven += 1
    }

    let unknownReason: UnknownReason | null = null
    if (evidence !== 'CREATE_PROVEN_STRONG') {
      unknownReason = classifyUnknownReason({
        hasAnyOperation: operations.length > 0,
        hasCreateOperation: createOperations.length > 0,
        createStatus: createOperation ? text(createOperation.status) : null,
        carrierCreateCalled: createOperation
          ? (createOperation.carrierCreateCalled as boolean | null)
          : null,
        source: row.source,
        createdAt,
      })
      result.unknownReasonBreakdown[unknownReason] =
        (result.unknownReasonBreakdown[unknownReason] ?? 0) + 1
      // YARDIMCI BAYRAKLAR: birincil sebep tek olsa da diğer olgular kaybolmaz.
      if (operations.length === 0) {
        result.auxiliaryFlags.NO_OPERATION_ROWS =
          (result.auxiliaryFlags.NO_OPERATION_ROWS ?? 0) + 1
      }
      if (createdAt && createdAt < OPERATION_TRACKING_INTRODUCED.date) {
        result.auxiliaryFlags.BEFORE_OPERATION_TRACKING =
          (result.auxiliaryFlags.BEFORE_OPERATION_TRACKING ?? 0) + 1
      }
      if (text(row.trackingNumber)) {
        result.auxiliaryFlags.HAS_TRACKING_NUMBER =
          (result.auxiliaryFlags.HAS_TRACKING_NUMBER ?? 0) + 1
      }
      if (source === 'local_create') {
        result.auxiliaryFlags.SOURCE_LOCAL_CREATE =
          (result.auxiliaryFlags.SOURCE_LOCAL_CREATE ?? 0) + 1
      }
    }

    const orderCount = orderCountByPackage.get(key) ?? 0
    if (orderCount === 0) result.orderJoinMissing += 1
    else if (orderCount === 1) result.orderJoinResolved += 1
    else result.orderJoinAmbiguous += 1

    const orderRow = orderByPackage.get(key)
    if (orderRow) {
      const { rawOrder, rawPayloadAvailability } = readOrderRawPayload(orderRow)
      const inspection = inspectTrendyolBillingSource(
        { rawOrder },
        { rawPayloadAvailability },
      )
      if (inspection.billingParty === 'TRENDYOL') result.expectedTrendyol += 1
      else if (inspection.billingParty === 'SELLER') result.expectedSeller += 1
      else result.expectedUnknown += 1
    } else result.expectedUnknown += 1

    analysed.push({ row, createOperation, unknownReason, evidence })
  }

  if (stamps.length > 0) {
    stamps.sort()
    result.oldestShipmentAt = stamps[0]
    result.newestShipmentAt = stamps[stamps.length - 1]
  }

  // TEMSİLCİ ÖRNEK: en eski 3 + en yeni 3 + kanıt sınıfı başına 2 (≤10).
  const byAge = [...analysed].sort((a, b) =>
    iso(a.row.createdAt).localeCompare(iso(b.row.createdAt)),
  )
  const sample: typeof analysed = []
  const push = (entry: (typeof analysed)[number]) => {
    if (sample.length >= MAX_FORENSIC_PAYLOADS) return
    if (sample.some((existing) => existing.row.id === entry.row.id)) return
    sample.push(entry)
  }
  byAge.slice(0, 3).forEach(push)
  byAge.slice(-3).forEach(push)
  for (const evidenceClass of Object.keys(result.createEvidence)) {
    analysed
      .filter((entry) => entry.evidence === evidenceClass)
      .slice(0, 2)
      .forEach(push)
  }

  const inventory = new Set<string>()
  const senderCodes = new Set<string>()
  for (const entry of sample) {
    let payload: Record<string, unknown> | null
    try {
      payload = decryptShipmentPayload(
        (entry.row.carrierPayloadEncrypted as string | null) ?? null,
      ) as Record<string, unknown> | null
      if (entry.row.carrierPayloadEncrypted) result.payloadsDecrypted += 1
    } catch {
      payload = null
    }
    let serviceMode = 'UNKNOWN'
    let actual: { key: string; value: string } | null = null
    if (payload) {
      // YALNIZ ALAN ADLARI toplanır — değerler basılmaz.
      for (const key of Object.keys(payload)) inventory.add(key)
      serviceMode = text(payload.serviceMode) || text(payload.serviceType) || 'UNKNOWN'
      actual = findPersistedActualWhoPays(payload)
      if (text(payload.ozelKargoTakipNo) === GOLDEN_PARCEL) {
        result.goldenSearchPayload = true
      }
    }
    result.serviceModeDistribution[serviceMode] =
      (result.serviceModeDistribution[serviceMode] ?? 0) + 1
    if (actual) {
      result.payloadsWithActualPayer += 1
      if (!result.actualPayerFieldNames.includes(actual.key)) {
        result.actualPayerFieldNames.push(actual.key)
      }
      if (!result.actualWhoPaysFieldFound) {
        result.actualWhoPaysFieldFound = true
        result.actualWhoPaysProvenance = `persistedCarrierPayload.${actual.key}`
      }
    }
    if (payload) {
      // CargoFlow KÖKENLİ alanlar ayrı raporlanır: `billingParty` bizim
      // kredensiyal sınıfımızdır, taşıyıcının payer cevabı DEĞİLDİR.
      for (const key of CARGOFLOW_ORIGIN_PAYER_KEYS) {
        if (
          Object.prototype.hasOwnProperty.call(payload, key) &&
          !result.cargoflowOriginPayerKeysSeen.includes(key)
        ) {
          result.cargoflowOriginPayerKeysSeen.push(key)
        }
      }
      // `senderCode` kaynağı — FirmaId ile KARIŞTIRILMAZ, ayrı alandır.
      const senderCode = text(payload.senderCode)
      if (senderCode) {
        result.senderCodeAvailableCount += 1
        senderCodes.add(senderCode)
      }
    }

    const key = text(entry.row.packageId)
    const orderCount = orderCountByPackage.get(key) ?? 0
    result.candidates.push({
      shipmentIdMasked: maskIdentifier(entry.row.id),
      packageIdMasked: maskIdentifier(entry.row.packageId),
      trackingIdentityMasked: maskIdentifier(entry.row.trackingNumber),
      createdAt: iso(entry.row.createdAt) || null,
      source: text(entry.row.source) || 'UNKNOWN',
      serviceMode,
      operationEvidence: entry.createOperation
        ? `${text(entry.createOperation.status)}/called=${String(
            entry.createOperation.carrierCreateCalled,
          )}`
        : 'NONE',
      createEvidence: entry.evidence,
      unknownReason: entry.unknownReason,
      orderJoin:
        orderCount === 0 ? 'MISSING' : orderCount === 1 ? 'RESOLVED' : 'AMBIGUOUS',
      expectedBillingParty: (() => {
        const orderRow = orderByPackage.get(key)
        if (!orderRow) return 'UNKNOWN'
        const { rawOrder, rawPayloadAvailability } = readOrderRawPayload(orderRow)
        return inspectTrendyolBillingSource(
          { rawOrder },
          { rawPayloadAvailability },
        ).billingParty
      })(),
      actualWhoPaysAvailable: actual !== null,
    })
  }
  result.payloadFieldInventory = [...inventory].sort()
  result.distinctSenderCodes = senderCodes.size
  result.operationPayloadsDecrypted = operationPayloadsDecrypted

  // GOLDEN ARAMASI — TAM EŞLEŞME, tenant kapsamlı, fuzzy YOK.
  const goldenOrders = (await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organization.id),
        eq(orders.cargoTrackingNumber, GOLDEN_PARCEL),
      ),
    )
    .limit(1)) as { id: string }[]
  dbQueryCount += 1
  result.goldenSearchOrder = goldenOrders.length > 0

  const goldenShipments = (await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organization.id),
        eq(shipments.trackingNumber, GOLDEN_PARCEL),
      ),
    )
    .limit(1)) as { id: string }[]
  dbQueryCount += 1
  result.goldenSearchShipment = goldenShipments.length > 0

  result.dbQueryCount = dbQueryCount
  return result
}

/** Rapor satırları — PII YOK, sır YOK, kimlikler maskeli. */
export function formatCreateEvidenceReport(
  result: CreateEvidenceForensics,
): string[] {
  const lines = [
    `ORGANIZATION                      ${result.organizationMasked}`,
    `TOTAL_SURAT_SHIPMENTS_IN_SCOPE    ${result.totalSuratShipmentsInScope}`,
    `QUERY_LIMIT_REQUESTED             ${result.queryLimitRequested || '—'}`,
    `QUERY_LIMIT_EFFECTIVE             ${result.queryLimitEffective}`,
    `SHIPMENTS_SCANNED                 ${result.shipmentsScanned}`,
    `DB_QUERY_COUNT                    ${result.dbQueryCount}`,
    '',
    'UNKNOWN_REASON_BREAKDOWN (precedence sirasiyla BIRINCIL sebep)',
  ]
  const reasons = Object.entries(result.unknownReasonBreakdown)
  if (reasons.length === 0) lines.push('  —')
  for (const [reason, value] of reasons) {
    lines.push(`  ${reason.padEnd(42)}${value}`)
  }
  lines.push('', 'OPERATION_TYPE_DISTRIBUTION (GERCEK operation_type degerleri)')
  const types = Object.entries(result.operationTypeDistribution)
  if (types.length === 0) lines.push('  —')
  for (const [type, entry] of types) {
    const statuses = Object.entries(entry.statuses)
      .map(([status, value]) => `${status}=${value}`)
      .join(' ')
    const called = Object.entries(entry.called)
      .map(([flag, value]) => `called:${flag}=${value}`)
      .join(' ')
    lines.push(
      `  ${type.padEnd(46)}${entry.count}  ${statuses}  ${called}` +
        `  ${isCreateOperationType(type) ? '[CREATE]' : '[NON-CREATE]'}`,
    )
  }

  lines.push('', 'AUXILIARY_FLAGS (birincil sebep disindaki olgular)')
  const flags = Object.entries(result.auxiliaryFlags)
  if (flags.length === 0) lines.push('  —')
  for (const [flag, value] of flags) lines.push(`  ${flag.padEnd(42)}${value}`)

  lines.push(
    '',
    'OPERATION COVERAGE',
    `  SHIPMENTS_WITH_ANY_OPERATION      ${result.shipmentsWithAnyOperation}`,
    `  SHIPMENTS_WITHOUT_ANY_OPERATION   ${result.shipmentsWithoutAnyOperation}`,
    `  SHIPMENTS_WITH_CREATE_OPERATION   ${result.shipmentsWithCreateOperation}`,
    `  SHIPMENTS_WITHOUT_CREATE_OPERATION ${result.shipmentsWithoutCreateOperation}`,
    `  CREATE_SUCCEEDED                  ${result.createSucceeded}`,
    `  CREATE_FAILED                     ${result.createFailed}`,
    `  CREATE_OTHER_STATUS               ${result.createOtherStatus}`,
    `  CARRIER_CREATE_CALLED_TRUE        ${result.carrierCreateCalledTrue}`,
    `  CARRIER_CREATE_CALLED_FALSE       ${result.carrierCreateCalledFalse}`,
    `  CARRIER_CREATE_CALLED_MISSING     ${result.carrierCreateCalledMissing}`,
    '',
    'TIME AXIS',
    `  OLDEST_SHIPMENT_AT                ${result.oldestShipmentAt ?? '—'}`,
    `  NEWEST_SHIPMENT_AT                ${result.newestShipmentAt ?? '—'}`,
    `  OPERATION_TRACKING_INTRODUCED_AT_COMMIT  ${OPERATION_TRACKING_INTRODUCED.commit}` +
      ` (${OPERATION_TRACKING_INTRODUCED.date})`,
    `  OPERATION_TRACKING_SCHEMA_INTRODUCED_AT  ${OPERATION_TRACKING_INTRODUCED.migration}`,
    `  SHIPMENTS_BEFORE_OPERATION_TRACKING      ${result.shipmentsBeforeOperationTracking}`,
    `  SHIPMENTS_AFTER_OPERATION_TRACKING       ${result.shipmentsAfterOperationTracking}`,
    '',
    'FIELD_PRESENCE (duz kolonlar · deger BASILMAZ)',
  )
  for (const [field, value] of Object.entries(result.fieldPresence)) {
    lines.push(`  ${field.padEnd(42)}${value}`)
  }
  lines.push('', 'SOURCE_DISTRIBUTION (shipments.source — semada kisitli)')
  for (const [source, value] of Object.entries(result.sourceDistribution)) {
    lines.push(`  ${source.padEnd(42)}${value}`)
  }
  lines.push(
    '',
    'SERVICE_MODE_DISTRIBUTION (YALNIZ cozulen ornekler · tam evren DEGIL)',
  )
  for (const [mode, value] of Object.entries(result.serviceModeDistribution)) {
    lines.push(`  ${mode.padEnd(42)}${value}`)
  }
  lines.push(
    '',
    'ORDER REVERSE JOIN (tum taranan gonderiler)',
    `  UNKNOWN_ORDER_JOIN_RESOLVED       ${result.orderJoinResolved}`,
    `  UNKNOWN_ORDER_JOIN_MISSING        ${result.orderJoinMissing}`,
    `  UNKNOWN_ORDER_JOIN_AMBIGUOUS      ${result.orderJoinAmbiguous}`,
    '',
    `  UNKNOWN_EXPECTED_TRENDYOL         ${result.expectedTrendyol}`,
    `  UNKNOWN_EXPECTED_SELLER           ${result.expectedSeller}`,
    `  UNKNOWN_EXPECTED_UNKNOWN          ${result.expectedUnknown}`,
    '',
    'PERSISTED CARRIER RESPONSE (operasyon yukunden · SINIRLI cozum)',
    `  PERSISTED_RESPONSE_SUCCESS          ${result.persistedResponseSuccess}`,
    `  PERSISTED_RESPONSE_FAILURE          ${result.persistedResponseFailure}`,
    `  PERSISTED_RESPONSE_UNKNOWN          ${result.persistedResponseUnknown}`,
    `  OPERATION_PAYLOADS_DECRYPTED        ${result.operationPayloadsDecrypted}`,
    '',
    'AUDIT-STATE INVARIANT (tasiyici gercegi != audit durumu)',
    `  CREATE_RESPONSE_SUCCESS_OPERATION_PENDING  ${result.responseSuccessOperationPending}`,
    `  CREATE_RESPONSE_FAILURE_OPERATION_PENDING  ${result.responseFailureOperationPending}`,
    `  CREATE_RESPONSE_UNKNOWN_OPERATION_PENDING  ${result.responseUnknownOperationPending}`,
    '',
    'CREATE EVIDENCE CLASSES',
    `  CREATE_PROVEN_STRONG              ${result.createEvidence.CREATE_PROVEN_STRONG}`,
    `  CREATE_PROVEN_CARRIER_RESPONSE    ${result.createEvidence.CREATE_PROVEN_CARRIER_RESPONSE}`,
    `  REAL_CREATE_SUCCESS_PROVEN        ${result.realCreateSuccessProven}`,
    `  CREATE_PROVEN_PERSISTED_LOCAL              ${result.createEvidence.CREATE_PROVEN_PERSISTED_LOCAL}`,
    `  CREATE_POSSIBLE                   ${result.createEvidence.CREATE_POSSIBLE}`,
    `  CREATE_UNKNOWN                    ${result.createEvidence.CREATE_UNKNOWN}`,
    '',
    `PAYLOADS_DECRYPTED                  ${result.payloadsDecrypted}`,
    `PAYLOAD_FIELD_INVENTORY             ${
      result.payloadFieldInventory.join(', ') || '—'
    }`,
    `ACTUAL_WHO_PAYS_FIELD_FOUND         ${
      result.actualWhoPaysFieldFound ? 'YES' : 'NO'
    }`,
    `ACTUAL_WHO_PAYS_PROVENANCE          ${result.actualWhoPaysProvenance ?? '—'}`,
    `PAYLOADS_WITH_ACTUAL_PAYER          ${result.payloadsWithActualPayer}`,
    `ACTUAL_PAYER_FIELD_NAMES            ${
      result.actualPayerFieldNames.join(', ') || '—'
    }`,
    `CARGOFLOW_ORIGIN_PAYER_KEYS_SEEN    ${
      result.cargoflowOriginPayerKeysSeen.join(', ') || '—'
    }`,
    '  (billingParty CargoFlow kredensiyal SINIFIDIR — tasiyici cevabi DEGIL)',
    `SENDER_CODE_AVAILABLE_COUNT         ${result.senderCodeAvailableCount}`,
    `DISTINCT_SENDER_CODES               ${result.distinctSenderCodes}`,
    '',
    `GOLDEN_SEARCH_ORDER                 ${result.goldenSearchOrder ? 'FOUND' : 'NO'}`,
    `GOLDEN_SEARCH_SHIPMENT              ${result.goldenSearchShipment ? 'FOUND' : 'NO'}`,
    `GOLDEN_SEARCH_PAYLOAD               ${result.goldenSearchPayload ? 'FOUND' : 'NO'}`,
    '',
    'CANDIDATES (maskeli · en fazla 10)',
  )
  if (result.candidates.length === 0) lines.push('  —')
  result.candidates.forEach((candidate, index) => {
    lines.push(
      `  CANDIDATE_${index + 1}  shipment=${candidate.shipmentIdMasked}` +
        `  package=${candidate.packageIdMasked}` +
        `  tracking=${candidate.trackingIdentityMasked}` +
        `  at=${candidate.createdAt ?? '—'}` +
        `  source=${candidate.source}` +
        `  mode=${candidate.serviceMode}` +
        `  op=${candidate.operationEvidence}` +
        `  evidence=${candidate.createEvidence}` +
        `  reason=${candidate.unknownReason ?? '—'}` +
        `  orderJoin=${candidate.orderJoin}` +
        `  expected=${candidate.expectedBillingParty}` +
        `  actual=${candidate.actualWhoPaysAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}`,
    )
  })
  return lines
}
