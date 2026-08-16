import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ÜRÜN FOOTER OKUNABİLİRLİĞİ + DİKEY "ALICI" BAŞLIĞININ KALDIRILMASI.
//
// FİZİKSEL REFERANS: kullanıcının 203 dpi Zebra çıktısı. DuruSoft'un ürün
// satırı İKİ SATIR ve belirgin daha büyük okunuyor; CargoFlow tek satıra
// sığdırıp küçültüyordu.
//
// KÖK NEDEN: profil merdiveninde `single-line-dense` (16 dot),
// `wrapped-compact`ten (18 dot, 2 satır) ÖNCE deneniyordu.
//
// Fixture MASKELİDİR; gerçek müşteri verisi içermez.

const here = dirname(fileURLToPath(import.meta.url))

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

const ZPL = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')

const item = (overrides = {}) => ({
  productName: 'Kadin Isil Tesettur Elbise Siyah',
  quantity: 1,
  color: 'Siyah',
  size: '38',
  sku: 'SCUBA-SEC01',
  ...overrides,
})

/** 203 dpi'de dot → mm (okunabilirlik kararı fiziksel boyuta dayanır). */
const mm = (dots) => Number(((dots / 203) * 25.4).toFixed(2))

async function planFor(items) {
  const { planSuratFooter } = await load('/src/utils/suratZplProductLine.ts')
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  return planSuratFooter(items, parseSuratZplGeometry(ZPL))
}

// ═══ FOOTER-READABILITY-1: KISA → EN BÜYÜK TEK SATIR ═════════════════════

test('FOOTER-READABILITY-1: kısa ürün → tek satır, en büyük font', async () => {
  const plan = await planFor([item({ productName: 'Elbise', sku: 'A1' })])
  assert.equal(plan.ok, true)
  assert.equal(plan.profile.maxLinesPerItem, 1)
  assert.ok(
    plan.profile.fontHeight >= 18,
    `kısa içerikte font >= 18 olmalı, ${plan.profile.fontHeight} geldi`,
  )
  assert.ok(mm(plan.profile.fontHeight) >= 2.2, 'fiziksel yükseklik >= 2,2 mm')
})

// ═══ FOOTER-READABILITY-2: ORTA (DuruSoft benzeri) ═══════════════════════

test('FOOTER-READABILITY-2: DuruSoft benzeri orta uzunluk → 20 dot, iki satır', async () => {
  // Fotoğraftaki CargoFlow satırıyla aynı uzunluk sınıfı (~76 karakter).
  // ESKİ davranış: 18 dot TEK satır (fiziksel olarak küçük kalıyordu).
  const plan = await planFor([item()])
  assert.equal(plan.ok, true)
  assert.equal(
    plan.profile.fontHeight,
    20,
    `referans görünüm 20 dot bekler, ${plan.profile.fontHeight} geldi`,
  )
  // KÜÇÜLTME DEĞİL SARMA.
  assert.equal(plan.profile.maxLinesPerItem, 2)
  assert.ok(mm(plan.profile.fontHeight) >= 2.4, 'fiziksel yükseklik >= 2,4 mm')
  assert.ok(plan.usedHeight <= plan.area.height, 'banda sığmalı')
})

// ═══ FOOTER-READABILITY-3: UZUN → SARILIR, TABAN KORUNUR ═════════════════

test('FOOTER-READABILITY-3: uzun ürün → iki satır, 16 dot tabanı korunur', async () => {
  const plan = await planFor([
    item({
      productName: 'Kadin Isiltili Uzun Kollu Tesettur Abiye Elbise Modeli Ozel Dikim',
      color: 'Lacivert',
      size: '42',
      sku: 'SCUBA-SEC01-LONG',
    }),
  ])
  assert.equal(plan.ok, true)
  // KÜÇÜLTME DEĞİL SARMA: iki satır kullanılır.
  assert.equal(plan.profile.maxLinesPerItem, 2)
  assert.ok(
    plan.profile.fontHeight >= 16,
    `uzun içerikte taban 16 dot, ${plan.profile.fontHeight} geldi`,
  )
  assert.ok(mm(plan.profile.fontHeight) >= 2.0, 'fiziksel taban >= 2,0 mm')
})

// ═══ FOOTER-READABILITY-4: PROFİL SIRASI + TAŞMA YOK ═════════════════════

