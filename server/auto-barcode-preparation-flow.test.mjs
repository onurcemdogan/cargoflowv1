import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// B4 (GÜVENLİ KISIM) — OTOMATİK BARKOD HAZIRLIĞI SINIRI.
//
// Bu turda CANLI SÜRAT ÇAĞRISI YOK. Kurulan şey: deterministik uygunluk
// motoru + idempotent iş kimliği/kuyruğu + baskının taşıyıcıya ÇIKMADIĞININ
// kilidi.

const prep = await import('./shipping/autoBarcodePreparation.ts')
const nl = (v) => v.split('\r\n').join('\n')

const IDENTITY = {
  organizationId: 'org-1',
  marketplace: 'Trendyol',
  packageId: 'PKG-1',
  operation: 'CREATE',
}
const ELIGIBLE_INPUT = {
  organizationId: 'org-1',
  marketplace: 'Trendyol',
  packageId: 'PKG-1',
  operationStatus: 'NEW',
  marketplaceStatus: 'Created',
  suratConfigured: true,
}

test.beforeEach(() => prep.resetBarcodePrepQueue())

/* ═══ UYGUNLUK MOTORU ══════════════════════════════════════════════════ */

test('ELG-1: temiz yeni siparis UYGUN', () => {
  const result = prep.evaluateBarcodeEligibility(ELIGIBLE_INPUT)
  assert.equal(result.state, 'ELIGIBLE')
  assert.equal(result.reason, 'READY_FOR_PREPARATION')
})

test('ELG-2: yazdirilabilir etiket VARSA yeniden hazirlik YOK', () => {
  for (const input of [
    { ...ELIGIBLE_INPUT, operationStatus: 'LABEL_READY' },
    { ...ELIGIBLE_INPUT, operationStatus: 'LABEL_PRINTED' },
    { ...ELIGIBLE_INPUT, hasPrintableLabel: true },
  ]) {
    const result = prep.evaluateBarcodeEligibility(input)
    assert.equal(result.state, 'ALREADY_READY', JSON.stringify(input))
    assert.equal(result.reason, 'PRINTABLE_LABEL_EXISTS')
  }
})

test('ELG-3: kapanmis pazaryeri statusu ENGELLI', () => {
  for (const status of [
    'Shipped', 'Delivered', 'Cancelled', 'Returned', 'UnDelivered', 'UnSupplied',
  ]) {
    const result = prep.evaluateBarcodeEligibility({
      ...ELIGIBLE_INPUT, marketplaceStatus: status,
    })
    assert.equal(result.state, 'BLOCKED', status)
    assert.equal(result.reason, 'MARKETPLACE_STATUS_CLOSED')
  }
})

test('ELG-4: arsivlenmis siparis ENGELLI', () => {
  const result = prep.evaluateBarcodeEligibility({
    ...ELIGIBLE_INPUT, archivedAt: '2026-02-01T00:00:00.000Z',
  })
  assert.equal(result.state, 'BLOCKED')
  assert.equal(result.reason, 'ORDER_ARCHIVED')
})

test('ELG-5: eksik kimlik/yapilandirma UYGUN DEGIL', () => {
  const cases = [
    [{ ...ELIGIBLE_INPUT, organizationId: '' }, 'ORGANIZATION_MISSING'],
    [{ ...ELIGIBLE_INPUT, packageId: '' }, 'PACKAGE_ID_MISSING'],
    [{ ...ELIGIBLE_INPUT, marketplace: '' }, 'MARKETPLACE_MISSING'],
    [{ ...ELIGIBLE_INPUT, suratConfigured: false }, 'CARRIER_NOT_CONFIGURED'],
    [{ ...ELIGIBLE_INPUT, suratConfigured: undefined }, 'CARRIER_NOT_CONFIGURED'],
  ]
  for (const [input, reason] of cases) {
    const result = prep.evaluateBarcodeEligibility(input)
    assert.equal(result.state, 'NOT_ELIGIBLE', reason)
    assert.equal(result.reason, reason)
  }
})

