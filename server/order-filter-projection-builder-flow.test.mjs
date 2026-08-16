import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// B2-1b-A — KANONİK FİLTRE PROJEKSİYONU ÜRETİCİSİ.
//
// Sözleşme: normalizasyon SQL'de YENİDEN YAZILMAZ. Projeksiyon değerleri
// üretimdeki normalizedToken / normalizedSearch ile üretilir; SQL eşitliği
// ve LIKE'ı kanonik JS davranışıyla BİREBİR olur.

const B = await import('./orders/orderFilterProjectionBuilder.ts')
const C = await import('../src/utils/orderClassification.ts')

const nl = (v) => v.split('\r\n').join('\n')
const BUILDER_SOURCE = nl(
  readFileSync('server/orders/orderFilterProjectionBuilder.ts', 'utf8'),
)
const SCHEMA_SOURCE = nl(readFileSync('server/db/schema.ts', 'utf8'))
const MIGRATION = nl(readFileSync('drizzle/0008_busy_wong.sql', 'utf8'))

const SEP = B.SEARCH_FIELD_SEPARATOR

/** Kanonik ESKI yol: alanları tek tek normalize edip includes ile ara. */
function oldMatches(values, query) {
  const token = C.normalizedSearch(query)
  if (!token) return true
  return values
    .filter(Boolean)
    .map(C.normalizedSearch)
    .some((value) => value.includes(token))
}
/** YENI yol: birleşik token üzerinde includes (SQL LIKE eşdeğeri). */
function newMatches(values, query) {
  const token = C.normalizedSearch(query)
  if (!token) return true
  return B.buildSearchToken(values).includes(token)
}

// ═══ 1. AYIRICI GÜVENLİĞİ (tasarımın temel ispatı) ════════════════════════

test('PRJ-1: ayirici normalizedSearch tarafindan URETILEMEZ', () => {
  assert.equal(SEP, '́')
  // Hicbir normalize edilmis deger/ sorgu bu karakteri iceremez.
  for (const sample of [
    'İstanbul', 'ábc', 'Ömer', 'ÇĞİÖŞÜ', 'é̀x', SEP, SEP + SEP,
    'test' + SEP + 'value',
  ]) {
    assert.equal(
      C.normalizedSearch(sample).includes(SEP), false,
      `normalizedSearch("${sample}") ayirici URETMEMELI`,
    )
  }
  assert.equal(C.normalizedToken(SEP), '')
})

test('PRJ-2: eslesme alan SINIRINI ASAMAZ', () => {
  // "abc" + "def" birlesirse "cd" ESKI yolda eslesmez; YENI yolda da
  // eslesmemeli (ayirici araya girdigi icin).
  const values = ['abc', 'def']
  assert.equal(oldMatches(values, 'cd'), false)
  assert.equal(newMatches(values, 'cd'), false)
  assert.equal(B.buildSearchToken(values), `abc${SEP}def`)
  // Gercek alan ici eslesmeler KORUNUR.
  for (const q of ['abc', 'bc', 'def', 'de']) {
    assert.equal(oldMatches(values, q), true, q)
    assert.equal(newMatches(values, q), true, q)
  }
})

// ═══ 3. TÜRKÇE NORMALİZASYON GOLDEN SET ═══════════════════════════════════

test('PRJ-3: Turkce sehir varyantlari AYNI token uretir', () => {
  const variants = [
    'İstanbul', 'ISTANBUL', 'Istanbul', 'İSTANBUL', 'İstanbul ',
    ' istanbul', 'Ist anbul', 'İstanbul.', 'i̇stanbul',
  ]
  const tokens = variants.map((v) => B.buildOrderProjectionFragment({ shippingCity: v }).shippingCityToken)
  // Projeksiyon, KANONIK fonksiyonun sonucuyla BIREBIR.
  for (let i = 0; i < variants.length; i += 1) {
    assert.equal(tokens[i], C.normalizedToken(variants[i]), variants[i])
  }
  // Bosluk/noktalama silindigi icin hepsi ayni kovaya duser.
  assert.equal(new Set(tokens).size, 1, `beklenen tek token, gelen: ${[...new Set(tokens)].join(',')}`)
  assert.equal(tokens[0], 'istanbul')
})

