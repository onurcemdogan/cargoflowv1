import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// GERÇEK PRODUCTION SÜRAT ŞABLONU — YAPISAL SÖZLEŞME.
//
// server/fixtures/real-template-masked.zpl, gerçek production technicalZpl'inden
// güvenli mask CLI ile üretilmiştir: komut dizisi, koordinatlar, font ve
// barkod parametreleri AYNEN korunur; yalnız ^FD veri gövdeleri maskelenmiştir.
//
// Bu paket iki şeyi kilitler:
//  1) Fixture'ın BAYT BAYT bütünlüğü (boyut + SHA256). Satır sonu
//     normalizasyonu .gitattributes `*.zpl -text` ile engellenir; bu test
//     platformdan bağımsız bozulmayı yakalar.
//  2) Gerçek şablonun SEMANTIC ALAN HARİTASI: hangi alan hangi koordinatta,
//     hangi font/boyutla ve hangi barkod parametreleriyle basılıyor.
//     Composer bu haritaya göre yazılacaktır; harita kayarsa test kırılır.
//
// Fixture MASKELİDİR: müşteri adı/adres/telefon/takip numarası GERÇEK DEĞİLDİR.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'real-template-masked.zpl')

const EXPECTED_BYTES = 1861
const EXPECTED_SHA256 =
  'cf94fb4f848dfd59a3cf60a2334cc6216ab66e4f881f06840b20b38a1d3da58a'

const raw = readFileSync(FIXTURE)
const zpl = raw.toString('utf8')

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
      // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
      // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
      // "server is being restarted or closed" hatası verir. SSR-only test
      // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
      // tarama tamamen kapatılır.
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

// ═══ RT-1..RT-2: BÜTÜNLÜK ════════════════════════════════════════════════

test('RT-1: fixture BAYT BAYT korunur (boyut + SHA256)', () => {
  assert.equal(raw.length, EXPECTED_BYTES, 'production doğrulamasıyla aynı boyut')
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    EXPECTED_SHA256,
    'production doğrulamasıyla aynı SHA256',
  )
})

test('RT-2: satır sonu normalizasyonu .gitattributes ile engellenir', () => {
  const attributes = readFileSync(join(here, '..', '.gitattributes'), 'utf8')
  assert.match(
    attributes,
    /^\*\.zpl -text$/m,
    'ZPL fixture EOL normalizasyonundan muaf olmalı',
  )
})

// ═══ RT-3..RT-5: ŞABLON İSKELETİ ═════════════════════════════════════════

