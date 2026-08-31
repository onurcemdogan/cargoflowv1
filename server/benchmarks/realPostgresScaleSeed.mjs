// GERÇEK POSTGRES ÖLÇEK TOHUMLAMASI — ÜRETİM BİÇİMLİ VERİ.
//
// ═══ NEDEN PGlite YETMEZ ═════════════════════════════════════════════════
// PGlite (WASM) testleri sorgu SAYISINI ve parite DOĞRULUĞUNU kanıtlar; ama
// gerçek bir Postgres'in planlayıcısını, disk/ağ gecikmesini ve sürücü
// serileştirme maliyetini taşımaz. "Tam liste hesabını tarayıcıdan sunucuya
// taşıdık" iddiası, ölçeğin YALNIZCA yer değiştirmediğini gerçek bir
// veritabanında göstermeyi gerektirir.
//
// ═══ ÜRETİM BİÇİMİ ═══════════════════════════════════════════════════════
// Salt sipariş satırı tohumlamak yanıltıcı olurdu: asıl maliyet sınıflandırma
// zincirindedir (gönderi bağlama, Sürat ZPL doğrulaması, ürün ailesi). Bu
// yüzden veri gerçek karışımı taşır:
//   · siparişlerin bir bölümü GERÇEK (maskelenmiş) Sürat artefaktına sahip
//   · gönderi başına bir operasyon kaydı
//   · sipariş başına 1–3 satır
//   · pazaryeri/statü/operasyon/şehir/tarih karışımı
//   · ayrı bir ürün kataloğu (varyantlı)
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
// ÜRETİME YAZMAZ: DATABASE_URL yerel izole örneği göstermiyorsa ÇIKAR.
// Taşıyıcıya/pazaryerine HİÇBİR çağrı yapılmaz; artefakt repodaki maskelenmiş
// fixture'dan gelir.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

// ═══ SABİT KIYASLAMA ANAHTARI ════════════════════════════════════════════
// Sipariş/gönderi alanları şifreli saklanır. Tohumlayan süreç ile ölçülen
// API süreci AYNI anahtarı kullanmazsa okuma çöker. Kabuk ortamına bağlı
// kalmak koşuyu tekrarlanamaz yapardı; bu yüzden anahtar burada, YALNIZ
// atanmamışsa, sabitlenir. Veritabanı yerel/izole ve tek kullanımlıktır
// (bkz. assertLocalDatabase); bu anahtar üretimde KULLANILMAZ.
const SCALE_ENCRYPTION_KEY =
  '5ca1e0be7c4d4f1a9b3e2d6c8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345'
process.env.ORDER_DATA_ENCRYPTION_KEY ??= SCALE_ENCRYPTION_KEY
process.env.CREDENTIAL_ENCRYPTION_KEY ??= SCALE_ENCRYPTION_KEY
process.env.SHIPMENT_ENCRYPTION_KEY ??= SCALE_ENCRYPTION_KEY

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

/** Yerel/izole olduğu KANITLANMIŞ ana makineler. */
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1']

export function assertLocalDatabase(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('[scale-seed] DATABASE_URL okunamadı.')
  }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(
      `[scale-seed] GÜVENLİK: yalnız yerel izole veritabanı kabul edilir (${parsed.hostname} reddedildi).`,
    )
  }
  // Ek kemer: üretim adı taşıyan bir veritabanına ASLA yazma.
  if (/prod/i.test(parsed.pathname)) {
    throw new Error('[scale-seed] GÜVENLİK: "prod" adlı veritabanına yazılmaz.')
  }
  return parsed
}

const CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Şanlıurfa', 'Çanakkale']
const DISTRICTS = ['Kadıköy', 'Çankaya', 'Bornova', 'Nilüfer', 'Muratpaşa', 'Siverek', 'Ayvacık']
const FIRST = ['Şükrü', 'Ayşe', 'Ibrahim', 'Zeynep', 'Ömer', 'Gülşah', 'Çağatay']
const LAST = ['Öztürk', 'Çelik', 'Ünal', 'Işık', 'Gül', 'Şahin', 'Yıldırım']
const MARKETPLACES = ['Trendyol', 'Trendyol', 'Trendyol', 'Hepsiburada', 'N11']
const MP_STATUS = ['Created', 'Picking', 'Invoiced', 'Shipped', 'Delivered', 'Cancelled', 'Returned']
const OP_STATUS = ['NEW', 'LABEL_READY', 'LABEL_PRINTED', 'HANDED_TO_CARGO']

/** Gerçek üretim etiketinin maskelenmiş kopyası (PII yok). */
const REAL_ZPL = readFileSync(
  join(root, 'server', 'fixtures', 'surat-real-success-11415535074.zpl'),
  'utf8',
)

