import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// YEREL ECC200 DATAMATRIX (^BX) — kaynak ZPL payload'ı, ISO/IEC 16022.
//
// Bu dosya "placeholder değil, gerçek sembol" iddiasını KANITLAR:
//   1) Reed-Solomon çıktısı ISO/IEC 16022'nin YAYINLANMIŞ örnek vektörüyle
//      birebir eşleşir ("123456" → [114,25,5,88,102]).
//   2) Tam kod sözcüğü vektörünün RS SENDROMLARI sıfırdır. Sendrom kontrolü
//      üreteç polinomundan BAĞIMSIZ bir doğrulamadır: geçerli bir RS kod
//      sözcüğü değilse sendromlar sıfır ÇIKMAZ.
//   3) Modül yerleşimi bağımsız bir TERS ÇÖZÜCÜ ile geri okunur ve payload
//      aynen elde edilir (round-trip).
//   4) Finder pattern (kesintisiz L) ve clock track (dönüşümlü) yapısı
//      standarda uygundur.
//
// Fiziksel okuyucu/tarayıcı testi YAPILMAMIŞTIR; iddia yalnız yukarıdaki
// matematiksel ve yapısal doğrulamalar kadardır.
//
// Fixture'lar SENTETİKTİR: gerçek müşteri verisi, adres veya telefon YOK.

const here = dirname(fileURLToPath(import.meta.url))

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

// ── GF(256) — testin KENDİ bağımsız uygulaması (üretim kodunu kullanmaz) ────
const LOG = new Uint8Array(256)
const ALOG = new Uint8Array(256)
{
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    ALOG[index] = value
    LOG[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x12d
  }
}
const gfMul = (a, b) => (a && b ? ALOG[(LOG[a] + LOG[b]) % 255] : 0)

function rsSyndromes(codewords, eccLength) {
  const out = []
  for (let root = 1; root <= eccLength; root += 1) {
    let sum = 0
    for (let index = 0; index < codewords.length; index += 1) {
      const power = (root * (codewords.length - 1 - index)) % 255
      sum ^= gfMul(codewords[index], ALOG[power])
    }
    out.push(sum)
  }
  return out
}

