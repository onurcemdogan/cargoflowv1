// FATURALAMA TARAFI TEŞHİSİ (CLI) — SALT OKUNUR.
//
// Kullanım:
//   npm run surat:billing:inspect -- --org <organizationId> --package <packageId>
//   npm run surat:billing:inspect -- --org <organizationId> --package <packageId> --get-cargo
//
// VARSAYILAN OLARAK AĞA ÇIKMAZ. `--get-cargo` verilmedikçe yalnız yerel veriye
// bakar. Hiçbir yazma, hiçbir create, hiçbir config değişikliği yapmaz.
//
// GİZLİLİK: müşteri adı/adres/telefon/e-posta, kimlik bilgisi kullanıcı adı ve
// şifresi, ham şifreli yük ASLA basılmaz. Yalnız operasyonel payer metadatası.
import { and, eq, sql } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orders, shipments } from '../db/schema.ts'
import { decryptOrderPayload } from '../orders/orderEncryption.ts'
import { decryptShipmentPayload } from './shipmentEncryption.ts'
import {
  buildBillingObservation,
  inspectTrendyolBillingSource,
} from './suratBillingParty.ts'
import {
  getSuratCargoByParcelUniqueId,
  isGetCargoConfigured,
} from './suratGetCargoClient.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function readArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)

