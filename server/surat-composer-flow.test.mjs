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