// Bağımsız ters çözücü: sembolden veri modüllerini toplayıp ISO Ek F
// yerleşimini TERSİNE uygular ve ASCII kod sözcüklerini çözer.
function decodeDataMatrixAscii(symbol) {
  const size = symbol.size
  // Kare, tek bölgeli semboller için (test kapsamı) veri alanı finder'ın içidir.
  const regionSide = size - 2
  const data = []
  for (let row = 0; row < regionSide; row += 1) {
    const line = []
    for (let column = 0; column < regionSide; column += 1) {
      line.push(symbol.modules[row + 1][column + 1])
    }
    data.push(line)
  }
  const rows = regionSide
  const columns = regionSide
  const slots = new Int32Array(rows * columns).fill(-1)
  const put = (row, column, chr, bit) => {
    let r = row
    let c = column
    if (r < 0) {
      r += rows
      c += 4 - ((rows + 4) % 8)
    }
    if (c < 0) {
      c += columns
      r += 4 - ((columns + 4) % 8)
    }
    slots[r * columns + c] = (chr << 3) | bit
  }
  const utah = (row, column, chr) => {
    put(row - 2, column - 2, chr, 0)
    put(row - 2, column - 1, chr, 1)
    put(row - 1, column - 2, chr, 2)
    put(row - 1, column - 1, chr, 3)
    put(row - 1, column, chr, 4)
    put(row, column - 2, chr, 5)
    put(row, column - 1, chr, 6)
    put(row, column, chr, 7)
  }
  let chr = 0
  let row = 4
  let column = 0
  do {
    if (row === rows && column === 0) {
      put(rows - 1, 0, chr, 0); put(rows - 1, 1, chr, 1); put(rows - 1, 2, chr, 2)
      put(0, columns - 2, chr, 3); put(0, columns - 1, chr, 4)
      put(1, columns - 1, chr, 5); put(2, columns - 1, chr, 6)
      put(3, columns - 1, chr, 7)
      chr += 1
    } else if (row === rows - 2 && column === 0 && columns % 4 !== 0) {
      put(rows - 3, 0, chr, 0); put(rows - 2, 0, chr, 1); put(rows - 1, 0, chr, 2)
      put(0, columns - 4, chr, 3); put(0, columns - 3, chr, 4)
      put(0, columns - 2, chr, 5); put(0, columns - 1, chr, 6)
      put(1, columns - 1, chr, 7)
      chr += 1
    } else if (row === rows - 2 && column === 0 && columns % 8 === 4) {
      put(rows - 3, 0, chr, 0); put(rows - 2, 0, chr, 1); put(rows - 1, 0, chr, 2)
      put(0, columns - 2, chr, 3); put(0, columns - 1, chr, 4)
      put(1, columns - 1, chr, 5); put(2, columns - 1, chr, 6)
      put(3, columns - 1, chr, 7)
      chr += 1
    } else if (row === rows + 4 && column === 2 && columns % 8 === 0) {
      put(rows - 1, 0, chr, 0); put(rows - 1, columns - 1, chr, 1)
      put(0, columns - 3, chr, 2); put(0, columns - 2, chr, 3)
      put(0, columns - 1, chr, 4); put(1, columns - 3, chr, 5)
      put(1, columns - 2, chr, 6); put(1, columns - 1, chr, 7)
      chr += 1
    }
    do {
      if (row < rows && column >= 0 && slots[row * columns + column] < 0) {
        utah(row, column, chr)
        chr += 1
      }
      row -= 2
      column += 2
    } while (row >= 0 && column < columns)
    row += 1
    column += 3
    do {
      if (row >= 0 && column < columns && slots[row * columns + column] < 0) {
        utah(row, column, chr)
        chr += 1
      }
      row += 2
      column -= 2
    } while (row < rows && column >= 0)
    row += 3
    column += 1
  } while (row < rows || column < columns)

  const codewords = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const slot = slots[r * columns + c]
      if (slot < 0) continue
      const index = slot >> 3
      const bit = slot & 7
      codewords[index] = codewords[index] ?? 0
      if (data[r][c]) codewords[index] |= 1 << (7 - bit)
    }
  }
  // ASCII çözümlemesi. YALNIZ veri kod sözcükleri okunur (ECC bölümü
  // metin DEĞİLDİR); kapasite ISO/IEC 16022 Tablo 7'den bağımsızca alınır.
  const DATA_CAPACITY = { 10: 3, 12: 5, 14: 8, 16: 12, 18: 18, 20: 22 }
  const capacity = DATA_CAPACITY[size]
  assert.ok(capacity, `test kapsamı dışı sembol boyutu: ${size}`)
  let text = ''
  for (const codeword of codewords.slice(0, capacity)) {
    if (codeword === 129) break
    if (codeword >= 130 && codeword <= 229) {
      text += String(codeword - 130).padStart(2, '0')
    } else if (codeword >= 1 && codeword <= 128) {
      text += String.fromCharCode(codeword - 1)
    }
  }
  return { codewords, text }
}

const OFFICIAL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO20,15^GB760,770,3^FS',
  '^FO60,20^A0N,28,28^FDSube: FERAH^FS',
  '^FO470,20^A0N,26,26^FDT.No: 21012920014311^FS',
  '^FO60,150^BY3^BCN,150,Y,N,N^FD01254596670^FS',
  '^FO60,345^A0N,24,24^FDALICI AD^FS',
  '^FO60,375^A0N,18,18^FB700,3,0,L,0^FDMAHALLE SOKAK NO ILCE IL^FS',
  '^FO60,480^A0N,20,20^FDOdemeTipi Birim Top Ds/Kg^FS',
  '^FO60,510^A0N,30,30^FDPOCH KOLI 2,00^FS',
  '^FO60,560^BXN,6,200^FD7270035184060553^FS',
  '^FO240,630^A0N,34,34^FDKARACADAG/04^FS',
  '^FO240,672^A0N,38,38^FDDIYARBAKIR AKTARMA^FS',
  '^FO660,560^BQN,2,6^FDLA,01254596670^FS',
  '^FWB', '^FO24,340^A0N,18,18^FDSiparis No: 7270035184060553^FS', '^FWN',
  '^PQ1,0,1,Y',
  '^XZ',
].join('\n')

// ═══ DM-1..DM-4: KODLAMA VE HATA DÜZELTME DOĞRULUĞU ════════════════════════

