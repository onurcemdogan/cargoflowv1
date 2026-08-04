import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Tek-buton UI wiring'i: App.tsx handler + OrdersPage buton/progress/sonuç.
// Kaynak tabanlı sözleşme kilidi (React render harness'i yok).

const here = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
const page = readFileSync(join(here, '..', 'src/pages/OrdersPage.tsx'), 'utf8')
// Tek-buton bolumu davranis degistirmeden ayri bilesene tasindi; kaynak
// sozlesmesi ORADA kilitlenir (gercek DOM testi: src/test/*.dom.test.tsx).
const controls = readFileSync(join(here, '..', 'src/components/SuratCreatePrintControls.tsx'), 'utf8')
// Asama metni saf yardimciya ayrildi (react-refresh: bilesen dosyasi yalniz
// bilesen export eder).
const phaseText = readFileSync(join(here, '..', 'src/utils/suratPhaseText.ts'), 'utf8')

test('UI-1: buton seçim yokken ve işlem sürerken DISABLED', () => {
  const block = controls.slice(
    controls.indexOf('surat-one-click-button'),
    controls.indexOf('onClick={onMarkPrinted}'),
  )
  assert.match(block, /disabled=\{/)
  assert.match(block, /suratCreatePrintRunning/, 'işlem sürerken disabled')
  assert.match(block, /selectedIds\.length === 0/, 'seçim yokken disabled')
  assert.match(block, /busy \|\|/, 'genel busy durumu da engeller')
})

test('UI-2: buton SEÇİM üzerinden çalışır, görünür listeden DEĞİL', () => {
  // Ortak, provider-bagimsiz giris noktasi (Siparisler + Detay + Dashboard).
  assert.match(app, /handleCreateAndPrintCarrierLabelsForIds\(selectedIds\)/)
  assert.match(
    app,
    /function handleCreateAndPrintCarrierLabelsForIds[\s\S]*?handleSuratCreateAndPrintForIds\(ids\)/,
    'wrapper mevcut akisa yonlendirir',
  )
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /const snapshotIds = \[\.\.\.ids\]/, 'immutable snapshot')
  assert.equal(
    /filteredOrders|visibleOrders/.test(handler), false,
    'görünür liste kullanılmıyor',
  )
})

test('UI-3: ikinci hızlı tıklama YENİ run başlatmaz', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /if \(ids\.length === 0 \|\| suratRunActive\.current\) return/)
  assert.match(handler, /suratRunActive\.current = true/)
  assert.match(handler, /suratRunGeneration\.current \+= 1/, 'generation guard')
})

test('UI-4: handler MEVCUT servisleri kullanır, iş mantığı KOPYALANMAZ', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /runSuratCreateAndPrint\(/, 'orchestrator çağrılır')
  assert.match(handler, /buildCreateAdapter\(/)
  assert.match(handler, /buildPrintAdapter\(/)
  assert.match(handler, /workflowService\.createShipments\(/)
  assert.match(handler, /workflowService\.printLabels\(/)
  // Yeni endpoint / lifecycle YOK.
  assert.equal(/fetch\(/.test(handler), false, 'yeni endpoint yok')
  assert.equal(/OrtakBarkod|SOAP/.test(handler), false, 'provider mantığı yok')
})

test('UI-5: başarı YALNIZ orchestrator çıktısından; UI yeniden yorumlamaz', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(
    handler,
    /resolveSelectionAfterBatch\(current, outcome\.printedOrderIds\)/,
    'yalnız doğrulanmış başarılılar seçimden çıkar',
  )
  // printCalled başarı sayılmaz.
  assert.equal(/printCalled/.test(handler), false)
  assert.equal(/printResult\.ok/.test(handler), false, 'global ok tek başına kullanılmaz')
})

test('UI-6: loading state finally ile HER koşulda temizlenir', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /\} finally \{/)
  assert.match(handler, /suratRunActive\.current = false/)
  assert.match(handler, /setSuratRunning\(false\)/)
  assert.match(handler, /catch \(error\)/, 'hata yakalanır')
})

test('UI-7: unmount ve eski run korumaları var', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /mounted\.current && generation === suratRunGeneration\.current/)
  assert.match(handler, /if \(!isCurrent\(\)\) return/)
  assert.match(app, /mounted\.current = false/, 'unmount temizliği')
})

test('UI-8: progress GERÇEK completed/total kullanır, yüzde uydurulmaz', () => {
  assert.match(phaseText, /Ön kontrol yapılıyor…/)
  assert.match(
    phaseText,
    /Kargo etiketleri oluşturuluyor: \$\{progress\.completed\}\/\$\{progress\.total\}/,
  )
  assert.match(
    phaseText,
    /Etiketler hazırlanıyor: \$\{progress\.completed\}\/\$\{progress\.total\}/,
  )
  assert.match(phaseText, /Yazdırma bekleniyor…/)
  assert.match(phaseText, /Sonuçlar işleniyor…/)
  assert.equal(
    /Math\.round\([^)]*100\)/.test(phaseText + controls), false,
    'yüzde hesaplanmıyor',
  )
  // Bileşen metni KOPYALAMAZ, saf yardımcıyı çağırır.
  assert.match(controls, /resolveSuratPhaseText\(/)
})

