import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// DURUSOFT COMPOSER — TEMEL KATMANLAR.
//
// Bu paket composer'ın altındaki ÜÇ bağımsız katmanı kilitler:
//   AŞAMA 1  zplCommandModel      — kayıpsız komut modeli (round-trip)
//   AŞAMA 2  suratSemanticParser  — gerçek şablonun 20 alanlık semantic haritası
//   AŞAMA 8  suratQrPayload       — doğrulanmış 727 QR payload çözümü
//
// Hiçbiri üretim baskı zincirine BAĞLI DEĞİLDİR; davranış değişikliği yoktur.
// Kaynak: server/fixtures/real-template-masked.zpl (bayt bayt sabit).

const here = dirname(fileURLToPath(import.meta.url))
const rawFixture = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'))
const zpl = rawFixture.toString('utf8')

// Fixture `^FH\` kaçış karakteri içerir; test kurguları backslash'ı KAYNAKTAN
// üretir, elle yazmaz (elle yazım kabuk/heredoc katmanlarında bozulabilir).
const BS = String.fromCharCode(92)

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      optimizeDeps: { noDiscovery: true, include: [] },
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

const model = () => load('/src/utils/zplCommandModel.ts')
const parser = () => load('/src/utils/suratSemanticParser.ts')
const qr = () => load('/src/utils/suratQrPayload.ts')

// ═══ AŞAMA 1 — KOMUT MODELİ ═══════════════════════════════════════════════

test('CF-1: gerçek fixture parse→serialize BAYT BAYT aynı', async () => {
  const { parseZplDocument, serializeZplDocument } = await model()
  const round = serializeZplDocument(parseZplDocument(zpl))
  assert.equal(round, zpl)
  assert.ok(
    Buffer.from(round, 'utf8').equals(rawFixture),
    'round-trip bayt düzeyinde de aynı olmalı (CRLF dahil)',
  )
})

test('CF-2: bilinmeyen komutlar ve artıklar KAYBOLMAZ', async () => {
  const { parseZplDocument, serializeZplDocument } = await model()
  const samples = [
    '^XA^ZZ9,9^QQbilinmeyen^XZ',
    'önek metni^XA^FO1,2^FDx^FS^XZ sonek',
    '^XA\r\n^MMT\r\n^XZ\r\n',
    '',
    'hiç komut yok',
    '^',
  ]
  for (const sample of samples) {
    assert.equal(
      serializeZplDocument(parseZplDocument(sample)),
      sample,
      `round-trip: ${JSON.stringify(sample)}`,
    )
  }
})

test('CF-3: komut envanteri gerçek şablonla birebir', async () => {
  const { parseZplDocument } = await model()
  const document = parseZplDocument(zpl)
  const inventory = {}
  for (const command of document.commands) {
    inventory[command.name] = (inventory[command.name] ?? 0) + 1
  }
  // RT-4 ile aynı sayılar — iki bağımsız yol aynı sonucu vermeli.
  assert.equal(inventory.GB, 9)
  assert.equal(inventory.BC, 1)
  assert.equal(inventory.BX, 1)
  assert.equal(inventory.BQ, undefined)
  assert.equal(inventory.FD, 38)
  assert.equal(inventory.FT, 38)
  assert.equal(inventory.FO, 9)
  assert.equal(inventory.FS, 47)
  assert.equal(inventory.XA, 1)
  assert.equal(inventory.XZ, 1)
  assert.equal(document.prologue, '')
})

test('CF-4: alanlar konum komutundan ^FS’e kadar doğru toplanır', async () => {
  const { parseZplDocument, collectZplFields } = await model()
  const fields = collectZplFields(parseZplDocument(zpl))
  assert.equal(fields.length, 47, '9 ^FO + 38 ^FT')
  const kinds = {}
  for (const field of fields) kinds[field.kind] = (kinds[field.kind] ?? 0) + 1
  assert.deepEqual(kinds, { text: 36, graphic: 9, datamatrix: 1, code128: 1 })

  const code128 = fields.find((field) => field.kind === 'code128')
  assert.equal(code128.x, 48)
  assert.equal(code128.y, 300)
  assert.equal(code128.positionType, 'FT')
  assert.equal(code128.byCommand.args.trim(), '4,3,143', '^BY alana iliştirilir')
  assert.ok(code128.codeCommand.args.startsWith('N,,Y,N'))

  const dataMatrix = fields.find((field) => field.kind === 'datamatrix')
  assert.equal(dataMatrix.x, 59)
  assert.equal(dataMatrix.y, 706)
  assert.equal(dataMatrix.byCommand.args.trim(), '128,128')
})

test('CF-5: font komutu çözümü (^A0 ve indirilmiş ^A@)', async () => {
  const { parseZplDocument, collectZplFields } = await model()
  const fields = collectZplFields(parseZplDocument(zpl))
  const address = fields.find((field) => field.x === 63 && field.y === 376)
  assert.deepEqual(address.font, {
    command: 'A@',
    fontId: '@',
    orientation: 'N',
    height: 15,
    width: 10,
    fontName: 'TT0003M_',
  })
  const rail = fields.find((field) => field.x === 25 && field.y === 706)
  assert.equal(rail.font.orientation, 'B', 'dikey ray ^A0B')
  assert.equal(rail.font.fontId, '0')
  assert.equal(rail.font.fontName, null, '^A0 indirilmiş font adı taşımaz')
})

