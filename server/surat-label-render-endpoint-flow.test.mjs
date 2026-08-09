import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// RESMÎ SÜRAT RENDER SERVİSİ — org kapsamlı, salt okunur, gerçek motorla.
//
// Testler GERÇEK PGlite veritabanı ve GERÇEK zebrash motoru kullanır.
// Fixture'lar SENTETİKTİR (gerçek müşteri verisi yok).

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY ??= 'a'.repeat(64)
process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'b'.repeat(64)

const schema = await import('./db/schema.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')
const renderService = await import('./labels/suratLabelRenderService.ts')
const { SURAT_PERSISTENCE_PROVIDER } = await import('./shipments/suratProvider.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

const pools = []
async function makeDb() {
  const pglite = new PGlite()
  pools.push(pglite)
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return drizzle(pglite, { schema })
}
after(async () => {
  for (const pool of pools) await pool.close()
})

// Sentetik resmî Sürat ZPL'i (gerçek müşteri verisi YOK).
const TECHNICAL_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO60,20^GB700,90,2^FS',
  '^FT80,50^A0N,24,24^FDSube: ORNEK^FS',
  '^FT470,50^A0N,26,26^FDT.No: 10000000000001^FS',
  '^FO90,130^BY3^BCN,130,Y,N,N^FD01200000001^FS',
  '^FO60,300^GB700,140,2^FS',
  '^FT80,330^A0N,24,24^FDSENTETIK ALICI^FS',
  '^FO90,565^BXN,5,200^FD1000000000000001^FS',
  '^FT300,650^A0N,34,34^FDORNEKSEHIR/01^FS',
  '^FO660,570^BQN,2,4^FDLA,01200000001^FS',
  '^FWB', '^FT48,690^A0B,20,20^FDSiparis No: 1000000000000001^FS', '^FWN',
  '^PQ1,0,1,Y', '^XZ',
].join('\n')

async function seed(db, over = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: over.slug ?? 'org-a', slug: over.slug ?? 'org-a' })
    .returning()
  const marketplace = 'Trendyol'
  const packageId = over.packageId ?? 'PKG-1'
  await db.insert(schema.orders).values({
    organizationId: org.id,
    marketplace,
    packageId,
    orderNumber: '1000000000000001',
    orderDate: new Date('2026-01-01T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptShipmentPayload({
      customerName: 'SENTETIK ALICI',
    }),
    operationStatus: over.operationStatus ?? 'LABEL_READY',
  })
  await db.insert(schema.shipments).values({
    organizationId: org.id,
    marketplace,
    packageId,
    // FIXTURE DÜZELTMESİ (fix/official-surat-canonical-provider):
    // burada DB'ye 'surat-kargo' yazılıyordu; ÜRETİM ise bu kolona
    // DAİMA kanonik 'surat' yazar (server/index.mjs create yolu).
    // Yanlış fixture, görünüm değerini anahtar olarak kullanan lookup
    // hatasını MASKELİYORDU. İddia GEVŞETİLMEDİ: satır artık üretimle
    // birebir aynı kanonik değerle yazılır.
    provider: over.dbProvider ?? SURAT_PERSISTENCE_PROVIDER,
    source: 'local_create',
    status: 'VERIFIED',
    carrierPayloadEncrypted: encryption.encryptShipmentPayload({
      technicalZpl: over.zpl ?? TECHNICAL_ZPL,
    }),
  })
  return { organizationId: org.id, marketplace, packageId }
}

function makeGetOrder(seeded, over = {}) {
  return async (_db, organizationId, orderId) => {
    if (organizationId !== seeded.organizationId) return null
    if (orderId !== 'order-1') return null
    return {
      id: 'order-1',
      marketplace: seeded.marketplace,
      packageId: seeded.packageId,
      shipment: { provider: over.provider ?? 'surat-kargo' }, // GÖRÜNEN ad
      ...over.order,
    }
  }
}

async function render(db, seeded, over = {}) {
  return renderService.renderSuratLabel({
    db,
    organizationId: over.organizationId ?? seeded.organizationId,
    marketplaceAccountId: null,
    orderId: over.orderId ?? 'order-1',
    getOrder: makeGetOrder(seeded, over),
  })
}