/** `****abcd` — tam kimlik BASILMAZ. */
const mask = (value: unknown): string => {
  const text = String(value ?? '').trim()
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`
}

const safe = (value: unknown): string => {
  const text = String(value ?? '').trim()
  return text || '—'
}

export interface BillingInspectionReport {
  organizationMasked: string
  packageIdMasked: string
  marketplace: string
  rawSourceField: string | null
  rawValue: string | null
  expectedBillingParty: string
  expectedBillingPartySource: string
  credentialClass: string
  parcelUniqueId: string | null
  shipmentIds: string[]
  getCargoRequested: boolean
  getCargoStatus: string
  actualSuratWhoPays: string | null
  actualBillingParty: string
  senderCode: string | null
  billingVerificationStatus: string
}

/**
 * Tek sipariş için teşhis — SALT OKUNUR.
 *
 * `credentialClass` yalnız SINIF adıdır (PRIMARY/SELLER_PAYS/COD); kullanıcı
 * adı veya şifre okunmaz ve basılmaz.
 */
export async function inspectOrderBilling(
  db: Db,
  organizationId: string,
  packageId: string,
  options: { getCargo?: boolean; getCargoConfig?: Record<string, unknown> } = {},
): Promise<BillingInspectionReport | null> {
  const orderRows = (await db
    .select()
    .from(orders)
    .where(
      and(eq(orders.organizationId, organizationId), eq(orders.packageId, packageId)),
    )
    .limit(1)) as Record<string, unknown>[]
  const orderRow = orderRows[0]
  if (!orderRow) return null

  // Ham Trendyol yükü YALNIZ bu tek kayıt için çözülür (sınırlı teşhis).
  let rawOrder: Record<string, unknown> = {}
  try {
    const decrypted = decryptOrderPayload(
      orderRow.rawPayloadEncrypted as string | null,
    )
    if (decrypted && typeof decrypted === 'object') {
      rawOrder = decrypted as Record<string, unknown>
    }
  } catch {
    rawOrder = {}
  }

  const inspection = inspectTrendyolBillingSource({ ...orderRow, rawOrder })

  const shipmentRows = (await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.packageId, packageId),
      ),
    )) as Record<string, unknown>[]

  // Pazaryeri paket kimliği (727…) — kanonik `OzelKargoTakipNo` kaynağı.
  let parcelUniqueId = String(orderRow.cargoTrackingNumber ?? '').trim()
  for (const shipment of shipmentRows) {
    if (parcelUniqueId) break
    try {
      const payload = decryptShipmentPayload(
        shipment.carrierPayloadEncrypted as string | null,
      ) as Record<string, unknown> | null
      parcelUniqueId = String(payload?.ozelKargoTakipNo ?? '').trim()
    } catch {
      /* teşhis kırılmaz */
    }
  }

  let getCargoStatus = 'SKIPPED'
  let whoPays: string | null = null
  let senderCode: string | null = null
  if (options.getCargo) {
    const config = options.getCargoConfig ?? {}
    if (!isGetCargoConfigured(config)) {
      // TAHMİNİ ADRESE İSTEK YOK.
      getCargoStatus = 'NOT_CONFIGURED'
    } else {
      const outcome = await getSuratCargoByParcelUniqueId({
        parcelUniqueId,
        config,
      })
      getCargoStatus = outcome.status
      whoPays = outcome.record?.whoPays ?? null
      senderCode = outcome.record?.senderCode ?? null
    }
  }

  const observation = buildBillingObservation({
    order: { ...orderRow, rawOrder },
    suratWhoPays: whoPays,
    senderCode,
  })

  return {
    organizationMasked: mask(organizationId),
    packageIdMasked: mask(packageId),
    marketplace: String(orderRow.marketplace ?? ''),
    rawSourceField: inspection.sourceField,
    rawValue: inspection.rawValue,
    expectedBillingParty: observation.expectedBillingParty,
    expectedBillingPartySource: observation.expectedBillingPartySource,
    // Bugünkü üretim davranışı: açık satıcı-öder sinyali olmadığı sürece
    // birincil hesap kullanılır (forensic audit bulgusu). Bu tur bunu
    // DEĞİŞTİRMEZ; yalnız raporlar.
    credentialClass: 'PRIMARY',
    parcelUniqueId: parcelUniqueId || null,
    shipmentIds: shipmentRows.map((row) => mask(row.id)),
    getCargoRequested: Boolean(options.getCargo),
    getCargoStatus,
    actualSuratWhoPays: observation.actualSuratWhoPays,
    actualBillingParty: observation.actualBillingParty,
    senderCode: observation.senderCode,
    billingVerificationStatus: observation.billingVerificationStatus,
  }
}

export function formatBillingReport(report: BillingInspectionReport): string[] {
  return [
    `ORGANIZATION            ${report.organizationMasked}`,
    `PACKAGE                 ${report.packageIdMasked}`,
    `MARKETPLACE             ${safe(report.marketplace)}`,
    '',
    `RAW_PAYER_FIELD         ${safe(report.rawSourceField)}`,
    `RAW_PAYER_VALUE         ${safe(report.rawValue)}`,
    `EXPECTED_BILLING_PARTY  ${report.expectedBillingParty}`,
    `EXPECTED_SOURCE         ${report.expectedBillingPartySource}`,
    `CREDENTIAL_CLASS        ${report.credentialClass}`,
    '',
    `PARCEL_UNIQUE_ID        ${safe(report.parcelUniqueId)}`,
    `SHIPMENT_IDS            ${report.shipmentIds.join(', ') || '—'}`,
    '',
    `GET_CARGO_REQUESTED     ${report.getCargoRequested ? 'YES' : 'NO'}`,
    `GET_CARGO_STATUS        ${report.getCargoStatus}`,
    `ACTUAL_SURAT_WHO_PAYS   ${safe(report.actualSuratWhoPays)}`,
    `ACTUAL_BILLING_PARTY    ${report.actualBillingParty}`,
    `SENDER_CODE             ${safe(report.senderCode)}`,
    `VERIFICATION            ${report.billingVerificationStatus}`,
  ]
}

export async function runSuratBillingInspect(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[surat:billing] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = readArg('org')
  const packageId = readArg('package')
  if (!organizationId || !packageId) {
    console.error('[surat:billing] --org ve --package ZORUNLU.')
    return 1
  }
  const db = getDb()
  let getCargoConfig: Record<string, unknown> = {}
  if (hasFlag('get-cargo')) {
    const rows = (await db.execute(
      sql`select settings from organization_settings
          where organization_id = ${organizationId} limit 1`,
    )) as unknown
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) ?? []
    const settings = ((list[0] as { settings?: unknown })?.settings ?? {}) as Record<
      string,
      unknown
    >
    getCargoConfig = (settings.suratGetCargo ?? {}) as Record<string, unknown>
  }

  const report = await inspectOrderBilling(db, organizationId, packageId, {
    getCargo: hasFlag('get-cargo'),
    getCargoConfig,
  })
  if (!report) {
    console.error('[surat:billing] Sipariş bulunamadı (tenant kapsamında).')
    return 1
  }
  for (const line of formatBillingReport(report)) console.info(line)
  if (report.billingVerificationStatus === 'MISMATCH') {
    // GÖZLEM: bu tur baskıyı/başarıyı ETKİLEMEZ, yalnız raporlar.
    console.info('')
    console.info('[surat:billing] BILLING_PARTY_MISMATCH — yalnız gözlem.')
  }
  return 0
}

const invokedDirectly = process.argv[1]?.includes('suratBillingInspectCli')
if (invokedDirectly) {
  runSuratBillingInspect()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(
        '[surat:billing] Teşhis başarısız:',
        error instanceof Error ? error.message : error,
      )
      process.exitCode = 2
    })
    .finally(() => closePool().catch(() => undefined))
}