test('CF-6: düzenlemeler KİMLİK üzerinden uygulanır, indeks kaymaz', async () => {
  const {
    parseZplDocument,
    serializeZplDocument,
    applyZplEdits,
    zplCommands,
    findCommand,
  } = await model()
  const document = parseZplDocument('^XA^FO1,2^FDa^FS^FO3,4^FDb^FS^XZ')
  const second = document.commands.find(
    (command) => command.name === 'FO' && command.args === '3,4',
  )
  const first = document.commands.find(
    (command) => command.name === 'FO' && command.args === '1,2',
  )
  // İki ekleme + bir değiştirme AYNI ANDA; hedefler nesne kimliğiyle bulunur.
  const edited = applyZplEdits(document, [
    { type: 'insertBefore', target: second, commands: zplCommands('^FO9,9^FDz^FS') },
    { type: 'insertBefore', target: findCommand(document, 'XZ'), commands: zplCommands('^PQ1') },
    { type: 'replace', target: first, commands: zplCommands('^FO7,7') },
  ])
  assert.equal(
    serializeZplDocument(edited),
    '^XA^FO7,7^FDa^FS^FO9,9^FDz^FS^FO3,4^FDb^FS^PQ1^XZ',
  )
  // Boş düzenleme listesi belgeyi AYNEN döndürür.
  assert.equal(applyZplEdits(document, []), document)
  // Belgede olmayan hedef sessizce yutulmaz.
  assert.throws(
    () => applyZplEdits(document, [{ type: 'remove', target: { name: 'FO', args: 'x' } }]),
    /hedef komut belgede yok/,
  )
})

// ═══ AŞAMA 2 — SEMANTIC PARSER ════════════════════════════════════════════

test('CF-7: gerçek şablon DESTEKLENİR ve 20 alan çözülür', async () => {
  const { resolveSuratSemanticModel, SUPPORTED_TEMPLATE_FINGERPRINT } = await parser()
  const semantic = resolveSuratSemanticModel(zpl)
  assert.equal(semantic.supported, true, semantic.reason ?? '')
  assert.equal(semantic.reason, null)
  assert.equal(semantic.fingerprint, SUPPORTED_TEMPLATE_FINGERPRINT)
  assert.equal(Object.keys(semantic.fields).length, 20)
  assert.equal(semantic.addressLines.length, 2)
  assert.equal(semantic.boldAddressSlots.length, 3)
  assert.equal(semantic.printWidth, 799)
  assert.equal(semantic.labelLength, 799)
})

test('CF-8: semantic alanlar RT-6 koordinatlarına oturur', async () => {
  const { resolveSuratSemanticModel } = await parser()
  const { fields } = resolveSuratSemanticModel(zpl)
  const expected = {
    branch: [113, 78],
    tNo: [514, 79],
    sender: [53, 106],
    senderInvoice: [54, 129],
    senderPhone: [487, 150],
    code128Payload: [48, 300],
    recipient: [63, 354],
    addressLine1: [63, 376],
    addressLine2: [63, 396],
    recipientPhone: [115, 470],
    cityDistrict: [507, 470],
    paymentType: [63, 531],
    unit: [184, 531],
    desiKg: [340, 530],
    parcelCount: [220, 602],
    deliveryType: [340, 599],
    routeCode: [220, 636],
    transferCenter: [220, 705],
    orderReference: [25, 706],
    dataMatrixPayload: [59, 706],
  }
  for (const [key, [x, y]] of Object.entries(expected)) {
    assert.ok(fields[key], `alan çözülmeli: ${key}`)
    assert.equal(fields[key].x, x, `${key}.x`)
    assert.equal(fields[key].y, y, `${key}.y`)
    assert.equal(fields[key].empty, false, `${key} gövdesi dolu olmalı`)
  }
  // Kritik makine-okunur alanlar HAM gövdeleriyle taşınır.
  assert.ok(fields.code128Payload.raw.startsWith('>:'), 'Code128 subset C öneki')
  assert.equal(fields.dataMatrixPayload.raw.includes('^'), false)
})

test('CF-9: bold adres slotları var ve KAYNAKTA BOŞ', async () => {
  const { resolveSuratSemanticModel, BOLD_ADDRESS_BASELINES, BOLD_ADDRESS_X, RECIPIENT_BOX_BOTTOM } =
    await parser()
  const semantic = resolveSuratSemanticModel(zpl)
  assert.deepEqual([...BOLD_ADDRESS_BASELINES], [417, 433, 449])
  assert.equal(BOLD_ADDRESS_X, 63)
  assert.ok(RECIPIENT_BOX_BOTTOM > 449, 'son slot kutu tabanının üstünde')
  for (const [index, slot] of semantic.boldAddressSlots.entries()) {
    assert.equal(slot.x, BOLD_ADDRESS_X)
    assert.equal(slot.y, BOLD_ADDRESS_BASELINES[index])
    assert.equal((slot.data ?? '').trim(), '', 'slot boş olmalı')
  }
})

