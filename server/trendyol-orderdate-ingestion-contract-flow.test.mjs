// TRENDYOL-ORDERDATE — KÖK NEDEN + ALIM SÖZLEŞMESİ + SAAT DİLİMİ BAĞIMSIZLIĞI.
//
// ═══ KÖK NEDEN (BU DOSYADA YENİDEN ÜRETİLİR, İDDİA EDİLMEZ) ══════════════
//
// Eski alım yolu `toIsoDate` idi:
//
//   if (typeof value === 'number') return new Date(value).toISOString()
//   return new Date(value).toISOString()
//
// Bu fonksiyon ham değerin BİÇİMİNE göre FARKLI davranır:
//
//   SAYISAL epoch (sözleşmenin belgelediği biçim) → GMT+3 sayı UTC sanılır
//                                                   → +3 saat İLERİ yazılır
//   AÇIK OFSETLİ dizgi ("...Z", "...+03:00")      → zaten mutlak → KAYMAZ
//
// ÜRETİM GÖZLEMİNİN ANLAMI BURADA DEĞİŞİR: "DRIFT=0 satırlar var, demek ki
// kusur tarihsel" çıkarımı ANCAK o satırlar SAYISAL ham değerden geliyorsa
// geçerlidir. Ofsetli dizgiden gelen satırlar kusurdan ZATEN etkilenmez —
// yani DRIFT=0 olmaları kusurun bittiğini DEĞİL, o kayıtların başka biçimde
// geldiğini gösterir. Ayrım veriden okunur: `npm run orders:orderdate:range`
// çıktısındaki `byRawShape` + `interpretation`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

import { randomBytes } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const vite = await createServer({
  root,
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  logLevel: 'error',
})
test.after(() => vite.close())

const { normalizeTrendyolOrderDate, normalizeTrendyolGmtTimestamp, TRENDYOL_TIMESTAMP_CONTRACT, TRENDYOL_ORDER_DATE_OFFSET_MINUTES } =
  await vite.ssrLoadModule('/server/marketplaces/trendyolOrderDate.ts')
const { normalizeHistoricalPackage } = await vite.ssrLoadModule(
  '/server/trendyol/historicalOrderFetch.ts',
)
const { classifyRawOrderDateShape, classifyOrderDateDrift } = await vite.ssrLoadModule(
  '/server/orders/trendyolOrderDateDrift.ts',
)

const RAW = 1789418160000
const OFFSET_MS = 180 * 60_000
const CORRECT = new Date(RAW - OFFSET_MS).toISOString() // 2026-09-14T17:36:00.000Z
const DRIFTED = new Date(RAW).toISOString() // 2026-09-14T20:36:00.000Z

/**
 * ESKİ alım yolunun BİREBİR kopyası. Kopya olduğu TZI-1'de kaynağa karşı
 * DOĞRULANIR — yoksa "kök neden" gösterimi zamanla gerçeklikten kopardı.
 */
function legacyToIsoDate(value) {
  if (!value) return ''
  if (typeof value === 'number') return new Date(value).toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

// ── KÖK NEDEN ──────────────────────────────────────────────────────────────

test('TZI-1: eski `toIsoDate` kopyasi KAYNAKLA BIREBIR ayni', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = source.indexOf('function toIsoDate(value) {')
  assert.ok(start > 0, 'toIsoDate kaynakta bulunamadi')
  const body = source.slice(start, source.indexOf('\n}', start) + 2)
  const strip = (text) => text.replace(/\s+/g, ' ').trim()
  assert.equal(
    strip(body),
    strip(legacyToIsoDate.toString().replace('function legacyToIsoDate', 'function toIsoDate')),
    'kok neden gosterimi kaynaktaki fonksiyonla AYNI olmali',
  )
})

test('TZI-2: KOK NEDEN — sayisal epoch eski yolda +180 dk KAYAR', () => {
  const legacy = legacyToIsoDate(RAW)
  assert.equal(legacy, DRIFTED)
  const verdict = classifyOrderDateDrift({ storedOrderDate: new Date(legacy), rawOrderDate: RAW })
  assert.equal(verdict.driftMinutes, TRENDYOL_ORDER_DATE_OFFSET_MINUTES)
  assert.equal(verdict.classification, 'DRIFTED_BY_OFFSET')
  assert.equal(verdict.correctedOrderDate, CORRECT)
})