test('FOOTER-READABILITY-4: sıra BÜYÜK FONT → WRAP → SHRINK; taşma yok', async () => {
  const { SURAT_FOOTER_PROFILES } = await load(
    '/src/utils/suratZplProductLine.ts',
  )
  const keys = SURAT_FOOTER_PROFILES.map((profile) => profile.key)
  // 18 dot'luk İKİ SATIR, 16 dot'luk TEK satırdan ÖNCE denenmeli.
  assert.ok(
    keys.indexOf('wrapped-compact') < keys.indexOf('single-line-dense'),
    'wrapped-compact (18 dot) single-line-dense (16 dot) ÖNCESİNDE olmalı',
  )
  // 16 dot tabanı, 14 ve altı son çare kademelerinden ÖNCE gelir.
  assert.ok(keys.indexOf('wrapped-dense') < keys.indexOf('wrapped-mid'))
  assert.ok(keys.indexOf('wrapped-dense') < keys.indexOf('single-line-micro'))
  // 20 dot iki satır, 18 dot tek satırdan ÖNCE denenmeli (referans görünüm).
  assert.ok(
    keys.indexOf('wrapped-standard') < keys.indexOf('single-line-compact'),
    'wrapped-standard (20 dot) single-line-compact (18 dot) ÖNCESİNDE olmalı',
  )

  // TAŞMA YOK: seçilen plan ayrılmış banda sığar.
  for (const items of [
    [item({ productName: 'Elbise' })],
    [item()],
    [item({ productName: 'A'.repeat(90) })],
    [item(), item({ sku: 'SCUBA-SEC02', size: '40' })],
  ]) {
    const plan = await planFor(items)
    if (!plan.ok) continue
    assert.ok(
      plan.usedHeight <= plan.area.height,
      `footer taşıyor: ${plan.usedHeight} > ${plan.area.height}`,
    )
    assert.ok(plan.area.height > 0 && plan.area.width > 0)
  }
})

// ═══ RECIPIENT-1/2: DİKEY "ALICI" BAŞLIĞI ════════════════════════════════

async function composed() {
  const { composeSuratDurusoftLabel } = await load(
    '/src/utils/suratDurusoftComposer.ts',
  )
  return composeSuratDurusoftLabel(ZPL, {
    cargoTrackingNumber: '7271234567890',
    ozelKargoTakipNo: '7271234567890',
  })
}

test('RECIPIENT-1: dikey başlık alanının gövdesi BOŞ, komut yapısı yerinde', async () => {
  const result = await composed()
  assert.equal(result.mode, 'durusoft_composed', result.reason ?? '')

  const { parseZplDocument, collectZplFields } = await load(
    '/src/utils/zplCommandModel.ts',
  )
  const findHeading = (zpl) =>
    collectZplFields(parseZplDocument(zpl)).find(
      (field) =>
        field.x === 54 &&
        field.y === 430 &&
        field.font?.orientation === 'B' &&
        field.font?.height === 23 &&
        field.font?.width === 24,
    )

  const before = findHeading(ZPL)
  assert.ok(before, 'kaynakta dikey başlık alanı bulunmalı')
  assert.ok(String(before.data ?? '').trim().length > 0, 'kaynakta gövde dolu')

  const after = findHeading(result.zpl)
  assert.ok(after, 'alan SİLİNMEMELİ (deletions=0 invariantı)')
  assert.equal(
    String(after.data ?? '').trim(),
    '',
    'başlık gövdesi BOŞALTILMALI',
  )
  // GERÇEK LİTERAL ile doğrulama: maskeli fixture'daki yer tutucu başka
  // alanlarda da geçebildiği için başlık gövdesine gerçek "ALICI" yazılır.
  const withLiteral = ZPL.replace(
    `^FD${before.data}^FS`,
    '^FDALICI^FS',
  )
  assert.ok(withLiteral.includes('^FDALICI^FS'), 'sentetik kaynak hazırlanmalı')
  const { composeSuratDurusoftLabel } = await load(
    '/src/utils/suratDurusoftComposer.ts',
  )
  const literalResult = composeSuratDurusoftLabel(withLiteral, {
    cargoTrackingNumber: '7271234567890',
    ozelKargoTakipNo: '7271234567890',
  })
  assert.equal(literalResult.mode, 'durusoft_composed', literalResult.reason ?? '')
  // KABUL KRİTERİ: literal "ALICI" hiçbir ^FD gövdesinde BASILMAZ.
  const bodies = Array.from(literalResult.zpl.matchAll(/\^FD([^]*?)\^FS/g)).map(
    (match) => match[1],
  )
  assert.equal(
    bodies.filter((body) => body.trim() === 'ALICI').length,
    0,
    'literal ALICI komutu KALMAMALI',
  )
})