test('CF-10: bilinmeyen şablon FAIL-SAFE (composer çalışmaz)', async () => {
  const { resolveSuratSemanticModel } = await parser()
  for (const sample of [
    '^XA^PW400^LL0400^FO10,10^A0N,20,20^FDx^FS^XZ',
    '^XA^XZ',
    '',
    'bu ZPL değil',
    zpl.replace('^PW799', '^PW800'),
    zpl.replace('^LL0799', '^LL0600'),
    zpl + zpl,
  ]) {
    const semantic = resolveSuratSemanticModel(sample)
    assert.equal(semantic.supported, false, `desteklenmemeli: ${sample.slice(0, 24)}`)
    assert.ok(semantic.reason, 'sebep teknik ve dolu olmalı')
    assert.equal(semantic.fingerprint, 'unsupported')
  }
})

test('CF-11: EKSİK kritik alan FAIL-SAFE', async () => {
  const { resolveSuratSemanticModel } = await parser()
  const tNoField = '^FT514,79^A0N,28,28^FH' + BS + '^FD63074185296307^FS'
  assert.ok(zpl.includes(tNoField), 'kurgu gerçek fixture ile eşleşmeli')
  const semantic = resolveSuratSemanticModel(zpl.replace(tNoField, ''))
  assert.equal(semantic.supported, false)
  assert.match(semantic.reason, /T\.No slotu yok/)
})

test('CF-12: BELİRSİZ kritik alan FAIL-SAFE', async () => {
  const { resolveSuratSemanticModel } = await parser()
  const tNoField = '^FT514,79^A0N,28,28^FH' + BS + '^FD63074185296307^FS'
  const semantic = resolveSuratSemanticModel(zpl.replace(tNoField, tNoField + tNoField))
  assert.equal(semantic.supported, false)
  assert.match(semantic.reason, /BELİRSİZ/)
})

test('CF-13: FONT İMZASI kayarsa FAIL-SAFE', async () => {
  const { resolveSuratSemanticModel } = await parser()
  // Koordinat aynı, font farklı → şablon bizim tanıdığımız şablon DEĞİL.
  for (const [from, to] of [
    ['^FT514,79^A0N,28,28', '^FT514,79^A0N,29,28'],
    ['^FT63,376^A@N,15,10,TT0003M_', '^FT63,376^A0N,15,10'],
    ['^FT25,706^A0B,20,28', '^FT25,706^A0N,20,28'],
  ]) {
    const semantic = resolveSuratSemanticModel(zpl.replace(from, to))
    assert.equal(semantic.supported, false, `font değişimi yakalanmalı: ${to}`)
    assert.match(semantic.reason, /font imzası uyuşmuyor|beklenen komut ailesi/)
  }
})

test('CF-14: yazılacak bölge DOLUYSA veya kaynakta QR VARSA FAIL-SAFE', async () => {
  const { resolveSuratSemanticModel } = await parser()
  const emptySlot = '^FT63,417^A0N,15,25^FH' + BS + '^FD^FS'
  assert.ok(zpl.includes(emptySlot))
  const filled = resolveSuratSemanticModel(
    zpl.replace(emptySlot, '^FT63,417^A0N,15,25^FH' + BS + '^FDDOLU^FS'),
  )
  assert.equal(filled.supported, false)
  assert.match(filled.reason, /slotu kaynakta DOLU/)

  const withQr = resolveSuratSemanticModel(
    zpl.replace('^PQ1', '^FO600,600^BQN,2,5^FDLA,7271234567890^FS^PQ1'),
  )
  assert.equal(withQr.supported, false)
  assert.match(withQr.reason, /beklenmeyen QR/)
})

test('CF-15: composer’ın VERİ bağımlılıkları boşsa FAIL-SAFE', async () => {
  const { resolveSuratSemanticModel } = await parser()
  const emptyCode128 = resolveSuratSemanticModel(
    zpl.replace('^FD>:18529630741^FS', '^FD^FS'),
  )
  assert.equal(emptyCode128.supported, false)
  assert.match(emptyCode128.reason, /Code128 gövdesi boş/)

  let noAddress = zpl
  for (const y of [376, 396]) {
    noAddress = noAddress.replace(
      new RegExp(`\\^FT63,${y}\\^A@N,15,10,TT0003M_\\^FH.\\^CI17\\^F8\\^FD[^^]*\\^FS`),
      `^FT63,${y}^A@N,15,10,TT0003M_^FH${BS}^CI17^F8^FD^FS`,
    )
  }
  const semantic = resolveSuratSemanticModel(noAddress)
  assert.equal(semantic.supported, false)
  assert.match(semantic.reason, /adres satırı yok/)
})

// ═══ AŞAMA 8 — DOĞRULANMIŞ 727 QR PAYLOAD ════════════════════════════════

test('CF-16: cargoTrackingNumber tek kaynakken çözülür', async () => {
  const { resolveSuratQrPayload } = await qr()
  const result = resolveSuratQrPayload({ cargoTrackingNumber: '7271234567890' })
  assert.equal(result.payload, '7271234567890')
  assert.equal(result.source, 'cargoTrackingNumber')
  assert.equal(result.rejection, null)
})

test('CF-17: ozelKargoTakipNo tek kaynakken çözülür', async () => {
  const { resolveSuratQrPayload } = await qr()
  const result = resolveSuratQrPayload({ ozelKargoTakipNo: '  727 123 456 7890 ' })
  assert.equal(result.payload, '7271234567890', 'yalnız boşluk temizlenir')
  assert.equal(result.source, 'ozelKargoTakipNo')
})