test('RT-3: fiziksel etiket sözleşmesi (100×100 mm, tek sayfa)', () => {
  assert.match(zpl, /\^PW799/)
  assert.match(zpl, /\^LL0799/)
  assert.match(zpl, /\^LS0/)
  assert.equal((zpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((zpl.match(/\^XZ/g) ?? []).length, 1)
  assert.match(zpl, /\^PQ1,0,1,Y/)
})

test('RT-4: komut envanteri production raporuyla AYNI', () => {
  assert.equal((zpl.match(/\^GB/g) ?? []).length, 9, '^GB')
  assert.equal((zpl.match(/\^BC/g) ?? []).length, 1, '^BC')
  assert.equal((zpl.match(/\^BX/g) ?? []).length, 1, '^BX')
  assert.equal((zpl.match(/\^BQ/g) ?? []).length, 0, '^BQ — şablonda QR YOK')
  assert.equal((zpl.match(/\^FD/g) ?? []).length, 38, '^FD alan sayısı')
})

test('RT-5: makine-okunur kodların parametreleri', () => {
  // Code128: modül 4, oran 3, yükseklik 143, yorum satırı ALTTA (Y,N).
  assert.match(zpl, /\^BY4,3,143\^FT48,300\^BCN,,Y,N/)
  assert.match(zpl, /\^FD>:\d+\^FS/, 'Code128 >: (subset C) öneki')
  // DataMatrix: ^BXN,8,200 — modül 8, ECC200.
  assert.match(zpl, /\^BY128,128\^FT59,706\^BXN,8,200,0,0,1,~/)
})

// ═══ RT-6: SEMANTIC ALAN HARİTASI ════════════════════════════════════════
//
// Composer bu haritaya göre yazılacak. Her satır: alan → (x, y, font, boyut).

test('RT-6: semantic alan haritası (koordinat + font) sabittir', () => {
  const map = [
    // [açıklama, regex]
    ['şube etiketi', /\^FT51,79\^A0N,23,24/],
    ['şube değeri', /\^FT113,78\^A0N,28,28/],
    ['T.No etiketi', /\^FT453,79\^A0N,23,24/],
    ['T.No değeri', /\^FT514,79\^A0N,28,28/],
    ['gönderici adı', /\^FT53,106\^A0N,20,28/],
    ['gönderici irsaliye', /\^FT54,129\^A0N,17,24/],
    ['gönderici tel etiketi', /\^FT431,146\^A0N,11,16/],
    ['gönderici tel', /\^FT487,150\^A0N,17,24/],
    ['alıcı adı', /\^FT63,354\^A0N,18,25/],
    ['adres satır 1 (TrueType)', /\^FT63,376\^A@N,15,10,TT0003M_/],
    ['adres satır 2 (TrueType)', /\^FT63,396\^A@N,15,10,TT0003M_/],
    ['alıcı tel etiketi', /\^FT64,470\^A0N,18,20/],
    ['alıcı tel', /\^FT115,470\^A0N,18,20/],
    ['il / ilçe', /\^FT507,470\^A0N,22,22/],
    ['ödeme tipi etiketi', /\^FT63,494\^A0N,16,24/],
    ['birim etiketi', /\^FT184,494\^A0N,16,24/],
    ['desi etiketi', /\^FT340,494\^A0N,16,24/],
    ['ödeme tipi değeri', /\^FT63,531\^A0N,32,31/],
    ['birim değeri', /\^FT184,531\^A0N,25,42/],
    ['desi değeri', /\^FT340,530\^A0N,25,50/],
    ['parça adedi etiketi', /\^FT220,559\^A0N,16,24/],
    ['parça adedi değeri', /\^FT220,602\^A0N,44,62/],
    ['teslim tipi', /\^FT340,599\^A0N,35,33/],
    ['rota kodu', /\^FT220,636\^A0N,44,52/],
    ['aktarma merkezi', /\^FT220,705\^A0N,70,50/],
    ['dikey sipariş rayı', /\^FT25,706\^A0B,20,28/],
    ['dikey ALICI rayı', /\^FT54,430\^A0B,23,24/],
    ['dikey SURAT KARGO rayı', /\^FT35,252\^A0B,28,28/],
  ]
  for (const [name, pattern] of map) {
    assert.match(zpl, pattern, `alan haritası kaydı: ${name}`)
  }
})

test('RT-7: kutu/ayraç çizgileri (^GB) sabittir', () => {
  for (const rule of [
    '^FO50,84^GB716,0,1^FS',   // üst kutu — üst çizgi
    '^FO48,84^GB0,71,1^FS',    // üst kutu — sol dikey
    '^FO766,84^GB0,71,1^FS',   // üst kutu — sağ dikey
    '^FO49,154^GB716,0,1^FS',  // üst kutu — alt çizgi
    '^FO59,336^GB716,0,1^FS',  // alıcı kutusu — üst
    '^FO59,337^GB0,201,1^FS',  // alıcı kutusu — sol dikey
    '^FO773,337^GB0,201,1^FS', // alıcı kutusu — sağ dikey
    '^FO59,476^GB716,0,1^FS',  // alıcı/ödeme ayracı
    '^FO59,539^GB716,0,1^FS',  // ödeme/alt bölge ayracı
  ]) {
    assert.ok(zpl.includes(rule), `çizgi: ${rule}`)
  }
})

// ═══ RT-8..RT-10: MEVCUT ZİNCİR GERÇEK ŞABLONLA ÇALIŞIYOR MU ════════════

test('RT-8: gerçek şablon DESTEKLENEN olarak tanınır', async () => {
  const { resolveSuratTemplateFingerprint } = await load(
    '/src/utils/suratZplProductLine.ts')
  const fingerprint = resolveSuratTemplateFingerprint(zpl)
  assert.equal(
    fingerprint.supported,
    true,
    `gerçek şablon desteklenmeli: ${fingerprint.reason ?? ''}`,
  )
  assert.equal(fingerprint.printWidth, 799)
  assert.equal(fingerprint.labelLength, 799)
  assert.equal(fingerprint.hasCode128, true)
  assert.equal(fingerprint.hasMatrixCode, true)
  assert.equal(fingerprint.hasVerticalRail, true)
})

test('RT-9: geometri ölçümü gerçek şablonda tutarlı', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const geometry = parseSuratZplGeometry(zpl)
  assert.equal(geometry.ok, true)
  assert.equal(geometry.printWidth, 799)
  assert.equal(geometry.labelLength, 799)
  // Resmî içerik etiket sınırını AŞMAZ (^FT/^BX taban çizgisi düzeltmeleri).
  assert.ok(
    geometry.contentBottom <= geometry.labelLength,
    `contentBottom taşmamalı: ${geometry.contentBottom}`,
  )
  // Dikey ray ölçülür ve etiket içinde kalır.
  assert.ok(geometry.leftRailRight > 0, 'ray sağ kenarı ölçüldü')
  assert.ok(
    geometry.leftRailBottom > 0 && geometry.leftRailBottom <= geometry.labelLength,
    `ray alt kenarı etiket içinde: ${geometry.leftRailBottom}`,
  )
})

// ═══ RT-10A / RT-10B: İKİ AYRI RENDER SÖZLEŞMESİ ═════════════════════════
//
// Baskı ZPL'i iki farklı sözleşmeyle üretilebilir ve bunların DOĞRU
// sözleşmeleri BİRBİRİNDEN FARKLIDIR. Tek bir teste sıkıştırmak, ikisinden
// birini zayıflatmak zorunda bırakırdı:
//
//   RT-10A  official_augmented — kaynak ZPL çıktının BAYT ÖNEKİ olarak durur.
//           Taşıyıcı komutları hiç değişmez, yalnız sona ürün footer'ı eklenir.
//           Bu, composer'dan ÖNCEKİ davranışın AYNISIDIR ve hiçbir iddiası
//           gevşetilmemiştir — altındaki test gövdesi değişmedi.
//
//   RT-10B  durusoft_composed — DuruSoft parity için bilinçli layout dönüşümü
//           uygulanır (^BC yorum satırı Y→N). Bu yüzden bayt-önek iddiası
//           BURADA GEÇERSİZDİR; yerine DAHA GÜÇLÜ bir sözleşme kanıtlanır:
//           kaynak artefakt değişmez + 6 semantic invariant + transform
//           whitelist (beklenmeyen mutasyon/silme = 0) + determinizm.
//
// Yani bu ayrım "beklentiyi geçsin diye gevşetme" DEĞİLDİR: RT-10A eski
// sözleşmeyi aynen korur, RT-10B onun kapsamadığı yeni modu daha sıkı
// koşullarla bağlar.

test('RT-10A: augmentation-only modda ürün footer’ı GÜVENLE eklenebilir', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const derived = deriveAugmentedSuratZpl(zpl, [
    {
      productName: 'Scuba Secil Detayli Tesettur Lacivert Elbise',
      quantity: 1,
      color: 'Lacivert',
      size: '40',
      sku: 'SCUBA-SEC01',
    },
  ])
  assert.equal(derived.augmented, true, 'gerçek şablonda ürün satırı eklenir')
  assert.equal(derived.augmentationStatus, 'success')
  // KAYNAK KUTSAL: bayt bayt korunur ve önek olarak durur.
  assert.equal(derived.sourceZpl, zpl)
  const head = zpl.slice(0, zpl.lastIndexOf('^PQ'))
  assert.ok(derived.printZpl.startsWith(head))
  // Tek sayfa, ^LL/^PW değişmedi.
  assert.equal((derived.printZpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^LL0799/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^PW799/g) ?? []).length, 1)
  // Makine-okunur alanlar AYNEN.
  assert.ok(derived.printZpl.includes('^BY4,3,143^FT48,300^BCN,,Y,N'))
  assert.ok(derived.printZpl.includes('^BXN,8,200,0,0,1,~'))
  // Footer resmî içeriğin ALTINDA ve etiket içinde.
  const geometry = parseSuratZplGeometry(zpl)
  assert.ok(derived.metrics.footerTop > geometry.contentBottom)
  assert.ok(derived.metrics.footerBottom <= 799 - 8)
  // Bu mod composer'ı ÇALIŞTIRMAZ.
  assert.equal(derived.renderContract, 'official_augmented')
  assert.equal(derived.composeMode, null)
})