// ═══ RE-1..RE-6: KİMLİK, KAPSAM, KAYNAK ═══════════════════════════════════

test('RE-1: canonical shipment bulunur ve 799×799 PNG üretilir', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const dto = await render(db, seeded)
  assert.equal(dto.mimeType, 'image/png')
  assert.equal(dto.widthPx, 799)
  assert.equal(dto.heightPx, 799)
  assert.equal(dto.widthMm, 99.875)
  assert.equal(dto.heightMm, 99.875)
  assert.ok(dto.imageBase64.length > 1000)
  const png = Buffer.from(dto.imageBase64, 'base64')
  assert.equal(png.readUInt32BE(16), 799)
  assert.equal(png.readUInt32BE(20), 799)
})

test('RE-2: motor sürümleri sabit ve doğrulanır', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const dto = await render(db, seeded)
  assert.equal(dto.renderEngine, 'zpl-renderer-js')
  assert.equal(dto.renderEngineVersion, '4.0.0')
  assert.equal(dto.zebrashVersion, 'v1.38.0')
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['zpl-renderer-js'], '4.0.0', 'sürüm SABİT olmalı')
})

test('RE-3: başka organization ERİŞEMEZ', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  await assert.rejects(
    () => render(db, seeded, { organizationId: 'baska-org' }),
    (error) => error.status === 404 && error.code === 'order_not_found',
  )
})

test('RE-4: Sürat OLMAYAN provider REDDEDİLİR', async () => {
  const db = await makeDb()
  const seeded = await seed(db, { dbProvider: 'baska-kargo' })
  await assert.rejects(
    () => render(db, seeded, { provider: 'baska-kargo' }),
    (error) =>
      error.status === 409 &&
      error.code === 'not_surat_shipment' &&
      error.message ===
        'Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.',
  )
  assert.equal(renderService.isSuratProvider('surat-kargo'), true)
  assert.equal(renderService.isSuratProvider('Sürat Kargo'), true)
  assert.equal(renderService.isSuratProvider('baska-kargo'), false)
})

test('RE-5: kayıtlı etiket yoksa açık 409 (ham ZPL sızmadan)', async () => {
  const db = await makeDb()
  const seeded = await seed(db, { zpl: '' })
  await assert.rejects(
    () => render(db, seeded),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'label_not_ready')
      assert.equal(/\^XA|\^FD/.test(error.message), false, 'mesajda ZPL YOK')
      return true
    },
  )
})