test('TZI-3: KOK NEDEN — ACIK OFSETLI dizgi eski yolda HIC KAYMAZ', () => {
  // ÜRETİMDEKİ "ALREADY_CORRECT" SATIRLARIN OLASI KAYNAĞI BUDUR.
  for (const rawString of ['2026-09-14T17:36:00.000Z', '2026-09-14T20:36:00+03:00']) {
    const legacy = legacyToIsoDate(rawString)
    assert.equal(legacy, CORRECT, `${rawString}: eski yol dogru degeri yazardi`)
    const verdict = classifyOrderDateDrift({
      storedOrderDate: new Date(legacy),
      rawOrderDate: rawString,
    })
    assert.equal(verdict.driftMinutes, 0)
    assert.equal(
      verdict.classification,
      'ALREADY_CORRECT',
      'ofsetli ham deger KUSURDAN ETKILENMEZ — tarih farki DEGIL, BICIM farki',
    )
    assert.equal(classifyRawOrderDateShape(rawString), 'OFFSET_STRING')
  }
  assert.equal(classifyRawOrderDateShape(RAW), 'EPOCH_MS')
})

// ── MEVCUT ALIM YOLU DÜZELTİLDİ Mİ ─────────────────────────────────────────

test('TZI-4: canli sync ve geri doldurma AYNI normalizeri kullanir', () => {
  const live = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(live, /normalizeTrendyolOrderDate\(item\.orderDate\)/)
  assert.equal(
    /orderDate\s*=\s*toIsoDate\(item\.orderDate\)/.test(live),
    false,
    'canli sync artik ham epochu duz UTC saymaz',
  )
  const backfill = readFileSync(join(here, 'trendyol', 'historicalOrderFetch.ts'), 'utf8')
  assert.match(backfill, /normalizeTrendyolOrderDate\(item\.orderDate\)/)
})

test('TZI-5: iki alim yolu AYNI kanonik ani uretir (cross-path parite)', () => {
  const backfilled = normalizeHistoricalPackage({
    id: 'PKG-1',
    orderNumber: 'ORD-1',
    orderDate: RAW,
    lines: [],
    shipmentAddress: {},
  })
  assert.equal(backfilled.orderDate, CORRECT)
  assert.equal(
    backfilled.orderDate,
    normalizeTrendyolOrderDate(RAW),
    'ayni siparis hangi yoldan gelirse gelsin AYNI an',
  )
})

test('TZI-6: persistence katmani ofsetli ISO degerini AYNEN korur', async () => {
  const mapper = await vite.ssrLoadModule('/server/orders/orderMapper.ts')
  const values = mapper.toOrderInsertValues('org-1', {
    marketplace: 'Trendyol',
    packageId: 'P1',
    orderNumber: 'N1',
    orderDate: CORRECT,
    rawOrder: { orderDate: RAW },
  })
  assert.equal(
    values.orderDate.toISOString(),
    CORRECT,
    'mapper saglayicidan BAGIMSIZDIR: ofsetli ISO tek adimda cozulur',
  )
})

// ── SÖZLEŞME ───────────────────────────────────────────────────────────────

test('TZI-7: resmi sozlesme SABIT — orderDate GMT+3, createdDate GMT', () => {
  assert.deepEqual(TRENDYOL_TIMESTAMP_CONTRACT, { orderDate: 'GMT+3', createdDate: 'GMT' })
  assert.equal(TRENDYOL_ORDER_DATE_OFFSET_MINUTES, 180)
  // İKİ ALAN AYNI DÖNÜŞÜMDEN GEÇMEZ.
  assert.equal(normalizeTrendyolOrderDate(RAW), CORRECT)
  assert.equal(normalizeTrendyolGmtTimestamp(RAW), DRIFTED)
  assert.notEqual(normalizeTrendyolOrderDate(RAW), normalizeTrendyolGmtTimestamp(RAW))
})

test('TZI-8: kanonik kural — saklanan deger GERCEK UTC ani, "Turkiye-ayarli UTC" DEGIL', () => {
  // Kanonik değer, ham epoch'un gösterdiği gerçek andır: Istanbul duvar saati
  // 20:36 → mutlak an 17:36Z. Saklanan değer duvar saatini TAŞIMAZ.
  assert.equal(normalizeTrendyolOrderDate(RAW), '2026-09-14T17:36:00.000Z')
  const istanbulWall = new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(normalizeTrendyolOrderDate(RAW)))
  assert.equal(istanbulWall, '20:36', 'yerellestirme YALNIZ sunumda yapilir')
})