test('RECIPIENT-2: alıcı adı/adres/telefon/il-ilçe KORUNUR', async () => {
  const result = await composed()
  const { extractSuratSemanticFields } = await load(
    '/src/utils/suratSemanticParser.ts',
  )
  const source = extractSuratSemanticFields(ZPL).fields
  const output = extractSuratSemanticFields(result.zpl).fields

  for (const key of [
    'recipient',
    'addressLine1',
    'addressLine2',
    'recipientPhone',
    'cityDistrict',
  ]) {
    assert.ok(output[key], `${key} alanı KAYBOLMAMALI`)
    assert.equal(
      output[key].raw,
      source[key].raw,
      `${key} gövdesi DEĞİŞMEMELİ`,
    )
  }
  // Taşıyıcı makine kodları da aynen korunur.
  for (const key of ['tNo', 'code128Payload', 'dataMatrixPayload']) {
    assert.equal(output[key].raw, source[key].raw, `${key} DEĞİŞMEMELİ`)
  }
})

// ═══ IMMUTABLE-1: KALICI ARTEFAKT YENİDEN COMPOSE EDİLMEZ ════════════════

test('IMMUTABLE-1: kalıcı artefakt baytları reprint sırasında DEĞİŞMEZ', async () => {
  const repo = await import('./shipments/printZplRepository.ts')
  const payload = {
    technicalZpl: ZPL,
    cargoTrackingNumber: '7271234567890',
    ozelKargoTakipNo: '7271234567890',
    orderNumber: '1141234567890',
    packageId: 'PKG-IMMUTABLE',
    aliciAdi: 'ARIFE BOLSAGAR',
  }
  const first = repo.attachPrintZplArtifact(
    payload,
    [item()],
    '2026-08-09T00:00:00.000Z',
  ).printZplArtifact

  // Kalıcı artefakt varsa okuma yolu onu AYNEN döndürür; composer ÇALIŞMAZ.
  const stored = repo.__testing.readPersisted({ printZplArtifact: first })
  assert.equal(stored.printZpl, first.printZpl)
  assert.equal(stored.printZplSha256, first.printZplSha256)
  // Yeni görünüm YALNIZ yeni üretilen artefaktlar içindir: aynı girdiyle
  // yeniden üretim deterministiktir, ama mevcut baytlar ezilmez.
  const again = repo.attachPrintZplArtifact(
    payload,
    [item()],
    '2026-08-09T00:00:00.000Z',
  ).printZplArtifact
  assert.equal(again.printZplSha256, first.printZplSha256)
})

// ═══ FOOTER-BOUND: GERÇEK RENDER EDİLMİŞ BANT SINIRI ═════════════════════
//
// Planner'ın soyut `area.height` değerine TEK BAŞINA güvenilmez. Aşağıdaki
// testler ÜRETİLEN ZPL komutlarından fiziksel kutuyu yeniden hesaplar.
//
// GERÇEK SÜRAT BANDI (799 × 799 fixture, ölçüldü):
//   x = 16 · width = 771 · top = 725 · bottom = 791 · height = 66 dot

const FOOTER_TOP = 725
const FOOTER_BOTTOM = 791
const FOOTER_HEIGHT = 66

/** Üretilen ^FO/^FB komutlarından GERÇEK fiziksel kutuyu çıkarır. */
async function renderedFooterBox(items) {
  const { planSuratFooter, buildFooterZplCommands } = await load(
    '/src/utils/suratZplProductLine.ts',
  )
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const plan = planSuratFooter(items, parseSuratZplGeometry(ZPL))
  if (!plan.ok) return { ok: false, reason: plan.reason }
  const commands = buildFooterZplCommands(plan, { utf8: true })
  const lineHeight =
    Math.round(plan.profile.fontHeight * 1.05) + plan.profile.lineGap
  let top = Infinity
  let bottom = -Infinity
  let maxLines = 0
  for (const command of commands) {
    const position = command.match(/\^FO(\d+),(\d+)/)
    const block = command.match(/\^FB(\d+),(\d+),/)
    assert.ok(position && block, `beklenen komut biçimi yok: ${command}`)
    const y = Number(position[2])
    const lines = Number(block[2])
    maxLines = Math.max(maxLines, lines)
    top = Math.min(top, y)
    bottom = Math.max(bottom, y + lines * lineHeight)
  }
  return {
    ok: true,
    top,
    bottom,
    height: bottom - top,
    maxLines,
    profile: plan.profile,
    commands,
  }
}

