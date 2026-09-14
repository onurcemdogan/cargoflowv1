// PRINT-GEOMETRY-002B — UZUN AKTARMA METNİ SARILIR, QR 21 DOT'A DÜŞMEZ.
//
// ═══ PG2'DEN DEVREDEN AÇIK DAL ═══════════════════════════════════════════
//
// PRINT-GEOMETRY-002, V1'in 105→84 küçülmesini ve V2'nin kısa/orta metin
// dallarını kapattı. AÇIK KALAN: uzun/çok uzun aktarma metninde V2, TAŞIYICI
// ŞABLONUNUN YERLİ 21 dot QR'ıyla kalıyordu.
//
// ═══ ÖLÇÜLEN KÖK NEDEN — PG2 RAPORU BU NOKTADA EKSİKTİ ═══════════════════
//
// PG2 raporu bu dalı "composer reddediyor, `deriveAugmentedSuratZpl` ham
// taşıyıcı ZPL'ine düşüyor" diye açıklamıştı. ÖLÇÜM BUNU DOĞRULAMADI:
//
//   V2 LONG(28)  composed=TRUE   renderContract=carrier_composed  QR=21 dot
//
// Composer REDDETMİYORDU — BAŞARIYLA dönüyor ve taşıyıcının `^BQN,4,4 `
// komutunu OLDUĞU GİBİ bırakıyordu. Yani kusur "fallback" yolunda değil,
// BAŞARI yolundaydı. (Ret + ham fallback yalnız V1'de oluyordu ve orada
// sonuç 21 dot değil, QR'IN HİÇ OLMAMASIYDI.)
//
// ═══ ÇÖZÜM ══════════════════════════════════════════════════════════════
//
// Yatay bütçe (434 dot) tek satırda yetmiyorsa metin İKİ SATIRA sarılır.
// Sarmayı YAZICI yapar (`^FB`), CargoFlow DEĞİL: `^FD` gövdesi BAYT BAYT
// aynı kalır. Böylece içerik korunumu YAPISALDIR.
//
// ═══ ÖLÇÜLEN SONUÇ ══════════════════════════════════════════════════════
//
//   case          7d82a27          BU DEĞİŞİKLİKTEN SONRA
//   V1 LONG(28)   RET (QR YOK)     105 dot, 33/24 font, 2 satır
//   V1 VLONG(38)  RET (QR YOK)     105 dot, 33/24 font, 2 satır
//   V2 LONG(28)    21 dot          105 dot
//   V2 VLONG(38)   21 dot          105 dot
//   V1/V2 SHORT   105 dot          105 dot  (DEĞİŞMEDİ, font 70/50)
//   V1/V2 MED     105 dot          105 dot  (DEĞİŞMEDİ, font 70/46)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import { decodePngToBitmap } from './labels/pngLandmarks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const V1_ZPL = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const V2_ZPL = readFileSync(join(here, 'fixtures', 'surat-real-v2-numeric.zpl'), 'utf8')
const VERIFIED_727 = '7270034422363739'

/** Kanonik hedef: 21 modül × 5 = 105 dot = 13.125 mm @ 203 dpi. */
const CANONICAL_QR_DOTS = 105
/** Taşıyıcının YERLİ (büyütülmemiş) QR boyu — ARTIK BASILMAMALI. */
const CARRIER_NATIVE_QR_DOTS = 21

/** Aktarma alanının işgal zarfı: `^FT220,705`, font yüksekliği 70. */
const TRANSFER_ENVELOPE_TOP = 705 - 70
const TRANSFER_ENVELOPE_BOTTOM = 705

const SHORT = 'IZMIR'
const MED = 'BALIKESIR AKTARMA'
const LONG = 'DIKILI/CAN BALIKESIR AKTARMA'
const VLONG = 'KAHRAMANMARAS ELBISTAN AKTARMA MERKEZI'
/** İki satıra DA sığmayan uç durum — fail-closed dalını ölçer. */
const IMPOSSIBLE = 'Z'.repeat(80)

let _vite
let renderZplToPng
let composeSuratLabel
let deriveAugmentedSuratZpl
let resolveSuratSemanticModel
let extractSuratSemanticFields
let composerSource

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ renderZplToPng } = await _vite.ssrLoadModule('/server/labels/zplRenderService.ts'))
  ;({ composeSuratLabel } = await _vite.ssrLoadModule('/src/utils/suratLabelComposer.ts'))
  ;({ deriveAugmentedSuratZpl } = await _vite.ssrLoadModule(
    '/src/utils/augmentedSuratZpl.ts',
  ))
  ;({ resolveSuratSemanticModel, extractSuratSemanticFields } =
    await _vite.ssrLoadModule('/src/utils/suratSemanticParser.ts'))
  composerSource = readFileSync(
    join(here, '..', 'src', 'utils', 'suratLabelComposer.ts'),
    'utf8',
  )
})
after(async () => {
  if (_vite) await _vite.close()
})

