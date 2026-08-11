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

  // ── SALT OKUMA: TEK KANONİK TAŞIYICI SORGUSU ─────────────────────────────
  //
  // TAKİP UCUNUN KABUL ETTİĞİ TEK KİMLİK: WebSiparisKodu.
  // Kanıt: resolveSuratTrackingQueryReference —
  //   "KargoTakipHareketDetayi yalnız WEB_SIPARIS_KODU kabul eder".
  // Kanıt: server/index.mjs requestFieldMapping (create) —
  //   WebSiparisKodu = orderNumber · ReferansNo = packageId ·
  //   OzelKargoTakipNo = 727 pazaryeri takip no.
  //
  // FALLBACK YOKTUR. packageId / T.No / barkod değerlerini WebSiparisKodu
  // ALANINA koyup denemek SEMANTİK OLARAK YANLIŞTIR: bunlar Serendip'te
  // farklı alanlardır ve bu uç için ayrı bir sorgu sözleşmesi KANITLANMADI.
  // Bulunamazsa mevcut durum KORUNUR.
  const queryReference = String(order?.orderNumber ?? '').trim()
  const mask = (value: string) =>
    value.length <= 4 ? '****' : `${value.slice(0, 3)}***${value.slice(-3)}`

  let carrierQuerySucceeded = false
  let gonderilerCount = 0
  let errorCategory: string | null = null
  let log: Record<string, unknown> | null = null

  if (!queryReference) {
    errorCategory = 'missing_web_siparis_kodu'
  } else {
    try {
      const response = await fetch(`${baseUrl}/api/shipments/surat/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webSiparisKodu: queryReference }),
      })
      const data = (await response.json()) as Record<string, unknown>
      if (!response.ok) errorCategory = `http_${response.status}`
      else if (data?.ok === false)
        errorCategory = String(data.errorCode ?? 'carrier_error')
      log = (data?.trackingLog ?? data) as Record<string, unknown>
      const list = log?.Gonderiler
      gonderilerCount = Number(
        log?.gonderilerLength ?? (Array.isArray(list) ? list.length : 0),
      )
      carrierQuerySucceeded = Boolean(response.ok && data?.ok !== false)
    } catch {
      errorCategory = 'transport_error'
    }
  }

  const gonderiler = log?.Gonderiler
  const kargonunDurumuSayi = log?.KargonunDurumuSayi ?? null
  const mapped = mapSuratCarrierStatus(
    kargonunDurumuSayi as string | number | undefined,
  )

  const report = {
    mode: 'read-only',
    packageId,
    localShipmentExists: Boolean(shipment),
    localOperationStatus: order?.operationStatus ?? null,
    marketplaceStatus: order?.marketplaceStatus ?? null,
    archived: Boolean(order?.archivedAt),
    // TEK sorgu kimliği — fallback YOK.
    queryIdentityType: 'orderNumber_webSiparisKodu',
    queryReference: mask(queryReference),
    carrierQuerySucceeded,
    errorCategory,
    gonderilerCount,
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