test('RE-6: DTO ham ZPL veya şifreli payload İÇERMEZ', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const dto = await render(db, seeded)
  // DEĞERLERİ tara (anahtar adları değil): `printZplSha256` gibi meşru
  // anahtarlar "printZpl" alt dizesini içerdiği için anahtar taraması yanlış
  // pozitif verir. Ham ZPL/PII yalnız DEĞERLERDE aranır; ikili PNG hariç
  // tutulur (base64 içinde rastgele dize eşleşmesi anlamlı değildir).
  const values = Object.entries(dto)
    .filter(([key]) => key !== 'imageBase64')
    .map(([, value]) => String(value))
    .join(' | ')
  for (const forbidden of [
    '^XA', '^FD', '^BC', '^GB', 'carrierPayload',
    'SENTETIK ALICI', '01200000001', '10000000000001',
  ]) {
    assert.equal(values.includes(forbidden), false, `sızıntı: ${forbidden}`)
  }
  // Ham ZPL taşıyacak bir ALAN hiç bulunmamalı.
  for (const forbidden of ['zpl', 'printZpl', 'technicalZpl', 'sourceZpl', 'barcodeRaw']) {
    assert.equal(forbidden in dto, false, `yasak alan: ${forbidden}`)
  }
  // İzin verilen alanlar (warning YALNIZ fallback durumunda bulunur).
  // renderContract/composeMode: baskı ZPL'inin hangi sözleşmeyle üretildiğini
  // raporlar. Serbest metin DEĞİLDİR — aşağıda KAPALI SÖZLÜK ile bağlanır, bu
  // yüzden müşteri verisi taşıyamaz.
  const allowed = new Set([
    'augmentationStatus', 'heightMm', 'heightPx', 'imageBase64', 'mimeType',
    'printZplSha256', 'renderEngine', 'renderEngineVersion', 'renderSha256',
    'widthMm', 'widthPx', 'zebrashVersion', 'warning',
    'renderContract', 'composeMode',
    // ÇOK SAYFALI SÖZLEŞME (4A). Hepsi sayı veya KAPALI SÖZLÜK; serbest
    // metin veya müşteri verisi taşıyamaz (aşağıda bağlanır).
    'pages', 'missingPages', 'printArtifactStatus', 'productDetailStatus',
    'productDetailFailureReason',
  ])
  for (const key of Object.keys(dto)) {
    assert.ok(allowed.has(key), `DTO'da beklenmeyen alan: ${key}`)
  }
  // Sayfa nesneleri de KAPALI: yeni bir alan sessizce eklenemez.
  const pageKeys = new Set([
    'kind', 'page', 'totalPages', 'imageBase64', 'renderSha256',
  ])
  for (const page of dto.pages ?? []) {
    for (const key of Object.keys(page)) {
      assert.ok(pageKeys.has(key), `sayfada beklenmeyen alan: ${key}`)
    }
    assert.ok(['carrier', 'product_detail'].includes(page.kind))
    assert.equal(Number.isInteger(page.page), true)
  }
  const missingKeys = new Set(['kind', 'page', 'totalPages', 'reason'])
  for (const missing of dto.missingPages ?? []) {
    for (const key of Object.keys(missing)) {
      assert.ok(missingKeys.has(key), `eksik sayfada beklenmeyen alan: ${key}`)
    }
    assert.ok(
      ['render_failed', 'invalid_page_structure'].includes(missing.reason),
    )
  }
  assert.ok(['ready', 'fallback_carrier'].includes(dto.printArtifactStatus))
  assert.ok(['none', 'ready', 'failed'].includes(dto.productDetailStatus))
  // Yeni teşhis alanları KAPALI SÖZLÜKTEN gelir; serbest metin sızamaz.
  assert.ok(
    ['official_augmented', 'durusoft_composed'].includes(dto.renderContract),
    `renderContract kapalı sözlükte olmalı: ${dto.renderContract}`,
  )
  assert.ok(
    dto.composeMode === null ||
      [
        'durusoft_composed',
        'fallback_unknown_template',
        'fallback_semantic_failure',
        'fallback_geometry_failure',
        'fallback_invariant_failure',
        'fallback_whitelist_violation',
      ].includes(dto.composeMode),
    `composeMode kapalı sözlükte olmalı: ${dto.composeMode}`,
  )
})

// ═══ RE-7..RE-11: KALICILIK, DETERMİNİZM, YAN ETKİSİZLİK ══════════════════

test('RE-7: aynı gönderi AYNI printZplSha256 ve renderSha256 verir', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const first = await render(db, seeded)
  const second = await render(db, seeded)
  assert.equal(first.printZplSha256, second.printZplSha256)
  assert.equal(first.renderSha256, second.renderSha256)
  assert.equal(first.imageBase64, second.imageBase64, 'PNG deterministik')
})

test('RE-8: legacy hydration YALNIZ BİR KEZ; ikinci çağrı kayıttan okur', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const before = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, seeded.organizationId))
  const beforePayload = encryption.decryptShipmentPayload(
    before[0].carrierPayloadEncrypted,
  )
  assert.equal(beforePayload.printZplArtifact, undefined, 'başlangıçta artifact yok')

  const first = await render(db, seeded)
  const after = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, seeded.organizationId))
  const afterPayload = encryption.decryptShipmentPayload(
    after[0].carrierPayloadEncrypted,
  )
  assert.ok(afterPayload.printZplArtifact, 'hydration bir kez yazdı')
  // technicalZpl ÜZERİNE YAZILMADI.
  assert.equal(afterPayload.technicalZpl, TECHNICAL_ZPL)

  const second = await render(db, seeded)
  assert.equal(second.printZplSha256, first.printZplSha256)
  assert.equal(second.renderSha256, first.renderSha256)
})

