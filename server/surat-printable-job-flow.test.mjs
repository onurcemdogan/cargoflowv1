import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// BASKI İŞİ KURUCUSU — SIRA, TAMLIK VE TEK-İŞ SÖZLEŞMESİ.
//
// Bu paket AŞAMA 3'ün merkezi helper'ını kilitler. Serving DTO ve UI
// kablolaması AYRI turda gelecek; helper ONLARDAN ÖNCE doğrulanır ki
// "yardımcı doğru, kablolama yanlış" hatası tekrar etmesin.

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

const mod = () => load('/src/utils/printableLabelJob.ts')
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

const CARRIER = '^XA^PW799^LL0799^FDCARRIER^FS^XZ'
const page = (n, total, body = `DETAY-${n}`) => {
  const zpl = `^XA^PW799^LL0799^FD${body}^FS^XZ`
  return { kind: 'product_detail', page: n, totalPages: total, zpl, sha256: hash(zpl) }
}

// ═══ SERVE-1..3: SAYFA SAYISI ════════════════════════════════════════════

test('SERVE-1: eski artefakt (ek sayfa yok) → TEK sayfa, geçerli iş', async () => {
  const { buildPrintableJob } = await mod()
  for (const input of [
    { carrierZpl: CARRIER },
    { carrierZpl: CARRIER, supplementalLabels: [] },
    { carrierZpl: CARRIER, supplementalLabels: undefined },
  ]) {
    const job = buildPrintableJob(input)
    assert.equal(job.printReady, true)
    assert.equal(job.labelPageCount, 1)
    assert.equal(job.productDetailPageCount, 0)
    assert.equal(job.pages[0].kind, 'carrier')
    assert.equal(job.combinedZpl, CARRIER)
  }
})

test('SERVE-2/3: ek sayfalı bundle → taşıyıcı + N sayfa', async () => {
  const { buildPrintableJob } = await mod()
  const job = buildPrintableJob({
    carrierZpl: CARRIER,
    supplementalLabels: [page(1, 2), page(2, 2)],
    hash,
  })
  assert.equal(job.printReady, true)
  assert.equal(job.labelPageCount, 3)
  assert.equal(job.productDetailPageCount, 2)
})

// ═══ SERVE-4..6: SIRA VE SAYFA SÖZLEŞMESİ ════════════════════════════════

test('SERVE-4: taşıyıcı HER ZAMAN ilk', async () => {
  const { buildPrintableJob } = await mod()
  const job = buildPrintableJob({
    carrierZpl: CARRIER,
    supplementalLabels: [page(1, 2), page(2, 2)],
    hash,
  })
  assert.equal(job.pages[0].kind, 'carrier')
  assert.ok(job.combinedZpl.startsWith(CARRIER))
  assert.ok(
    job.combinedZpl.indexOf('CARRIER') < job.combinedZpl.indexOf('DETAY-1'),
  )
})

test('SERVE-5: ek sayfalar 1..N sırasında', async () => {
  const { buildPrintableJob } = await mod()
  const job = buildPrintableJob({
    carrierZpl: CARRIER,
    supplementalLabels: [page(1, 3), page(2, 3), page(3, 3)],
    hash,
  })
  assert.deepEqual(
    job.pages.map((entry) => entry.kind),
    ['carrier', 'product_detail', 'product_detail', 'product_detail'],
  )
  const order = job.pages.slice(1).map((entry) => entry.page)
  assert.deepEqual(order, [1, 2, 3])
  // Birleşik yükte de aynı sıra.
  const positions = ['DETAY-1', 'DETAY-2', 'DETAY-3'].map((token) =>
    job.combinedZpl.indexOf(token),
  )
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
})

test('SERVE-6: birleşik işte ^XA/^XZ sayısı sayfa sayısına EŞİT', async () => {
  const { buildPrintableJob } = await mod()
  for (const count of [0, 1, 2, 4]) {
    const supplementalLabels = Array.from({ length: count }, (_, index) =>
      page(index + 1, count),
    )
    const job = buildPrintableJob({ carrierZpl: CARRIER, supplementalLabels, hash })
    assert.equal(job.labelPageCount, count + 1)
    assert.equal((job.combinedZpl.match(/\^XA/g) ?? []).length, job.labelPageCount)
    assert.equal((job.combinedZpl.match(/\^XZ/g) ?? []).length, job.labelPageCount)
  }
})

// ═══ SERVE-7..8: BOZUK BUNDLE → BASKI ENGELLENİR ═════════════════════════

