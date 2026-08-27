import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// ═══ SÜRAT SLOT HARİTASI + BBOX REGRESYONU ═══════════════════════════════
//
// KÖK NEDEN (kanıtlanmış): composer KIRIK DEĞİLDİ — GÜVENLİ DÜŞTÜ. Parser
// slotları TAM koordinat + TAM punto ile kilitliyordu; taşıyıcı şablonu
// birkaç nokta kaydırıp puntoları değiştirince şablon "tanınmadı" sayıldı ve
// etiket ham basıldı.
//
// EN BÜYÜK RİSK: toleransı gevşetirken bir alanın YANLIŞ slota bağlanması.
// Yanlış barkod = yanlış paketi taşıyan etiket. Bu paket tam olarak bunu
// kovalar.

const here = dirname(fileURLToPath(import.meta.url))
const PARSER = await import('../src/utils/suratSemanticParser.ts')

const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')
const V1 = 'real-template-masked.zpl'
const V2 = 'surat-real-success-11415535074.zpl'

/** Bağımsız üretim kanıtı: `outputs/surat-11415535074-summary.json`. */
const KNOWN_BARCODE = 'Web00157962154'

/* ═══ HER İKİ SÜRÜM DE DESTEKLENİR ═════════════════════════════════ */

test('SLOT-1: QRsiz (v1) ve QRli (v2) sablon DESTEKLENIR', () => {
  const v1 = PARSER.resolveSuratSemanticModel(fixture(V1))
  const v2 = PARSER.resolveSuratSemanticModel(fixture(V2))
  assert.equal(v1.supported, true, v1.reason ?? '')
  assert.equal(v2.supported, true, v2.reason ?? '')
  assert.equal(v1.sourceQrCount, 0)
  assert.equal(v2.sourceQrCount, 1)
  // Surumler parmak izinde AYIRT EDILIR.
  assert.ok(v1.fingerprint.startsWith('surat-real-v1'))
  assert.ok(v2.fingerprint.startsWith('surat-real-v2'))
})

test('SLOT-2: QR varligi diger slotlari KAYDIRMAZ', () => {
  const v2 = PARSER.resolveSuratSemanticModel(fixture(V2))
  // QR eklendi diye "alan indeksi +1" gibi bir cikarim YOK: slotlar
  // KONUMLA eslesir. Kimlik alanlari yerinde.
  assert.ok((v2.fields.code128Payload?.text ?? '').includes(KNOWN_BARCODE))
  assert.ok((v2.fields.branch?.text ?? '').trim().length > 0)
  assert.ok((v2.fields.addressLine1?.text ?? '').trim().length > 0)
})

/* ═══ BARKOD KİMLİĞİ — BAĞIMSIZ DOĞRULAMA ══════════════════════════ */

test('SLOT-3: tasiyici barkodu BAGIMSIZ uretim kanitiyla AYNI', () => {
  const v2 = PARSER.resolveSuratSemanticModel(fixture(V2))
  const barcode = v2.fields.code128Payload?.text ?? ''
  // `outputs/surat-11415535074-summary.json` → finalSuratBarcode.
  assert.ok(
    barcode.includes(KNOWN_BARCODE),
    `barkod uretim kanitiyla uyusmuyor: ${barcode}`,
  )
  // DataMatrix da AYNI barkod kimligini tasir.
  assert.ok((v2.fields.dataMatrixPayload?.text ?? '').includes(KNOWN_BARCODE))
})

test('SLOT-4: barkod slotuna paket/siparis numarasi GECEMEZ', () => {
  const v2 = PARSER.resolveSuratSemanticModel(fixture(V2))
  const barcode = v2.fields.code128Payload?.text ?? ''
  // Bu etiketin paket/siparis kimlikleri barkod DEGILDIR.
  for (const foreign of ['4001749648', '11415535074', '7270034422363739']) {
    assert.equal(
      barcode.includes(foreign), false,
      `barkod yabanci kimlik tasiyor: ${foreign}`,
    )
  }
})

/* ═══ KOMŞU ALAN PERMÜTASYONU — SIZINTI OLMAMALI ═══════════════════ */