const render = async (zpl) =>
  decodePngToBitmap(Buffer.from((await renderZplToPng({ zpl })).pngBase64, 'base64'))

/** İki bitmap'in FARKI — tek bir öğenin mürekkebini izole eder. */
function xorBitmap(a, b) {
  const dark = []
  for (let y = 0; y < a.height; y += 1) {
    const row = new Array(a.width)
    for (let x = 0; x < a.width; x += 1) row[x] = a.dark[y][x] !== b.dark[y][x]
    dark.push(row)
  }
  return { width: a.width, height: a.height, dark }
}

function boxOf(bmp) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, ink = 0
  for (let y = 0; y < bmp.height; y += 1) {
    for (let x = 0; x < bmp.width; x += 1) {
      if (!bmp.dark[y][x]) continue
      ink += 1
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return ink === 0
    ? null
    : { x: x0, y: y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1, ink }
}

/** Yatay mürekkep bantları — SATIR SAYISINI verir. */
function bandsOf(bmp, box) {
  const out = []
  let start = null
  for (let y = box.y; y <= box.y1; y += 1) {
    let n = 0
    for (let x = box.x; x <= box.x1; x += 1) if (bmp.dark[y][x]) n += 1
    if (n > 0 && start === null) start = y
    if (n === 0 && start !== null) {
      out.push([start, y - 1])
      start = null
    }
  }
  if (start !== null) out.push([start, box.y1])
  return out
}

const overlaps = (a, b) =>
  Boolean(a) && Boolean(b) && a.x <= b.x1 && b.x <= a.x1 && a.y <= b.y1 && b.y <= a.y1

const RE_TRANSFER = /\^FT220,705\^A0N,70,50\^FH\\\^FD([^\^]*)\^FS/

function withTransfer(baseZpl, text) {
  const zpl = baseZpl.replace(
    RE_TRANSFER,
    `^FT220,705^A0N,70,50^FH\\^FD${text}^FS`,
  )
  // METİN GERÇEKTEN YERLEŞTİ Mİ? Bu kontrol olmadan tüm ölçüm sessizce AYNI
  // etiketi ölçer ve "değişmiyor" diye YANLIŞ bir yeşil üretir.
  assert.ok(zpl.includes(`^FD${text}^FS`), `aktarma metni YERLESTIRILEMEDI: ${text}`)
  return zpl
}

/** QR mürekkebini izole eder: aynı etiket, `^BQ` komutu çıkarılmış hâliyle. */
const stripQr = (zpl) => zpl.replace(/\^BQ[^\^]*\^FD[^\^]*\^FS/, '^FS')
/** Aktarma mürekkebini izole eder: aynı etiket, `^FD` gövdesi boş. */
const stripTransfer = (zpl) =>
  zpl.replace(/(\^FT220,705[^]*?\^FD)[^\^]*(\^FS)/, '$1$2')

async function measure(baseZpl, text, items = []) {
  const source = withTransfer(baseZpl, text)
  const result = composeSuratLabel(source, {
    cargoTrackingNumber: VERIFIED_727,
    ...(items.length > 0 ? { items } : {}),
  })
  if (!result.composed) return { composed: false, reason: result.reason, mode: result.mode }
  const full = await render(result.zpl)
  const qrOnly = xorBitmap(full, await render(stripQr(result.zpl)))
  const textOnly = xorBitmap(full, await render(stripTransfer(result.zpl)))
  const textBox = boxOf(textOnly)
  return {
    composed: true,
    zpl: result.zpl,
    diagnostics: result.diagnostics,
    qr: boxOf(qrOnly),
    text: textBox,
    bands: textBox ? bandsOf(textOnly, textBox) : [],
    textOnly,
  }
}

// ═══ PG2B-1 — LONG V2: KANONİK QR, 21 DEĞİL ══════════════════════════════

test('PG2B-1: V2 LONG — QR kanonik 105 dot, tasiyici yerli 21 DEGIL', async () => {
  const out = await measure(V2_ZPL, LONG)
  assert.equal(out.composed, true, 'LONG compose edilmeli')
  assert.equal(out.qr.width, CANONICAL_QR_DOTS, 'QR genisligi')
  assert.equal(out.qr.height, CANONICAL_QR_DOTS, 'QR yuksekligi')
  // ÖLÇÜLEN ÖNCEKİ DURUM (7d82a27): 21 dot. Regresyon bu satırda düşer.
  assert.notEqual(out.qr.width, CARRIER_NATIVE_QR_DOTS, '21 dot ARTIK BASILMAZ')
})

// ═══ PG2B-2 — VLONG: KANONİK QR, ya da BASILAMAZ AÇIK HATA ═══════════════

test('PG2B-2: V2 VLONG — kanonik QR; sigmayan uc durumda BASILABILIR artefakt YOK', async () => {
  const vlong = await measure(V2_ZPL, VLONG)
  assert.equal(vlong.composed, true, 'VLONG iki satirla compose edilmeli')
  assert.equal(vlong.qr.width, CANONICAL_QR_DOTS, 'VLONG QR kanonik')

  // İKİ SATIRA DA SIĞMAYAN UÇ DURUM: sessizce 21 dot BASILMAZ, AÇIK hata.
  const source = withTransfer(V2_ZPL, IMPOSSIBLE)
  const result = composeSuratLabel(source, { cargoTrackingNumber: VERIFIED_727 })
  assert.equal(result.composed, false, 'sigmayan metin compose EDILMEZ')
  assert.equal(result.mode, 'fallback_carrier_qr_unsafe', 'AYRI, taninabilir mod')

  // ÜST KATMAN: ham taşıyıcı ZPL'i de 21 dot taşıdığı için "fallback" bir
  // çözüm DEĞİLDİR. Bu yüzden çıktı GÜVENSİZ olarak işaretlenir.
  const derived = deriveAugmentedSuratZpl(source, [], {
    compose: { cargoTrackingNumber: VERIFIED_727 },
  })
  assert.equal(derived.carrierQrUnsafe, true, 'cikti BASILABILIR degil')

  // VE kalıcılık katmanı bunu YAZMAYI REDDEDER.
  const repository = readFileSync(
    join(here, 'shipments', 'printZplRepository.ts'),
    'utf8',
  )
  assert.match(repository, /if \(derived\.carrierQrUnsafe\) \{/)
  assert.match(repository, /throw new CarrierQrUnsafeError/)
  // FAIL-OPEN ALLOWLIST'E EKLENMEDİ: bu hata taşıyıcı etiketini yine de
  // sunmaya yol açMAZ. `isSupplementalLabelFailure` onu TANIMAMALI.
  const allowlist = repository.slice(
    repository.indexOf('export function isSupplementalLabelFailure'),
  )
  assert.equal(
    allowlist.slice(0, 500).includes('CARRIER_QR_UNSAFE'),
    false,
    'guvensiz QR hatasi fail-open allowlist DISINDA kalmali',
  )

  // ═══ FAIL-CLOSED KAPSAMI DAR: GEREKSIZ KESINTI URETILMEZ ═════════════
  //
  // Tasiyicinin QR YUKU buyutmeye UYGUN DEGILSE (sayisal olmayan ya da
  // Version-1'e sigmayacak kadar uzun) buyutme zaten HIC denenemez. Bu,
  // aktarma metniyle ILGISIZ ve bu biletten ONCE DE var olan bir durumdur;
  // boyle bir etiketin baskisini ENGELLEMEK kapsam disi bir kesinti olurdu.
  // Bu yuzden KISA metinle bile olsa BLOKLANMAMALI.
  const longPayload = V2_ZPL.replace(
    /\^FDQA,\d+\^FS/,
    '^FDQA,' + '9'.repeat(40) + '^FS',
  )
  assert.notEqual(longPayload, V2_ZPL, 'QR yuku degistirilemedi')
  const nonEnlargeable = composeSuratLabel(withTransfer(longPayload, SHORT), {
    cargoTrackingNumber: VERIFIED_727,
  })
  assert.equal(
    nonEnlargeable.mode === 'fallback_carrier_qr_unsafe',
    false,
    'buyutulemeyen YUK, baski engeline yol acMAMALI',
  )
})

// ═══ PG2B-3 — İÇERİK KORUNUR: TEK HARF DÜŞMEZ ═══════════════════════════

test('PG2B-3: iki satir sarma aktarma metnini TAM korur (kirpma/kayip YOK)', async () => {
  for (const [name, base] of [['V1', V1_ZPL], ['V2', V2_ZPL]]) {
    for (const text of [LONG, VLONG]) {
      const out = await measure(base, text)
      assert.equal(out.composed, true, `${name} "${text}"`)

      // (a) YAPISAL KANIT: `^FD` gövdesi BAYT BAYT aynı. CargoFlow metni
      //     BÖLMEZ; sarmayı yazıcı yapar. Bu yüzden doğrulanacak bir
      //     "line1 + line2" birleştirmesi YOKTUR — kaynak gövde hiç
      //     dokunulmamıştır.
      assert.ok(
        out.zpl.includes(`^FD${text}^FS`),
        `${name} "${text}" govdesi DEGISMEMELI`,
      )

      // (b) SESSİZ KIRPMA YOK: `^FB` maxLines'a sığmayan metni KIRPAR.
      //     Kanıt: AYNI alanı maxLines=2 (bizim ürettiğimiz) ve maxLines=4
      //     ile render et; mürekkep AYNI ise 2 satır metnin TAMAMINI
      //     taşıyordu demektir.
      //
      //     ÖLÇÜM TUZAĞI — ALAN TEK BAŞINA RENDER EDİLİR: ilk denemede bu
      //     karşılaştırma TAM ETİKET üzerinde yapılıyordu ve DÜŞÜYORDU
      //     (4520 vs 6421). Sebep kırpma DEĞİLDİ: maxLines büyüyünce blok
      //     YUKARI kayıyor, rota kodunun mürekkebiyle örtüşüyor ve XOR
      //     izolasyonu ortak pikselleri BİRBİRİNE GÖTÜRÜYORDU. Alan boş bir
      //     etikete tek başına konunca örtüşme YOKTUR ve ölçüm temizdir.
      const field = out.zpl.match(/\^FT220,705[^]*?\^FS/)
      assert.ok(field, `${name} "${text}": aktarma alani bulunmali`)
      if (!field[0].includes('^FB')) continue // tek satir: sarma yok
      const solo = (zpl) => `^XA^PW799^LL799${zpl}^XZ`
      const ours = await render(solo(field[0]))
      const relaxedField = field[0].replace(/\^FB(\d+),2,(\d+),L/, '^FB$1,4,$2,L')
      assert.notEqual(relaxedField, field[0], 'maxLines degistirilemedi')
      const relaxed = await render(solo(relaxedField))

      const inkOf = (bmp) => bmp.dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
      assert.equal(
        inkOf(relaxed),
        inkOf(ours),
        `${name} "${text}": maxLines=4 ile murekkep degisti => 2 satirda HARF DUSMUS`,
      )
      const oursBands = bandsOf(ours, boxOf(ours))
      const relaxedBands = bandsOf(relaxed, boxOf(relaxed))
      assert.equal(
        relaxedBands.length,
        oursBands.length,
        `${name} "${text}": maxLines=4 daha fazla satir uretti => 2 satirda KIRPILMIS`,
      )
      assert.equal(oursBands.length, 2, `${name} "${text}": iki satir beklenir`)

      // (c) AŞAĞI AKIŞ METNİ TAM OKUR — "sinyal üretilir ama tüketilmez"
      //     kusur sınıfına karşı. Sarılmış etiket hâlâ çözümlenebilmeli ve
      //     `transferCenter` alanı metnin TAMAMINI vermeli. Alan iki `^FD`'ye
      //     BÖLÜNSEYDİ burası yarım metin okurdu ve etiket düzenleyici
      //     bölgeleri SESSİZCE kaybolurdu.
      //
      //     KIYAS SABİT BİR DEĞERE DEĞİL, AYNI ŞABLONUN SARILMAMIŞ ÇIKTISINA
      //     YAPILIR. Ölçüldü: V1'in compose edilmiş çıktısı SARMADAN ÖNCE DE
      //     `supported=false` veriyor (fixture imzası; bu değişiklikle
      //     İLGİSİZ, MEVCUT bir durum). Sabit `true` beklemek, sarmayla ilgisi
      //     olmayan bir farkı bu bilete YIKARDI. Doğru iddia: SARMA HİÇBİR
      //     ŞEYİ KÖTÜLEŞTİRMEZ.
      const reference = await measure(base, SHORT)
      const referenceModel = resolveSuratSemanticModel(reference.zpl)
      const model = resolveSuratSemanticModel(out.zpl)
      assert.equal(
        model.supported,
        referenceModel.supported,
        `${name} "${text}": sarma cozumlenebilirligi DEGISTIRDI`,
      )
      const extraction = extractSuratSemanticFields(out.zpl)
      const referenceExtraction = extractSuratSemanticFields(reference.zpl)
      assert.equal(
        extraction.errors.length,
        referenceExtraction.errors.length,
        `${name} "${text}": sarma YENI alan hatasi uretti (${extraction.errors[0] ?? ''})`,
      )
      // VE metin AŞAĞI AKIŞTA TAM okunur — alan iki `^FD`'ye bölünseydi
      // burası yarım metin okurdu.
      assert.equal(
        extraction.fields.transferCenter.text,
        text,
        `${name} "${text}": asagi akis metni TAM okumali`,
      )
    }
  }
})

// ═══ PG2B-4 — ÇAKIŞMA YOK, ZARF TAŞMASI YOK ═════════════════════════════

test('PG2B-4: iki satir QR/barkod/rota ile CAKISMAZ ve zarfi TASMAZ', async () => {
  for (const [name, base] of [['V1', V1_ZPL], ['V2', V2_ZPL]]) {
    for (const text of [SHORT, MED, LONG, VLONG]) {
      const out = await measure(base, text)
      assert.equal(out.composed, true, `${name} "${text}"`)
      assert.equal(
        overlaps(out.qr, out.text),
        false,
        `${name} "${text}": QR aktarma metniyle CAKISIYOR`,
      )
      // DİKEY ZARF — ÜST: rota kodunun mürekkebi 636'da biter; blok ona
      // DEĞMEZ. Bu, sarmanın getirdiği TEK yeni dikey risktir ve sert
      // sınırla ölçülür.
      assert.ok(
        out.text.y >= TRANSFER_ENVELOPE_TOP,
        `${name} "${text}": ust zarf asildi (${out.text.y} < ${TRANSFER_ENVELOPE_TOP})`,
      )

      // DİKEY ZARF — ALT: ÖLÇÜLDÜ, taban çizgisinin ALTINA inen tek şey
      // GLİF KUYRUĞUDUR (ör. "DIKILI/CAN" içindeki "/" → 2 dot). Bu, fontun
      // kendi özelliğidir, sarmanın değil. Doğru kıyas sabit bir sayı değil,
      // TAŞIYICININ KENDİ çizimidir: bloğumuz, aynı metni taşıyıcı özgün
      // fontuyla bastığında indiği yerden AŞAĞI inemez.
      const rawZpl = withTransfer(base, text)
      const rawOnly = xorBitmap(await render(rawZpl), await render(stripTransfer(rawZpl)))
      const rawBox = boxOf(rawOnly)
      assert.ok(rawBox, `${name} "${text}": ham metin olculemedi`)
      assert.ok(
        out.text.y1 <= rawBox.y1,
        `${name} "${text}": blok taşıyıcının KENDI cizgisinden asagi indi ` +
          `(${out.text.y1} > ${rawBox.y1})`,
      )
      // Ve her hâlükârda ürün footer'ının gövdesine (y ≥ 710) UZANMAZ.
      assert.ok(
        out.text.y1 < 710,
        `${name} "${text}": urun footer bandina uzandi (${out.text.y1})`,
      )
      // KIRPILMA YOK: metin etiket kenarına DEĞMEZ.
      assert.ok(out.text.x1 < 799, `${name} "${text}": metin etiket kenarinda`)
    }
  }
})

// ═══ PG2B-5 / PG2B-6 — MUTASYON MUHAFIZI ════════════════════════════════

test('PG2B-5: sarma ILGISIZ komut mutasyonu URETMEZ; izin sayisi ARTMADI', async () => {
  // `^FB` bir EKLEMEDİR (insertion), mutasyon DEĞİL — kaynakta `^FB` yoktur.
  // Bu yüzden whitelist'e YENİ bir izin dalı EKLENMEDİ.
  const start = composerSource.indexOf('const unexpected = diff.mutations.filter(')
  assert.ok(start > 0, 'whitelist filtresi bulunmali')
  const block = composerSource.slice(start, start + 2600)
  assert.match(block, /return true\s*\}\)/, 'varsayilan: BEKLENMEYEN')
  const allowances = (block.match(/return false/g) ?? []).length
  // 38ca3d2 -> 7d82a27 -> BU COMMIT: 6 -> 6 -> 6. Degisirse test DUSER.
  assert.equal(allowances, 6, `whitelist izin sayisi degisti (${allowances})`)

  // Guard AYNEN yerinde.
  assert.match(composerSource, /unexpectedMutations: 0/)
  assert.match(composerSource, /beklenmeyen taşıyıcı mutasyonu/)
  // Font izni HÂLÂ birebir from/to dizgisiyle sinirli.
  assert.match(
    composerSource,
    /mutation\.from === allowedTransferFont\.from &&\s*mutation\.to === allowedTransferFont\.to/,
  )
  // TEK KAYNAK: emit, whitelist ve invariant AYNI degerden beslenir.
  assert.match(composerSource, /const appliedTransfer: TransferTypography = carrierQrEnlargement/)
  // ONAYLI ARALIK emitten ONCE kanitlanir (serbest font degeri GECEMEZ).
  assert.match(composerSource, /aktarma tipografisi onaylı aralığın dışında/)
  // Genel bir "QR komutlari degisebilir" izni EKLENMEDI.
  assert.equal(/mutation\.name === 'BQ'\s*\)/.test(composerSource), false)

  // ÇIKTIDA SİLME YOK, BEKLENMEYEN MUTASYON YOK — gerçek etiket üzerinde.
  for (const base of [V1_ZPL, V2_ZPL]) {
    for (const text of [SHORT, MED, LONG, VLONG]) {
      const result = composeSuratLabel(withTransfer(base, text), {
        cargoTrackingNumber: VERIFIED_727,
      })
      assert.equal(result.composed, true, text)
      assert.equal(result.diagnostics.diff.unexpectedMutations, 0, text)
      assert.equal(result.diagnostics.diff.deletions, 0, text)
    }
  }
})

