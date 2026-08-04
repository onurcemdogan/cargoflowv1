import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Sürat create in-flight koruması: canonical sunucu sinyali + istemci
// Promise kaydı. Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const reg = () => load('/src/services/suratOperationRegistry.ts')

test('REG-1: canonical sunucu sinyali in-flight sayılır', async () => {
  const { hasPendingServerOperation } = await reg()
  assert.equal(hasPendingServerOperation({ operationStatus: 'SHIPMENT_PENDING' }), true)
  assert.equal(hasPendingServerOperation({ operationStatus: 'CREATE_IN_PROGRESS' }), true)
  assert.equal(hasPendingServerOperation({ operationStatus: 'shipment_pending' }), true)
  assert.equal(hasPendingServerOperation({ operationStatus: 'LABEL_READY' }), false)
  assert.equal(hasPendingServerOperation({}), false)
})

test('REG-2: aynı kimlik için İKİNCİ çağrı açılmaz, Promise yeniden kullanılır', async () => {
  const { runExclusiveOperation, resetOperationRegistry } = await reg()
  resetOperationRegistry()
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const task = async () => { calls += 1; await gate; return 'ok' }

  const first = runExclusiveOperation('tr:package:P1', task)
  const second = runExclusiveOperation('tr:package:P1', task)
  assert.equal(calls, 1, 'görev YALNIZ bir kez çalışır')
  assert.equal(first, second, 'aynı Promise döner')
  release()
  assert.equal(await first, 'ok')
  assert.equal(await second, 'ok')
})

test('REG-3: farklı kimlikler paralel çalışabilir', async () => {
  const { runExclusiveOperation, resetOperationRegistry, inFlightOperationCount } = await reg()
  resetOperationRegistry()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const a = runExclusiveOperation('tr:package:A', async () => { await gate; return 'a' })
  const b = runExclusiveOperation('tr:package:B', async () => { await gate; return 'b' })
  assert.equal(inFlightOperationCount(), 2)
  release()
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b'])
  assert.equal(inFlightOperationCount(), 0, 'terminal sonrası temizlenir')
})

test('REG-4: Promise terminal olunca kayıt temizlenir; retry SONRA mümkün', async () => {
  const { runExclusiveOperation, isOperationInFlight, resetOperationRegistry } = await reg()
  resetOperationRegistry()
  let calls = 0
  await runExclusiveOperation('tr:package:P1', async () => { calls += 1 })
  assert.equal(isOperationInFlight('tr:package:P1'), false, 'temizlendi')
  await runExclusiveOperation('tr:package:P1', async () => { calls += 1 })
  assert.equal(calls, 2, 'terminal sonrası retry çalışır')
})

test('REG-5: HATA durumunda da kayıt temizlenir (takılı kalmaz)', async () => {
  const { runExclusiveOperation, isOperationInFlight, resetOperationRegistry } = await reg()
  resetOperationRegistry()
  await assert.rejects(
    () => runExclusiveOperation('tr:package:P1', async () => {
      throw new Error('Sürat hatası.')
    }),
  )
  assert.equal(isOperationInFlight('tr:package:P1'), false, 'finally temizler')
  // Retry mümkün.
  assert.equal(await runExclusiveOperation('tr:package:P1', async () => 'ok'), 'ok')
})

test('REG-6: in-flight sipariş planlayıcıda create grubuna GİRMEZ', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const { hasPendingServerOperation } = await reg()
  const pending = {
    id: 'o-1', orderNumber: 'N1', packageId: 'P1', marketplace: 'Trendyol',
    operationStatus: 'SHIPMENT_PENDING',
  }
  const plan = resolveSuratCreateAndPrintPlan([pending], {
    isSuratOrder: () => true,
    resolveDesiBlock: () => null,
    resolveFitBlock: () => null,
    resolveDataBlock: () => null,
    hasPrintableLabel: () => false,
    isPrinted: () => false,
    isInFlight: (order) => hasPendingServerOperation(order),
  })
  assert.equal(plan.needsCreate.length, 0, 'create YOK')
  assert.equal(plan.inFlight.length, 1)
  assert.equal(plan.inFlight[0].stage, 'CREATE_IN_PROGRESS')
})

test('REG-7: App handler GERÇEK in-flight kaynağını kullanır (sabit false YOK)', () => {
  const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
  assert.equal(
    /isInFlight: \(\) => false/.test(app), false,
    'sabit false kaldırılmalı',
  )
  assert.match(app, /hasPendingServerOperation\(order\)/, 'canonical sunucu sinyali')
  assert.match(app, /isOperationInFlight\(orderPackageIdentity\(order\)\)/, 'istemci kaydı')
  // create Promise yeniden kullanımı bağlı.
  assert.match(app, /runExclusiveOperation\(identity, \(\) =>/)
  assert.match(app, /workflowService\.createShipments\(list, createIds, integrationConfig\)/)
})

test('REG-8: çakışan mutasyon/baskı butonları run sırasında DISABLED', () => {
  const controls = readFileSync(join(here, '..', 'src/components/SuratCreatePrintControls.tsx'), 'utf8')
  const actions = controls.slice(
    controls.indexOf('<div className="toolbar-actions">'),
    controls.indexOf(
      '</section>', controls.indexOf('<div className="toolbar-actions">'),
    ),
  )
  // Ana buton + eski aksiyonların HEPSİ run sırasında kilitlenir. Kilit artık
  // actionsLocked'tir: run SÜRERKEN veya baskı doğrulaması BEKLERKEN kapalı.
  const guarded = (actions.match(/actionsLocked/g) ?? []).length
  assert.ok(guarded >= 7, `run guard'ı yetersiz (${guarded})`)
  const controlsSrc = readFileSync(
    join(here, '..', 'src/components/SuratCreatePrintControls.tsx'), 'utf8')
  // Baskı doğrulaması kaldırıldı: kilit YALNIZ run süresince.
  assert.match(controlsSrc, /const actionsLocked = suratCreatePrintRunning/)
  assert.equal(/awaitingConfirmation/.test(controlsSrc), false)
  for (const label of [
    'Barkod Bas', 'Ortak Barkod Oluştur / Tamamla', 'ZPL İndir',
    'Kargoya Verildi Yap',
  ]) {
    assert.ok(actions.includes(label), `${label} korunmalı`)
  }
  // Butonlar KALDIRILMADI, handler'lar DEĞİŞMEDİ.
  for (const handler of [
    'onMarkPrinted', 'onCreateShipments', 'onDownloadZpl', 'onMarkHandedToCargo',
  ]) {
    assert.ok(actions.includes(handler), `${handler} korunmalı`)
  }
})

test('REG-9: registry PII TAŞIMAZ (yalnız canonical kimlik)', async () => {
  const { runExclusiveOperation, isOperationInFlight, resetOperationRegistry } = await reg()
  resetOperationRegistry()
  const identity = 'trendyol:package:PKG-1'
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const run = runExclusiveOperation(identity, async () => { await gate })
  assert.equal(isOperationInFlight(identity), true)
  // Kimlik yalnız marketplace + packageId taşır; müşteri verisi YOK.
  assert.equal(/YAGMUR|CADDESI|54\d{8}/.test(identity), false)
  release()
  await run
})
