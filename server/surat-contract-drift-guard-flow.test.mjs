import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ SÖZLEŞME KAYMASI KORUMASI ═══════════════════════════════════════════
//
// `bfcf7b8` regresyonu şundan doğdu: KAYITLI servis niyeti ile ÇALIŞMA
// ZAMANI servisi sessizce ayrıştı. Hiçbir test bunu yakalamadı çünkü hiçbir
// test ikisinin AYNI olduğunu pinlemiyordu.
//
// Bu paket, sözleşmeye duyarlı yüzeyi anlık görüntü olarak kilitler. Fixture
// yalnız KASITLI bir sözleşme değişikliğinde güncellenir — testi yeşile
// çevirmek için DEĞİL.

const ROUTE = await import('./shipments/suratPrimaryCreateRoute.ts')
const MODE = await import('./shipments/suratCanonicalServiceMode.mjs')
const CLIENT = await import('./shipments/suratWebApiClient.ts')

const here = new URL('.', import.meta.url)

/** Kanonik Trendyol yolunun DEĞİŞMEZ sözleşme yüzeyi. */
const CANONICAL_CONTRACT_SNAPSHOT = {
  configuredServiceMode: 'SURAT_CANONICAL_API',
  resolvedServiceMode: 'SURAT_CANONICAL_API',
  serviceType: 'SuratCanonicalWebApi',
  operation: 'OrtakBarkodOlustur',
  host: 'api02.suratkargo.com.tr',
  createPath: '/api/OrtakBarkodOlustur',
}

test('DRIFT-1: kayitli mod = cozulen mod (calisma zamani EZEMEZ)', () => {
  const snap = CANONICAL_CONTRACT_SNAPSHOT
  const route = ROUTE.resolveSuratPrimaryCreateRoute({
    configuredServiceMode: snap.configuredServiceMode,
    marketplace: 'Trendyol',
  })
  assert.equal(route.serviceMode, snap.resolvedServiceMode)
  assert.equal(route.soapPrimarySelected, false)
  assert.equal(route.overrodeConfiguredMode, false)
  // Hicbir kayitli mod degistirilemez.
  assert.deepEqual([...ROUTE.SOAP_PRIMARY_REPLACEABLE_MODES], [])
})

test('DRIFT-2: servis tipi ve operasyon SABIT', () => {
  const snap = CANONICAL_CONTRACT_SNAPSHOT
  assert.equal(MODE.SURAT_CANONICAL_SERVICE_MODE, snap.configuredServiceMode)
  assert.equal(MODE.SURAT_CANONICAL_SERVICE_TYPE, snap.serviceType)
  assert.equal(MODE.SURAT_CANONICAL_OPERATION_NAME, snap.operation)
})

test('DRIFT-3: host ve yol SABIT; izin listesi TEK host', () => {
  const snap = CANONICAL_CONTRACT_SNAPSHOT
  assert.equal(
    new URL(CLIENT.SURAT_CANONICAL_LIVE_API_BASE_URL).hostname, snap.host,
  )
  assert.equal(CLIENT.SURAT_CANONICAL_CREATE_PATH, snap.createPath)
  assert.deepEqual([...CLIENT.SURAT_CANONICAL_ALLOWED_HOSTS], [snap.host])
})

test('DRIFT-4: resmi sozlesme artefakti depoda ve bu ucu TANIYOR', () => {
  // 2026-08-26'da api02'nin canli Swagger'indan alindi. SIR ICERMEZ.
  const swagger = JSON.parse(readFileSync(
    new URL('../docs/contracts/surat-web-api-swagger-v2.json', here), 'utf8',
  ))
  assert.equal(swagger.info.title, 'Sürat Kargo Web API')
  const paths = Object.keys(swagger.paths)
  assert.ok(
    paths.includes(CANONICAL_CONTRACT_SNAPSHOT.createPath),
    'kullandigimiz uc resmi sozlesmede YOK',
  )
  // ACIK SORU: pazaryeri icin AYRI uc var. Uc DEGISTIRILMEDI; bu satir
  // bulgunun kaybolmamasi icindir.
  assert.ok(paths.includes('/api/PazaryeriOrtakBarkod'))
})

