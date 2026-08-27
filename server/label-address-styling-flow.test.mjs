import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ ADRES SUNUMU — KODSUZ, GÜVENLİ, GERİ ALINABİLİR ════════════════════
//
// Müşteri "adresi büyüt / kalınlaştır / satır aralığını aç" diyebilmeli.
// Ama adres, etiketin EN DAR bandındadır: hemen altında rota kutusu,
// DataMatrix ve aktarma satırı vardır. Puntoyu körlemesine büyütmek adresi
// makine-okunur alanların üzerine bindirir ve etiketi TARANAMAZ yapar.
//
// Bu dosya iki şeyi birden kanıtlar:
//   1. İstenen özelleştirmeler GERÇEKTEN çıktıyı değiştiriyor.
//   2. Güvenlik sınırları AŞILAMIYOR ve sessizce kırpılmıyor.
//
// TAŞIYICI ÇAĞRISI YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

const REAL_ZPL = readFileSync(
  join(here, 'fixtures', 'surat-real-success-11415535074.zpl'),
  'utf8',
)

// Gerçek etiketten ÖLÇÜLEN adres bandı: adres satırları 417..458
// arasındadır ve bir sonraki taşıyıcı içeriği 476'da başlar.
const BAND = { left: 63, right: 700, top: 400, bottom: 470 }

// Korunan alanlar (barkod bandı ve alt makine-okunur bölge).
const PROTECTED = [
  { left: 48, top: 120, right: 700, bottom: 300 },
  { left: 48, top: 476, right: 775, bottom: 780 },
]

const ADDRESS = [
  'Ornek Mahallesi Ornek Caddesi No 12 Daire 3',
  'Kadikoy Istanbul',
]

const escape = (value) => value

test('ADDR-1: VARSAYILAN adres bugunku ciktiyla ayni sekilde yerlesir', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  const layout = mod.resolveAddressBlockLayout({
    lines: ADDRESS, band: BAND, protectedBoxes: PROTECTED,
  })
  assert.equal(layout.ok, true, layout.message ?? '')
  // Varsayilan punto tasiyicinin bugunku adres yuksekligiyle ayni (16 dot).
  assert.equal(mod.DEFAULT_ADDRESS_STYLE.fontSize, 16)
  for (const line of layout.placements) {
    assert.equal(line.fontHeight, 16)
    assert.equal(line.x, BAND.left, 'varsayilan hizalama SOL')
  }
  const commands = mod.buildAddressZplCommands(layout, { escape })
  assert.ok(commands.length > 0)
  assert.ok(commands.every((command) => command.includes('^A0N,16,')))
})

test('ADDR-2: BUYUK punto ciktiyi GERCEKTEN degistirir', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  const small = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { fontSize: 16, maxLines: 4 },
    band: BAND, protectedBoxes: PROTECTED,
  })
  const large = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { fontSize: 24, maxLines: 4 },
    band: BAND, protectedBoxes: PROTECTED,
  })
  assert.equal(small.ok, true, small.message ?? '')
  assert.equal(large.ok, true, large.message ?? '')

  const smallZpl = mod.buildAddressZplCommands(small, { escape }).join('\n')
  const largeZpl = mod.buildAddressZplCommands(large, { escape }).join('\n')
  assert.notEqual(smallZpl, largeZpl, 'punto degisti ama CIKTI ayni!')
  assert.ok(largeZpl.includes('^A0N,24,'))
  // Buyuk punto DAHA COK dikey alan ister.
  assert.ok(large.requiredHeight > small.requiredHeight)
})

test('ADDR-3: KALIN adres ciktiyi degistirir (ikinci vurus)', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  const plain = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { bold: false }, band: BAND, protectedBoxes: PROTECTED,
  })
  const bold = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { bold: true }, band: BAND, protectedBoxes: PROTECTED,
  })
  const plainZpl = mod.buildAddressZplCommands(plain, { escape })
  const boldZpl = mod.buildAddressZplCommands(bold, { escape })
  // Kalin = ayni metnin +1 dot kaydirilmis IKINCI vurusu; yeni font indirilmez.
  assert.equal(boldZpl.length, plainZpl.length * 2)
  assert.ok(!boldZpl.join('\n').includes('^CW'), 'yeni font yuklenmis!')
})