test('RE-9: render sipariş/shipment DURUMUNU değiştirmez', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const orderBefore = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.organizationId, seeded.organizationId))
  await render(db, seeded)
  const orderAfter = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.organizationId, seeded.organizationId))
  assert.equal(orderAfter[0].operationStatus, orderBefore[0].operationStatus)
  assert.equal(orderAfter[0].rawPayloadEncrypted, orderBefore[0].rawPayloadEncrypted)
})

test('RE-10: PRINTED gönderi de yeniden render edilir (reprint)', async () => {
  const db = await makeDb()
  const seeded = await seed(db, { operationStatus: 'LABEL_PRINTED' })
  const dto = await render(db, seeded)
  assert.equal(dto.widthPx, 799)
  assert.ok(dto.printZplSha256)
})

test('RE-11: augmentation ürün satırı yoksa technicalZpl render edilir + güvenli uyarı', async () => {
  const db = await makeDb()
  // Sipariş satırı YOK → ürün satırı üretilemez.
  const seeded = await seed(db)
  const dto = await render(db, seeded)
  assert.equal(dto.augmentationStatus, 'unavailable')
  assert.equal(dto.warning, 'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.')
  assert.equal(/\^XA|\^FD/.test(dto.warning), false)
  assert.equal(dto.widthPx, 799, 'baskı BLOKLANMAZ')
})

// ═══ RE-12..RE-16: ENDPOINT SÖZLEŞMESİ (kaynak denetimi) ══════════════════

test('RE-12: endpoint HAM ZPL kabul etmez ve güvenli header gönderir', () => {
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = server.indexOf("app.post('/api/labels/render/surat'")
  assert.ok(start > -1, 'endpoint kayıtlı olmalı')
  const block = server.slice(start, server.indexOf('\n})', start))
  for (const forbidden of ['zpl', 'printZpl', 'technicalZpl', 'barcodeRaw']) {
    assert.ok(block.includes(`'${forbidden}'`), `reddedilen alan: ${forbidden}`)
  }
  assert.match(block, /raw_zpl_not_accepted/)
  assert.match(block, /Cache-Control', 'private, no-store'/)
  assert.match(block, /Pragma', 'no-cache'/)
  assert.match(block, /X-Content-Type-Options', 'nosniff'/)
  // Auth + org kapsamı mevcut zincirden gelir.
  assert.match(block, /requireOrderPersistenceContext\(request, response\)/)
  assert.match(block, /organizationId: context\.organizationId/)
})

test('RE-13: endpoint ve servis DB WRITE / provider çağrısı içermez', () => {
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = server.indexOf("app.post('/api/labels/render/surat'")
  const block = server.slice(start, server.indexOf('\n})', start))
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'markLabelReady', 'markLabelPrinted',
    'createShipment', 'ortakBarkod', 'printCount', 'labelStatus',
  ]) {
    assert.equal(block.includes(forbidden), false, `yasak: ${forbidden}`)
  }
  const service = readFileSync(
    join(here, 'labels', 'suratLabelRenderService.ts'), 'utf8',
  )
  const code = service
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'createShipment', 'printCount',
    'labelStatus =', 'fetch(', 'labelary',
  ]) {
    assert.equal(code.includes(forbidden), false, `yasak: ${forbidden}`)
  }
})

test('RE-14: servis ve motor LOG YAZMAZ (ham ZPL/PII sızmaz)', () => {
  for (const file of [
    join(here, 'labels', 'suratLabelRenderService.ts'),
    join(here, 'labels', 'zplRenderService.ts'),
  ]) {
    const source = readFileSync(file, 'utf8')
    assert.equal(
      /console\.(log|info|warn|error|debug)/.test(source), false, file,
    )
  }
})

test('RE-15: harici render API YOK (motor yerel WASM)', () => {
  const source = readFileSync(join(here, 'labels', 'zplRenderService.ts'), 'utf8')
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(/labelary|labelzoom|fetch\(|https?:\/\//i.test(code), false)
  // Uzaktan WASM yükleyen `/external` girişi KULLANILMAZ.
  assert.equal(code.includes('zpl-renderer-js/external'), false)
  assert.match(code, /await import\('zpl-renderer-js'\)/)
})

test('RE-16: migration EKLENMEDİ', () => {
  const dir = join(here, '..', 'drizzle')
  const sql = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n')
  assert.equal(/render_sha|label_render|zebrash/i.test(sql), false)
})