test('RT-10B: composed mod kaynağı korur ve whitelist/invariant ile bağlanır', async () => {
  const { deriveAugmentedSuratZplWithHashes, sha256Hex } = await load(
    '/src/utils/augmentedSuratZpl.ts')
  const { verifyPersistedPrintZpl } = await load(
    '/server/shipments/printZplRepository.ts')
  const { parseZplDocument } = await load('/src/utils/zplCommandModel.ts')
  const { diffZplAgainstSource, INVARIANT_KEYS } = await load(
    '/src/utils/suratDurusoftComposer.ts')
  const { extractSuratSemanticFields } = await load(
    '/src/utils/suratSemanticParser.ts')

  const items = [{ productName: 'Ornek Urun', quantity: 1, sku: 'SKU-1' }]
  const compose = { cargoTrackingNumber: '7271234567890' }
  const sourceShaBefore = sha256Hex(zpl)
  const derived = deriveAugmentedSuratZplWithHashes(zpl, items, { compose })

  // — A) SOURCE IMMUTABILITY —
  assert.equal(derived.renderContract, 'durusoft_composed')
  assert.equal(derived.composeMode, 'durusoft_composed')
  assert.equal(derived.sourceZpl, zpl, 'kaynak AYNEN taşınır')
  assert.equal(sha256Hex(zpl), sourceShaBefore, 'kaynak SHA değişmez')
  assert.equal(derived.printZplSourceSha256, sourceShaBefore)

  // Composed çıktı kaynağın bayt öneki OLMAK ZORUNDA DEĞİLDİR.
  assert.notEqual(derived.printZpl, zpl)
  assert.equal(
    derived.printZpl.startsWith(zpl.slice(0, zpl.lastIndexOf('^PQ'))),
    false,
    'bilinçli dönüşüm nedeniyle bayt-önek iddiası burada geçerli değil',
  )

  // — C) TRANSFORM WHITELIST —
  const diff = diffZplAgainstSource(
    parseZplDocument(zpl),
    parseZplDocument(derived.printZpl),
  )
  assert.equal(diff.removed.length, 0, 'taşıyıcı komutu SİLİNMEZ')
  // İKİ beklenen mutasyon: (1) Code128 yorum bayrağı, (6) dikey alıcı
  // başlığının GÖVDESİ boşaltılır. Başlık komutu SİLİNMEZ — bu yüzden
  // `removed` hâlâ sıfırdır.
  assert.equal(diff.mutations.length, 2, 'iki beklenen mutasyon')
  const barcodeFlag = diff.mutations.find((mutation) => mutation.name === 'BC')
  assert.ok(barcodeFlag, '^BC yorum bayrağı mutasyonu bulunmalı')
  assert.ok(barcodeFlag.from.startsWith('N,,Y,N'))
  assert.ok(barcodeFlag.to.startsWith('N,,N,N'))
  const heading = diff.mutations.find((mutation) => mutation.name === 'FD')
  assert.ok(heading, 'başlık gövdesi mutasyonu bulunmalı')
  assert.equal(heading.to, '', 'başlık gövdesi BOŞALTILIR')
  assert.ok(diff.inserted > 0, 'yeni alanlar EKLENİR')

  // — B) SEMANTIC INVARIANTS —
  const before = extractSuratSemanticFields(zpl).fields
  const after = extractSuratSemanticFields(derived.printZpl).fields
  for (const key of INVARIANT_KEYS) {
    assert.equal(after[key].raw, before[key].raw, `invariant: ${key}`)
  }
  // QR gövdesi TAM doğrulanmış değer.
  assert.ok(derived.printZpl.includes('^BQN,2,5^FDLA,7271234567890^FS'))
  assert.equal((derived.printZpl.match(/\^BQ/g) ?? []).length, 1)
  // Tek etiket, sayfa parametreleri sabit.
  assert.equal((derived.printZpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^XZ/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^PW799/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^LL0799/g) ?? []).length, 1)

  // — D) DETERMINISM —
  const again = deriveAugmentedSuratZplWithHashes(zpl, items, { compose })
  assert.equal(again.printZpl, derived.printZpl, 'bayt bayt aynı')
  assert.equal(again.printZplSha256, derived.printZplSha256)

  // — IMMUTABLE REPRINT —
  // Kalıcı kayıt kaynağın SHA'sına bağlanır; kaynak değişmediği sürece
  // kayıtlı composed artefakt AYNEN geri döner (yeniden compose EDİLMEZ).
  if (typeof verifyPersistedPrintZpl === 'function') {
    const verdict = verifyPersistedPrintZpl(
      {
        printZpl: derived.printZpl,
        printZplLength: derived.printZplLength,
        printZplSha256: derived.printZplSha256,
        printZplSourceSha256: derived.printZplSourceSha256,
        printZplVersion: derived.printZplVersion,
        printZplFooterProfile: derived.printZplFooterProfile,
        templateFingerprint: derived.templateFingerprint,
        printZplCreatedAt: '2026-08-09T00:00:00.000Z',
      },
      sourceShaBefore,
    )
    assert.equal(verdict.ok, true, verdict.reason ?? '')
  }
})