test('CF-18: iki kaynak AYNI ise çözülür', async () => {
  const { resolveSuratQrPayload } = await qr()
  const result = resolveSuratQrPayload({
    cargoTrackingNumber: '7271234567890',
    ozelKargoTakipNo: '7271234567890',
  })
  assert.equal(result.payload, '7271234567890')
  assert.equal(result.source, 'both')
})

test('CF-19: iki kaynak FARKLI ise QR ÜRETİLMEZ', async () => {
  const { resolveSuratQrPayload } = await qr()
  const result = resolveSuratQrPayload({
    cargoTrackingNumber: '7271234567890',
    ozelKargoTakipNo: '7279999999999',
  })
  assert.equal(result.payload, null)
  assert.equal(result.rejection, 'sources_disagree')
  assert.equal(result.source, null)
})

test('CF-20: DOĞRULANMAMIŞ biçim QR ÜRETMEZ', async () => {
  const { resolveSuratQrPayload, isVerifiedTrendyolTracking } = await qr()
  const rejected = [
    '1141234567890', // 114… sipariş numarası
    '0121234567890', // 012… Code128
    '63074185296307', // T.No
    '727', // çok kısa
    '727123', // çok kısa
    '7271234567890123456789', // çok uzun
    '727-1234567890', // rakam dışı
    'https://t.co/7271234567890', // URL
    '{"t":"7271234567890"}', // JSON
    '727abc4567890',
  ]
  for (const value of rejected) {
    assert.equal(isVerifiedTrendyolTracking(value), false, `reddedilmeli: ${value}`)
    const result = resolveSuratQrPayload({ cargoTrackingNumber: value })
    assert.equal(result.payload, null, `QR üretilmemeli: ${value}`)
    assert.equal(result.rejection, 'invalid_format')
  }
})

test('CF-21: aday YOKSA QR ÜRETİLMEZ', async () => {
  const { resolveSuratQrPayload } = await qr()
  for (const input of [{}, { cargoTrackingNumber: '' }, { ozelKargoTakipNo: null }, { cargoTrackingNumber: '   ' }]) {
    const result = resolveSuratQrPayload(input)
    assert.equal(result.payload, null)
    assert.equal(result.rejection, 'no_candidate')
  }
})

test('CF-22: başka makine-okunur alanla ÇAKIŞIRSA QR ÜRETİLMEZ', async () => {
  const { resolveSuratQrPayload } = await qr()
  const result = resolveSuratQrPayload({
    cargoTrackingNumber: '7271234567890',
    forbiddenValues: ['63074185296307', '7271234567890'],
  })
  assert.equal(result.payload, null)
  assert.equal(result.rejection, 'collides_with_machine_field')
})

test('CF-23: gerçek şablonun kendi değerleri QR’a ASLA girmez', async () => {
  const { resolveSuratSemanticModel } = await parser()
  const { resolveSuratQrPayload } = await qr()
  const { fields } = resolveSuratSemanticModel(zpl)
  // Şablondaki T.No, Code128, DataMatrix ve sipariş referansı 727 DEĞİLDİR;
  // hiçbiri tek başına QR adayı olamaz.
  for (const key of ['tNo', 'code128Payload', 'dataMatrixPayload', 'orderReference']) {
    const result = resolveSuratQrPayload({ cargoTrackingNumber: fields[key].text })
    assert.equal(result.payload, null, `${key} QR adayı olmamalı`)
  }
})

test('CF-24: teşhis çıktısı GERÇEK DEĞER veya hash SIZDIRMAZ', async () => {
  const { resolveSuratQrPayload } = await qr()
  const secret = '7271234567890'
  for (const input of [
    { cargoTrackingNumber: secret },
    { cargoTrackingNumber: secret, ozelKargoTakipNo: '7279999999999' },
    { cargoTrackingNumber: '727-x' },
    { cargoTrackingNumber: secret, forbiddenValues: [secret] },
  ]) {
    const result = resolveSuratQrPayload(input)
    assert.equal(
      result.diagnostic.includes(secret),
      false,
      'teşhis metni takip numarasını içermemeli',
    )
    assert.equal(/[0-9a-f]{16,}/.test(result.diagnostic), false, 'hash sızmamalı')
  }
})

// ═══ AŞAMA 4-14 — COMPOSER ════════════════════════════════════════════════

const composer = () => load('/src/utils/suratDurusoftComposer.ts')
const augment = () => load('/src/utils/augmentedSuratZpl.ts')
const VERIFIED_727 = '7271234567890'

test('CF-25: Code128 dahili yorum satırı KAPANIR, gövde DEĞİŞMEZ', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  const out = composeSuratDurusoftLabel(zpl, {}).zpl
  assert.ok(zpl.includes('^BCN,,Y,N'), 'kaynakta yorum satırı AÇIK')
  assert.ok(out.includes('^BCN,,N,N'), 'çıktıda yorum satırı KAPALI')
  assert.equal(out.includes('^BCN,,Y,N'), false)
  // Gövde ve barkod parametreleri AYNEN.
  assert.ok(out.includes('^BY4,3,143^FT48,300^BCN,,N,N'))
  assert.ok(out.includes('^FD>:18529630741^FS'), 'Code128 gövdesi değişmez')
})