test('ADDR-4: UZUN adres KELIME sinirinda sarar, kirpilmaz', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  const long = [
    'Cumhuriyet Mahallesi Sehit Ogretmen Fahrettin Sokak '
      + 'Yesilvadi Sitesi B Blok Kat 4 Daire 17',
    'Atasehir Istanbul',
  ]
  // ÖLÇÜM: bu adres 16 dot puntoda 499 dot sürer ve 637 dot'luk banda
  // TEK SATIRDA sığar (A0 glif ilerlemeleri karakter başına 1 punto
  // DEĞİLDİR). Sarmayı gerçekten zorlamak için punto büyütülür.
  const layout = mod.resolveAddressBlockLayout({
    lines: long, style: { fontSize: 24, maxLines: 6 },
    band: { ...BAND, bottom: 560 }, protectedBoxes: [],
  })
  assert.equal(layout.ok, true, layout.message ?? '')
  assert.ok(layout.lineCount > 2, `sarma olmadi (${layout.lineCount} satir)`)

  // HICBIR KELIME KAYBOLMAZ: sarilmis metinlerin birlesimi kaynagi icerir.
  const joined = layout.placements.map((line) => line.text).join(' ')
  for (const word of long.join(' ').split(' ')) {
    assert.ok(joined.includes(word), `kelime kayboldu: ${word}`)
  }
  // Kirpma isareti YOK.
  assert.ok(!joined.includes('…') && !joined.includes('...'))
})

test('ADDR-5: SIGMAYAN adres AKTIVE EDILMEDEN once REDDEDILIR', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  const layout = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { fontSize: 48, maxLines: 6 },
    band: BAND, protectedBoxes: PROTECTED,
  })
  assert.equal(layout.ok, false)
  assert.equal(layout.placements.length, 0, 'sessizce yarim basilmis!')
  assert.ok(
    ['EXCEEDS_BAND_HEIGHT', 'TOO_MANY_LINES', 'EXCEEDS_BAND_WIDTH']
      .includes(layout.rejection),
    layout.rejection,
  )
  // Operatore ACIK ve TURKCE bir sebep gosterilir.
  assert.match(layout.message, /sığmıyor|küçült|azalt/)
  // Sessiz KUCULTME de yok: istenen punto DUSURULMEZ, yerlesim reddedilir.
  assert.ok(layout.requiredHeight === 0 || layout.requiredHeight > layout.availableHeight)
})

test('ADDR-6: adres KORUNAN alanlarin uzerine BINEMEZ', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  // Bant kasitli olarak barkod bandinin uzerine tasar.
  const layout = mod.resolveAddressBlockLayout({
    lines: ADDRESS,
    style: { fontSize: 20, maxLines: 4 },
    band: { left: 63, right: 700, top: 200, bottom: 320 },
    protectedBoxes: PROTECTED,
  })
  assert.equal(layout.ok, false)
  assert.equal(layout.rejection, 'OVERLAPS_PROTECTED_ELEMENT')
  assert.match(layout.message, /barkod|taranamaz/)
  assert.equal(layout.placements.length, 0)
})

test('ADDR-7: adres SUNUMU degistirmek TASIYICI cagrisi URETMEZ', async () => {
  const source = readFileSync(
    join(here, '..', 'src', 'utils', 'labelAddressBlock.ts'), 'utf8',
  )
  // Yerlesim motoru SAF olmalidir: ag, DB veya tasiyici istemcisi YOK.
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'axios', 'services.asmx',
    'OrtakBarkodOlustur', 'drizzle', 'db.']) {
    assert.ok(!source.includes(forbidden), `adres motorunda ${forbidden}`)
  }
  const mod = await load('/src/utils/labelAddressBlock.ts')
  const fetchSpy = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('olmamali') }
  try {
    for (const fontSize of [14, 18, 22]) {
      mod.resolveAddressBlockLayout({
        lines: ADDRESS, style: { fontSize }, band: BAND, protectedBoxes: PROTECTED,
      })
    }
  } finally {
    globalThis.fetch = fetchSpy
  }
  assert.equal(calls, 0)
})