test('DRIFT-5: sozlesme kaydi kanit seviyeleriyle GUNCEL', () => {
  const registry = readFileSync(
    new URL('../docs/contracts/TRENDYOL-SURAT.md', here), 'utf8',
  )
  for (const marker of [
    'API02_LIVE_FOR_THIS_ACCOUNT',   // host sinifi cozuldu
    'PazaryeriOrtakBarkod',          // acik soru kayitli
    'PRODUCTION_PROVEN',             // kimlik esleme kanit seviyesi
    'BİRLEŞTİRİCİ KURAL',            // WebSiparisKodu kurali
  ]) {
    assert.ok(registry.includes(marker), `sozlesme kaydinda eksik: ${marker}`)
  }
})

test('DRIFT-6: yeni server test dosyalari test:surat icinde KAYITLI', () => {
  // Daha once yeni test dosyalari pakete girmedigi icin YANLIS YESIL olustu.
  const listed = new Set(
    JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  const orphans = onDisk.filter((f) => !listed.has(f))
  assert.deepEqual(orphans, [], `test:surat icinde OLMAYAN: ${orphans.join(', ')}`)
})

/* ═══ CANLI SÖZLEŞME OLGULARI ══════════════════════════════════════ */

const CONTRACT = JSON.parse(readFileSync(
  new URL('../docs/contracts/surat-web-api-swagger-v2.json', here), 'utf8',
))
const SCHEMAS = CONTRACT.components.schemas
const bodyRef = (route) => CONTRACT.paths[route].post.requestBody
  .content['application/json'].schema.oneOf[0].$ref.split('/').pop()

test('CONTRACT-1: uc ailesi ve istek govdeleri SABIT', () => {
  // Dordu de ayni `OrtakBarkod` etiketi altinda; govdeleri FARKLI.
  assert.equal(bodyRef('/api/OrtakBarkodOlustur'), 'OrtakBarkodOlusturParam')
  assert.equal(bodyRef('/api/PazaryeriOrtakBarkod'), 'MarketPlace')
  assert.equal(bodyRef('/api/PazaryeriGonderi'), 'OrtakBarkodOlusturParam')
  assert.equal(bodyRef('/api/CreateCommonBarcode'), 'CreateCommonBarcodeParam')
})

test('CONTRACT-2: PazaryeriOrtakBarkod ADRES TASIMAZ', () => {
  // Bu, ucun MEVCUT kaydi referansla cagirdiginin yapisal kanitidir:
  // adres/alici alani olmadan YENI gonderi kurulamaz.
  const gonder = SCHEMAS.Gonder.properties
  assert.deepEqual(Object.keys(gonder), [
    'EntegrasyonFirmasi', 'KargoMusteriKodu', 'WebSiparisKodu',
    'Desi', 'Kg', 'Adet',
  ])
  // Genel uc ise adres TASIR.
  assert.ok('AliciAdresi' in SCHEMAS.GonderiModel.properties)
  assert.ok('KisiKurum' in SCHEMAS.GonderiModel.properties)
})

test('CONTRACT-3: Trendyol pazaryeri enum degeri 1', () => {
  const e = SCHEMAS.WebMusteriEntegrasyon
  assert.equal(e['x-enumNames'][0], 'Trendyol')
  assert.equal(e.enum[0], 1)
})

test('CONTRACT-4: WhoPays eslemesi SOZLESMEDEN dogrulanir', () => {
  // expectedSuratWhoPays artik TAHMIN DEGIL.
  const e = SCHEMAS.MusteriEntegrasyonOdemeSekli
  const at = (name) => e.enum[e['x-enumNames'].indexOf(name)]
  assert.equal(at('GondericiOder'), 1)          // SELLER_PAYS
  assert.equal(at('EntegrasyonFirmasiOder'), 3) // TRENDYOL_PAYS
})

test('CONTRACT-5: Iademi CANLI SOZLESMEDE boolean', () => {
  // 2024 tarihli BASKA urunun PDF'i `byte` diyordu; bu uc icin GECERSIZ.
  assert.equal(SCHEMAS.GonderiModel.properties.Iademi.type, 'boolean')
})

test('CONTRACT-6: ResultMesaj.Barcode TIPSIZ dizi (KargoBarkod burada)', () => {
  const barcode = SCHEMAS.ResultMesaj.properties.Barcode
  assert.equal(barcode.type, 'array')
  assert.deepEqual(barcode.items, {})
  // `KargoBarkod` istekte YOKTUR — cast hatasi yanit kurulurken olusur.
  assert.equal(JSON.stringify(SCHEMAS.GonderiModel).includes('KargoBarkod'), false)
})