test('PRJ-4: aksanli isim / bos / null davranisi kanonikle AYNI', () => {
  for (const value of [null, undefined, '', '   ', 'Ömer Çağrı', 'ŞİŞLİ', 'a-b_c']) {
    const row = B.buildOrderProjectionFragment({ shippingDistrict: value })
    assert.equal(row.shippingDistrictToken, C.normalizedToken(value), String(value))
  }
})

test('PRJ-5: marketplaceStatus EXACT kalir (normalize EDILMEZ)', () => {
  const row = B.buildOrderProjectionFragment({ marketplaceStatus: 'AtCollectionPoint' })
  assert.equal(row.marketplaceStatus, 'AtCollectionPoint')
})

// ═══ 6-8. ARAMA PARİTESİ (eski JS vs projeksiyon) ═════════════════════════

const CUSTOMER = ['Ömer Çağrı Şahin', '0555 000 11 22', 'Omer@Ornek.COM']
const ORDERNO = ['1141000042', 'EXT-42', '727001042', '7270ABC', null]
const CARGOSLIP = ['727001042', 'GND42', 'IRS-42', 'BRK42', null, '']

test('PRJ-6: customer arama paritesi', () => {
  for (const q of [
    'ömer', 'OMER', 'omer', 'çağrı', 'cagri', '0555', '555 000', 'ornek.com',
    'OMER@ORNEK', 'yok', '', '   ', 'şahin', 'sahin',
  ]) {
    assert.equal(newMatches(CUSTOMER, q), oldMatches(CUSTOMER, q), `customer:"${q}"`)
  }
})

test('PRJ-7: orderNumber arama paritesi', () => {
  for (const q of ['114100', '1141000042', 'ext', 'EXT-42', '727001042', '7270', 'yok', '']) {
    assert.equal(newMatches(ORDERNO, q), oldMatches(ORDERNO, q), `orderNo:"${q}"`)
  }
})

test('PRJ-8: cargoSlip arama paritesi', () => {
  for (const q of ['727', 'GND42', 'gnd', 'IRS-42', 'irs42', 'BRK', 'yok', '']) {
    assert.equal(newMatches(CARGOSLIP, q), oldMatches(CARGOSLIP, q), `cargoSlip:"${q}"`)
  }
})

test('PRJ-9: parca kaynaklari kanonik filtreyle AYNI', () => {
  const orderFrag = B.buildOrderProjectionFragment({
    customerName: CUSTOMER[0], customerPhone: CUSTOMER[1], customerEmail: CUSTOMER[2],
    orderNumber: ORDERNO[0], externalOrderId: ORDERNO[1],
    cargoTrackingNumber: ORDERNO[2],
  })
  assert.equal(orderFrag.customerSearchToken, B.buildSearchToken(CUSTOMER))
  assert.equal(
    orderFrag.orderNumberOrderToken,
    B.buildSearchToken([ORDERNO[0], ORDERNO[1], ORDERNO[2]]),
  )
  const shipFrag = B.buildShipmentProjectionFragment({
    ozelKargoTakipNo: ORDERNO[3], trendyolCargoTrackingNumber: ORDERNO[4],
    cargoSlipShipmentValues: CARGOSLIP,
  })
  assert.equal(
    shipFrag.orderNumberShipmentToken,
    B.buildSearchToken([ORDERNO[3], ORDERNO[4]]),
  )
  assert.equal(shipFrag.cargoSlipShipmentToken, B.buildSearchToken(CARGOSLIP))
})

// ESKI tek-blob arama vs YENI parcali OR: BIREBIR ayni sonuc.
test('PRJ-9B: split-token arama paritesi (orderNumber + cargoSlip)', () => {
  const orderOwned = [ORDERNO[0], ORDERNO[1], ORDERNO[2]]
  const shipOwned = [ORDERNO[3], ORDERNO[4]]
  const opOwned = ['41176176501029', 'BRK99']
  for (const q of [
    '114100', '1141000042', 'ext', 'EXT-42', '727001042', '7270', 'yok', '',
    'GND42', 'irs42', 'BRK', '4117617', 'brk99', 'Ömer', '   ',
  ]) {
    const oldHit = oldMatches([...orderOwned, ...shipOwned, ...opOwned], q)
    const token = C.normalizedSearch(q)
    const newHit = !token
      ? true
      : B.buildSearchToken(orderOwned).includes(token) ||
        B.buildSearchToken(shipOwned).includes(token) ||
        B.buildSearchToken(opOwned).includes(token)
    assert.equal(newHit, oldHit, `split:"${q}"`)
  }
})

