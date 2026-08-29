import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Create SONRASI baskı: güncel sipariş kullanımı, sınırlı doğrulama, print host
// ve aşama bazlı sebepler. Veriler SENTETİKTİR; gerçek Sürat çağrısı YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
      // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
      // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
      // "server is being restarted or closed" hatası verir. SSR-only test
      // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
      // tarama tamamen kapatılır.
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')

const order = (index, extra = {}) => ({
  id: `o-${index}`,
  orderNumber: `TESTORD-${index}`,
  marketplace: 'Trendyol',
  packageId: `PKG-${index}`,
  items: [{ id: `l-${index}`, productName: 'Test Ürün', quantity: 1 }],
  ...extra,
})

// Create ONCESI "Barkod Bekliyor", SONRASI etiketli sipariş.
const withLabel = (index) => order(index, { labelReady: true })

async function runFlow(options = {}) {
  const { runSuratCreateAndPrint } = await load(
    '/src/services/suratCreateAndPrintOrchestrator.ts')
  const { buildCreateAdapter, buildPrintAdapter } = await load(
    '/src/services/suratOrchestratorDeps.ts')

  const before = options.orders ?? [order(1)]
  const printedWith = []
  const createdIds = []

  const outcome = await runSuratCreateAndPrint(before, before, {
    preflight: {
      isSuratOrder: () => true,
      resolveDesiBlock: () => null,
      resolveFitBlock: options.resolveFitBlock ?? (() => null),
      resolveDataBlock: () => null,
      hasPrintableLabel: (o) => Boolean(o.labelReady),
      isPrinted: (o) => Boolean(o.printed),
      isInFlight: () => false,
    },
    createShipments: buildCreateAdapter({
      callCreate: async (list, ids) => {
        createdIds.push(...ids)
        if (options.createReturnsLabel === false) return { orders: list }
        return {
          orders: list.map((item) =>
            ids.includes(String(item.id)) ? withLabel(item.id.slice(2)) : item),
        }
      },
      hasPrintableLabel: (o) => Boolean(o.labelReady),
      verifyAfterCreate: options.verifyAfterCreate,
    }),
    printLabels: buildPrintAdapter({
      callPrint: async (list, ids) => {
        // Baskı aşamasına GELEN listeyi kaydet (stale mi güncel mi?).
        printedWith.push(ids.map((id) =>
          list.find((item) => String(item.id) === String(id))))
        return { orders: list, printResult: options.printResult }
      },
    }),
    onOrdersUpdated: options.onOrdersUpdated,
  })
  return { outcome, printedWith, createdIds }
}

const jobsOk = (numbers) => ({
  ok: true, jobs: numbers.map((orderNumber) => ({ orderNumber, ok: true })),
})

// ---------------------------------------------------------------- 1
test('PCP-1: print host İLK AWAIT\'TEN ÖNCE, click stack\'inde hazırlanır', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  const prepareAt = handler.indexOf('prepareSuratPrintHostSynchronously()')
  const firstAwait = handler.indexOf('await ')
  assert.ok(prepareAt > 0, 'host hazırlığı çağrılmalı')
  assert.ok(
    prepareAt < firstAwait,
    'host ilk await\'ten ÖNCE hazırlanmalı',
  )
  // Zebra/native yolunda host GEREKMEZ.
  assert.match(handler, /printerSettings\.mode === 'browser-print'/)
})

// ---------------------------------------------------------------- 2
test('PCP-2: host hazır değilse create HİÇ çağrılmaz ve açık mesaj verilir', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  const guard = handler.slice(
    handler.indexOf('if (printHost && !printHost.ready)'),
    handler.indexOf('suratRunActive.current = true'),
  )
  assert.ok(guard.includes('return'), 'işlem durur')
  assert.ok(
    guard.includes('PRINT_HOST_UNAVAILABLE_MESSAGE'),
    'açık kullanıcı mesajı',
  )
  // Guard, create/orchestrator çağrısından ÖNCE gelir.
  assert.ok(
    handler.indexOf('if (printHost && !printHost.ready)') <
      handler.indexOf('runSuratCreateAndPrint('),
  )
})