test('PG2B-6: ENJEKTE edilmis ILGISIZ bir mutasyon REDDEDILIR', async () => {
  // Sarma yolu açıkken bile muhafız SERT kalmalı. Composer'ın ürettiği ZPL'e
  // DIŞARIDAN ilgisiz bir komut değişikliği enjekte edilirse, aynı kaynakla
  // yapılan whitelist doğrulaması bunu YAKALAMALI.
  const geometryModule = await _vite.ssrLoadModule('/src/utils/suratLabelComposer.ts')
  const { diffZplAgainstSource } = geometryModule
  const zplModule = await _vite.ssrLoadModule('/src/utils/zplCommandModel.ts')
  const { parseZplDocument } = zplModule

  const source = withTransfer(V2_ZPL, VLONG)
  const result = composeSuratLabel(source, { cargoTrackingNumber: VERIFIED_727 })
  assert.equal(result.composed, true)

  // İLGİSİZ ALAN: ROTA KODUNUN fontu. Hedef BENZERSİZ olmalıdır — `^A0N,18,20`
  // fixture'da İKİ KEZ geçer ve sıralı diff ikinci kopyayı eşleştirip
  // mutasyonu GÖRMEZ (ölçüldü: 0 mutasyon). Rota fontu her iki fixture'da da
  // TEK kez geçer ve whitelist'te YERİ YOKTUR.
  assert.equal(source.split('^A0N,44,52').length - 1, 1, 'hedef BENZERSIZ olmali')
  const tampered = result.zpl.replace('^A0N,44,52', '^A0N,44,51')
  assert.notEqual(tampered, result.zpl, 'enjeksiyon UYGULANAMADI')
  const diff = diffZplAgainstSource(parseZplDocument(source), parseZplDocument(tampered))
  const injected = diff.mutations.filter(
    (mutation) => mutation.from === 'N,44,52' && mutation.to === 'N,44,51',
  )
  assert.equal(injected.length, 1, 'enjekte mutasyon diff tarafindan GORULMELI')

  // VE bu mutasyon whitelist'in HİÇBİR dalına uymaz: izinli tek font
  // değişimi AKTARMA alanınındır ve `from` dizgisi aktarmanın ÖZGÜN
  // fontudur (`N,70,50`), rota fontu DEĞİL.
  assert.notEqual(injected[0].from, 'N,70,50', 'rota fontu aktarma izniyle KARISMAZ')

  // Composer'ın KENDİ ürettiği çıktıda ise beklenmeyen mutasyon SIFIRDIR.
  assert.equal(result.diagnostics.diff.unexpectedMutations, 0)
})