// ═══ 10. LIKE DESENİ ══════════════════════════════════════════════════════

test('PRJ-10: LIKE deseni kacisli, bos sorgu null', () => {
  assert.equal(B.buildSearchLikePattern(''), null)
  assert.equal(B.buildSearchLikePattern('   '), null)
  assert.equal(B.buildSearchLikePattern('abc'), '%abc%')
  assert.equal(B.buildSearchLikePattern('a%b'), '%a\\%b%')
  assert.equal(B.buildSearchLikePattern('a_b'), '%a\\_b%')
  // Aksan sorgu tarafinda da silinir.
  assert.equal(B.buildSearchLikePattern('Ömer'), '%omer%')
})

// ═══ 11. SAFLIK + SIR DIŞLAMA ═════════════════════════════════════════════

test('PRJ-11: builder SAF — ag/DB/decrypt/env YOK', () => {
  const code = BUILDER_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of [
    'process.env', 'fetch(', 'require(', 'decrypt', 'db.', 'drizzle', 'await ',
  ]) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
})

test('PRJ-12: projeksiyona SIR girmez', () => {
  const row = {
    ...B.buildOrderProjectionFragment({ customerName: 'Ali', marketplace: 'Trendyol' }),
    ...B.buildShipmentProjectionFragment({}),
    ...B.buildOperationProjectionFragment({}),
  }
  const keys = Object.keys(row).join(' ').toLowerCase()
  for (const secret of [
    'password', 'sifre', 'secret', 'apikey', 'webpassword', 'credential', 'payload',
  ]) {
    assert.equal(keys.includes(secret), false, secret)
  }
  assert.equal(row.projectionVersion, B.ORDER_FILTER_PROJECTION_VERSION)
})

// ═══ 13. ŞEMA + MIGRATION ═════════════════════════════════════════════════

test('PRJ-13: tablo tenant kapsamli, 1:1 ve siparisle birlikte silinir', () => {
  assert.match(SCHEMA_SOURCE, /order_filter_projection/)
  assert.match(SCHEMA_SOURCE, /order_filter_projection_org_order_unique/)
  assert.match(SCHEMA_SOURCE, /onDelete: 'cascade'/)
  assert.match(SCHEMA_SOURCE, /projectionVersion/)
  // Parca kolonlari kaynak yasam dongusune gore AYRI.
  for (const col of [
    'orderNumberOrderToken', 'orderNumberShipmentToken',
    'cargoSlipOrderToken', 'cargoSlipShipmentToken', 'cargoSlipOperationToken',
  ]) assert.match(SCHEMA_SOURCE, new RegExp(col), col)
})

test('PRJ-14: migration ADDITIVE — mevcut tablolara dokunmaz', () => {
  assert.match(MIGRATION, /CREATE TABLE.*order_filter_projection/s)
  // Yikici ifade YOK.
  for (const destructive of ['DROP TABLE', 'DROP COLUMN', 'ALTER COLUMN', 'TRUNCATE']) {
    assert.equal(MIGRATION.toUpperCase().includes(destructive), false, destructive)
  }
})

test('PRJ-15: SQL icinde normalizasyon YENIDEN YAZILMAMIS', () => {
  const sql = MIGRATION.toUpperCase()
  for (const forbidden of ['UNACCENT', 'GENERATED ALWAYS AS', 'REGEXP_REPLACE', 'LOWER(']) {
    assert.equal(sql.includes(forbidden), false, forbidden)
  }
  // Tek dogruluk kaynagi: uretim JS fonksiyonlari.
  assert.match(BUILDER_SOURCE, /from '\.\.\/\.\.\/src\/utils\/orderClassification\.ts'/)
})

// ═══ 16. OKUMA YOLU DEĞİŞMEDİ ═════════════════════════════════════════════

test('PRJ-16: okuma yolu bu unitede DEGISMEDI', () => {
  const projection = nl(
    readFileSync('server/orders/orderFilterProjection.ts', 'utf8'),
  )
  // Okuma yolu hâlâ kanonik JS filtresini kullaniyor; projeksiyon tablosu
  // heniz OKUNMUYOR (B2-1b-B'de baglanacak).
  assert.match(projection, /buildVisibleOrders/)
  assert.equal(projection.includes('orderFilterProjectionBuilder'), false)
  assert.equal(projection.includes('orderFilterProjectionRepository'), false)
  assert.equal(projection.includes('order_filter_projection'), false)
})