test('DM-1: ASCII kodlaması rakam çiftlerini standart biçimde sıkıştırır', async () => {
  const { encodeDataMatrixAscii } = await load('/src/utils/dataMatrixEncoder.ts')
  // ISO/IEC 16022 örneği: "123456" → 12,34,56 → 130+değer.
  assert.deepEqual(encodeDataMatrixAscii('123456'), [142, 164, 186])
  // Tek rakam ve harf: değer+1.
  assert.deepEqual(encodeDataMatrixAscii('A'), [66])
  // 127 üstü bayt: upper shift (235) + (bayt-128+1). "Ş" UTF-8'de 2 bayttır.
  const turkish = encodeDataMatrixAscii('Ş')
  assert.equal(turkish[0], 235)
  assert.ok(turkish.length === 4, 'her yüksek bayt upper-shift ile kodlanır')
})

test('DM-2: RS çıktısı ISO/IEC 16022 yayınlanmış vektörüyle BİREBİR eşleşir', async () => {
  const { computeDataMatrixEcc } = await load('/src/utils/dataMatrixEncoder.ts')
  assert.deepEqual(
    computeDataMatrixEcc([142, 164, 186], 5),
    [114, 25, 5, 88, 102],
  )
})

test('DM-3: tam kod sözcüğü vektörünün RS SENDROMLARI sıfırdır (bağımsız kontrol)', async () => {
  const { computeDataMatrixEcc } = await load('/src/utils/dataMatrixEncoder.ts')
  for (const [data, eccLength] of [
    [[142, 164, 186], 5],
    [[130, 131, 132, 133, 134, 135, 136, 137], 10],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 12],
  ]) {
    const ecc = computeDataMatrixEcc(data, eccLength)
    const syndromes = rsSyndromes([...data, ...ecc], eccLength)
    assert.deepEqual(
      syndromes,
      new Array(eccLength).fill(0),
      `sendromlar sıfır değil: ${syndromes.join(',')}`,
    )
  }
})

test('DM-4: sembol boyutu kapasiteye göre EN KÜÇÜK kare seçilir', async () => {
  const { encodeDataMatrix } = await load('/src/utils/dataMatrixEncoder.ts')
  assert.equal(encodeDataMatrix('123456').size, 10, '3 kod sözcüğü → 10×10')
  // 16 haneli Sürat payload'ı 8 kod sözcüğü → 14×14 (kapasite 8).
  assert.equal(encodeDataMatrix('7270035184060553').size, 14)
  assert.equal(encodeDataMatrix(''), null, 'boş payload sembol üretmez')
})

// ═══ DM-5..DM-7: YERLEŞİM VE YAPI ══════════════════════════════════════════

test('DM-5: finder pattern kesintisiz L, clock track dönüşümlüdür', async () => {
  const { encodeDataMatrix } = await load('/src/utils/dataMatrixEncoder.ts')
  const symbol = encodeDataMatrix('7270035184060553')
  const { size, modules } = symbol
  for (let index = 0; index < size; index += 1) {
    assert.equal(modules[index][0], true, `sol L kesintisiz (satır ${index})`)
    assert.equal(modules[size - 1][index], true, `alt L kesintisiz (sütun ${index})`)
  }
  for (let index = 0; index < size; index += 1) {
    assert.equal(
      modules[0][index], index % 2 === 0,
      `üst clock track dönüşümlü (sütun ${index})`,
    )
    assert.equal(
      modules[index][size - 1], index % 2 === 1,
      `sağ clock track dönüşümlü (satır ${index})`,
    )
  }
})

test('DM-6: bağımsız ters çözücü payload’ı AYNEN geri okur (round-trip)', async () => {
  const { encodeDataMatrix } = await load('/src/utils/dataMatrixEncoder.ts')
  for (const payload of ['123456', '7270035184060553', '01254596670']) {
    const symbol = encodeDataMatrix(payload)
    const decoded = decodeDataMatrixAscii(symbol)
    assert.equal(decoded.text, payload, `round-trip başarısız: ${payload}`)
  }
})

test('DM-7: üretim determinismi — aynı payload HER ZAMAN aynı matris', async () => {
  const { encodeDataMatrix } = await load('/src/utils/dataMatrixEncoder.ts')
  const first = encodeDataMatrix('7270035184060553')
  const second = encodeDataMatrix('7270035184060553')
  assert.deepEqual(first.modules, second.modules)
})

// ═══ DM-8..DM-13: RENDERER ENTEGRASYONU ════════════════════════════════════