test('CF-26: ayrı insan-okunur metin, ZPL subset-C geometrisiyle ortalanır', async () => {
  const { composeSuratDurusoftLabel, code128ModuleCount } = await composer()
  const result = composeSuratDurusoftLabel(zpl, {})
  // Görüntülenen sayı = kodlanan gövde (kontrol öneki HARİÇ).
  assert.ok(result.zpl.includes('^FD18529630741^FS'))
  // Ortalama bloğu barkodun GERÇEK YAZICI genişliğine göre kurulur.
  const counted = code128ModuleCount('>:18529630741')
  assert.equal(counted.modules, 112, '11 hane: subset C + tek hane için B geçişi')
  assert.equal(result.diagnostics.barcodeWidth, 112 * 4)
  assert.ok(
    result.zpl.includes(`^FO48,306^A0N,20,20^FB${112 * 4},1,0,C`),
    'blok barkodun sol kenarından başlar ve ortalar',
  )
  // Deterministik: aynı girdi → aynı X/genişlik.
  assert.equal(
    composeSuratDurusoftLabel(zpl, {}).diagnostics.barcodeWidth,
    result.diagnostics.barcodeWidth,
  )
  // Çift hane subset C'de tam yarıya iner; önek yoksa subset B.
  assert.equal(code128ModuleCount('>:012345678901').modules, 101)
  assert.equal(code128ModuleCount('012345678901').modules, 167)
})

test('CF-27: bold adres kaynağın KENDİ satır ve baytlarını kullanır', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  const { resolveSuratSemanticModel, BOLD_ADDRESS_BASELINES } = await parser()
  const semantic = resolveSuratSemanticModel(zpl)
  const result = composeSuratDurusoftLabel(zpl, {})
  assert.equal(result.diagnostics.boldAddressLines, 2)
  semantic.addressLines.forEach((line, index) => {
    const baseline = BOLD_ADDRESS_BASELINES[index]
    // Aynı font stratejisi, aynı ^FD baytları — YENİDEN SARMA YOK.
    assert.ok(
      result.zpl.includes(
        `^FT63,${baseline}^A@N,15,10,TT0003M_^FH${BS}^CI17^F8^FD${line.raw}^FS`,
      ),
      `bold satır ${index + 1} kaynak baytlarıyla`,
    )
    // Çift vuruş (+1 dot): ZPL'de bold varyantı yok, kalınlaştırma böyle yapılır.
    assert.ok(
      result.zpl.includes(
        `^FT64,${baseline}^A@N,15,10,TT0003M_^FH${BS}^CI17^F8^FD${line.raw}^FS`,
      ),
      `bold satır ${index + 1} çift vuruş`,
    )
  })
  // Normal adres satırları AYNEN korunur.
  assert.ok(result.zpl.includes('^FT63,376^A@N,15,10,TT0003M_'))
  assert.ok(result.zpl.includes('^FT63,396^A@N,15,10,TT0003M_'))
})

test('CF-28: tek satırlık adres tek bold slot kullanır', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  // Kaynakta 2. adres satırını boşalt → 1 satırlık profil.
  const single = zpl.replace(
    /\^FT63,396\^A@N,15,10,TT0003M_\^FH.\^CI17\^F8\^FD[^^]*\^FS/,
    `^FT63,396^A@N,15,10,TT0003M_^FH${BS}^CI17^F8^FD^FS`,
  )
  const result = composeSuratDurusoftLabel(single, {})
  assert.equal(result.composed, true, result.reason ?? '')
  assert.equal(result.diagnostics.boldAddressLines, 1)
  assert.ok(result.zpl.includes('^FT63,417^A@N,15,10,TT0003M_'))
  assert.equal(result.zpl.includes('^FT63,433^A@N,15,10,TT0003M_'), false)
  // NOT: gerçek taşıyıcı şablonunda YALNIZ İKİ adres satırı vardır (376/396),
  // bu yüzden 3 satırlık bold profil BU ŞABLONDAN ÜRETİLEMEZ. Composer üçüncü
  // slotu (449) genel olarak destekler; şablon üçüncü satır kazanırsa çalışır.
})

test('CF-29: bölgeye sığmayan adres composer’ı REDDEDER (kırpma YOK)', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  const huge = 'A'.repeat(120)
  const oversized = zpl.replace(
    /\^FT63,376\^A@N,15,10,TT0003M_\^FH.\^CI17\^F8\^FD[^^]*\^FS/,
    `^FT63,376^A@N,15,10,TT0003M_^FH${BS}^CI17^F8^FD${huge}^FS`,
  )
  const result = composeSuratDurusoftLabel(oversized, {})
  assert.equal(result.composed, false)
  assert.equal(result.mode, 'fallback_geometry_failure')
  assert.match(result.reason, /sığmıyor/)
  assert.equal(result.zpl, oversized, 'fallback kaynağı AYNEN döndürür')
})