test('ADDR-8: RAW_SURAT_FALLBACK artefakti BAYT BAYT degismez', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')

  // Ham mod: adres motoru DEVREDE DEGILDIR.
  assert.equal(mod.DEFAULT_ADDRESS_STYLE.visible, true)
  const before = augment.deriveAugmentedSuratZpl(REAL_ZPL, [])
  // Kaynak artefakt HER KOSULDA korunur.
  assert.equal(before.sourceZpl, REAL_ZPL)

  // Adres sunumu degistirilse bile KAYNAK ZPL'e dokunulmaz.
  for (const fontSize of [14, 20, 28]) {
    mod.resolveAddressBlockLayout({
      lines: ADDRESS, style: { fontSize }, band: BAND, protectedBoxes: PROTECTED,
    })
  }
  const after = augment.deriveAugmentedSuratZpl(REAL_ZPL, [])
  assert.equal(after.sourceZpl, REAL_ZPL)
  assert.equal(after.sourceZpl, before.sourceZpl)
  assert.equal(after.printZplSourceSha256 ?? null, before.printZplSourceSha256 ?? null)
})

test('ADDR-9: Kiraci A stili Kiraci B etiketini ETKILEMEZ', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  // Motor SAF ve DURUMSUZDUR: iki kiracinin ayari birbirine sizamaz.
  const tenantA = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { fontSize: 22, bold: true, align: 'center' },
    band: BAND, protectedBoxes: PROTECTED,
  })
  const tenantB = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { fontSize: 16, bold: false, align: 'left' },
    band: BAND, protectedBoxes: PROTECTED,
  })
  assert.equal(tenantA.ok, true, tenantA.message ?? '')
  assert.equal(tenantB.ok, true, tenantB.message ?? '')
  assert.equal(tenantA.placements[0].fontHeight, 22)
  assert.equal(tenantB.placements[0].fontHeight, 16)
  assert.equal(tenantB.placements[0].bold, false)
  assert.equal(tenantB.placements[0].x, BAND.left)

  // A'yi TEKRAR hesapla: B'nin arasina girmesi sonucu DEGISTIRMEZ.
  const tenantAAgain = mod.resolveAddressBlockLayout({
    lines: ADDRESS, style: { fontSize: 22, bold: true, align: 'center' },
    band: BAND, protectedBoxes: PROTECTED,
  })
  assert.deepEqual(tenantAAgain.placements, tenantA.placements)
})

test('ADDR-10: kiraci girdisi GUVENLI araliga indirgenir', async () => {
  const mod = await load('/src/utils/labelAddressBlock.ts')
  // Absurt degerler REDDEDILMEZ, KISILIR — ama okunabilirlik tabani korunur.
  const huge = mod.normalizeAddressStyle({ fontSize: 999, maxLines: 99, lineHeight: 9 })
  assert.equal(huge.fontSize, mod.ADDRESS_STYLE_LIMITS.maxFontSize)
  assert.equal(huge.maxLines, mod.ADDRESS_STYLE_LIMITS.maxMaxLines)
  assert.equal(huge.lineHeight, mod.ADDRESS_STYLE_LIMITS.maxLineHeight)
  const tiny = mod.normalizeAddressStyle({ fontSize: 1, maxLines: 0 })
  assert.equal(tiny.fontSize, mod.ADDRESS_STYLE_LIMITS.minFontSize)
  assert.equal(tiny.maxLines, mod.ADDRESS_STYLE_LIMITS.minMaxLines)
  // Bozuk hizalama varsayilana duser.
  assert.equal(mod.normalizeAddressStyle({ align: 'diagonal' }).align, 'left')
})