test('TZI-9: yaz/kis — Turkiye 2016dan beri SABIT +03, DST kaymasi YOK', () => {
  // Yaz (Temmuz) ve kış (Ocak) aynı sabit ofsetle çözülmeli.
  const summer = Date.UTC(2026, 6, 15, 12, 0, 0)
  const winter = Date.UTC(2026, 0, 15, 12, 0, 0)
  for (const epoch of [summer, winter]) {
    assert.equal(
      normalizeTrendyolOrderDate(epoch),
      new Date(epoch - OFFSET_MS).toISOString(),
      'DST varsayimi YOK — sabit ofset',
    )
  }
})

// ── SAAT DİLİMİ BAĞIMSIZLIĞI (GERÇEK ÇOCUK SÜREÇ) ──────────────────────────

/**
 * Normalize'ı AYRI BİR NODE SÜRECİNDE, TZ ortam değişkeni SÜREÇ BAŞLARKEN
 * ayarlanmış hâlde çalıştırır.
 *
 * Neden çocuk süreç: `process.env.TZ`yi süreç İÇİNDE değiştirmek, motorun
 * saat dilimini ne zaman önbelleğe aldığına bağlıdır ve "sunucu UTC'de
 * çalışıyordu" senaryosunu tam olarak temsil ETMEZ. Gerçek kanıt, süreci o
 * saat diliminde BAŞLATMAKTIR.
 */
function normalizeInProcessWithTz(timeZone, rawLiteral) {
  const script = `
    const { normalizeTrendyolOrderDate } = await import(${JSON.stringify(
      pathToFileURL(join(here, 'marketplaces', 'trendyolOrderDate.ts')).href,
    )})
    process.stdout.write(String(normalizeTrendyolOrderDate(${rawLiteral})))
  `
  return execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: timeZone },
    encoding: 'utf8',
  })
}

test('TZI-10: sunucu UTCde de Europe/Istanbulda da AYNI kanonik deger yazilir', () => {
  const zones = ['UTC', 'Europe/Istanbul', 'America/New_York', 'Asia/Tokyo']
  // 1) Sayısal epoch — sözleşmenin belgelediği biçim.
  const epochResults = zones.map((zone) => [zone, normalizeInProcessWithTz(zone, String(RAW))])
  for (const [zone, value] of epochResults) {
    assert.equal(value, CORRECT, `${zone}: sayisal epoch sunucu saatinden BAGIMSIZ`)
  }
  // 2) Ofsetsiz (naive) dizgi — `new Date(...)` bunu SUNUCU YERELINDE cozerdi.
  const naiveResults = zones.map((zone) => [
    zone,
    normalizeInProcessWithTz(zone, JSON.stringify('2026-09-14 20:36:00')),
  ])
  for (const [zone, value] of naiveResults) {
    assert.equal(value, CORRECT, `${zone}: naive dizgi de sunucu saatinden BAGIMSIZ`)
  }
})

test('TZI-11: eski yol saat diliminE BAGLIYDI — bu yuzden naive dizgi AMBIGUOUS', () => {
  // Eski `new Date('2026-09-14 20:36:00')` ifadesinin sonucu sunucunun saat
  // dilimine gore DEGISIRDI. Iki farkli TZ'de KANIT:
  const naive = '2026-09-14 20:36:00'
  const script = (tz) =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `process.stdout.write(new Date(${JSON.stringify(naive)}).toISOString())`],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
    )
  const utc = script('UTC')
  const istanbul = script('Europe/Istanbul')
  assert.notEqual(
    utc,
    istanbul,
    'eski yol ayni girdiyi FARKLI anlara cevirirdi (saat dilimine bagli)',
  )
  // Bu yüzden ofsetsiz ham değer için hangi anın yazıldığı GERİYE DÖNÜK
  // kanıtlanamaz → otomatik onarım DIŞI.
  assert.equal(
    classifyOrderDateDrift({
      storedOrderDate: new Date(utc),
      rawOrderDate: naive,
    }).classification,
    'AMBIGUOUS',
  )
})