// ═══ PG2B-7 — KISA/ORTA DAVRANIŞI DEĞİŞMEDİ ═════════════════════════════

test('PG2B-7: kisa/orta metin 7d82a27 ile AYNI (gereksiz sarma YOK)', async () => {
  for (const [name, base] of [['V1', V1_ZPL], ['V2', V2_ZPL]]) {
    const short = await measure(base, SHORT)
    assert.equal(short.composed, true)
    // ÖZGÜN tipografi DOKUNULMAZ.
    assert.equal(short.diagnostics.transferFontHeight, 70, `${name} kisa yukseklik`)
    assert.equal(short.diagnostics.transferFontWidth, 50, `${name} kisa genislik`)
    assert.equal(short.diagnostics.transferLines, 1, `${name} kisa TEK satir`)
    assert.equal(short.bands.length, 1, `${name} kisa render TEK bant`)
    assert.equal(short.qr.width, CANONICAL_QR_DOTS)

    const med = await measure(base, MED)
    assert.equal(med.composed, true)
    // Orta metinde YALNIZ genislik daralir; yukseklik ve satir sayisi AYNI.
    assert.equal(med.diagnostics.transferFontHeight, 70, `${name} orta yukseklik`)
    assert.ok(med.diagnostics.transferFontWidth < 50, `${name} orta genislik DARALIR`)
    assert.equal(med.diagnostics.transferLines, 1, `${name} orta TEK satir`)
    assert.equal(med.qr.width, CANONICAL_QR_DOTS)
    // `^FB` YAZILMAZ: tek satirda sarma komutu EKLENMEZ.
    //
    // DİKKAT: etikette BAŞKA bir `^FB` ZATEN VARDIR — composer'ın barkod
    // altına yazdığı insan-okunur satır (`^FO48,306...^FB624,1,0,C`).
    // Bu yüzden kontrol TÜM ZPL'de değil, YALNIZ aktarma alanında yapılır;
    // aksi halde test her zaman düşerdi (ölçüldü).
    const transferField = med.zpl.match(/\^FT220,705[^]*?\^FS/)
    assert.ok(transferField, `${name} aktarma alani bulunmali`)
    assert.equal(
      transferField[0].includes('^FB'),
      false,
      `${name} orta metinde aktarma alaninda ^FB YOK`,
    )
  }
})