test('CF-30: QR komutu ve gövdesi doğrulanmış değere EŞİT', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  const result = composeSuratDurusoftLabel(zpl, { ozelKargoTakipNo: VERIFIED_727 })
  assert.ok(result.zpl.includes(`^BQN,2,5^FDLA,${VERIFIED_727}^FS`))
  assert.equal((result.zpl.match(/\^BQ/g) ?? []).length, 1)
  // Konum SABİT DEĞİL, DIŞ MARJ SİMETRİSİNDEN türetilir:
  //   QR sağ kenarı = labelEdge − DataMatrix dış sol marjı
  // Böylece alt bölümde DataMatrix ile QR dış boşlukları eşitlenir.
  const { SURAT_GRID } = await composer()
  const { fields } = (await parser()).resolveSuratSemanticModel(zpl)
  const expectedX =
    SURAT_GRID.labelEdge - fields.dataMatrixPayload.field.x - 105
  assert.equal(expectedX, 635, 'gerçek şablonda simetrik konum')
  assert.deepEqual(result.diagnostics.qrBox, { x: expectedX, y: 596, size: 105 })
  // QR'dan hemen önce kapsam ^BY'si yazılır (renderer sapmasını 10 dota sınırlar).
  assert.ok(result.zpl.includes(`^BY2,3,10^FO${expectedX},596^BQN,2,5`))
  // Uyuşmayan iki kaynak → QR YOK, composer yine çalışır.
  const clash = composeSuratDurusoftLabel(zpl, {
    cargoTrackingNumber: VERIFIED_727,
    ozelKargoTakipNo: '7279999999999',
  })
  assert.equal(clash.composed, true)
  assert.equal((clash.zpl.match(/\^BQ/g) ?? []).length, 0)
  assert.equal(clash.diagnostics.qrRejection, 'sources_disagree')
})

test('CF-31: transform whitelist — beklenmeyen mutasyon/silme YOK', async () => {
  const { composeSuratDurusoftLabel, diffZplAgainstSource } = await composer()
  const { parseZplDocument } = await model()
  const result = composeSuratDurusoftLabel(zpl, { cargoTrackingNumber: VERIFIED_727 })
  const diff = diffZplAgainstSource(
    parseZplDocument(zpl),
    parseZplDocument(result.zpl),
  )
  // SİLME SIFIR KALIR — taşıyıcı komutu ASLA kaldırılmaz.
  assert.equal(diff.removed.length, 0)
  // İZİNLİ MUTASYONLAR (whitelist): (1) Code128 yorum satırı bayrağı ve
  // (6) dikey alıcı başlığının GÖVDESİNİN boşaltılması. Başlık SİLİNMEZ,
  // yalnız `^FD` gövdesi boşaltılır — bu yüzden mutasyon, silme değil.
  assert.equal(diff.mutations.length, 2)
  const names = diff.mutations.map((mutation) => mutation.name).sort()
  assert.deepEqual(names, ['BC', 'FD'])
  const headingMutation = diff.mutations.find(
    (mutation) => mutation.name === 'FD',
  )
  assert.equal(headingMutation.to, '', 'başlık gövdesi BOŞALTILIR')
  assert.equal(result.diagnostics.diff.unexpectedMutations, 0)
  assert.equal(result.diagnostics.diff.deletions, 0)
  assert.equal(result.diagnostics.diff.allowedMutations, 2)
})

test('CF-32: invariant doğrulayıcı BOZULMUŞ çıktıyı reddeder', async () => {
  const { composeSuratDurusoftLabel, verifySuratOutputInvariants } = await composer()
  const { resolveSuratSemanticModel } = await parser()
  const semantic = resolveSuratSemanticModel(zpl)
  const good = composeSuratDurusoftLabel(zpl, { cargoTrackingNumber: VERIFIED_727 })
  assert.equal(
    verifySuratOutputInvariants(semantic, good.zpl, VERIFIED_727).ok,
    true,
  )
  // T.No kurcalanmış çıktı REDDEDİLİR.
  const tampered = good.zpl.replace('^FD63074185296307^FS', '^FD99999999999999^FS')
  const verdict = verifySuratOutputInvariants(semantic, tampered, VERIFIED_727)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /invariant BOZULDU: tNo/)
  // QR gövdesi kurcalanmış çıktı REDDEDİLİR.
  const badQr = good.zpl.replace(`LA,${VERIFIED_727}`, 'LA,7270000000000')
  assert.equal(
    verifySuratOutputInvariants(semantic, badQr, VERIFIED_727).ok,
    false,
  )
})

test('CF-33: sayfa sözleşmesi composed çıktıda korunur', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  const out = composeSuratDurusoftLabel(zpl, { cargoTrackingNumber: VERIFIED_727 }).zpl
  assert.equal((out.match(/\^XA/g) ?? []).length, 1)
  assert.equal((out.match(/\^XZ/g) ?? []).length, 1)
  assert.equal((out.match(/\^PW799/g) ?? []).length, 1)
  assert.equal((out.match(/\^LL0799/g) ?? []).length, 1)
  assert.equal((out.match(/\^PQ1,0,1,Y/g) ?? []).length, 1)
})