// ---------------------------------------------------------------- 3
test('PCP-3: host mesajı güvenli ve açıklayıcıdır', async () => {
  const { PRINT_HOST_UNAVAILABLE_MESSAGE } = await load(
    '/src/utils/suratPrintFailureReasons.ts')
  assert.match(PRINT_HOST_UNAVAILABLE_MESSAGE, /açılır pencerelere izin/)
  assert.equal(/\^XA|technicalZpl/.test(PRINT_HOST_UNAVAILABLE_MESSAGE), false)
})

// ---------------------------------------------------------------- 4 + 5
test('PCP-4/5: baskıya GÜNCEL create sonucu gider, ESKİ snapshot GİTMEZ', async () => {
  const { printedWith, outcome } = await runFlow({
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.equal(printedWith.length, 1)
  const sent = printedWith[0][0]
  assert.ok(sent, 'sipariş baskı listesine girdi')
  assert.equal(sent.labelReady, true, 'GÜNCEL (etiketli) sipariş gönderildi')
  assert.equal(outcome.printed, 1)
})

test('PCP-5b: App callPrint stale state DEĞİL, orkestratör listesini kullanır', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  // `_list` ile atılan parametre KALMADI.
  assert.equal(/callPrint: async \(_list/.test(handler), false)
  assert.match(handler, /callPrint: async \(list, printIds\)/)
  assert.match(handler, /hydratePersistedLabels\(\s*printIds,\s*list,\s*\)/)
})

// ---------------------------------------------------------------- 6
test('PCP-6: create başarılı + güncel sipariş READY → AYNI run içinde print', async () => {
  const { outcome, createdIds, printedWith } = await runFlow({
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.deepEqual(createdIds, ['o-1'])
  assert.equal(printedWith.length, 1, 'print AYNI run içinde çağrıldı')
  assert.equal(outcome.created, 1)
  assert.equal(outcome.printed, 1)
  assert.deepEqual(outcome.printedOrderIds, ['o-1'])
})

// ---------------------------------------------------------------- 7
test('PCP-7: create sonrası etiket görünmüyor → print YOK, AÇIK sebep', async () => {
  const { outcome, printedWith } = await runFlow({
    createReturnsLabel: false,
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.equal(printedWith.length, 0, 'print çağrılmadı')
  assert.equal(outcome.printed, 0)
  assert.equal(outcome.failed.length, 1)
  assert.match(outcome.failed[0].reason, /etiketin oluştuğu teyit edilemedi/)
  assert.equal(/doğrulanmadı; durum/.test(outcome.failed[0].reason), false)
})

// ---------------------------------------------------------------- 8
test('PCP-8: sınırlı doğrulama sonrası READY bulunursa sipariş basılır', async () => {
  let verifyCalls = 0
  const { outcome, printedWith } = await runFlow({
    createReturnsLabel: false,
    verifyAfterCreate: async (list, ids) => {
      verifyCalls += 1
      return list.map((item) =>
        ids.includes(String(item.id)) ? withLabel(item.id.slice(2)) : item)
    },
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.equal(verifyCalls, 1, 'doğrulama YALNIZ bir kez')
  assert.equal(outcome.created, 1)
  assert.equal(printedWith.length, 1)
  assert.equal(printedWith[0][0].labelReady, true)
  assert.equal(outcome.printed, 1)
})

test('PCP-8b: doğrulama da etiketi bulamazsa sipariş failed kalır', async () => {
  const { outcome } = await runFlow({
    createReturnsLabel: false,
    verifyAfterCreate: async (list) => list,
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.equal(outcome.created, 0)
  assert.equal(outcome.failed.length, 1)
})

// ---------------------------------------------------------------- 9
test('PCP-9: READY sipariş → create YOK, print VAR', async () => {
  const { outcome, createdIds, printedWith } = await runFlow({
    orders: [withLabel(1)],
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.deepEqual(createdIds, [])
  assert.equal(outcome.existingReady, 1)
  assert.equal(printedWith.length, 1)
  assert.equal(outcome.printed, 1)
})

// ---------------------------------------------------------------- 10
test('PCP-10: PRINTED sipariş → create YOK, reprint VAR', async () => {
  const { outcome, createdIds } = await runFlow({
    orders: [order(1, { labelReady: true, printed: true })],
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.deepEqual(createdIds, [])
  assert.equal(outcome.created, 0)
  assert.equal(outcome.reprinted, 1)
  assert.equal(outcome.printed, 1)
})

// ---------------------------------------------------------------- 11 + 12
test('PCP-11/12: baskı motoru KALICI iframe\'i yeniden kullanır; window.open YOK', () => {
  // ═══ BASKI YIĞINI İKİ MODÜLE AYRILDI ═════════════════════════════════
  //
  // `prepareSuratPrintHostSynchronously` kullanıcı jestinde SENKRON çalışmak
  // zorundadır, bu yüzden `App` onu STATİK import eder. Aynı dosyada kalınca
  // JsBarcode + qrcode-generator + tüm render yığını da ilk yüke giriyordu
  // (ölçüldü: 685 kB → 575 kB fark). Host yaşam döngüsü `suratPrintHost`e
  // taşındı; render `browserLabelPrint`te kaldı.
  //
  // DEĞİŞMEZLER AYNEN GEÇERLİDİR ve artık İKİ dosyanın BİRLEŞİMİ üzerinde
  // ölçülür: böylece kod ileride tekrar bölünse bile bu kontrol kör kalmaz.
  const renderer = readFileSync(
    join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8',
  )
  const host = readFileSync(join(here, '..', 'src/utils/suratPrintHost.ts'), 'utf8')
  const src = `${renderer}\n${host}`
  assert.equal(/window\.open\(/.test(src), false, 'window.open kullanılmaz')
  // Tek host: ensurePersistentPrintFrame hem hazırlıkta hem baskıda çağrılır ve
  // mevcut frame'i YENİDEN KULLANIR.
  assert.match(src, /if \(\s*persistentPrintFrame &&/)
  assert.match(src, /IFRAME_REUSED/)
  const prepare = src.slice(
    src.indexOf('export function prepareSuratPrintHostSynchronously'),
    src.indexOf('export function reserveCleanLabelPrintWindow'),
  )
  assert.match(prepare, /ensurePersistentPrintFrame\('host-prepare'\)/)
  assert.equal(
    (src.match(/document\.createElement\('iframe'\)/g) ?? []).length, 1,
    'iframe YALNIZ tek yerde oluşturulur',
  )
  // Tekil frame durumu TEK sahibe aittir: renderer kendi kopyasını TUTMAZ.
  assert.equal(
    (renderer.match(/let persistentPrintFrame/g) ?? []).length, 0,
    'renderer ikinci bir iframe durumu tutuyor',
  )
  assert.equal(
    (host.match(/let persistentPrintFrame/g) ?? []).length, 1,
    'host tekil iframe durumunun TEK sahibi olmalı',
  )
})

// ---------------------------------------------------------------- 13
test('PCP-13: printResult YOKSA hiçbir durum/sayaç değişmez', async () => {
  const { outcome } = await runFlow({ printResult: undefined })
  assert.equal(outcome.printed, 0)
  assert.deepEqual(outcome.printedOrderIds, [])
  assert.equal(outcome.reprinted, 0)
})

// ---------------------------------------------------------------- 14
test('PCP-14: baskı doğrulaması İSTENMEZ; teknik koşullar karar verir', async () => {
  const { resolveBrowserPrintJobs, hasPrintedDocument } = await load(
    '/src/providers/printing/BrowserDownloadPrintProvider.ts')

  // print çağrıldı + sipariş belgeye girdi -> BAŞARILI (kullanıcıya soru YOK).
  const ok = resolveBrowserPrintJobs(
    { printCalled: true, printedOrderNumbers: ['TESTORD-1'] },
    ['TESTORD-1'],
  )
  assert.equal(ok.printed, true)
  assert.equal(ok.jobs[0].ok, true)
  assert.ok(ok.jobs[0].printJobId)

  // print ÇAĞRILMADI -> başarı YOK.
  const noPrint = resolveBrowserPrintJobs(
    { printCalled: false, printedOrderNumbers: ['TESTORD-1'] },
    ['TESTORD-1'],
  )
  assert.equal(noPrint.printed, false)
  assert.equal(noPrint.jobs[0].ok, false)
  assert.equal(
    hasPrintedDocument({ printCalled: false, printedOrderNumbers: ['TESTORD-1'] },
      ['TESTORD-1']),
    false,
  )
})

test('PCP-14b: belgeye girmeyen sipariş başarılı SAYILMAZ', async () => {
  const { resolveBrowserPrintJobs } = await load(
    '/src/providers/printing/BrowserDownloadPrintProvider.ts')
  const decision = resolveBrowserPrintJobs(
    { printCalled: true, printedOrderNumbers: [] },
    ['TESTORD-1'],
  )
  assert.equal(decision.printed, false)
  assert.equal(decision.jobs[0].ok, false)
})

// ---------------------------------------------------------------- 15
test('PCP-15: kısmi batch — YALNIZ belgeye giren işler başarılıdır', async () => {
  const { resolveBrowserPrintJobs } = await load(
    '/src/providers/printing/BrowserDownloadPrintProvider.ts')
  const decision = resolveBrowserPrintJobs(
    {
      printCalled: true,
      printedOrderNumbers: ['TESTORD-1'],
      skipped: [
        { orderNumber: 'TESTORD-2', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
      ],
    },
    ['TESTORD-1', 'TESTORD-2'],
  )
  assert.equal(decision.printed, true)
  assert.equal(decision.jobs[0].ok, true)
  assert.equal(decision.jobs[1].ok, false)
  assert.match(decision.jobs[1].errorMessage, /sığmıyor/)
})

test('PCP-15b: baskı motoru hata verirse her sipariş KENDİ sebebini alır', async () => {
  const { BrowserDownloadPrintProvider } = await load(
    '/src/providers/printing/BrowserDownloadPrintProvider.ts')
  // Node'da document yok: printCleanLabelDocument başarısız olur.
  const provider = new BrowserDownloadPrintProvider()
  const result = await provider.print({
    orders: [{ orderNumber: 'TESTORD-1', label: { zplContent: 'X' } }],
    printerSettings: { mode: 'browser-print', printerName: 'test' },
    action: 'print',
  })
  assert.equal(result.ok, false)
  assert.equal(Array.isArray(result.jobs), true, 'jobs BOŞ BIRAKILMAZ')
  assert.equal(result.jobs[0].ok, false)
  assert.ok(String(result.jobs[0].errorMessage).length > 0)
})

// ---------------------------------------------------------------- 16
test('PCP-16: product overflow siparişi DIŞARIDA kalır, diğerleri basılır', async () => {
  const { outcome, printedWith } = await runFlow({
    orders: [withLabel(1), withLabel(2)],
    resolveFitBlock: (o) =>
      String(o.id) === 'o-2' ? 'Ürün bilgileri tek etikete sığmıyor.' : null,
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.equal(printedWith[0].length, 1)
  assert.equal(printedWith[0][0].orderNumber, 'TESTORD-1')
  assert.equal(outcome.printed, 1)
  assert.equal(outcome.skipped.length, 1)
  assert.match(outcome.skipped[0].reason, /sığmıyor/)
})

// ---------------------------------------------------------------- 17
test('PCP-17: hiç printable yoksa print ÇAĞRILMAZ ve host serbest bırakılır', async () => {
  const { outcome, printedWith } = await runFlow({
    orders: [withLabel(1)],
    resolveFitBlock: () => 'Ürün bilgileri tek etikete sığmıyor.',
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.equal(printedWith.length, 0, 'print çağrısı YOK')
  assert.equal(outcome.printed, 0)
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /if \(outcome\.printed === 0\) printHost\?\.release\(\)/)
})

// ---------------------------------------------------------------- 18
test('PCP-18: create biter bitmez GÜNCEL orders UI\'a verilir', async () => {
  const updates = []
  await runFlow({
    onOrdersUpdated: (list) => updates.push(list),
    printResult: jobsOk(['TESTORD-1']),
  })
  assert.equal(updates.length, 1, 'create sonrası TEK tazeleme')
  assert.equal(updates[0][0].labelReady, true, 'canonical etiketli durum')
  // App bunu state'e yazar; seçim DEĞİŞTİRİLMEZ.
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  const block = handler.slice(
    handler.indexOf('onOrdersUpdated: (updated)'),
    handler.indexOf('onOrdersUpdated: (updated)') + 320,
  )
  assert.match(block, /setOrdersState/)
  assert.equal(/setSelectedIds/.test(block), false, 'seçim korunur')
})

// ---------------------------------------------------------------- 19
test('PCP-19: baskı başarısız olsa bile İKİNCİ create planlanmaz', async () => {
  const { outcome, createdIds } = await runFlow({
    printResult: { ok: true, jobs: [{ orderNumber: 'TESTORD-1', ok: false }] },
  })
  assert.deepEqual(createdIds, ['o-1'], 'create YALNIZ bir kez')
  assert.equal(outcome.created, 1)
  assert.equal(outcome.printed, 0)
  // Sipariş READY kalır; seçimden çıkmaz.
  assert.deepEqual(outcome.printedOrderIds, [])
})

// ---------------------------------------------------------------- 20
test('PCP-20: hızlı çift click → tek host, tek run', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  // Run guard host hazırlığından SONRA ama create'ten ÖNCE set edilir; ikinci
  // click erken döner.
  assert.match(handler, /if \(ids\.length === 0 \|\| suratRunActive\.current\) return/)
  assert.ok(
    handler.indexOf('suratRunActive.current') <
      handler.indexOf('prepareSuratPrintHostSynchronously()'),
    'guard host hazırlığından önce kontrol edilir',
  )
  const src = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  assert.match(src, /activePrintExecution/, 'baskı motorunda da tek yürütme')
})

// ---------------------------------------------------------------- 21
test('PCP-21: registry ve idempotency korunur', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /runExclusiveOperation\(identity, \(\) =>/)
  assert.match(handler, /hasPendingServerOperation\(order\)/)
  assert.match(handler, /isOperationInFlight\(orderPackageIdentity\(order\)\)/)
})

// ---------------------------------------------------------------- 22
test('PCP-22: eski butonlar ve handler\'ları korunur', () => {
  const page = readFileSync(
    join(here, '..', 'src/components/SuratCreatePrintControls.tsx'), 'utf8')
  for (const [prop, handler] of [
    ['onMarkPrinted', 'handleMarkPrinted'],
    ['onCreateShipments', 'handleCreateShipments'],
    ['onDownloadZpl', 'handleDownloadZpl'],
    ['onMarkHandedToCargo', 'handleMarkHandedToCargo'],
  ]) {
    assert.ok(app.includes(`${prop}={${handler}}`), `${prop} → ${handler}`)
    assert.ok(page.includes(prop), `${prop} render edilir`)
  }
})

// ---------------------------------------------------------------- 23
test('PCP-23: kayıtlı ZPL byte-for-byte korunur (yeniden üretim YOK)', () => {
  const src = readFileSync(join(here, '..', 'src/utils/persistedLabel.ts'), 'utf8')
  const before = readFileSync(
    join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  // Bu düzeltme ZPL üretim/dönüştürme yolu EKLEMEZ.
  assert.equal(/\^XA/.test(before.slice(
    before.indexOf('prepareSuratPrintHostSynchronously'),
    before.indexOf('export function reserveCleanLabelPrintWindow'),
  )), false, 'host hazırlığı ZPL üretmez')
  assert.ok(src.length > 0)
})

// ---------------------------------------------------------------- 24
test('PCP-24: yeni sebepler ve izler PII/ZPL TAŞIMAZ', async () => {
  const reasons = await load('/src/utils/suratPrintFailureReasons.ts')
  for (const [name, value] of Object.entries(reasons)) {
    assert.equal(typeof value, 'string', name)
    assert.equal(
      /\^XA|\^XZ|customerName|address|phone|apiKey|password/i.test(value),
      false,
      `${name} güvenli olmalı`,
    )
  }
  const src = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  const prepare = src.slice(
    src.indexOf('export function prepareSuratPrintHostSynchronously'),
    src.indexOf('export function reserveCleanLabelPrintWindow'),
  )
  // Trace yalnız güvenli metadata yazar.
  assert.equal(/customerName|address|barcodeRaw/.test(prepare), false)
})
