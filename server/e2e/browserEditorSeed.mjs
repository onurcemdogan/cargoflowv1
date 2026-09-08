// TARAYICI E2E TOHUMLAMASI — ÜRETİM BENZERİ KİRACI DURUMLARI.
//
// ═══ NEDEN GERÇEK VERİ ═══════════════════════════════════════════════════
// Düzenleyicinin "boş tuval değil, taşıyıcının GERÇEK etiketi" iddiası ancak
// kalıcı bir Sürat artefaktı varsa sınanabilir. Bu tohumlama, üretimde
// karşılaşılan durumları birebir kurar:
//
//   · gerçek (maskelenmiş) Sürat artefaktı taşıyan sipariş
//   · ESKİ (mode alanı OLMAYAN) tam-etiket şablonu, YAYINDA
//   · ikinci kiracı — izolasyon kanıtı
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
// ÜRETİME YAZMAZ: DATABASE_URL yerel/izole değilse ÇIKAR. Taşıyıcıya
// HİÇBİR çağrı yapılmaz; artefakt depodaki fixture'dan gelir.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const SCALE_KEY =
  '5ca1e0be7c4d4f1a9b3e2d6c8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345'
process.env.ORDER_DATA_ENCRYPTION_KEY ??= SCALE_KEY
process.env.CREDENTIAL_ENCRYPTION_KEY ??= SCALE_KEY
process.env.SHIPMENT_ENCRYPTION_KEY ??= SCALE_KEY

const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1']

export function assertLocalDatabase(url) {
  const parsed = new URL(url)
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(
      `[e2e-seed] GÜVENLİK: yalnız yerel izole veritabanı (${parsed.hostname} reddedildi).`,
    )
  }
  if (/prod/i.test(parsed.pathname)) {
    throw new Error('[e2e-seed] GÜVENLİK: "prod" adlı veritabanına yazılmaz.')
  }
  return parsed
}