// ═══ PG2B-8 — ÜRÜN SAYISI QR'I DEĞİŞTİRMEZ ══════════════════════════════

// ÜRÜN FOOTER'I GERÇEK YOLDAN EKLENİR — `composeSuratLabel` DEĞİL.
//
// ═══ YAKALANAN SAHTE YEŞİL ═══════════════════════════════════════════════
//
// Bu test ilk yazıldığında ürünleri `composeSuratLabel(zpl, { items })` ile
// veriyordu. `SuratComposeInput` böyle bir alan TAŞIMIYOR (`cargoTrackingNumber`,
// `ozelKargoTakipNo`, `orderDate` — hepsi bu kadar) ve composer içinde `items`
// kelimesi HİÇ GEÇMİYOR. Yani dört varyant da AYNI etiketi üretiyordu ve test
// "ürün sayısı QR'ı değiştirmiyor" diye SAHTE bir yeşil veriyordu.
//
// Footer'ı ekleyen gerçek yol `deriveAugmentedSuratZpl(zpl, items, {compose})`
// olduğu için test ORAYA taşındı; ayrıca footer'ın GERÇEKTEN basıldığı
// doğrulanır, aksi halde aynı sahte yeşil geri dönerdi.
test('PG2B-8: urun sayisi sarilmis etikette de QR boyutunu DEGISTIRMEZ', async () => {
  const variants = [
    [],
    [{ productName: 'Tisort', quantity: 1, sku: 'SKU-1' }],
    [{ productName: 'Cok Uzun Bir Urun Adi Ornegi Buraya Kadar', quantity: 2, sku: 'SKU-2' }],
    [
      { productName: 'Birinci Urun', quantity: 1, sku: 'SKU-A' },
      { productName: 'Ikinci Urun', quantity: 2, sku: 'SKU-B' },
      { productName: 'Ucuncu Urun', quantity: 3, sku: 'SKU-C' },
    ],
  ]
  const outcomes = new Map()
  for (const text of [MED, VLONG]) {
    const source = withTransfer(V2_ZPL, text)
    const widths = []
    const footers = []
    for (const items of variants) {
      const derived = deriveAugmentedSuratZpl(source, items, {
        compose: { cargoTrackingNumber: VERIFIED_727 },
      })
      assert.equal(derived.renderContract, 'carrier_composed', `"${text}"`)
      // FOOTER GERÇEKTEN BASILDI MI? Bu kontrol olmadan test, ürünlerin hiç
      // işlenmediği durumda da GEÇERDİ.
      for (const item of items) {
        assert.ok(
          derived.printZpl.includes(item.productName.slice(0, 12)),
          `"${text}": "${item.productName}" footer'a girmedi`,
        )
      }
      footers.push(`${derived.augmentationStatus}/${derived.printZplFooterProfile ?? '-'}`)
      const full = await render(derived.printZpl)
      const qr = boxOf(xorBitmap(full, await render(stripQr(derived.printZpl))))
      widths.push(qr.width)
    }
    for (const width of widths) {
      assert.equal(width, CANONICAL_QR_DOTS, `"${text}" QR urun sayisiyla degisti`)
    }
    outcomes.set(text, footers)
  }

  // ═══ SARMA FOOTER KAPASİTESİNİ DÜŞÜRMEZ ═══════════════════════════════
  //
  // ÖLÇÜLEN VE DÜZELTİLEN KUSUR: `suratZplGeometry` çok satırlı `^FT`+`^FB`
  // bloğunu AŞAĞI doğru büyüyor sayıyordu; contentBottom bir satır boyu
  // FAZLA çıkıyor ve footer alanından o kadar yer çalınıyordu. Sonuç:
  // sarılmış etikette 3 ürünlü sipariş sahte biçimde `footer_overflow`
  // veriyordu (ölçüldü). Ölçüm gerçek render'a göre düzeltildi.
  //
  // Bu iddia regresyonu yakalar: sarılmış etiketin footer sonucu, sarılmamış
  // etiketinkiyle BİREBİR AYNI olmalıdır.
  assert.deepEqual(
    outcomes.get(VLONG),
    outcomes.get(MED),
    'sarma urun footer kapasitesini DEGISTIRDI',
  )
})