test('SERVE-7: sayfa hash uyuşmazlığı → baskı ENGELLENİR', async () => {
  const { buildPrintableJob } = await mod()
  const tampered = { ...page(1, 1), sha256: hash('baska icerik') }
  const job = buildPrintableJob({
    carrierZpl: CARRIER,
    supplementalLabels: [tampered],
    hash,
  })
  assert.equal(job.printReady, false)
  assert.equal(job.reason, 'supplemental_hash_mismatch')
  // TAŞIYICI TEK BAŞINA BASILMAZ.
  assert.equal(job.pages.length, 0)
  assert.equal(job.combinedZpl, '')
  assert.equal(job.labelPageCount, 0)
})

test('SERVE-8: eksik / sırasız / tutarsız sayfa → baskı ENGELLENİR', async () => {
  const { buildPrintableJob } = await mod()
  const cases = [
    [[{ ...page(1, 2), zpl: '' }, page(2, 2)], 'supplemental_page_missing'],
    [[page(2, 2), page(1, 2)], 'supplemental_order_invalid'],
    [[page(1, 5)], 'supplemental_total_mismatch'],
  ]
  for (const [supplementalLabels, reason] of cases) {
    const job = buildPrintableJob({ carrierZpl: CARRIER, supplementalLabels, hash })
    assert.equal(job.printReady, false, reason)
    assert.equal(job.reason, reason)
    assert.equal(job.pages.length, 0, 'kısmi baskı YOK')
  }
  // Taşıyıcı yoksa da iş üretilmez.
  const empty = buildPrintableJob({ carrierZpl: '   ' })
  assert.equal(empty.printReady, false)
  assert.equal(empty.reason, 'carrier_missing')
})

// ═══ SERVE-9..10: KALICI BAYT, YENİDEN ÜRETİM YOK ════════════════════════

test('SERVE-9/10: yalnız verilen baytlar kullanılır — üretim/toplama YOK', async () => {
  const { buildPrintableJob } = await mod()
  const pages = [page(1, 2, 'OZGUN-A'), page(2, 2, 'OZGUN-B')]
  const job = buildPrintableJob({
    carrierZpl: CARRIER,
    supplementalLabels: pages,
    hash,
  })
  // Çıktı baytları GİRDİYLE birebir.
  assert.equal(job.pages[1].zpl, pages[0].zpl)
  assert.equal(job.pages[2].zpl, pages[1].zpl)
  assert.ok(job.combinedZpl.includes('OZGUN-A'))
  assert.ok(job.combinedZpl.includes('OZGUN-B'))
  // Modül ürün/kompozisyon bağımlılığı TAŞIMAZ (kaynak düzeyinde kilit).
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('src/utils/printableLabelJob.ts', 'utf8')
  assert.equal(
    /aggregateProductLineItems|planProductDetailPages|composeSuratDurusoftLabel|renderZplToPng/.test(
      source,
    ),
    false,
    'baskı işi kurucusu ÜRETİM yapmamalı',
  )
})

// ═══ SERVE-11: TOPLU İŞ — GÖNDERİ BAZINDA SIRA ═══════════════════════════

test('SERVE-11: toplu işte her taşıyıcı KENDİ ek sayfalarından önce gelir', async () => {
  const { buildBatchPrintableJob } = await mod()
  const carrier = (name) => `^XA^FD${name}^FS^XZ`
  const detail = (name, n, total) => {
    const zpl = `^XA^FD${name}-D${n}^FS^XZ`
    return { kind: 'product_detail', page: n, totalPages: total, zpl, sha256: hash(zpl) }
  }
  const job = buildBatchPrintableJob([
    { carrierZpl: carrier('A') },
    { carrierZpl: carrier('B'), supplementalLabels: [detail('B', 1, 2), detail('B', 2, 2)], hash },
    { carrierZpl: carrier('C'), supplementalLabels: [detail('C', 1, 1)], hash },
  ])
  assert.equal(job.printReady, true)
  assert.equal(job.labelPageCount, 6)
  assert.equal(job.productDetailPageCount, 3)
  // Ek sayfalar İŞİN SONUNA TOPLANMAZ.
  const tokens = ['A^FS', 'B^FS', 'B-D1', 'B-D2', 'C^FS', 'C-D1']
  const positions = tokens.map((token) => job.combinedZpl.indexOf(token))
  assert.ok(positions.every((value) => value >= 0), 'tüm sayfalar var')
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'sıra korunur')
})

test('SERVE-12: toplu işte TEK gönderi bile bozuksa iş ÜRETİLMEZ', async () => {
  const { buildBatchPrintableJob } = await mod()
  const job = buildBatchPrintableJob([
    { carrierZpl: CARRIER },
    { carrierZpl: CARRIER, supplementalLabels: [{ ...page(1, 1), sha256: 'bozuk' }], hash },
  ])
  assert.equal(job.printReady, false)
  assert.equal(job.reason, 'supplemental_hash_mismatch')
  assert.equal(job.pages.length, 0)
  assert.equal(job.combinedZpl, '')
})