/** Gönderi/operasyon taşıyan sipariş oranı (üretimde tipik). */
const SHIPMENT_RATIO = 0.4
/** Katalog varyant sayısı — sipariş sayısına bağlı, üst sınırlı. */
function catalogSize(orderCount) {
  return Math.min(4000, Math.max(200, Math.round(orderCount / 5)))
}

function chunked(items, size) {
  const out = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

/** Çok satırlı INSERT — parametre sınırını aşmadan hızlı yazım. */
async function insertRows(client, table, columns, rows, perStatement = 500) {
  if (rows.length === 0) return
  for (const batch of chunked(rows, perStatement)) {
    const values = []
    const placeholders = batch.map((row, rowIndex) => {
      const marks = columns.map((_, colIndex) => {
        values.push(row[colIndex])
        return `$${rowIndex * columns.length + colIndex + 1}`
      })
      return `(${marks.join(',')})`
    })
    await client.query(
      `insert into ${table} (${columns.join(',')}) values ${placeholders.join(',')}`,
      values,
    )
  }
}

export async function seedScaleDataset({ databaseUrl, orderCount, log = () => {} }) {
  assertLocalDatabase(databaseUrl)
  // Şifreleyiciler ortam anahtarlarını kullanır; uygulama yolunun AYNISI.
  const orderEncryption = await import('../orders/orderEncryption.ts')
  const shipmentEncryption = await import('../shipments/shipmentEncryption.ts')
  const printRepo = await import('../shipments/printZplRepository.ts')

  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('truncate table organizations cascade')
    const org = await client.query(
      `insert into organizations (name, slug) values ($1,$2) returning id`,
      ['Scale Bench', `scale-${randomUUID().slice(0, 8)}`],
    )
    const organizationId = org.rows[0].id

    // ── Katalog ────────────────────────────────────────────────────────
    const variantCount = catalogSize(orderCount)
    const productRows = []
    for (let index = 0; index < variantCount; index += 1) {
      productRows.push([
        organizationId,
        'Trendyol',
        `PRD-${index}`,
        `Ürün ${index % 400} Model ${(index % 7) + 1}`,
        'ONRSOFT',
        false,
      ])
    }
    await insertRows(
      client,
      'products',
      ['organization_id', 'marketplace', 'external_product_id', 'title', 'brand', 'archived'],
      productRows,
      400,
    )
    const products = await client.query(
      `select id, external_product_id from products where organization_id = $1`,
      [organizationId],
    )
    const variantRows = products.rows.map((row, index) => [
      organizationId,
      row.id,
      `VAR-${index}`,
      `SKU-${index}`,
      `869${String(index).padStart(10, '0')}`,
      ['Lacivert', 'Siyah', 'Ekru', 'Bordo'][index % 4],
      ['S', 'M', 'L', 'XL', 'STD'][index % 5],
      false,
    ])
    await insertRows(
      client,
      'product_variants',
      [
        'organization_id', 'product_id', 'external_variant_id', 'merchant_sku',
        'barcode', 'color', 'size', 'archived',
      ],
      variantRows,
      400,
    )
    log(`katalog: ${variantRows.length} varyant`)

    // ── Siparişler ─────────────────────────────────────────────────────
    const orderRows = []
    for (let index = 0; index < orderCount; index += 1) {
      const packageId = `SC-${String(index).padStart(8, '0')}`
      orderRows.push([
        organizationId,
        MARKETPLACES[index % MARKETPLACES.length],
        packageId,
        `SCORD-${String(index).padStart(8, '0')}`,
        `EXT-${index}`,
        MP_STATUS[index % MP_STATUS.length],
        OP_STATUS[index % OP_STATUS.length],
        FIRST[index % FIRST.length],
        `${LAST[index % LAST.length]}${index % 137}`,
        CITIES[index % CITIES.length],
        DISTRICTS[index % DISTRICTS.length],
        'Sürat Kargo',
        `7281${String(index).padStart(9, '0')}`,
        String(100 + (index % 900)),
        new Date(Date.UTC(2026, 6 + (index % 2), 1 + (index % 27), index % 24)),
        orderEncryption.encryptOrderPayload({
          id: packageId,
          orderNumber: `SCORD-${index}`,
          status: MP_STATUS[index % MP_STATUS.length],
        }),
      ])
    }
    await insertRows(
      client,
      'orders',
      [
        'organization_id', 'marketplace', 'package_id', 'order_number',
        'external_order_id', 'marketplace_status', 'operation_status',
        'customer_first_name', 'customer_last_name', 'shipping_city',
        'shipping_district', 'cargo_provider_name', 'cargo_tracking_number',
        'total_amount', 'order_date', 'raw_payload_encrypted',
      ],
      orderRows,
      300,
    )
    log(`sipariş: ${orderRows.length}`)

    const persisted = await client.query(
      `select id, package_id from orders where organization_id = $1 order by package_id`,
      [organizationId],
    )

    // ── Sipariş satırları (1–3) ────────────────────────────────────────
    const lineRows = []
    for (const [index, row] of persisted.rows.entries()) {
      const lineCount = 1 + (index % 3)
      for (let line = 0; line < lineCount; line += 1) {
        lineRows.push([
          organizationId,
          row.id,
          `L-${index}-${line}`,
          `Ürün ${index % 400} Model ${(index % 7) + 1}`,
          `SKU-${index % variantCount}`,
          `869${String(index % variantCount).padStart(10, '0')}`,
          1 + (index % 3),
          JSON.stringify([
            { name: 'Renk', value: ['Lacivert', 'Siyah', 'Ekru', 'Bordo'][index % 4] },
            { name: 'Beden', value: ['S', 'M', 'L', 'XL', 'STD'][index % 5] },
          ]),
        ])
      }
    }
    await insertRows(
      client,
      'order_lines',
      [
        'organization_id', 'order_id', 'external_line_id', 'product_name',
        'merchant_sku', 'barcode', 'quantity', 'variant_attributes',
      ],
      lineRows,
      300,
    )
    log(`sipariş satırı: ${lineRows.length}`)

    // ── Gönderiler + operasyonlar (GERÇEK artefakt biçimi) ─────────────
    const now = '2026-08-27T00:00:00.000Z'
    const shipmentRows = []
    const operationRows = []
    for (const [index, row] of persisted.rows.entries()) {
      if (index % Math.round(1 / SHIPMENT_RATIO) !== 0) continue
      const trackingNumber = `114${String(index).padStart(8, '0')}`
      const items = [
        {
          productName: `Ürün ${index % 400} Model ${(index % 7) + 1}`,
          quantity: 1 + (index % 3),
          color: ['Lacivert', 'Siyah', 'Ekru', 'Bordo'][index % 4],
          size: ['S', 'M', 'L', 'XL', 'STD'][index % 5],
          sku: `SKU-${index % variantCount}`,
        },
      ]
      // Uygulama yolunun AYNISI: ham ZPL → baskı artefaktı → şifreli payload.
      const payload = printRepo.attachPrintZplArtifact(
        {
          technicalZpl: REAL_ZPL,
          ozelKargoTakipNo: trackingNumber,
          kargoTakipNo: trackingNumber,
          labelStatus: index % 3 === 0 ? 'PRINTED' : 'READY',
          dispatchRegistrationConfirmed: true,
        },
        items,
        now,
      )
      const encrypted = shipmentEncryption.encryptShipmentPayload(payload)
      shipmentRows.push([
        organizationId,
        MARKETPLACES[index % MARKETPLACES.length],
        row.package_id,
        `SCORD-${String(index).padStart(8, '0')}`,
        'surat',
        'local_create',
        'created',
        trackingNumber,
        encrypted,
      ])
      operationRows.push([
        organizationId,
        MARKETPLACES[index % MARKETPLACES.length],
        row.package_id,
        `SCORD-${String(index).padStart(8, '0')}`,
        'surat',
        'create',
        `idem-${index}`,
        'succeeded',
        trackingNumber,
        encrypted,
        1,
        true,
      ])
    }
    await insertRows(
      client,
      'shipments',
      [
        'organization_id', 'marketplace', 'package_id', 'order_number',
        'provider', 'source', 'status', 'tracking_number',
        'carrier_payload_encrypted',
      ],
      shipmentRows,
      120,
    )
    await insertRows(
      client,
      'shipment_operations',
      [
        'organization_id', 'marketplace', 'package_id', 'order_number',
        'provider', 'operation_type', 'idempotency_key', 'status',
        'tracking_number', 'response_payload_encrypted', 'create_call_count',
        'carrier_create_called',
      ],
      operationRows,
      120,
    )
    log(`gönderi: ${shipmentRows.length}, operasyon: ${operationRows.length}`)

    await client.query(
      `insert into organization_settings (organization_id, onboarding_completed, onboarding_completed_at)
       values ($1, true, now())
       on conflict (organization_id) do update set onboarding_completed = true`,
      [organizationId],
    )
    await client.query('analyze')

    return {
      organizationId,
      orders: orderRows.length,
      lines: lineRows.length,
      shipments: shipmentRows.length,
      operations: operationRows.length,
      variants: variantRows.length,
    }
  } finally {
    await client.end()
  }
}