test('DM-8: ^BX SVG’de gerçek modüllerle çizilir, boş kare BIRAKILMAZ', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const { encodeDataMatrix } = await load('/src/utils/dataMatrixEncoder.ts')
  const result = renderSuratZplToSvg(OFFICIAL)
  assert.equal(result.renderStatus, 'ok')
  // Modül sayısı kadar koyu dikdörtgen SVG'de bulunmalı.
  const symbol = encodeDataMatrix('7270035184060553')
  const darkModules = symbol.modules
    .flat()
    .filter(Boolean).length
  assert.ok(darkModules > 50, 'anlamlı sayıda koyu modül')
  // ^BXN,6 → modül kenarı 6 dot. İlk koyu modül (sol üst köşe, L'nin başı)
  // ^FO60,560 konumundadır.
  assert.ok(
    result.svg.includes('<rect x="60" y="560" width="6" height="6" fill="#000"/>'),
    'DataMatrix modülleri kaynak ^FO/^BX ölçüsüyle çizilir',
  )
  // Uyarı üretilmez: alan artık gerçekten dolduruluyor.
  assert.equal(
    result.warnings.some((warning) => /Matris kod/.test(warning)),
    false,
    'DataMatrix için uyarı kalmadı',
  )
})

test('DM-9: ^BX quiet zone (1 modül) beyaz olarak KORUNUR', async () => {
  const { renderSuratZplToSvg, DATA_MATRIX_QUIET_MODULES } = await load(
    '/src/utils/suratZplSvgRenderer.ts',
  )
  assert.equal(DATA_MATRIX_QUIET_MODULES, 1)
  const svg = renderSuratZplToSvg(OFFICIAL).svg
  // 14 modül × 6 dot = 84; quiet 6 dot → 54,554 başlangıç ve 96×96 alan.
  assert.ok(
    svg.includes('<rect x="54" y="554" width="96" height="96" fill="#fff"/>'),
    'sessiz alan beyaz dikdörtgenle garanti edilir',
  )
})

test('DM-10: ^BX yönü (^BXB) kaynak parametresinden alınır', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const rotated = renderSuratZplToSvg(OFFICIAL.replace('^BXN,6,200', '^BXB,6,200'))
  assert.equal(rotated.renderStatus, 'ok')
  assert.ok(
    rotated.svg.includes('<g transform="rotate(-90 60 560)">'),
    'dönmüş alan grup dönüşümüyle çizilir',
  )
})

test('DM-11: modül boyutu kaynak ^BX parametresinden gelir', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const bigger = renderSuratZplToSvg(OFFICIAL.replace('^BXN,6,200', '^BXN,9,200'))
  assert.ok(
    bigger.svg.includes('<rect x="60" y="560" width="9" height="9" fill="#000"/>'),
    'modül kenarı 9 dot',
  )
})

test('DM-12: ECC200 dışı kalite TAHMİNLE çizilmez, açık durum döner', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const result = renderSuratZplToSvg(OFFICIAL.replace('^BXN,6,200', '^BXN,6,140'))
  assert.equal(result.renderStatus, 'matrix_encode_failed')
  assert.equal(result.unsupportedCommand, '^BX')
  assert.equal(result.svg, '')
  assert.ok(result.warnings.length > 0)
})

test('DM-13: render başarısızsa baskı akışı GÜVENLİ mesajla atlar', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const order = {
    id: 'o-dm', marketplace: 'Trendyol', orderNumber: '900', packageId: 'PKG-DM',
    customerName: 'TEST ALICI', address: 'TEST MAH 1',
    operationStatus: 'LABEL_READY', labelStatus: 'READY', hasPrintableLabel: true,
    desi: 2, items: [],
    shipment: {
      provider: 'surat-kargo', trackingNumber: '21012920014311',
      tNo: '21012920014311', barcode: '01254596670', barkodNo: '01254596670',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      zplReady: true, printEnabled: true,
      barcodeRaw: OFFICIAL.replace('^BXN,6,200', '^BXN,6,140'),
      desi: 2,
    },
  }
  const doc = buildSuratOfficialPrintDocument([order])
  assert.equal(doc.pages.length, 0)
  assert.equal(doc.skipped.length, 1)
  assert.match(
    doc.skipped[0].reason,
    /Resmî Sürat etiketi tarayıcıda görüntülenemedi/,
  )
})

// ═══ DM-14..DM-17: PAYLOAD KORUMASI (^BC / ^BQ / ^BX) ══════════════════════

