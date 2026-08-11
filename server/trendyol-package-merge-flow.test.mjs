import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// TRENDYOL PAKET BIRLESTIRME — BAYAT STATU EZME HATASI.
//
// GOLDEN URETIM VAKASI (PII YOK):
//   orderNumber 11493372619 · packageId 4065907241
//   Trendyol panelinde: Kargoya Verildi
//   CargoFlow'da: Hazirlaniyor (Picking) + LABEL_PRINTED
//
// KOK NEDEN (kod duzeyinde kanitlandi): callTrendyolOrdersByStatuses TEK
// turda IKI gecis yapar —
//   1) statu-filtreli gecis        → paket GUNCEL statusuyle (Shipped)
//   2) filtresiz son-10-gun kesfi  → yalniz ACTIVE/bilinmeyen statuler
//                                    (Created/Picking/Invoiced) suzulur
// ve `mergeTrendyolPackageCollections(filtered, unfiltered)` eskiden
// `{...existing, ...item}` ile KOSULSUZ "son gelen kazanir" yapiyordu.
// Kesif gecisi IKINCI oldugu icin BAYAT Picking, Shipped'i EZIYORDU.
//
// Bu paket YALNIZ birlestirme determinizmini kilitler. Surat/SSP, ZPL,
// etiket, retention KAPSAM DISIDIR.

const SOURCE = readFileSync('server/index.mjs', 'utf8')

/**
 * `mergeTrendyolPackageCollections` + yardimcilarini index.mjs'ten izole
 * calistirir (express uygulamasini BOOT ETMEDEN).
 */
function loadMerge() {
  const names = [
    'function trendyolPackageModifiedAt',
    'function definedFieldsOf',
    'function getTrendyolPackageDedupKey',
    'function mergeTrendyolLines',
    'function mergeTrendyolPackageCollections',
  ]
  const lines = SOURCE.split(/\r?\n/)
  const blocks = names.map((needle) => {
    const start = lines.findIndex((line) => line.startsWith(needle))
    assert.ok(start >= 0, `bulunamadi: ${needle}`)
    const end = lines.findIndex((line, index) => index > start && line === '}')
    return lines.slice(start, end + 1).join('\n')
  })
  const factory = new Function(
    `${blocks.join('\n\n')}\nreturn { mergeTrendyolPackageCollections, trendyolPackageModifiedAt }`,
  )
  return factory()
}

const { mergeTrendyolPackageCollections } = loadMerge()

const GOLDEN = { packageId: '4065907241', orderNumber: '11493372619' }

const pkg = (status, lastModifiedDate, overrides = {}) => ({
  packageId: GOLDEN.packageId,
  orderNumber: GOLDEN.orderNumber,
  status,
  lastModifiedDate,
  lines: [],
  ...overrides,
})

test('TRENDYOL-GOLDEN-EXACT-PACKAGE: filtreli Shipped kaydi KORUNUR', () => {
  // Golden senaryo: filtreli gecis Shipped (yeni), kesif gecisi Picking (eski).
  const merged = mergeTrendyolPackageCollections(
    [pkg('Shipped', 1_760_000_000_000)],
    [pkg('Picking', 1_750_000_000_000)],
  )
  assert.equal(merged.length, 1, 'tek paket')
  assert.equal(merged[0].status, 'Shipped', 'BAYAT Picking EZEMEZ')
  assert.equal(merged[0].packageId, GOLDEN.packageId)
})

test('TRENDYOL-DUPLICATE-FRESHNESS: eski Picking + yeni Shipped → Shipped', () => {
  const merged = mergeTrendyolPackageCollections(
    [pkg('Picking', 1_750_000_000_000)],
    [pkg('Shipped', 1_760_000_000_000)],
  )
  assert.equal(merged[0].status, 'Shipped')
})

test('TRENDYOL-DUPLICATE-ORDER-INDEPENDENT: giris sirasi SONUCU DEGISTIRMEZ', () => {
  const older = pkg('Picking', 1_750_000_000_000)
  const newer = pkg('Shipped', 1_760_000_000_000)
  const forward = mergeTrendyolPackageCollections([newer], [older])
  const reversed = mergeTrendyolPackageCollections([older], [newer])
  assert.equal(forward[0].status, 'Shipped')
  assert.equal(reversed[0].status, 'Shipped')
  assert.equal(forward[0].status, reversed[0].status)
})

test('TRENDYOL-TIMESTAMP-MISSING: damgasiz kayit damgaliyi EZEMEZ', () => {
  const merged = mergeTrendyolPackageCollections(
    [pkg('Shipped', 1_760_000_000_000)],
    [pkg('Picking', undefined)],
  )
  assert.equal(merged[0].status, 'Shipped')
  // Ikisi de damgasizsa ILK gorulen korunur (deterministik).
  const bothMissing = mergeTrendyolPackageCollections(
    [pkg('Shipped', undefined)],
    [pkg('Picking', undefined)],
  )
  assert.equal(bothMissing[0].status, 'Shipped')
})

test('TRENDYOL-UNDEFINED-FIELD: eksik alan dolu alani SILMEZ', () => {
  const merged = mergeTrendyolPackageCollections(
    [pkg('Shipped', 1_760_000_000_000, { cargoTrackingNumber: '727000' })],
    [pkg(undefined, 1_770_000_000_000, { cargoTrackingNumber: undefined })],
  )
  assert.equal(merged[0].status, 'Shipped', 'status: undefined EZMEZ')
  assert.equal(merged[0].cargoTrackingNumber, '727000')
})

test('TRENDYOL-PACKAGE-REPLACEMENT: ayni orderNumber farkli paket AYRI kalir', () => {
  const merged = mergeTrendyolPackageCollections(
    [pkg('Picking', 1_750_000_000_000)],
    [
      pkg('Shipped', 1_760_000_000_000, {
        packageId: '4099999999',
      }),
    ],
  )
  assert.equal(merged.length, 2, 'farkli paketler birbirini EZMEZ')
  const byId = Object.fromEntries(
    merged.map((item) => [item.packageId, item.status]),
  )
  assert.equal(byId['4065907241'], 'Picking')
  assert.equal(byId['4099999999'], 'Shipped')
})

test('TRENDYOL-STATUS-FIELD: normalizer paket `status` alanini okur', () => {
  // Sozlesme: marketplaceStatus = normalizeStatus(item.status).
  assert.ok(
    SOURCE.includes('const marketplaceStatus = normalizeStatus(item.status)'),
    'normalizer kaynak alani `item.status` olmali',
  )
  // Kesif suzgeci status/packageStatus/shipmentPackageStatus'u birlikte okur.
  assert.ok(SOURCE.includes('item?.shipmentPackageStatus'))
})

test('TRENDYOL-MERGE-CONTRACT: kosulsuz "son gelen kazanir" KALDIRILDI', () => {
  const lines = SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('function mergeTrendyolPackageCollections'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end + 1).join('\n')
  assert.ok(body.includes('incomingIsNewer'), 'freshness karari bulunmali')
  assert.ok(body.includes('trendyolPackageModifiedAt'))
  assert.equal(
    body.includes('...existing,\n        ...item,'),
    false,
    'kosulsuz uzerine yazma OLMAMALI',
  )
})

test('TRENDYOL-MERGE-SCOPE: birlestirme Surat/etiket katmanina DOKUNMAZ', () => {
  const lines = SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('function mergeTrendyolPackageCollections'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end + 1).join('\n')
  for (const forbidden of ['surat', 'zpl', 'barkod', 'operationStatus']) {
    assert.equal(
      body.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      forbidden,
    )
  }
})