// ═══ PG2B-9 / PG2B-10 / PG2B-11 — KAPSAM SINIRLARI ══════════════════════

test('PG2B-9: kayitli printZpl geriye donuk DEGISTIRILMEZ', async () => {
  const repository = readFileSync(
    join(here, 'shipments', 'printZplRepository.ts'),
    'utf8',
  )
  assert.match(repository, /printZplSourceSha256/)
  // Toplu yeniden yazma / migration yolu YOK.
  assert.equal(/for\s*\([^)]*\)\s*\{[^}]*update\([^)]*printZpl/m.test(repository), false)
})

test('PG2B-10: bilinmeyen sablon FAIL-SAFE kalir', async () => {
  const geometry = await _vite.ssrLoadModule('/src/utils/labelTemplateGeometry.ts')
  assert.equal(geometry.mayMutateTemplateGeometry('bilinmeyen'), false)
  assert.equal(geometry.resolveLabelTemplateGeometry('bilinmeyen'), null)
  // Taninmayan ZPL compose EDILMEZ ve sarma UYGULANMAZ.
  const unknown = composeSuratLabel('^XA^PW400^LL0400^FO1,1^FDx^FS^XZ', {
    cargoTrackingNumber: VERIFIED_727,
  })
  assert.equal(unknown.composed, false)
  assert.equal(unknown.mode, 'fallback_unknown_template')
})