test('ELG-6: kuyrukta is VARSA PENDING', () => {
  for (const jobState of ['PENDING', 'PROCESSING']) {
    const result = prep.evaluateBarcodeEligibility({ ...ELIGIBLE_INPUT, jobState })
    assert.equal(result.state, 'PENDING')
    assert.equal(result.reason, 'PREPARATION_ALREADY_QUEUED')
  }
})

test('ELG-7: motor SAF — ag/sifre cozme/tahmin YOK', () => {
  const raw = nl(readFileSync('server/shipping/autoBarcodePreparation.ts', 'utf8'))
  const code = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ')
  for (const forbidden of [
    'fetch(', 'axios', 'https://', 'suratWebApiClient', 'createCanonicalSuratShipment',
    'decrypt', 'getDb(', '.insert(', '.update(',
  ]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
})

/* ═══ İŞ KİMLİĞİ + İDEMPOTENSİ ═════════════════════════════════════════ */

test('JOB-1: is anahtari YALNIZ kalici kimlikten turer', () => {
  const first = prep.buildPrepJobKey(IDENTITY)
  const second = prep.buildPrepJobKey({ ...IDENTITY })
  assert.equal(first, second, 'anahtar DETERMINISTIK olmali')
  assert.equal(first, 'org-1::Trendyol::PKG-1::CREATE')
  // Tenant/pazaryeri/paket ayrimi.
  assert.notEqual(first, prep.buildPrepJobKey({ ...IDENTITY, organizationId: 'org-2' }))
  assert.notEqual(first, prep.buildPrepJobKey({ ...IDENTITY, packageId: 'PKG-2' }))
  assert.notEqual(first, prep.buildPrepJobKey({ ...IDENTITY, marketplace: 'Hepsiburada' }))
})

test('JOB-2: DUPLICATE 0 — ayni siparis 4 kez gorulse de TEK is', () => {
  const results = []
  // senkron cakismasi + manuel yenileme + zamanlanmis tur + yeniden baslatma
  for (let i = 0; i < 4; i += 1) {
    results.push(prep.enqueueBarcodePreparation(IDENTITY, ELIGIBLE_INPUT))
  }
  assert.equal(results.filter((r) => r.enqueued).length, 1, 'YALNIZ bir is')
  assert.equal(results.filter((r) => r.duplicate).length, 3)
  const snapshot = prep.getPrepQueueSnapshot('org-1')
  assert.equal(snapshot.PENDING, 1)
  const job = prep.getPrepJob(prep.buildPrepJobKey(IDENTITY))
  assert.equal(job.duplicateRequests, 3, 'tekrar sayisi gozlemlenebilir')
})

test('JOB-3: uygun OLMAYAN siparis kuyruga GIRMEZ', () => {
  const result = prep.enqueueBarcodePreparation(IDENTITY, {
    ...ELIGIBLE_INPUT, marketplaceStatus: 'Delivered',
  })
  assert.equal(result.enqueued, false)
  assert.equal(result.job, null)
  assert.equal(result.eligibility.state, 'BLOCKED')
  assert.deepEqual(prep.getPrepQueueSnapshot('org-1'), {
    PENDING: 0, PROCESSING: 0, READY: 0, BLOCKED: 0, FAILED_SAFE: 0,
  })
})

test('JOB-4: TENANT izolasyonu — ayni paket kimligi iki tenantta AYRI is', () => {
  prep.enqueueBarcodePreparation(IDENTITY, ELIGIBLE_INPUT)
  prep.enqueueBarcodePreparation(
    { ...IDENTITY, organizationId: 'org-2' },
    { ...ELIGIBLE_INPUT, organizationId: 'org-2' },
  )
  assert.equal(prep.getPrepQueueSnapshot('org-1').PENDING, 1)
  assert.equal(prep.getPrepQueueSnapshot('org-2').PENDING, 1)
})

test('JOB-5: durum makinesi kanonik yasam dongusuyle CELISMEZ', () => {
  const key = prep.buildPrepJobKey(IDENTITY)
  prep.enqueueBarcodePreparation(IDENTITY, ELIGIBLE_INPUT)

  // PENDING -> READY siçraması YASAK (hazırlık yapılmadan hazır denemez).
  assert.equal(prep.transitionPrepJob(key, 'READY').changed, false)
  assert.equal(prep.getPrepJob(key).state, 'PENDING')

  assert.equal(prep.transitionPrepJob(key, 'PROCESSING').changed, true)
  assert.equal(prep.transitionPrepJob(key, 'READY').changed, true)
  // READY terminaldir.
  assert.equal(prep.transitionPrepJob(key, 'PROCESSING').changed, false)
  assert.equal(prep.getPrepJob(key).state, 'READY')
})

test('JOB-6: BLOCKED/FAILED_SAFE tekrar denenebilir', () => {
  const key = prep.buildPrepJobKey(IDENTITY)
  prep.enqueueBarcodePreparation(IDENTITY, ELIGIBLE_INPUT)
  prep.transitionPrepJob(key, 'BLOCKED', { blockedReason: 'CARRIER_NOT_CONFIGURED' })
  assert.equal(prep.getPrepJob(key).blockedReason, 'CARRIER_NOT_CONFIGURED')
  assert.equal(prep.transitionPrepJob(key, 'PENDING').changed, true)
  assert.equal(prep.getPrepJob(key).blockedReason, null)
})

test('JOB-7: sayaclar ICERIK loglamaz', () => {
  prep.enqueueBarcodePreparation(IDENTITY, ELIGIBLE_INPUT)
  const snapshot = prep.getPrepQueueSnapshot('org-1')
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'BLOCKED', 'FAILED_SAFE', 'PENDING', 'PROCESSING', 'READY',
  ])
  for (const value of Object.values(snapshot)) {
    assert.equal(typeof value, 'number')
  }
})

