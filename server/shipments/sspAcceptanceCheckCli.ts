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
      orderNumber: orders.orderNumber,
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

  // ── SALT OKUMA: ÇOK KİMLİKLİ TAŞIYICI SORGUSU ────────────────────────────
  //
  // KANITLANMIŞ SIRA (server/index.mjs requestFieldMapping):
  //   WebSiparisKodu = orderNumber   ← Serendip kaydının ANAHTARI
  //   SatisKodu      = orderNumber
  //   ReferansNo     = packageId
  //   OzelKargoTakipNo = 727 pazaryeri takip numarası
  // Takip ucu YALNIZ WebSiparisKodu kabul eder. Bu yüzden birincil aday
  // orderNumber'dır; diğerleri TANI amaçlı denenir (brute-force DEĞİL,
  // create'in gerçekten yazdığı alanlarla sınırlı kapalı liste).
  const mask = (value: string) =>
    value.length <= 4 ? '****' : `${value.slice(0, 3)}***${value.slice(-3)}`

  const identities = [
    { identityType: 'orderNumber_webSiparisKodu', value: order?.orderNumber },
    { identityType: 'packageId_referansNo', value: packageId },
    { identityType: 'carrierTNo', value: shipment?.trackingNumber },
    { identityType: 'carrierBarcode', value: shipment?.barcode },
  ].filter((entry) => String(entry.value ?? '').trim())

  const attempts: Record<string, unknown>[] = []
  let winning: {
    identityType: string
    trackingLog: Record<string, unknown> | null
    gonderilerCount: number
  } | null = null

  for (const identity of identities) {
    const value = String(identity.value)
    let succeeded = false
    let gonderilerCount = 0
    let errorCategory: string | null = null
    let trackingLog: Record<string, unknown> | null = null
    try {
      const response = await fetch(`${baseUrl}/api/shipments/surat/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webSiparisKodu: value }),
      })
      const data = (await response.json()) as Record<string, unknown>
      if (!response.ok) errorCategory = `http_${response.status}`
      else if (data?.ok === false)
        errorCategory = String(data.errorCode ?? 'carrier_error')
      trackingLog = (data?.trackingLog ?? data) as Record<string, unknown>
      const gonderiler = trackingLog?.Gonderiler
      gonderilerCount = Number(
        trackingLog?.gonderilerLength ??
          (Array.isArray(gonderiler) ? gonderiler.length : 0),
      )
      succeeded = Boolean(response.ok && data?.ok !== false)
    } catch (error) {
      errorCategory = 'transport_error'
      void error
    }
    const matchFound = succeeded && gonderilerCount > 0
    attempts.push({
      identityType: identity.identityType,
      maskedIdentity: mask(value),
      queryTransport: 'POST /api/shipments/surat/track',
      succeeded,
      gonderilerCount,
      errorCategory,
      matchFound,
      returnedIdentitySummary: matchFound
        ? {
            barkodNo: trackingLog?.BarkodNo ?? null,
            kargonunDurumuSayi: trackingLog?.KargonunDurumuSayi ?? null,
          }
        : null,
    })
    if (matchFound && !winning) {
      winning = {
        identityType: identity.identityType,
        trackingLog,
        gonderilerCount,
      }
    }
  }

  const log = winning?.trackingLog ?? null
  const gonderiler = log?.Gonderiler
  const kargonunDurumuSayi = log?.KargonunDurumuSayi ?? null
  const mapped = mapSuratCarrierStatus(
    kargonunDurumuSayi as string | number | undefined,
  )

  const report = {
    mode: 'read-only',
    packageId,
    orderNumber: order?.orderNumber ?? null,
    tNo: shipment?.trackingNumber ?? null,
    carrierBarcode: shipment?.barcode ?? null,
    localOperationStatus: order?.operationStatus ?? null,
    marketplaceStatus: order?.marketplaceStatus ?? null,
    localShipmentExists: Boolean(shipment),
    archived: Boolean(order?.archivedAt),
    attempts,
    winningIdentityType: winning?.identityType ?? null,
    carrierQuerySucceeded: Boolean(winning),
    gonderilerCount: winning?.gonderilerCount ?? 0,
    kargonunDurumu: log?.KargonunDurumu ?? null,
    kargonunDurumuSayi,
    sonHareketTarihi: log?.SonHareketTarihi ?? null,
    structuredAcceptanceFields: extractStructuredAcceptanceFields(
      Array.isArray(gonderiler) && gonderiler.length > 0 ? gonderiler[0] : log,
    ),
    mappedCarrierStatus: mapped
      ? { key: mapped.key, shipped: mapped.shipped, delivered: mapped.delivered }
      : null,
    // Gönderi BULUNMASI tek başına yeterli DEĞİL: shipped kodu da şart.
    wouldResolveHandedToCargo: Boolean(
      (winning?.gonderilerCount ?? 0) > 0 && mapped?.shipped === true,
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