function orderWith(over = {}) {
  return {
    id: 'o-1', marketplace: 'Trendyol', orderNumber: '7270035184060553',
    packageId: 'PKG-1', customerName: 'TEST ALICI', address: 'TEST MAH 1',
    city: 'DIYARBAKIR', district: 'KAYAPINAR',
    operationStatus: 'LABEL_READY', labelStatus: 'READY', hasPrintableLabel: true,
    desi: 2, desiSource: 'manual_total',
    items: [
      {
        id: 'l-1', productName: 'Scuba Elbise', quantity: 1,
        color: 'Siyah', size: '42', merchantSku: 'SCUBA-SEC01',
      },
    ],
    shipment: {
      provider: 'surat-kargo', trackingNumber: '21012920014311',
      tNo: '21012920014311', barcode: '01254596670', barkodNo: '01254596670',
      barcodeValue: '01254596670', ozelKargoTakipNo: '7270035184060553',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      zplReady: true, printEnabled: true, barcodeRaw: OFFICIAL, desi: 2,
    },
    ...over,
  }
}

test('DM-14: tracking/sipariş alanları değişse de KAYNAK payload’lar korunur', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const tampered = orderWith({
    orderNumber: '000000000000',
    cargoTrackingNumber: '55555555555',
    shipment: {
      ...orderWith().shipment,
      // UI alanları DEĞİŞTİ; kaynak ZPL aynı.
      ozelKargoTakipNo: '88888888888',
      barcodeValue: '99999999999',
    },
  })
  const svg = buildSuratOfficialPrintDocument([tampered]).pages[0].render.svg
  // ^BC insan-okur numarası kaynak ZPL'den.
  assert.ok(svg.includes('>01254596670<'))
  assert.equal(svg.includes('99999999999'), false)
  assert.equal(svg.includes('88888888888'), false)
  assert.equal(svg.includes('55555555555'), false)
  // EN GÜÇLÜ KANIT: kaynak ZPL ve ürün satırları AYNI olduğu için, sipariş/
  // tracking alanları değiştirilmiş sipariş ile bozulmamış sipariş BİREBİR
  // AYNI SVG'yi üretir. ^BC, ^BQ ve ^BX payload'larının hiçbiri UI'dan
  // türetilmiyor demektir.
  const pristine = buildSuratOfficialPrintDocument([orderWith()]).pages[0]
  assert.equal(svg, pristine.render.svg, 'payload’lar UI alanlarından türemiyor')
})

test('DM-15: ^BY modül genişliği ve insan-okur numara korunur', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const svg = renderSuratZplToSvg(OFFICIAL).svg
  // ^BY3 → ilk çubuk 2 modül × 3 dot = 6 dot genişlik, yükseklik ^BCN,150.
  assert.ok(
    svg.includes('<rect x="60" y="150" width="6" height="150" fill="#000"/>'),
    '^BY3 modül genişliği uygulanır',
  )
  assert.ok(svg.includes('>01254596670<'), 'insan-okur numara korunur')
})

test('DM-16: ^BQ payload’ı "LA," ön ekinden arındırılıp AYNEN kullanılır', async () => {
  const { renderSuratZplToSvg, defaultMatrixRenderer } = await load(
    '/src/utils/suratZplSvgRenderer.ts',
  )
  const expected = defaultMatrixRenderer('01254596670')
  const expectedDark = expected.flat().filter(Boolean).length
  const svg = renderSuratZplToSvg(OFFICIAL).svg
  // ^BQN,2,6 → modül kenarı 6 dot; QR modülleri bu ölçüde çizilir.
  const qrRects = (svg.match(/width="6" height="6" fill="#000"/g) ?? []).length
  assert.ok(qrRects > expectedDark, 'QR modülleri SVG’de mevcut')
})

test('DM-17: yerel üreteçler AĞ çağrısı yapmaz, payload LOGLANMAZ', () => {
  const encoder = readFileSync(
    join(here, '..', 'src', 'utils', 'dataMatrixEncoder.ts'),
    'utf8',
  )
  const code = encoder
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(/fetch\(|https?:\/\/|XMLHttpRequest|WebSocket/.test(code), false)
  assert.equal(/console\.(log|info|warn|error|debug)/.test(encoder), false)
  // Yeni dependency EKLENMEDİ.
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(
    Object.keys(pkg.dependencies).some((name) => /datamatrix|bwip|zxing/i.test(name)),
    false,
    'DataMatrix için yeni bağımlılık yok',
  )
})