test('UI-9: yeni run progress ve sonucu SIFIRLAR', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /setSuratProgress\(undefined\)/)
  assert.match(handler, /setSuratResult\(undefined\)/)
})

test('UI-10: sonuç paneli aggregate alanlarını gösterir', () => {
  const panel = controls.slice(
    controls.indexOf('surat-batch-result'),
    controls.indexOf('<section className="toolbar">'),
  )
  for (const label of [
    'Seçilen:', 'Yeni oluşturulan:', 'Hazır etiket:', 'Tekrar baskı:',
    'Yazdırılan:', 'Atlanan:', 'Başarısız:',
  ]) {
    assert.ok(panel.includes(label), `${label} gösterilmeli`)
  }
  // Başlıklar PROVIDER-BAĞIMSIZ. Baskı doğrulaması KALDIRILDI: "doğrulanmadı"
  // kategorisi ve onay bekleyen panel ARTIK YOK.
  for (const status of [
    'Kargo etiketi işlemi tamamlandı',
    'Kargo etiketi işlemi kısmen tamamlandı',
    'Kargo etiketi işlemi tamamlanamadı',
  ]) {
    assert.ok(panel.includes(status), `${status} durumu`)
  }
  assert.equal(panel.includes('Baskı doğrulanmadı'), false)
  assert.equal(panel.includes('Yeniden yazdırılabilir:'), false)
  assert.equal(controls.includes('Evet, çıktı'), false)
  assert.equal(controls.includes('Hayır, çıkmadı'), false)
  assert.match(panel, /<details>/, 'detaylar açılır bölümde')
})

test('UI-11: sonuç detayında PII alanı GÖSTERİLMEZ', () => {
  const panel = controls.slice(
    controls.indexOf('surat-batch-result'),
    controls.indexOf('<section className="toolbar">'),
  )
  for (const pii of [
    'customerName', 'address', 'customerPhone', 'barcodeRaw',
    'zplContent', 'technicalZpl', 'rawResponse',
  ]) {
    assert.equal(panel.includes(pii), false, `PII alanı sızdı: ${pii}`)
  }
  // Yalnız sipariş no + aşama + sebep.
  assert.match(panel, /item\.orderNumber/)
  assert.match(panel, /item\.stage/)
  assert.match(panel, /item\.reason/)
})

test('UI-12: ESKİ butonlar korunur ve ESKİ handler\'larına bağlıdır', () => {
  for (const [prop, handler] of [
    ['onMarkPrinted', 'handleMarkPrinted'],
    ['onCreateShipments', 'handleCreateShipments'],
    ['onDownloadZpl', 'handleDownloadZpl'],
    ['onMarkHandedToCargo', 'handleMarkHandedToCargo'],
    ['onTrackShipments', 'handleTrackShipments'],
  ]) {
    assert.ok(
      app.includes(`${prop}={${handler}}`),
      `${prop} → ${handler} bağlantısı korunmalı`,
    )
    assert.ok(
      page.includes(prop) || controls.includes(prop),
      `${prop} orders yüzeyinde kullanılmalı`,
    )
  }
})

test('UI-13: ana buton eski butonları KALDIRMADAN eklenmiş', () => {
  const actions = controls.slice(
    controls.indexOf('<div className="toolbar-actions">'),
    controls.indexOf(
      '</section>', controls.indexOf('<div className="toolbar-actions">'),
    ),
  )
  assert.match(actions, /surat-one-click-button/, 'yeni buton var')
  assert.match(actions, /onClick=\{onMarkPrinted\}/, 'eski buton duruyor')
  assert.match(actions, /primary-button/, 'yeni buton birincil')
})

test('UI-14: seçim özeti snapshot\'tan gelir (0/0/0 regresyonu kapalı)', () => {
  assert.match(controls, /selectionCounts\.packageCount/)
  assert.match(controls, /buildSelectedOrderSnapshot\(orders, selectedIds/)
  assert.match(controls, /describeSelectionOutsideView/)
  // OrdersPage bileşeni GERÇEK seçim ve tüm siparişlerle besler.
  assert.match(page, /orders=\{orders\}/)
  assert.match(page, /selectedIds=\{selectedIds\}/)
})

test('UI-15: preflight gerçek yardımcılardan beslenir', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /resolveEffectiveLabelDesi\(/, 'desi mevcut yardımcıdan')
  // Product-fit artik TEK yerleşim cozumleyicisi uzerinden gelir; on kontrol
  // ile renderer AYNI profili secer.
  assert.match(handler, /resolveLabelLayoutBlockReason\(/, 'tek kaynak cozumleyici')
  assert.match(handler, /resolvePersistedLabelArtifact\(/, 'etiket mevcut resolver')
  // Tasma sebebi ARTIK cozumleyiciden gelir (App'te sabit metin yok);
  // guvenli sebep sozlesmesi labelLayoutResolver'da kilitlidir.
  const resolver = readFileSync(
    join(here, '..', 'src/utils/labelLayoutResolver.ts'), 'utf8')
  assert.match(resolver, /PRODUCT_OVERFLOW_MESSAGE/)
  assert.match(resolver, /ROUTE_OVERFLOW_MESSAGE/)
})