test('CF-34: augmentation zinciri iki sözleşmeyi AYIRIR', async () => {
  const { deriveAugmentedSuratZpl } = await augment()
  const items = [{ productName: 'Ornek Urun', quantity: 1, sku: 'SKU-1' }]

  // compose verilmezse davranış ESKİSİYLE AYNI (RT-10A sözleşmesi).
  const legacy = deriveAugmentedSuratZpl(zpl, items)
  assert.equal(legacy.renderContract, 'official_augmented')
  assert.equal(legacy.composeMode, null)
  assert.ok(legacy.printZpl.startsWith(zpl.slice(0, zpl.lastIndexOf('^PQ'))))

  // compose verilirse composed sözleşme (RT-10B).
  const composed = deriveAugmentedSuratZpl(zpl, items, {
    compose: { cargoTrackingNumber: VERIFIED_727 },
  })
  assert.equal(composed.renderContract, 'durusoft_composed')
  assert.equal(composed.composeMode, 'durusoft_composed')
  assert.equal(composed.sourceZpl, zpl, 'kaynak alanı HAM kalır')
  assert.equal(composed.augmentationStatus, 'success')

  // Bilinmeyen şablonda composer fallback’e düşer, augmentation davranışı sürer.
  const unknown = deriveAugmentedSuratZpl('^XA^PW400^LL0400^FO1,1^FDx^FS^XZ', items, {
    compose: { cargoTrackingNumber: VERIFIED_727 },
  })
  assert.equal(unknown.renderContract, 'official_augmented')
  assert.equal(unknown.composeMode, 'fallback_unknown_template')
  assert.ok(unknown.composeReason)
  assert.equal(unknown.printZpl, unknown.sourceZpl, 'kaynak AYNEN kullanılır')
})

test('CF-35: ürün toplama — aynı ürün birleşir, varyantlar AYRI kalır', async () => {
  const { aggregateProductLineItems } = await load(
    '/src/utils/suratZplProductLine.ts')
  const same = aggregateProductLineItems([
    { productName: 'A Elbise', quantity: 1, color: 'Siyah', size: '38', sku: 'A-1' },
    { productName: 'A Elbise', quantity: 1, color: 'Siyah', size: '38', sku: 'A-1' },
  ])
  assert.equal(same.length, 1, 'aynı kimlik BİRLEŞİR')
  assert.equal(same[0].quantity, 2, '1x + 1x = 2x')

  const variants = aggregateProductLineItems([
    { productName: 'A Elbise', quantity: 1, color: 'Siyah', size: '38', sku: 'A-1' },
    { productName: 'A Elbise', quantity: 1, color: 'Siyah', size: '40', sku: 'A-2' },
    { productName: 'A Elbise', quantity: 1, color: 'Beyaz', size: '38', sku: 'A-3' },
  ])
  assert.equal(variants.length, 3, 'farklı beden/renk/SKU BİRLEŞMEZ')
  for (const item of variants) assert.equal(item.quantity, 1)
})

// ═══ QR ZORUNLULUĞU + ^BY DURUM İZOLASYONU ═══════════════════════════════

/** Aktarma merkezi metnini uzatarak QR bölgesini işgal eden kaynak üretir. */
function withLongTransferCenter(source, value) {
  const next = source.replace(
    /\^FT220,705\^A0N,70,50\^FH.\^FD[^^]*\^FS/,
    `^FT220,705^A0N,70,50^FH${BS}^FD${value}^FS`,
  )
  assert.notEqual(next, source, 'kurgu gerçek fixture ile eşleşmeli')
  return next
}

test('CF-36: GEÇERLİ 727 + QR çakışması → composer TÜMÜYLE reddeder', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  // 20 karakterlik aktarma merkezi adı QR'ın güvenli bölgesini yer.
  const crowded = withLongTransferCenter(zpl, 'ISTANBUL ANADOLU AKTARMA MERKEZI')
  const result = composeSuratDurusoftLabel(crowded, {
    cargoTrackingNumber: VERIFIED_727,
  })

  // QR'sız KISMİ DuruSoft etiketi ÜRETİLMEZ.
  assert.equal(result.composed, false)
  assert.equal(result.mode, 'fallback_geometry_failure')
  assert.match(result.reason, /qrRejection=geometry_conflict/)
  assert.equal(result.diagnostics, null)

  // Çıktı kaynağın AYNISI: hiçbir yarım dönüşüm sızmaz.
  assert.equal(result.zpl, crowded)
  assert.equal((result.zpl.match(/\^BQ/g) ?? []).length, 0, 'QR yok')
  assert.ok(result.zpl.includes('^BCN,,Y,N'), 'dahili yorum satırı AÇIK kalır')
  assert.equal(result.zpl.includes('^BCN,,N,N'), false)
  assert.equal(result.zpl.includes('^FT63,417^A@N'), false, 'bold adres yok')
  assert.equal(result.zpl.includes('^FB'), false, 'barkod insan metni yok')

  // Teşhis hassas QR değerini SIZDIRMAZ.
  assert.equal(result.reason.includes(VERIFIED_727), false)
})

test('CF-37: çakışma durumunda augmentation zinciri RT-10A sözleşmesine döner', async () => {
  const { deriveAugmentedSuratZpl } = await augment()
  const crowded = withLongTransferCenter(zpl, 'ISTANBUL ANADOLU AKTARMA MERKEZI')
  const derived = deriveAugmentedSuratZpl(
    crowded,
    [{ productName: 'Ornek Urun', quantity: 1, sku: 'SKU-1' }],
    { compose: { cargoTrackingNumber: VERIFIED_727 } },
  )
  assert.equal(derived.renderContract, 'official_augmented')
  assert.equal(derived.composeMode, 'fallback_geometry_failure')
  assert.ok(derived.composeReason)
  // RT-10A sözleşmesi: kaynak çıktının BAYT ÖNEKİ.
  assert.ok(derived.printZpl.startsWith(crowded.slice(0, crowded.lastIndexOf('^PQ'))))
  assert.equal(derived.augmentationStatus, 'success', 'ürün footer’ı yine eklenir')
  assert.equal((derived.printZpl.match(/\^BQ/g) ?? []).length, 0)
  assert.ok(derived.printZpl.includes('^BCN,,Y,N'))
})

