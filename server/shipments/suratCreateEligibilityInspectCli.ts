// SALT-OKUNUR UYGUNLUK DENETÇİSİ.
//
// "Yeni Siparişler" sekmesinde görünmek create adayı olmak DEĞİLDİR. Bu araç,
// GERÇEK create uç noktasının kullandığı AYNI yordamı (`resolveSuratCreate
// Eligibility`) aynı kayıtlar üzerinde çalıştırır ve kararı gösterir.
//
// PARALEL/SİMÜLE BİR YORDAM YOKTUR: farklı bir kopya, üretimdekinden farklı
// cevap verir ve denetim yalan söyler.
//
// YAZMA YOK · TAŞIYICI ÇAĞRISI YOK · BASKI YOK.
import { and, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orders, shipments } from '../db/schema.ts'
import { rowToOrder } from '../orders/orderMapper.ts'
import { resolveOrganizationByName } from './suratBillingScanner.ts'
import { resolveSuratCreateEligibility } from './suratCreateEligibility.ts'

const readArg = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

const mask = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  return raw.length <= 8 ? `${raw.slice(0, 2)}****` : `${raw.slice(0, 4)}****${raw.slice(-4)}`
}

const yesNo = (value: unknown): string => (value ? 'YES' : 'NO')
const orUnavailable = (value: unknown): string => {
  const raw = value === null || value === undefined ? '' : String(value).trim()
  return raw.length > 0 ? raw : 'UNAVAILABLE_IN_CURRENT_SCHEMA'
}

export async function runSuratCreateEligibilityInspect(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[surat:eligibility] DATABASE_URL tanımlı değil.')
    return 1
  }
  const db = getDb()
  const name = readArg('name')
  const packageId = readArg('package')
  let organizationId = readArg('org')
  if (!organizationId && name) {
    const resolved = await resolveOrganizationByName(db, name)
    if (resolved.status !== 'ok') {
      console.error(`[surat:eligibility] "${name}" için tenant çözülemedi.`)
      return 1
    }
    organizationId = resolved.organization.id
  }
  if (!organizationId || !packageId) {
    console.error('[surat:eligibility] (--org veya --name) ve --package ZORUNLU.')
    return 1
  }

  // ── SALT OKUMA ────────────────────────────────────────────────────────
  const orderRows = await db
    .select()
    .from(orders)
    .where(and(
      eq(orders.organizationId, organizationId),
      eq(orders.packageId, packageId),
    ))
  const orderRow = orderRows[0]
  if (!orderRow) {
    console.error(`[surat:eligibility] paket bulunamadı: ${mask(packageId)}`)
    return 1
  }
  const shipmentRows = await db
    .select()
    .from(shipments)
    .where(and(
      eq(shipments.organizationId, organizationId),
      eq(shipments.packageId, packageId),
    ))
  const shipmentRow = shipmentRows[0] ?? null

  const order = rowToOrder(orderRow, []) as Record<string, unknown>
  // Gönderi kanıtı, create yolundaki `order.shipment` ile AYNI şekle konur.
  if (shipmentRow) {
    // ŞEMADA GERÇEKTEN VAR OLAN alanlar. `ozelKargoTakipNo`, `printZpl` ve
    // `technicalZpl` shipments tablosunda YOKTUR; uydurulmaz.
    order.shipment = {
      trackingNumber: shipmentRow.trackingNumber ?? '',
      barcodeValue: shipmentRow.barcode ?? '',
    }
  }

  // ── GERÇEK CREATE YOLUNUN YORDAMI ─────────────────────────────────────
  const eligibility = resolveSuratCreateEligibility({ order })

  const orderDate = orderRow.orderDate ? new Date(orderRow.orderDate) : null
  const ageHours = orderDate
    ? Math.round((Date.now() - orderDate.getTime()) / 36e5)
    : null

  console.info(`ORGANIZATION                 ${mask(organizationId)}`)
  console.info('')
  console.info(`PACKAGE_ID                   ${mask(packageId)}`)
  console.info(`ORDER_NUMBER                 ${mask(orderRow.orderNumber)}`)
  console.info(`CARGO_TRACKING_NUMBER        ${mask(orderRow.cargoTrackingNumber)}`)
  console.info(`ORDER_DATE                   ${orUnavailable(orderRow.orderDate)}`)
  console.info(`AGE_HOURS                    ${ageHours ?? 'UNAVAILABLE_IN_CURRENT_SCHEMA'}`)
  console.info('')
  console.info(`PROVIDER_STATUS_STORED       ${orUnavailable(orderRow.marketplaceStatus)}`)
  console.info(`PROVIDER_STATUS_OBSERVED_AT  ${orUnavailable(orderRow.marketplaceLastModifiedAt)}`)
  // `orders` tablosunda tekil `status` kolonu YOK; kanonik durum
  // `operationStatus`, pazaryeri durumu `marketplaceStatus` alanindadir.
  console.info(`LOCAL_CANONICAL_STATUS       ${orUnavailable(orderRow.operationStatus)}`)
  console.info(`LOCAL_OPERATION_STATUS       ${orUnavailable(orderRow.operationStatus)}`)
  console.info(`LAST_PACKAGE_OBSERVED_AT     ${orUnavailable(orderRow.updatedAt)}`)
  console.info('')
  console.info(`SHIPMENT_STATE               ${shipmentRow ? orUnavailable(shipmentRow.source) : 'NONE'}`)
  console.info(`LABEL_STATE                  ${orUnavailable(orderRow.operationStatus)}`)
  console.info(`CARRIER_EVIDENCE_PRESENT     ${yesNo(shipmentRow)}`)
  console.info(`TRACKING_EVIDENCE_PRESENT    ${yesNo(shipmentRow?.trackingNumber)}`)
  console.info(`LABEL_ARTIFACT_PRESENT       ${yesNo(shipmentRow?.barcode)}`)
  console.info('LABEL_ZPL_STATE              UNAVAILABLE_IN_CURRENT_SCHEMA')
  console.info('')
  // Önceki deneme güvenliği IDEMPOTENCY katmanının sahibidir; burada
  // kopyalanmaz, yalnız gözlemlenebilen kanıt bildirilir.
  console.info('PRIOR_CREATE_ATTEMPT_STATE   OWNED_BY_IDEMPOTENCY_LAYER')
  console.info(`CREATE_IDEMPOTENCY_KEY_PRESENT ${yesNo(shipmentRow)}`)
  console.info('LAST_CREATE_TRACE_ID         UNAVAILABLE_IN_CURRENT_SCHEMA')
  console.info('')
  const identityReason = eligibility.reasons.filter(
    (reason) => reason.startsWith('IDENTITY_'),
  )
  console.info(`IDENTITY_CONSISTENT          ${yesNo(identityReason.length === 0)}`)
  console.info(`IDENTITY_REASON              ${identityReason.join(', ') || '—'}`)
  console.info('')
  console.info(`ELIGIBLE                     ${yesNo(eligibility.eligible)}`)
  console.info(`ELIGIBILITY_REASON           ${eligibility.reasons.join(', ') || '—'}`)
  console.info('')
  console.info('NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0 · PRINT_CALLS 0')
  return 0
}

const invokedDirectly = process.argv[1]?.includes(
  'suratCreateEligibilityInspectCli',
)
if (invokedDirectly) {
  runSuratCreateEligibilityInspect()
    .then(async (code) => { await closePool(); process.exitCode = code })
    .catch(async (error) => {
      console.error('[surat:eligibility]', (error as Error)?.message)
      await closePool()
      process.exitCode = 1
    })
}
