// CLI: SSP FİZİKSEL KABUL TANI KOMUTU — TAMAMEN SALT OKUNUR.
//
//   npm run surat:ssp-acceptance:check -- --package-id 4065907241
//
// YAPMAZ: shipment create · carrier update · order update · DB write.
// YAPAR : kalıcı sipariş/gönderi kimliğini OKUR ve mevcut salt-okunur
//         taşıyıcı takip ucunu (POST /api/shipments/surat/track) çağırır.
//
// Çıktı PII TAŞIMAZ: müşteri adı/adres/telefon YOKTUR; yalnız teknik
// kimlikler ve taşıyıcı durum alanları.
//
// AMAÇ: golden vaka için gerçek AFTER `KargonunDurumuSayi` değerini görmek.
// Bu değer görülmeden taşıyıcı durum haritasına DOKUNULMAZ.
import { and, eq } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { orders, shipments } from '../db/schema.ts'
import { mapSuratCarrierStatus } from '../../src/utils/shipmentStatus.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

/** Taşıyıcı yanıtından YALNIZ yapılandırılmış teknik alanları toplar. */
function extractStructuredAcceptanceFields(
  payload: unknown,
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  const record = payload as Record<string, unknown>
  const keys = [
    'KabulTarihi',
    'IslemTipi',
    'HareketTipi',
    'EventCode',
    'MovementCode',
    'Sube',
    'CikisSubesi',
    'TeslimAlan',
    'KargoTipi',
    'SonHareketKodu',
  ]
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
      out[key] = record[key]
    }
  }
  return out
}

async function main(): Promise<void> {
  const packageId = parseArg('package-id')
  if (!packageId) {
    console.error('Kullanım: --package-id <packageId>')
    process.exitCode = 1
    return
  }
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }
  const baseUrl = parseArg('base-url') ?? 'http://127.0.0.1:8787'
  const db = getDb()

  // ── SALT OKUMA: sipariş + gönderi kimliği ────────────────────────────────
  const orderRows = await db
    .select({
      operationStatus: orders.operationStatus,
      marketplaceStatus: orders.marketplaceStatus,
      archivedAt: orders.archivedAt,
      marketplace: orders.marketplace,
      organizationId: orders.organizationId,
    })
    .from(orders)
    .where(eq(orders.packageId, packageId))
    .limit(1)
  const order = orderRows[0]

  const shipmentRows = order
    ? await db
        .select({
          trackingNumber: shipments.trackingNumber,
          barcode: shipments.barcode,
          status: shipments.status,
        })
        .from(shipments)
        .where(
          and(
            eq(shipments.organizationId, order.organizationId),
            eq(shipments.marketplace, order.marketplace),
            eq(shipments.packageId, packageId),
          ),
        )
        .limit(1)
    : []
  const shipment = shipmentRows[0]

  // ── SALT OKUMA: taşıyıcı takip sorgusu (mevcut uç) ───────────────────────
  let carrier: Record<string, unknown> | null = null
  let carrierQuerySucceeded = false
  try {
    const response = await fetch(`${baseUrl}/api/shipments/surat/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webSiparisKodu: packageId }),
    })
    const data = (await response.json()) as Record<string, unknown>
    carrierQuerySucceeded = Boolean(response.ok && data?.ok !== false)
    carrier = data
  } catch (error) {
    console.error('taşıyıcı sorgusu başarısız:', (error as Error).message)
  }

  const trackingLog = (carrier?.trackingLog ??
    carrier?.suratTrackingLog ??
    carrier) as Record<string, unknown> | null
  const gonderiler = trackingLog?.Gonderiler
  const gonderilerCount = Number(
    trackingLog?.gonderilerLength ??
      (Array.isArray(gonderiler) ? gonderiler.length : 0),
  )
  const kargonunDurumuSayi = trackingLog?.KargonunDurumuSayi ?? null
  const mapped = mapSuratCarrierStatus(
    kargonunDurumuSayi as string | number | undefined,
  )

  const report = {
    mode: 'read-only',
    packageId,
    tNo: shipment?.trackingNumber ?? null,
    carrierBarcode: shipment?.barcode ?? null,
    localOperationStatus: order?.operationStatus ?? null,
    marketplaceStatus: order?.marketplaceStatus ?? null,
    localShipmentExists: Boolean(shipment),
    archived: Boolean(order?.archivedAt),
    carrierQuerySucceeded,
    gonderilerCount,
    kargonunDurumu: trackingLog?.KargonunDurumu ?? null,
    kargonunDurumuSayi,
    sonHareketTarihi: trackingLog?.SonHareketTarihi ?? null,
    structuredAcceptanceFields: extractStructuredAcceptanceFields(
      Array.isArray(gonderiler) && gonderiler.length > 0
        ? gonderiler[0]
        : trackingLog,
    ),
    mappedCarrierStatus: mapped
      ? { key: mapped.key, shipped: mapped.shipped, delivered: mapped.delivered }
      : null,
    // MEVCUT harita ile bu yanıt "Kargoya Verildi" üretir miydi?
    wouldResolveHandedToCargo: Boolean(
      gonderilerCount > 0 && mapped?.shipped === true,
    ),
  }
  console.log(JSON.stringify(report, null, 2))
}

main()
  .catch((error) => {
    console.error('tanı başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