const CARRIER_ZPL = readFileSync(
  join(root, 'server', 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)

/**
 * ÜRETİMDEKİ ESKİ ŞABLONUN GERÇEK ŞEKLİ — `mode` alanı YOKTUR.
 *
 * Mimari değişiklikten önce kaydedilmiş bir belge tam olarak böyle görünür.
 * Yükseltmeden sonra `standalone` sayılmalı ve çıktısı DEĞİŞMEMELİDİR.
 */
const LEGACY_STANDALONE = {
  schemaVersion: 1,
  id: 'tpl_legacy',
  name: 'Eski Tam Etiket',
  elements: [
    { id: 'recipient', type: 'recipientName', x: 4, y: 4, width: 92, height: 7, z: 1, visible: true, fontSize: 13, bold: true },
    { id: 'address', type: 'address', x: 4, y: 17, width: 92, height: 18, z: 3, visible: true, fontSize: 9, wrap: true, maxLines: 4 },
    { id: 'city', type: 'cityDistrict', x: 4, y: 36, width: 92, height: 7, z: 4, visible: true, fontSize: 12 },
    { id: 'barcode', type: 'barcode', x: 4, y: 45, width: 92, height: 18, z: 5, visible: true },
    { id: 'tracking', type: 'trackingText', x: 4, y: 64, width: 92, height: 6, z: 6, visible: true, fontSize: 10 },
    { id: 'qr', type: 'qr', x: 78, y: 71, width: 18, height: 18, z: 8, visible: true },
    { id: 'store-note', type: 'staticText', x: 4, y: 30, width: 60, height: 4, z: 11, visible: true, fontSize: 7, text: 'Bizi tercih ettiğiniz için teşekkürler' },
    { id: 'products', type: 'productList', x: 4, y: 77, width: 70, height: 14, z: 9, visible: true, fontSize: 7, wrap: true, maxLines: 4 },
  ],
}

/** UZUN adres — üretimde binmeye yol açan gerçek şekil. */
const LONG_ADDRESS =
  'ORTACAMI MAH ORTACAMI MAHALLESI AKIK SOKAK JEOSIT APARTMANI 6-8 KAT 1 DAIRE 6'

const ITEMS = [
  {
    productName: 'Buyuk Ispanyol Kol Uzun Parca Detayli Ozel Gun Abiye',
    quantity: 1,
    color: 'Zumrut Yesil',
    size: '38',
    sku: 'zeyna-gfb44',
  },
]

export async function seedBrowserE2e(databaseUrl) {
  assertLocalDatabase(databaseUrl)
  const printRepo = await import('../shipments/printZplRepository.ts')
  const shipmentEncryption = await import('../shipments/shipmentEncryption.ts')
  const orderEncryption = await import('../orders/orderEncryption.ts')
  const { analyzeSuratZpl } = await import('../../src/utils/suratZplAnalysis.ts')

  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    // Temiz sayfa: E2E her koşuda AYNI durumdan başlar.
    await client.query(
      'truncate organization_settings, shipment_operations, shipments, order_lines, orders, organizations restart identity cascade',
    )
    const orgs = {}
    for (const [key, name] of [['a', 'E2E Kiracı A'], ['b', 'E2E Kiracı B']]) {
      const { rows } = await client.query(
        'insert into organizations (name, slug) values ($1, $2) returning id',
        [name, `e2e-${key}`],
      )
      orgs[key] = rows[0].id
    }

    // ── Sipariş + GERÇEK artefakt (yalnız A kiracısı) ────────────────
    const analysis = analyzeSuratZpl(CARRIER_ZPL)
    const barcode = analysis.acceptedFinalBarcode || 'Web00157962154'
    const tracking = '11415535074'
    const { rows: orderRows } = await client.query(
      `insert into orders (organization_id, marketplace, package_id, order_number,
         customer_first_name, customer_last_name, customer_phone,
         shipping_city, shipping_district, shipping_address_encrypted,
         marketplace_status, order_date, operation_status)
       values ($1,'Trendyol','PKG-E2E','ORD-E2E','HELIN','AYAS','5440000000',
         'TEKIRDAG','SULEYMANPASA',$2,'Created',$3,'LABEL_READY') returning id`,
      [
        orgs.a,
        orderEncryption.encryptOrderPayload({ fullAddress: LONG_ADDRESS }),
        new Date('2026-08-20T09:00:00.000Z'),
      ],
    )
    const orderId = orderRows[0].id
    for (const [index, item] of ITEMS.entries()) {
      await client.query(
        `insert into order_lines (organization_id, order_id, external_line_id,
           product_name, merchant_sku, quantity, variant_attributes)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          orgs.a, orderId, `L-${index}`, item.productName, item.sku, item.quantity,
          JSON.stringify([
            { key: 'Renk', value: item.color },
            { key: 'Beden', value: item.size },
          ]),
        ],
      )
    }
    const payload = printRepo.attachPrintZplArtifact(
      {
        technicalZpl: CARRIER_ZPL,
        carrierTrackingNumber: tracking,
        carrierBarcodeNumber: barcode,
        ozelKargoTakipNo: barcode,
        labelStatus: 'READY',
        dispatchRegistrationConfirmed: true,
        // ═══ CargoFlow ETİKET ÜST VERİSİ ═══════════════════════════════
        // `cargoflow_html` baskı yolu, siparişte üretilmiş bir CargoFlow
        // etiketi (order.label) arar. Üretimde bu, etiket oluşturulurken
        // yazılır; E2E tohumu da GERÇEK şekli taşımalıdır, aksi hâlde
        // baskı yolu siparişi daha ilk adımda eler.
        label: {
          id: 'lbl-e2e',
          labelType: 'zpl',
          barcodeFormat: 'Code128',
          barcodeValue: barcode,
          templateId: 'surat-default',
          zplContent: CARRIER_ZPL,
          zplSource: 'surat.ortakBarkod.BarcodeRaw',
          createdAt: '2026-08-27T00:00:00.000Z',
        },
        shipment: {
          tNo: tracking, kargoTakipNo: tracking, barkodNo: barcode,
          ozelKargoTakipNo: barcode, barcodeRaw: CARRIER_ZPL,
          labelStatus: 'READY', printEnabled: true, zplReady: true,
          lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
          candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
          desi: 2,
        },
      },
      ITEMS,
      '2026-08-27T00:00:00.000Z',
    )
    await client.query(
      `insert into shipments (organization_id, marketplace, package_id, order_number,
         provider, source, status, tracking_number, carrier_payload_encrypted)
       values ($1,'Trendyol','PKG-E2E','ORD-E2E','surat','local_create','created',$2,$3)`,
      [orgs.a, tracking, shipmentEncryption.encryptShipmentPayload(payload)],
    )

    // ── ESKİ tam-etiket şablonu, A kiracısında YAYINDA ───────────────
    await client.query(
      'insert into organization_settings (organization_id, settings_json) values ($1, $2)',
      [
        orgs.a,
        JSON.stringify({
          labelDocuments: {
            activeTemplateId: 'tpl_legacy',
            templates: {
              tpl_legacy: {
                id: 'tpl_legacy',
                name: LEGACY_STANDALONE.name,
                version: 3,
                updatedAt: '2026-01-01T00:00:00.000Z',
                activatedAt: '2026-01-01T00:00:00.000Z',
                draft: LEGACY_STANDALONE,
                active: LEGACY_STANDALONE,
              },
            },
          },
        }),
      ],
    )
    // B kiracısı: HİÇ özel şablonu yok → taşıyıcı orijinali.
    await client.query(
      'insert into organization_settings (organization_id, settings_json) values ($1, $2)',
      [orgs.b, JSON.stringify({})],
    )

    return {
      organizationA: orgs.a,
      organizationB: orgs.b,
      orderId,
      tracking,
      barcode,
      longAddress: LONG_ADDRESS,
    }
  } finally {
    await client.end()
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const url =
    process.env.E2E_DATABASE_URL ??
    'postgres://postgres:cargoflow_e2e@127.0.0.1:15434/cargoflow_e2e'
  seedBrowserE2e(url).then(
    (info) => {
      // Çıktı, tarayıcı koşucusunun okuyacağı tek satırlık JSON'dur.
      process.stdout.write(`${JSON.stringify(info)}\n`)
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`)
      process.exit(1)
    },
  )
}