test('SLOT-5: komsu alanlar yer degistirse barkod DOGRU kalir ya da FAIL-CLOSED', () => {
  const source = fixture(V2)
  const baseline = PARSER.resolveSuratSemanticModel(source)
  assert.equal(baseline.supported, true)

  // Adres satirlarinin ICERIGINI yer degistir: slot haritasi konuma
  // dayandigi icin barkod ETKILENMEMELI.
  const swapped = source
    .replace('ORNEK MAHALLESI ORNEK CADDESI ORNEK SOKAK NUMARA X', '@@A@@')
    .replace('33', '@@B@@')
    .replace('@@A@@', '33')
    .replace('@@B@@', 'ORNEK MAHALLESI ORNEK CADDESI ORNEK SOKAK NUMARA X')
  const permuted = PARSER.resolveSuratSemanticModel(swapped)
  if (permuted.supported) {
    assert.ok(
      (permuted.fields.code128Payload?.text ?? '').includes(KNOWN_BARCODE),
      'komsu permutasyonu barkodu BOZDU',
    )
  }
})

test('SLOT-6: BELIRSIZ slot TAHMIN EDILMEZ — fail-closed', () => {
  const source = fixture(V2)
  // Alici slotunun HEMEN yanina AYNI font/aile ile ikinci bir alan koy:
  // tolerans yaricapi icinde IKI aday olur.
  const duplicated = source.replace(
    '^FT63,354', '^FT63,358^A0N,18,25^FH\\^FDSAHTE^FS\n^FT63,354',
  )
  const model = PARSER.resolveSuratSemanticModel(duplicated)
  // Ya belirsizligi gorup DUSER ya da dogru alani korur; TAHMIN ETMEZ.
  if (model.supported) {
    assert.notEqual(
      (model.fields.recipient?.text ?? '').trim(), 'SAHTE',
      'belirsizlikte YANLIS alan secildi',
    )
  } else {
    assert.ok(/BELİRSİZ|belirsiz|slotu yok/.test(model.reason ?? ''))
  }
})

/* ═══ BBOX — BÖLGE SIZINTISI YOK ═══════════════════════════════════ */

test('SLOT-7: her semantik alan KENDI bolgesinde kalir', () => {
  // Bolgeler etiketin yapisindan gelir: ust blok gonderici/sube, orta blok
  // alici/adres, alt blok rota/aktarma/kimlik.
  const REGIONS = {
    branch: [0, 140], tNo: [0, 140],
    sender: [90, 200], senderInvoice: [90, 200],
    recipient: [330, 410], addressLine1: [330, 410], addressLine2: [330, 410],
    routeCode: [560, 700], transferCenter: [640, 780],
  }
  for (const name of [V1, V2]) {
    const model = PARSER.resolveSuratSemanticModel(fixture(name))
    assert.equal(model.supported, true, `${name}: ${model.reason ?? ''}`)
    for (const [key, [min, max]] of Object.entries(REGIONS)) {
      const field = model.fields[key]
      if (!field) continue
      const y = field.field?.y ?? field.y
      assert.ok(
        y >= min && y <= max,
        `${name}: ${key} bolge disinda (y=${y}, beklenen ${min}-${max})`,
      )
    }
  }
})

test('SLOT-8: bir ZPL alani EN FAZLA BIR slota baglanir', () => {
  for (const name of [V1, V2]) {
    const model = PARSER.resolveSuratSemanticModel(fixture(name))
    assert.equal(model.supported, true)
    const seen = new Map()
    for (const [key, field] of Object.entries(model.fields)) {
      const node = field?.field
      if (!node) continue
      const at = `${node.x},${node.y}`
      assert.equal(
        seen.has(at), false,
        `${name}: ${at} hem ${seen.get(at)} hem ${key} tarafindan sahiplenildi`,
      )
      seen.set(at, key)
    }
  }
})

/* ═══ GÜVENLİ GERİ DÖNÜŞ ═══════════════════════════════════════════ */

test('SLOT-9: taninmayan sablon HAM etikete duser', () => {
  const unknown = PARSER.resolveSuratSemanticModel(
    fixture('synthetic-surat-reference.zpl'),
  )
  assert.equal(unknown.supported, false)
  assert.equal(unknown.fingerprint, 'unsupported')
  // Bos/bozuk girdi de composed etiket URETMEZ.
  assert.equal(PARSER.resolveSuratSemanticModel('').supported, false)
  assert.equal(PARSER.resolveSuratSemanticModel('^XA^XZ').supported, false)
})