/* ═══ CANLI İŞÇİ KAPISI ════════════════════════════════════════════════ */

test('LIVE-1: canli isci VARSAYILAN KAPALI', () => {
  assert.equal(prep.isLiveBarcodeWorkerEnabled({}), false)
  assert.equal(prep.isLiveBarcodeWorkerEnabled({ LIVE_SURAT_BARCODE_WORKER: '' }), false)
  assert.equal(prep.isLiveBarcodeWorkerEnabled({ LIVE_SURAT_BARCODE_WORKER: '1' }), false)
  assert.equal(prep.isLiveBarcodeWorkerEnabled({ LIVE_SURAT_BARCODE_WORKER: 'yes' }), false)
  assert.equal(prep.isLiveBarcodeWorkerEnabled({ LIVE_SURAT_BARCODE_WORKER: 'true' }), true)
  // Gerçek ortamda da kapalı (kazara açık kalmasın).
  assert.equal(prep.isLiveBarcodeWorkerEnabled(), false)
})

/* ═══ BASKI HIZLI YOLU — TAŞIYICI ÇAĞRISI 0 ════════════════════════════ */

test('PRINT-1: baski yetkisi KALICI artifacttan turer, create YAPMAZ', () => {
  const source = nl(readFileSync('src/utils/orderActionCapabilities.ts', 'utf8'))
  // Sözleşme yorumda AÇIKÇA yazılı ve kodda taşıyıcı çağrısı yok.
  assert.ok(source.includes('yeni Sürat provider create çağrısı YAPILMAZ'))
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ')
  for (const forbidden of [
    'fetch(', 'createCanonicalSuratShipment', 'OrtakBarkodOlustur', 'axios',
  ]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  // Yetki KALICI kanıttan: operationStatus + hasPrintableLabel.
  assert.ok(code.includes('hasPrintableLabel'))
  assert.ok(code.includes('LABEL_READY'))
})

test('PRINT-2: yeniden baski etiketi YENIDEN URETMEZ', () => {
  const source = nl(readFileSync('src/utils/browserLabelPrint.ts', 'utf8'))
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ')
  // Baskı yolu taşıyıcıya create atmaz.
  for (const forbidden of ['OrtakBarkodOlustur', 'createCanonicalSuratShipment']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
})