/** Her senaryoda uygulanan KATI sınır. */
function assertInsideBand(box, label) {
  assert.equal(box.ok, true, `${label}: plan üretilmeli`)
  assert.ok(box.top >= FOOTER_TOP, `${label}: top ${box.top} < ${FOOTER_TOP}`)
  assert.ok(
    box.bottom <= FOOTER_BOTTOM,
    `${label}: bottom ${box.bottom} > ${FOOTER_BOTTOM}`,
  )
  assert.ok(
    box.height <= FOOTER_HEIGHT,
    `${label}: yükseklik ${box.height} > ${FOOTER_HEIGHT}`,
  )
}

test('FOOTER-BOUND-1: kısa içerik gerçek bandın İÇİNDE', async () => {
  const box = await renderedFooterBox([item({ productName: 'Elbise', sku: 'A1' })])
  assertInsideBand(box, 'kısa')
  assert.equal(box.maxLines, 1)
})

test('FOOTER-BOUND-2: DuruSoft görünümü → 20 dot, EN FAZLA 2 satır, bant içinde', async () => {
  const box = await renderedFooterBox([item()])
  assertInsideBand(box, 'normal')
  assert.equal(box.profile.fontHeight, 20, 'referans görünüm 20 dot')
  assert.ok(box.maxLines <= 2, `2 satır sınırı aşıldı: ${box.maxLines}`)
})

test('FOOTER-BOUND-3: aşırı uzun içerik 3. SATIRA ÇIKMAZ, banttan taşmaz', async () => {
  const box = await renderedFooterBox([
    item({
      productName:
        'Kadin Isiltili Uzun Kollu Tesettur Abiye Elbise Modeli Ozel Dikim Premium Koleksiyon Seri',
      color: 'Lacivert',
      size: '42',
      sku: 'SCUBA-SEC01-EXTRA-LONG',
    }),
  ])
  assertInsideBand(box, 'aşırı uzun')
  // KATI KURAL: 2 satırı AŞMAZ — daha küçük fonta düşer, 3. satır AÇILMAZ.
  assert.ok(box.maxLines <= 2, `3. satır açıldı: ${box.maxLines}`)
  // Fontu küçültmüş olabilir ama okunabilirlik tabanının üstünde kalır.
  assert.ok(box.profile.fontHeight >= 16, `taban altı: ${box.profile.fontHeight}`)
  // VERİ KAYBI YOK: SKU ve beden çıktıda TAM olarak bulunur.
  const joined = box.commands.join('')
  assert.ok(joined.includes('SCUBA-SEC01-EXTRA-LONG'), 'SKU parçalanmamalı')
  assert.ok(joined.includes('Beden: 42'))
})

test('FOOTER-BOUND-4: iki aggregated ürün birlikte bandın İÇİNDE', async () => {
  const box = await renderedFooterBox([
    item(),
    item({ sku: 'SCUBA-SEC02', size: '40' }),
  ])
  assertInsideBand(box, 'iki ürün')
  // Bir ürün diğerini EZMEZ: her blok kendi satır(lar)ını alır.
  assert.ok(box.maxLines <= 2)
  const joined = box.commands.join('')
  assert.ok(joined.includes('SCUBA-SEC01'))
  assert.ok(joined.includes('SCUBA-SEC02'))
})

test('FOOTER-BOUND-5: profil tavanı KATI — hiçbir profil kendi sınırını aşamaz', async () => {
  const { SURAT_FOOTER_PROFILES, planSuratFooter } = await load(
    '/src/utils/suratZplProductLine.ts',
  )
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const geometry = parseSuratZplGeometry(ZPL)
  // Farklı uzunluk sınıflarında seçilen profilin KENDİ tavanı aşılmamalı.
  for (const length of [10, 40, 80, 120, 200]) {
    const plan = planSuratFooter(
      [item({ productName: 'U'.repeat(length) })],
      geometry,
    )
    if (!plan.ok) continue
    for (const block of plan.blocks) {
      for (const entry of block) {
        assert.ok(
          entry.lines <= plan.profile.maxLinesPerItem,
          `${plan.profile.key}: ${entry.lines} > ${plan.profile.maxLinesPerItem}`,
        )
      }
    }
    assert.ok(plan.usedHeight <= FOOTER_HEIGHT)
  }
  // Merdivendeki her profil için tavan anlamlı bir sayıdır.
  for (const profile of SURAT_FOOTER_PROFILES) {
    assert.ok(profile.maxLinesPerItem >= 1 && profile.maxLinesPerItem <= 2)
  }
})