test('CF-38: 727 YOK/GEÇERSİZ ise mevcut iş kuralı korunur (composed sürer)', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  // Çakışma OLMAYAN kaynakta 727 yoksa composed mod çalışır, QR basılmaz.
  for (const [label, input, rejection] of [
    ['aday yok', {}, 'no_candidate'],
    ['geçersiz biçim', { cargoTrackingNumber: '1141234567890' }, 'invalid_format'],
    [
      'kaynaklar çelişiyor',
      { cargoTrackingNumber: VERIFIED_727, ozelKargoTakipNo: '7279999999999' },
      'sources_disagree',
    ],
  ]) {
    const result = composeSuratDurusoftLabel(zpl, input)
    assert.equal(result.composed, true, `${label}: composed sürmeli`)
    assert.equal(result.diagnostics.qrRejection, rejection, label)
    assert.equal(result.diagnostics.qrBox, null)
    assert.equal((result.zpl.match(/\^BQ/g) ?? []).length, 0, label)
  }
  // 727 YOKKEN aktarma metni uzun olsa bile composed mod ENGELLENMEZ:
  // QR zaten üretilmeyecektir, geometri çakışması doğmaz.
  const crowded = withLongTransferCenter(zpl, 'ISTANBUL ANADOLU AKTARMA MERKEZI')
  const noQr = composeSuratDurusoftLabel(crowded, {})
  assert.equal(noQr.composed, true)
  assert.equal(noQr.diagnostics.qrRejection, 'no_candidate')
})

test('CF-39: ^BY durumu QR’dan sonra GERİ YÜKLENİR (sızıntı yok)', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  const { parseZplDocument } = await model()
  const result = composeSuratDurusoftLabel(zpl, { cargoTrackingNumber: VERIFIED_727 })

  const sourceBy = parseZplDocument(zpl).commands.filter((c) => c.name === 'BY')
  const outputBy = parseZplDocument(result.zpl).commands.filter((c) => c.name === 'BY')
  // Kaynakta 2 (^BY128,128 DataMatrix, ^BY4,3,143 Code128).
  assert.deepEqual(
    sourceBy.map((c) => c.args.trim()),
    ['128,128', '4,3,143'],
  )
  // Çıktıda +2: geçici varsayılan ve ÖNCEKİ durumun geri yüklenmesi.
  assert.deepEqual(
    outputBy.map((c) => c.args.trim()),
    ['128,128', '4,3,143', '2,3,10', '4,3,143'],
  )
  // Geri yüklenen değer KÖR SABİT değil, kaynaktaki SON ^BY ile aynı.
  assert.equal(
    outputBy[outputBy.length - 1].args,
    sourceBy[sourceBy.length - 1].args,
    'QR sonrası durum QR öncesiyle BİREBİR aynı',
  )
  // Geçici durum yalnız QR alanını sarar.
  const { x: qrX, y: qrY } = result.diagnostics.qrBox
  assert.ok(result.zpl.includes(`^BY2,3,10^FO${qrX},${qrY}^BQN,2,5`))
  assert.ok(
    result.zpl.includes(`^FDLA,${VERIFIED_727}^FS^BY4,3,143`),
    'geri yükleme QR alanının HEMEN ardından',
  )

  // Taşıyıcı barkodlarının kendi ^BY’leri ve gövdeleri DEĞİŞMEDİ.
  assert.ok(result.zpl.includes('^BY4,3,143^FT48,300^BCN,,N,N'))
  assert.ok(result.zpl.includes('^BY128,128^FT59,706^BXN,8,200,0,0,1,~'))
  assert.ok(result.zpl.includes('^FD>:18529630741^FS'))
  assert.ok(result.zpl.includes('^FD41852963074-R529-3074^FS'))
})

test('CF-40: fark raporu mutasyon / ekleme / silme AYRI verir', async () => {
  const { composeSuratDurusoftLabel } = await composer()
  const result = composeSuratDurusoftLabel(zpl, { cargoTrackingNumber: VERIFIED_727 })
  const { diff } = result.diagnostics
  assert.equal(diff.deletions, 0, 'taşıyıcı komutu SİLİNMEZ')
  assert.equal(diff.unexpectedMutations, 0)
  // İzinli mutasyonlar: ^BC yorum bayrağı + dikey alıcı başlığının
  // gövdesinin boşaltılması. İkisi de whitelist'te AÇIKÇA tanımlı.
  assert.equal(diff.allowedMutations, 2, '^BC bayrağı + başlık gövdesi')
  assert.equal(diff.mutations, 2)
  assert.ok(diff.insertions > 0, 'yeni alanlar eklenir')
  // Ekleme bileşimi: barkod metni + bold adres vuruşları + QR durum/QR.
  assert.equal(
    result.zpl.includes('^FO48,306^A0N,20,20^FB448,1,0,C^FD18529630741^FS'),
    true,
  )
  assert.equal(result.diagnostics.boldAddressLines, 2)
  assert.ok(result.diagnostics.qrBox)
})