test('SLOT-10: taşıyıcı adres blogunu doldurduysa composer TEKRAR YAZMAZ', () => {
  const v1 = PARSER.resolveSuratSemanticModel(fixture(V1))
  const v2 = PARSER.resolveSuratSemanticModel(fixture(V2))
  // v1: bolge BOS → composer yazar.
  assert.equal(v1.carrierOwnsAddressBlock, false)
  assert.ok(v1.boldAddressSlots.length > 0)
  // v2: tasiyici ZATEN yazmis → composer yazmaz (cift adres basilmaz).
  assert.equal(v2.carrierOwnsAddressBlock, true)
  assert.equal(v2.boldAddressSlots.length, 0)
})

test('SLOT-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  // Liste `package.json`'dan AYRI bir dosyada: 190 dosyada komut satiri
  // Windows cmd.exe'nin 8191 karakter sinirini asiyordu ve paket
  // CALISMADAN dusuyordu. Acik kayit KORUNUR, yalnizca yeri degisti.
  const listed = new Set(
    JSON.parse(readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})

/* ═══ COMPOSER — v2 ŞABLONU ARTIK BESTELENİR ═══════════════════════ */

const COMPOSER = await import('../src/utils/suratDurusoftComposer.ts')
const V2_NUMERIC = 'surat-real-v2-numeric.zpl'
const compose = (zpl) => COMPOSER.composeSuratDurusoftLabel(zpl, {
  items: [{ productName: 'Urun A', quantity: 2 }],
  cargoTrackingNumber: '7270034422363739',
})

test('COMPOSER-1: v1 ve v2 sablonlari BESTELENIR', () => {
  const v1 = compose(fixture(V1))
  assert.equal(v1.composed, true, v1.reason ?? '')
  // v2 (QR'li tasiyici sablonu) ARTIK destekleniyor — kok neden buydu.
  const v2 = compose(fixture(V2_NUMERIC))
  assert.equal(v2.composed, true, v2.reason ?? '')
})

test('COMPOSER-2: CIFT QR BASILMAZ', () => {
  // v1: kaynakta QR yok → composer EKLER → 1.
  const v1 = compose(fixture(V1))
  assert.equal((String(v1.zpl).match(/\^BQ/g) ?? []).length, 1)
  // v2: kaynakta QR VAR → composer EKLEMEZ → yine 1.
  const v2 = compose(fixture(V2_NUMERIC))
  assert.equal(
    (String(v2.zpl).match(/\^BQ/g) ?? []).length, 1,
    'tasiyici QRi + composer QRi = CIFT QR',
  )
})

test('COMPOSER-3: bestelenen ciktida tasiyici barkodu DEGISMEZ', () => {
  // Cikti KAYNAK sablonu degildir (composer bold adres bolgesine yazar), bu
  // yuzden tam kaynak modeli yerine ALAN CIKARICI kullanilir — composer'in
  // kendi degismez dogrulayicisinin kullandigi yordamin AYNISI.
  for (const name of [V1, V2_NUMERIC]) {
    const source = PARSER.resolveSuratSemanticModel(fixture(name))
    const result = compose(fixture(name))
    assert.equal(result.composed, true, result.reason ?? '')
    const after = PARSER.extractSuratSemanticFields(String(result.zpl))
    assert.deepEqual(after.errors, [], `${name}: ciktida alan cozulemedi`)
    assert.equal(
      after.fields.code128Payload?.raw, source.fields.code128Payload?.raw,
      `${name}: besteleme barkodu DEGISTIRDI`,
    )
    assert.equal(
      after.fields.dataMatrixPayload?.raw, source.fields.dataMatrixPayload?.raw,
      `${name}: besteleme DataMatrix kimligini DEGISTIRDI`,
    )
  }
})

test('COMPOSER-4: guvenle kodlanamayan Code128 FAIL-CLOSED', () => {
  // Gercek uretim etiketinin barkodu `>:Web00157962154`: `>:` subset-C
  // (SAYISAL) oneki ile alfanumerik govde. Yeniden kodlamak okunamayan bir
  // barkod uretebilirdi; composer HAM etikete duser.
  const risky = compose(fixture(V2))
  assert.equal(risky.composed, false)
  assert.ok(/rakam/.test(risky.reason ?? ''))
  // Ham kaynak AYNEN korunur.
  assert.equal(String(risky.zpl), fixture(V2))
})