test('PG2B-11: saglayiciya ait etiketler ETKILENMEZ', async () => {
  const geometry = await _vite.ssrLoadModule('/src/utils/labelTemplateGeometry.ts')
  for (const key of ['trendyol_common_label', 'hepsiburada_mutual_barcode', 'aras_native']) {
    assert.equal(geometry.mayMutateTemplateGeometry(key), false, key)
  }
  // Sarma mantigi SURAT composer'ina OZELDIR; baska modulde YOK.
  assert.match(composerSource, /TRANSFER_WRAP_MAX_LINES = 2/)
  const augmented = readFileSync(
    join(here, '..', 'src', 'utils', 'augmentedSuratZpl.ts'),
    'utf8',
  )
  assert.equal(augmented.includes('^FB'), false, 'sarma yalniz composer icinde')
})

// ═══ PG2B-12 — GERÇEK BITMAP MATRİSİ ════════════════════════════════════

test('PG2B-12: gercek render matrisi — her SUCCESS durumunda QR KANONIK', async () => {
  const CASES = [
    'GEBZE AKTARMA',
    'IKITELLI AKTARMA',
    'DIYARBAKIR AKTARMA',
    'ISTANBUL ANADOLU AKTARMA MERKEZI',
    'KAHRAMANMARAS ELBISTAN AKTARMA MERKEZI',
    'AFYONKARAHISAR SANDIKLI AKTARMA MERKEZI',
  ]
  const rows = []
  for (const [name, base] of [['V1', V1_ZPL], ['V2', V2_ZPL]]) {
    for (const text of CASES) {
      const out = await measure(base, text)
      assert.equal(out.composed, true, `${name} "${text}" compose edilmeli`)
      rows.push({
        tpl: name,
        text,
        qr: out.qr.width,
        font: `${out.diagnostics.transferFontHeight}/${out.diagnostics.transferFontWidth}`,
        bands: out.bands.length,
        textBox: `${out.text.x}..${out.text.x1} y${out.text.y}..${out.text.y1}`,
      })
      // HER SUCCESS: kanonik QR, 21 dot YOK.
      assert.equal(out.qr.width, CANONICAL_QR_DOTS, `${name} "${text}" QR`)
      assert.equal(out.qr.height, CANONICAL_QR_DOTS, `${name} "${text}" QR`)
      assert.ok(out.bands.length >= 1 && out.bands.length <= 2, 'satir sayisi 1 veya 2')
    }
  }
  // Ölçülen matris kayda geçer (kanıt raporda kullanılır).
  console.log('PG2B-12 MATRIS:\n' + rows.map((r) => JSON.stringify(r)).join('\n'))
  assert.equal(rows.length, CASES.length * 2)
})
