import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IntegrationsPage } from '../pages/IntegrationsPage'
import { SuratCreatePrintControls } from '../components/SuratCreatePrintControls'
import { SuratOfficialLabelPreview } from '../components/SuratOfficialLabelPreview'
import { defaultIntegrationConfig } from '../services/integrationConfigService'
import { BrowserDownloadPrintProvider } from '../providers/printing/BrowserDownloadPrintProvider'
import {
  clearSuratRenderCache,
  fetchSuratRenderArtifact,
  peekSuratRenderArtifact,
  SURAT_RENDER_ENDPOINT,
} from '../services/suratLabelRenderClient'
import { prepareSuratPrintHostSynchronously } from '../utils/browserLabelPrint'
import {
  describeLabelPrintTemplate,
  resolveLabelPrintTemplateDecision,
} from '../utils/labelPrintTemplateRouting'
import type { CargoOrder, IntegrationConfig } from '../types/cargoflow'

// UÇTAN UCA İSTEMCİ ZİNCİRİ — gerçek DOM + gerçek user-event.
//
// Render endpoint STUB'lanır (sunucu tarafı ayrı test dosyasında GERÇEK
// PGlite + GERÇEK zebrash ile doğrulanır). Buradaki amaç istemcinin doğru
// uca gitmesi, AYNI artefaktı önizleme ve baskıda kullanması ve ham ZPL
// göndermemesidir. TÜM VERİLER SENTETİKTİR.

// 1×1 saydam PNG (gerçek etiket değil; artefakt taşıma sözleşmesi için).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const ARTIFACT = {
  ok: true,
  mimeType: 'image/png',
  imageBase64: PNG_BASE64,
  widthPx: 799,
  heightPx: 799,
  widthMm: 99.875,
  heightMm: 99.875,
  printZplSha256: 'a'.repeat(64),
  renderSha256: 'b'.repeat(64),
  renderEngine: 'zpl-renderer-js',
  renderEngineVersion: '4.0.0',
  zebrashVersion: 'v1.38.0',
  augmentationStatus: 'success',
}

let fetchCalls: Array<{ url: string; body: unknown }> = []
let originalFetch: typeof globalThis.fetch

function stubFetch(responder?: (body: Record<string, unknown>) => unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    fetchCalls.push({ url: String(url), body })
    const payload = responder ? responder(body) : ARTIFACT
    const ok = Boolean((payload as { ok?: boolean }).ok)
    return {
      ok,
      status: ok ? 200 : 409,
      json: async () => payload,
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  fetchCalls = []
  originalFetch = globalThis.fetch
  clearSuratRenderCache()
  document.body.innerHTML = ''
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

function suratOrder(over: Partial<CargoOrder> = {}): CargoOrder {
  return {
    id: 'o-1',
    marketplace: 'Trendyol',
    orderNumber: '1000000000000001',
    packageId: 'PKG-1',
    customerName: 'SENTETIK ALICI',
    address: 'ORNEK MAH 1',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    desi: 2,
    items: [{ id: 'l-1', productName: 'Ornek Elbise', quantity: 1 }],
    city: 'ORNEKSEHIR',
    district: 'ORNEKILCE',
    label: { zplContent: '^XA^XZ' },
    shipment: {
      provider: 'surat-kargo',
      printEnabled: true,
      zplReady: true,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      trackingNumber: '10000000000001',
      tNo: '10000000000001',
      barcode: '01200000001',
      barkodNo: '01200000001',
      barcodeValue: '01200000001',
      ozelKargoTakipNo: '1000000000000001',
      barcodeRaw: '^XA^PW799^LL0799^FO60,150^BY3^BCN,130,Y,N,N^FD01200000001^FS^XZ',
      desi: 2,
    },
    ...over,
  } as unknown as CargoOrder
}

function makeConfig(labelPrintTemplate?: string) {
  return {
    ...defaultIntegrationConfig,
    desi: {
      ...defaultIntegrationConfig.desi!,
      defaultUnitDesi: 2,
      multiplyByItemQuantity: false,
      ...(labelPrintTemplate ? { labelPrintTemplate } : {}),
    },
  } as IntegrationConfig
}

function renderSettings(config: IntegrationConfig) {
  const onSave = vi.fn()
  render(
    <IntegrationsPage
      config={config}
      busy={false}
      onSave={onSave}
      onTestTrendyol={vi.fn()}
      onTestSurat={vi.fn()}
      onFetchOrders={vi.fn()}
      onFetchProducts={vi.fn()}
    />,
  )
  return { onSave }
}
const sharedSection = () =>
  screen.getByRole('region', { name: 'Kargo ve Etiket Varsayılanları' })
// ── 1-4: AYAR EKRANI ───────────────────────────────────────────────────────
//
// ŞABLON SEÇİCİSİ AYARLAR EKRANINDAN KALDIRILDI.
//
// Ana aksiyon ("Kargo Etiketi Oluştur ve Yazdır") Sürat gönderileri için HER
// ZAMAN resmî Sürat şablonunu kullanır ve organizasyon ayarı bunu EZEMEZ.
// Kullanıcıya "varsayılan şablon" seçtirip ana aksiyonun onu yok sayması
// yanıltıcı olurdu; bu yüzden seçici gösterilmez.
//
// OS-1..OS-3 seçicinin DAVRANIŞINI ölçüyordu ve konusu ortadan kalktı.
// Yerlerine seçicinin BULUNMADIĞINI ve kayıtlı config değerinin BOZULMADAN
// taşındığını kanıtlayan testler geldi. OS-4'ün asıl amacı (kaydetmek diğer
// alanları ezmiyor) KORUNDU, yalnız etkileşim başka bir kontrole taşındı.

test('OS-1: Ayarlar ekranında şablon seçicisi GÖSTERİLMEZ', () => {
  renderSettings(makeConfig())
  const section = sharedSection()
  expect(
    within(section).queryByRole('group', { name: 'Kargo Etiketi Şablonu' }),
  ).toBeNull()
  expect(
    within(section).queryByRole('radio', {
      name: /CargoFlow Etiket Şablonu/,
    }),
  ).toBeNull()
  expect(
    within(section).queryByRole('radio', {
      name: /Resmî Sürat Etiket Şablonu/,
    }),
  ).toBeNull()
})

test('OS-2: kayıtlı config değeri seçici olmadan da BOZULMADAN taşınır', async () => {
  // Geriye uyumluluk: eski `labelPrintTemplate` değeri config modelinde
  // KORUNUR. DB migration YOKTUR; kaydetmek onu silmez veya değiştirmez.
  const user = userEvent.setup()
  for (const stored of ['cargoflow_html', 'surat_official_zpl']) {
    document.body.innerHTML = ''
    const { onSave } = renderSettings(makeConfig(stored))
    await user.click(
      screen.getByRole('button', { name: 'Varsayılanları Kaydet' }),
    )
    const saved = onSave.mock.calls[0][0] as IntegrationConfig
    expect(saved.desi?.labelPrintTemplate).toBe(stored)
  }
})

test('OS-3: kaydetmek şablon değerini UYDURMAZ ve DEĞİŞTİRMEZ', async () => {
  // Seçici olmadığı için kaydetmek bu alana hiçbir şey yazmamalı: giriş ne
  // ise çıkış da o olmalı (uydurma değer YOK, sessiz değişiklik YOK).
  const user = userEvent.setup()
  const config = makeConfig()
  const { onSave } = renderSettings(config)
  await user.click(screen.getByRole('button', { name: 'Varsayılanları Kaydet' }))
  const saved = onSave.mock.calls[0][0] as IntegrationConfig
  expect(saved.desi?.labelPrintTemplate).toBe(config.desi?.labelPrintTemplate)
})

test('OS-4: kaydetmek DİĞER settings alanlarını EZMEZ', async () => {
  const user = userEvent.setup()
  const config = makeConfig()
  const { onSave } = renderSettings(config)
  // Etkileşim şablon radio'sundan desi anahtarına taşındı; iddia aynı.
  await user.click(
    within(sharedSection()).getByRole('switch', { name: /Ürün adedine göre/i }),
  )
  await user.click(screen.getByRole('button', { name: 'Varsayılanları Kaydet' }))
  const saved = onSave.mock.calls[0][0] as IntegrationConfig
  expect(saved.desi?.defaultUnitDesi).toBe(2)
  expect(saved.trendyol).toEqual(config.trendyol)
  expect(saved.surat.kullaniciAdi).toBe(config.surat.kullaniciAdi)
})


test('OS-5: geçici seçim organizasyon ayarını DEĞİŞTİRMEZ', () => {
  // Karar fonksiyonu override'ı yalnız o çalışmaya uygular.
  const orders = [suratOrder()]
  expect(
    resolveLabelPrintTemplateDecision({
      organizationTemplate: 'cargoflow_html',
      templateOverride: 'surat_official_zpl',
      orders,
    }).template,
  ).toBe('surat_official_zpl')
  // Organizasyon varsayılanı DEĞİŞMEDİ.
  expect(
    resolveLabelPrintTemplateDecision({
      organizationTemplate: 'cargoflow_html',
      orders,
    }).template,
  ).toBe('cargoflow_html')
})

// ── 6-8: GEÇİCİ SEÇİM VE ORTAK HANDLER ─────────────────────────────────────

function renderControls(
  over: Partial<React.ComponentProps<typeof SuratCreatePrintControls>> = {},
) {
  const onSuratCreateAndPrint = vi.fn()
  const onSuratCreateAndPrintWithTemplate = vi.fn()
  render(
    <SuratCreatePrintControls
      orders={[suratOrder()]}
      visibleOrders={[suratOrder()]}
      selectedIds={['o-1']}
      listedCounts={{ orderCount: 1, packageCount: 1, lineCount: 1, quantityTotal: 1 }}
      activeTabLabel="Tümü"
      busy={false}
      suratCreatePrintRunning={false}
      onSuratCreateAndPrint={onSuratCreateAndPrint}
      onSuratCreateAndPrintWithTemplate={onSuratCreateAndPrintWithTemplate}
      labelPrintTemplateIndicator={describeLabelPrintTemplate('cargoflow_html')}
      hasSuratPrintableSelection
      onMarkPrinted={vi.fn()}
      onCreateShipments={vi.fn()}
      onTrackShipments={vi.fn()}
      onDownloadZpl={vi.fn()}
      onMarkHandedToCargo={vi.fn()}
      hasPrintableSelection
      hasShipmentCreatableSelection
      hasZplDownloadableSelection
      hasHandedToCargoSelection
      {...over}
    />,
  )
  return { onSuratCreateAndPrint, onSuratCreateAndPrintWithTemplate }
}

test('OS-6: ana düğme organizasyon varsayılanını kullanır (override GÖNDERMEZ)', async () => {
  const user = userEvent.setup()
  const { onSuratCreateAndPrint, onSuratCreateAndPrintWithTemplate } =
    renderControls()
  await user.click(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  )
  expect(onSuratCreateAndPrint).toHaveBeenCalledTimes(1)
  expect(onSuratCreateAndPrintWithTemplate).not.toHaveBeenCalled()
  expect(screen.getByTestId('label-print-template-indicator').textContent).toBe(
    'Şablon: CargoFlow',
  )
})

test('OS-7: Gelişmiş İşlemler geçici seçimleri ortak handler’a gider', async () => {
  const user = userEvent.setup()
  const { onSuratCreateAndPrintWithTemplate } = renderControls()
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  await user.click(screen.getByTestId('print-with-cargoflow-template'))
  expect(onSuratCreateAndPrintWithTemplate).toHaveBeenCalledWith('cargoflow_html')

  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  await user.click(screen.getByTestId('print-with-surat-template'))
  expect(onSuratCreateAndPrintWithTemplate).toHaveBeenCalledWith(
    'surat_official_zpl',
  )
  // POPUP/MODAL YOK.
  expect(screen.queryByRole('dialog')).toBe(null)
  expect(screen.queryByRole('alertdialog')).toBe(null)
})

test('OS-8: Sürat dışı seçimde resmî şablon aksiyonu PASİF ve mesaj AÇIK', async () => {
  const user = userEvent.setup()
  renderControls({ hasSuratPrintableSelection: false })
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  const action = screen.getByTestId('print-with-surat-template') as HTMLButtonElement
  expect(action.disabled).toBe(true)
  expect(action.title).toBe(
    'Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.',
  )
  // Açık seçimde güvenli HATA, organizasyon varsayılanında güvenli fallback.
  const foreign = suratOrder({
    id: 'o-foreign',
    shipment: { provider: 'baska-kargo' },
  } as unknown as Partial<CargoOrder>)
  expect(
    resolveLabelPrintTemplateDecision({
      templateOverride: 'surat_official_zpl',
      orders: [foreign],
    }).blockedReason,
  ).toBe('Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.')
  const fallback = resolveLabelPrintTemplateDecision({
    organizationTemplate: 'surat_official_zpl',
    orders: [foreign],
  })
  expect(fallback.template).toBe('cargoflow_html')
  expect(fallback.fallbackApplied).toBe(true)
})

// ── 9-14: ÖNİZLEME, BASKI, ARTEFAKT EŞİTLİĞİ ───────────────────────────────

test('OS-9: istemci YALNIZ canonical kimlik gönderir, ham ZPL GÖNDERMEZ', async () => {
  stubFetch()
  await fetchSuratRenderArtifact('o-1')
  expect(fetchCalls).toHaveLength(1)
  expect(fetchCalls[0].url).toBe(SURAT_RENDER_ENDPOINT)
  expect(fetchCalls[0].body).toEqual({ orderId: 'o-1' })
  for (const forbidden of ['zpl', 'printZpl', 'technicalZpl', 'barcodeRaw']) {
    expect(forbidden in (fetchCalls[0].body as object)).toBe(false)
  }
})

test('OS-10: önizleme endpoint artefaktını gösterir (yaklaşık SVG/HTML YOK)', async () => {
  stubFetch()
  render(<SuratOfficialLabelPreview order={suratOrder()} />)
  const node = await screen.findByTestId('surat-official-preview')
  expect(node.getAttribute('data-print-zpl-sha256')).toBe(ARTIFACT.printZplSha256)
  expect(node.getAttribute('data-render-sha256')).toBe(ARTIFACT.renderSha256)
  expect(node.getAttribute('data-zebrash-version')).toBe('v1.38.0')
  const img = node.querySelector('img')
  expect(img?.getAttribute('src')).toBe(`data:image/png;base64,${PNG_BASE64}`)
  // Önizleme SVG üretmez.
  expect(node.querySelector('svg')).toBe(null)
})

test('OS-11: preview ve print AYNI artefaktı kullanır (tek render)', async () => {
  stubFetch()
  render(<SuratOfficialLabelPreview order={suratOrder()} />)
  await screen.findByTestId('surat-official-preview')
  const previewArtifact = peekSuratRenderArtifact('o-1')
  expect(previewArtifact).toBeTruthy()

  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  const frame = document.querySelector(
    '[data-surat-print-frame]',
  ) as HTMLIFrameElement
  const printSpy = vi.fn()
  ;(frame.contentWindow as unknown as { print: () => void }).print = printSpy
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}

  const result = await new BrowserDownloadPrintProvider().print({
    orders: [suratOrder()],
    printerSettings: {
      mode: 'browser-print',
      printerName: 'Test',
      labelSize: '100x100',
    } as never,
    action: 'print',
    labelPrintTemplate: 'surat_official_zpl',
  })

  // İkinci bir render ÇALIŞTIRILMADI: önbellek nedeniyle tek fetch.
  expect(fetchCalls).toHaveLength(1)
  expect(printSpy).toHaveBeenCalledTimes(1)
  expect(result.browserPrintDebug?.printMode).toBe('surat-official-png')
  expect(result.ok).toBe(true)
  const printed = peekSuratRenderArtifact('o-1')
  expect(printed?.printZplSha256).toBe(previewArtifact?.printZplSha256)
  expect(printed?.renderSha256).toBe(previewArtifact?.renderSha256)
  expect(printed?.zebrashVersion).toBe(previewArtifact?.zebrashVersion)
}, 20000)

test('OS-12: iframe belgesi 100×100 mm, tek sayfa, PNG overlay YOK', async () => {
  stubFetch()
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  const frame = document.querySelector(
    '[data-surat-print-frame]',
  ) as HTMLIFrameElement
  ;(frame.contentWindow as unknown as { print: () => void }).print = vi.fn()
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}

  await new BrowserDownloadPrintProvider().print({
    orders: [suratOrder()],
    printerSettings: {
      mode: 'browser-print',
      printerName: 'Test',
      labelSize: '100x100',
    } as never,
    action: 'print',
    labelPrintTemplate: 'surat_official_zpl',
  })

  const html = frame.contentDocument?.documentElement.outerHTML ?? ''
  expect(html).toContain('100mm')
  const pages = frame.contentDocument?.querySelectorAll('.surat-official-page')
  expect(pages?.length).toBe(1)
  const img = frame.contentDocument?.querySelector('.surat-official-page img')
  expect(img?.getAttribute('src')).toContain(PNG_BASE64)
  // Görüntü üzerine overlay EKLENMEZ: sayfada img DIŞINDA öğe yok.
  expect(pages?.[0].children.length).toBe(1)
  // CargoFlow HTML etiketi resmî modda YENİDEN ÇİZİLMEZ.
  expect(frame.contentDocument?.querySelector('.label-page')).toBe(null)
}, 20000)

test('OS-13: CargoFlow modu MEVCUT HTML renderer’ı kullanır (endpoint ÇAĞRILMAZ)', async () => {
  stubFetch()
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  const frame = document.querySelector(
    '[data-surat-print-frame]',
  ) as HTMLIFrameElement
  ;(frame.contentWindow as unknown as { print: () => void }).print = vi.fn()
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}

  const result = await new BrowserDownloadPrintProvider().print({
    orders: [suratOrder()],
    printerSettings: {
      mode: 'browser-print',
      printerName: 'Test',
      labelSize: '100x100',
    } as never,
    action: 'print',
    // Şablon verilmedi → VARSAYILAN CargoFlow HTML yolu.
  })
  // AYIRT EDİCİ KANIT: resmî yol HER ZAMAN render endpoint'ini çağırır.
  // Burada hiç çağrılmadı → mevcut CargoFlow HTML yoluna gidildi.
  expect(fetchCalls).toHaveLength(0)
  // Resmî moda ait sayfa yapısı OLUŞMADI ve resmî PNG modu raporlanmadı.
  expect(frame.contentDocument?.querySelector('.surat-official-page')).toBe(null)
  expect(result.browserPrintDebug?.printMode).not.toBe('surat-official-png')
  expect(result.provider).toBe('browser-label-document')
}, 20000)

test('OS-14: batch — bir render hatası diğerlerini DURDURMAZ', async () => {
  stubFetch((body) =>
    body.orderId === 'o-bad'
      ? { ok: false, code: 'label_not_ready', message: 'Kayıtlı etiket yok.' }
      : ARTIFACT,
  )
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  const frame = document.querySelector(
    '[data-surat-print-frame]',
  ) as HTMLIFrameElement
  ;(frame.contentWindow as unknown as { print: () => void }).print = vi.fn()
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}

  const result = await printOfficialSuratLabels([
    suratOrder({ id: 'o-bad', orderNumber: '999' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-1', orderNumber: '111' } as Partial<CargoOrder>),
  ])
  // Sağlıklı sipariş basıldı, hatalı sipariş güvenli sebeple atlandı.
  expect(result.printedOrderNumbers).toEqual(['111'])
  expect(result.skipped.map((item) => item.orderNumber)).toEqual(['999'])
  expect(result.skipped[0].reason).toBe('Kayıtlı etiket yok.')
  // Sonda BOŞ SAYFA yok: tek sayfa.
  expect(
    frame.contentDocument?.querySelectorAll('.surat-official-page').length,
  ).toBe(1)
}, 20000)

test('OS-15: render hatasında yaklaşık SVG’ye DÜŞÜLMEZ, güvenli mesaj gösterilir', async () => {
  stubFetch(() => ({
    ok: false,
    code: 'render_failed',
    message:
      'Resmî Sürat etiketi yerel ZPL motorunda oluşturulamadı. CargoFlow şablonuyla yazdırabilirsiniz.',
  }))
  render(<SuratOfficialLabelPreview order={suratOrder()} />)
  await waitFor(() => {
    expect(
      screen.getByText(/yerel ZPL motorunda oluşturulamadı/),
    ).toBeTruthy()
  })
  expect(screen.queryByTestId('surat-official-preview')).toBe(null)
  expect(document.querySelector('svg')).toBe(null)
})

test('OS-16: augmentation fallback güvenli uyarı taşır, baskıyı BLOKLAMAZ', async () => {
  stubFetch(() => ({
    ...ARTIFACT,
    augmentationStatus: 'overflow',
    warning: 'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.',
  }))
  render(<SuratOfficialLabelPreview order={suratOrder()} />)
  const node = await screen.findByTestId('surat-official-preview')
  expect(node.getAttribute('data-augmentation-status')).toBe('overflow')
  expect(
    screen.getByText('Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.'),
  ).toBeTruthy()
  // Uyarı ham ZPL TAŞIMAZ ve etiket YİNE gösterilir.
  expect(node.querySelector('img')).toBeTruthy()
})

// ═══ 4B: GERÇEK ÇOK SAYFALI BASKI WIRING ══════════════════════════════════
//
// Sunucu sıralı `pages[]` döndürür (4A). İstemci bu sırayı DEĞİŞTİRMEZ ve
// TEK baskı belgesinde TEK window.print() ile basar. Bir sipariş birden çok
// FİZİKSEL sayfa üretse bile BİR sipariş sayılır.

const multiPageArtifact = (detailCount: number, over = {}) => ({
  ...ARTIFACT,
  pages: [
    {
      kind: 'carrier',
      page: 1,
      totalPages: detailCount + 1,
      imageBase64: PNG_BASE64,
      mimeType: 'image/png',
    },
    ...Array.from({ length: detailCount }, (_, index) => ({
      kind: 'product_detail',
      page: index + 2,
      totalPages: detailCount + 1,
      imageBase64: PNG_BASE64,
      mimeType: 'image/png',
    })),
  ],
  missingPages: [],
  productDetailStatus: detailCount > 0 ? 'ready' : 'none',
  printArtifactStatus: 'ready',
  ...over,
})

function printHost() {
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  const frame = document.querySelector(
    '[data-surat-print-frame]',
  ) as HTMLIFrameElement
  const printSpy = vi.fn()
  ;(frame.contentWindow as unknown as { print: () => void }).print = printSpy
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}
  return { frame, printSpy }
}
const pageSections = (frame: HTMLIFrameElement) =>
  Array.from(
    frame.contentDocument?.querySelectorAll('.surat-official-page') ?? [],
  )
const orderOf = (section: Element) => section.getAttribute('data-order')

test('PRINT-1: tek sayfalı yanıt → TEK sayfa, TEK window.print', async () => {
  // Eski yanıt biçimi (pages[] YOK) → geriye uyumlu tek taşıyıcı sayfa.
  stubFetch(() => ARTIFACT)
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { frame, printSpy } = printHost()
  const result = await printOfficialSuratLabels([suratOrder()])
  expect(printSpy).toHaveBeenCalledTimes(1)
  expect(pageSections(frame)).toHaveLength(1)
  expect(result.printedOrderNumbers).toHaveLength(1)
  expect(result.productDetailWarnings).toEqual([])
}, 20000)

test('PRINT-2/3/4: çok sayfalı yanıt → tek belge, taşıyıcı ilk, sunucu sırası korunur', async () => {
  stubFetch(() => multiPageArtifact(2))
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { frame, printSpy } = printHost()
  const result = await printOfficialSuratLabels([suratOrder()])
  // TEK KULLANICI TIKLAMASI → TEK BASKI ÇAĞRISI.
  expect(printSpy).toHaveBeenCalledTimes(1)
  // 1 taşıyıcı + 2 ürün detayı = 3 FİZİKSEL SAYFA, AYNI belgede.
  const sections = pageSections(frame)
  expect(sections).toHaveLength(3)
  // Sayfaların hepsi aynı siparişe ait; sipariş TEK KEZ basıldı sayılır.
  expect(sections.map(orderOf)).toEqual([
    '1000000000000001',
    '1000000000000001',
    '1000000000000001',
  ])
  expect(result.printedOrderNumbers).toEqual(['1000000000000001'])
  // Sipariş başına TEK render isteği.
  expect(fetchCalls).toHaveLength(1)
}, 20000)

test('PRINT-5: ürün detayı üretilemedi → taşıyıcı BASILIR, uyarı taşınır, ATLANMAZ', async () => {
  stubFetch(() =>
    multiPageArtifact(0, {
      productDetailStatus: 'failed',
      printArtifactStatus: 'fallback_carrier',
      missingPages: [
        {
          kind: 'product_detail',
          page: 2,
          totalPages: 2,
          reason: 'render_failed',
        },
      ],
      warning: 'Ürün detay etiketi hazırlanamadı.',
    }),
  )
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { frame, printSpy } = printHost()
  const result = await printOfficialSuratLabels([suratOrder()])
  // FAIL-OPEN: ana kargo etiketi ENGELLENMEZ.
  expect(printSpy).toHaveBeenCalledTimes(1)
  expect(pageSections(frame)).toHaveLength(1)
  expect(result.printedOrderNumbers).toEqual(['1000000000000001'])
  // UYARI KAYBOLMAZ ve ATLANAN ile KARIŞTIRILMAZ.
  expect(result.productDetailWarnings).toHaveLength(1)
  expect(result.productDetailWarnings[0].reason).toBe(
    'Ürün detay etiketi hazırlanamadı.',
  )
  expect(result.skipped).toEqual([])
}, 20000)

test('PRINT-6: taşıyıcı yoksa BASKI YOK', async () => {
  stubFetch(() => ({
    ok: false,
    code: 'label_not_ready',
    message: 'Etiket yok.',
  }))
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { frame, printSpy } = printHost()
  const result = await printOfficialSuratLabels([suratOrder()])
  expect(printSpy).not.toHaveBeenCalled()
  expect(pageSections(frame)).toHaveLength(0)
  expect(result.printedOrderNumbers).toEqual([])
  expect(result.skipped).toHaveLength(1)
}, 20000)

// ── PRINT-7/8: HAM ZPL (Zebra local-agent) ────────────────────────────────

const bundleOrder = (orderNumber: string, detailCount: number) =>
  ({
    id: `id-${orderNumber}`,
    orderNumber,
    shipment: {
      provider: 'surat-kargo',
      printBundle: {
        pages: [
          { kind: 'carrier', page: 1, zpl: `^XA^FD${orderNumber}-CARRIER^FS^XZ` },
          ...Array.from({ length: detailCount }, (_, index) => ({
            kind: 'product_detail',
            page: index + 2,
            zpl: `^XA^FD${orderNumber}-DETAY${index + 1}^FS^XZ`,
          })),
        ],
        labelPageCount: detailCount + 1,
        productDetailPageCount: detailCount,
      },
    },
    // RESMÎ MODDA BİLEREK BOŞ (baskı içeriği sunucudan gelir).
    label: { id: 'l', labelType: 'zpl', zplContent: '' },
  }) as unknown as CargoOrder

async function localAgentPrint(orders: CargoOrder[]) {
  const calls: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, printJobId: 'zebra-1', jobs: [] }),
      } as unknown as Response
    }),
  )
  const { BrowserDownloadPrintProvider } = await import(
    '../providers/printing/BrowserDownloadPrintProvider'
  )
  const result = await new BrowserDownloadPrintProvider().print({
    orders,
    printerSettings: { mode: 'local-agent', printerName: 'Zebra' },
    action: 'print',
    requestedAt: '2026-08-09T00:00:00.000Z',
    confirmedAt: '2026-08-09T00:00:00.000Z',
    labelPrintTemplate: 'surat_official_zpl',
  } as never)
  return { calls, result }
}

test('PRINT-7: local-agent çok sayfa → TEK çağrı, canonical sırada combinedZpl', async () => {
  const { calls } = await localAgentPrint([bundleOrder('A', 2)])
  // TEK YEREL AJAN ÇAĞRISI.
  expect(calls).toHaveLength(1)
  const labels = calls[0].labels as Array<{ orderNumber: string; zpl: string }>
  expect(labels).toHaveLength(1)
  const zpl = labels[0].zpl
  // Taşıyıcı + iki detay TEK ham ZPL işinde.
  expect((zpl.match(/\^XA/g) ?? []).length).toBe(3)
  expect((zpl.match(/\^XZ/g) ?? []).length).toBe(3)
  // CANONICAL SIRA: taşıyıcı ilk, detaylar 1..N.
  expect(zpl.indexOf('A-CARRIER')).toBeLessThan(zpl.indexOf('A-DETAY1'))
  expect(zpl.indexOf('A-DETAY1')).toBeLessThan(zpl.indexOf('A-DETAY2'))
}, 20000)

test('PRINT-8: resmî Sürat + local-agent → BOŞ zplContent gönderilmez', async () => {
  const { calls } = await localAgentPrint([bundleOrder('B', 1)])
  const labels = calls[0].labels as Array<{ orderNumber: string; zpl: string }>
  // KÖK NEDEN KAPANDI: eskiden bilerek boş bırakılan zplContent gidiyordu.
  expect(labels[0].zpl.trim().length).toBeGreaterThan(0)
  expect(labels[0].zpl).toContain('B-CARRIER')
  // İSTEMCİ technicalZpl SEÇİMİNE GERİ DÖNMEZ.
  const source = calls[0]
  expect(JSON.stringify(source)).not.toContain('technicalZpl')
  expect(JSON.stringify(source)).not.toContain('barcodeRaw')
}, 20000)

// ── BULK ──────────────────────────────────────────────────────────────────

test('BULK-1/2/3: çok gönderi → TEK baskı, gönderi bazında sıra, doğru sayfa sayısı', async () => {
  const plan = { 'o-a': 1, 'o-b': 0, 'o-c': 2 } as Record<string, number>
  stubFetch((body) => multiPageArtifact(plan[String(body.orderId)] ?? 0))
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { frame, printSpy } = printHost()
  const result = await printOfficialSuratLabels([
    suratOrder({ id: 'o-a', orderNumber: 'A' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-b', orderNumber: 'B' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-c', orderNumber: 'C' } as Partial<CargoOrder>),
  ])
  // TEK BASKI İŞİ.
  expect(printSpy).toHaveBeenCalledTimes(1)
  // 2 + 1 + 3 = 6 fiziksel sayfa.
  const sections = pageSections(frame)
  expect(sections).toHaveLength(6)
  // GÖNDERİ BAZINDA SIRA — ek sayfalar işin SONUNA toplanmaz.
  expect(sections.map(orderOf)).toEqual(['A', 'A', 'B', 'C', 'C', 'C'])
  // BULK-8: her gönderi TEK KEZ sayılır (sayfa başına DEĞİL).
  expect(result.printedOrderNumbers).toEqual(['A', 'B', 'C'])
}, 30000)

test('BULK-4/5: geçersiz gönderi diğerlerini BLOKLAMAZ, atlanan AÇIKÇA raporlanır', async () => {
  stubFetch((body) => {
    if (body.orderId === 'o-bad') {
      return { ok: false, code: 'label_not_ready', message: 'Etiket yok.' }
    }
    if (body.orderId === 'o-fb') {
      return multiPageArtifact(0, {
        productDetailStatus: 'failed',
        printArtifactStatus: 'fallback_carrier',
        warning: 'Ürün detay etiketi hazırlanamadı.',
      })
    }
    return multiPageArtifact(1)
  })
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { frame, printSpy } = printHost()
  const result = await printOfficialSuratLabels([
    suratOrder({ id: 'o-full', orderNumber: 'FULL' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-fb', orderNumber: 'FB' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-bad', orderNumber: 'BAD' } as Partial<CargoOrder>),
  ])
  expect(printSpy).toHaveBeenCalledTimes(1)
  // Geçerli 2 gönderi basıldı (2 + 1 sayfa); biri fallback.
  expect(pageSections(frame)).toHaveLength(3)
  expect(result.printedOrderNumbers).toEqual(['FULL', 'FB'])
  // SESSİZ ATLAMA YOK.
  expect(result.skipped.map((item) => item.orderNumber)).toEqual(['BAD'])
  expect(result.skipped[0].reason).toBe('Etiket yok.')
  // Fallback ATLANMADI; yalnız uyarı taşıyor.
  expect(result.productDetailWarnings.map((item) => item.orderNumber)).toEqual([
    'FB',
  ])
}, 30000)

test('BULK-6/7: hazır baskıda provider-create ve ürün toplama/composer ÇAĞRISI YOK', async () => {
  stubFetch(() => multiPageArtifact(2))
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  printHost()
  await printOfficialSuratLabels([
    suratOrder({ id: 'o-a', orderNumber: 'A' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-b', orderNumber: 'B' } as Partial<CargoOrder>),
  ])
  // YALNIZ render ucu çağrılır: shipment create / marketplace ucu YOK.
  expect(fetchCalls).toHaveLength(2)
  for (const call of fetchCalls) {
    expect(call.url).toBe(SURAT_RENDER_ENDPOINT)
  }
  // Koşucu ÜRETİM yapmaz — kaynak düzeyinde kilit.
  const runnerSource = await import('../services/officialSuratPrintRunner?raw')
  const text = String((runnerSource as { default: string }).default)
  for (const forbidden of [
    'aggregateProductLineItems',
    'planProductDetailPages',
    'composeSuratDurusoftLabel',
    'deriveAugmentedSuratZpl',
    'OrtakBarkodOlustur',
  ]) {
    expect(text).not.toContain(forbidden)
  }
}, 30000)

test('BULK-8: çok sayfalı gönderi mükerrer sayılmaz', async () => {
  // Her gönderi 3 fiziksel sayfa üretir; sipariş sayımı yine 3 OLMALI (9 değil).
  stubFetch(() => multiPageArtifact(2))
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { frame } = printHost()
  const result = await printOfficialSuratLabels([
    suratOrder({ id: 'o-a', orderNumber: 'A' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-b', orderNumber: 'B' } as Partial<CargoOrder>),
    suratOrder({ id: 'o-c', orderNumber: 'C' } as Partial<CargoOrder>),
  ])
  expect(pageSections(frame)).toHaveLength(9)
  expect(result.printedOrderNumbers).toEqual(['A', 'B', 'C'])
  expect(new Set(result.printedOrderNumbers).size).toBe(3)
}, 30000)

// ═══ DISPATCH: "BASKIYA GÖNDERİLDİ" MUHASEBESİ ════════════════════════════
//
// `persistLabelPrinted` (POST /api/orders/:id/label-printed) YALNIZ
// `printResult.jobs[].ok === true` olan siparişler için, SİPARİŞ BAŞINA BİR
// KEZ çağrılır. Bu muhasebenin girdisi `resolveBrowserPrintJobs`'tur ve o da
// `debug.printedOrderNumbers` kümesini okur.
//
// TERMİNOLOJİ: tarayıcı baskısında fiziksel yazıcı onayı YOKTUR; bu yüzden
// kullanıcıya "Yazdırıldı" DEĞİL "Baskıya Gönderildi" denir.

/** Baskı kararını üreten saf fonksiyon — dispatch muhasebesinin girdisi. */
async function dispatchDecision(orders: CargoOrder[]) {
  const { printOfficialSuratLabels } = await import(
    '../services/officialSuratPrintRunner'
  )
  const { resolveBrowserPrintJobs } = await import(
    '../providers/printing/BrowserDownloadPrintProvider'
  )
  const run = await printOfficialSuratLabels(orders)
  const jobs = resolveBrowserPrintJobs(
    run.debug,
    orders.map((order) => order.orderNumber),
  ).jobs
  // Üretimdeki kapı: `successfulPrintableOrders` bu kümeden türer ve her
  // öğesi için persistLabelPrinted BİR KEZ çağrılır.
  const dispatched = jobs.filter((job) => job.ok).map((job) => job.orderNumber)
  return { run, jobs, dispatched }
}

test('DISPATCH-1: 3 fiziksel sayfalı TEK sipariş → tam 1 dispatch', async () => {
  stubFetch(() => multiPageArtifact(2))
  printHost()
  const { run, dispatched } = await dispatchDecision([suratOrder()])
  // Sayfa sayısı 3 ama SİPARİŞ muhasebesi 1.
  expect(run.debug.printedOrderNumbers).toEqual(['1000000000000001'])
  expect(dispatched).toEqual(['1000000000000001'])
  expect(dispatched).toHaveLength(1)
}, 20000)

test('DISPATCH-2: taşıyıcı fallback başarıyla gönderildi → tam 1 dispatch', async () => {
  stubFetch(() =>
    multiPageArtifact(0, {
      productDetailStatus: 'failed',
      printArtifactStatus: 'fallback_carrier',
      warning: 'Ürün detay etiketi hazırlanamadı.',
    }),
  )
  printHost()
  const { run, dispatched } = await dispatchDecision([suratOrder()])
  // Ürün detayı eksik olsa da ana etiket gönderildi → durum geçişi YAPILIR.
  expect(dispatched).toEqual(['1000000000000001'])
  expect(run.productDetailWarnings).toHaveLength(1)
  expect(run.skipped).toEqual([])
}, 20000)

test('DISPATCH-3: atlanan/geçersiz gönderi → 0 dispatch', async () => {
  stubFetch(() => ({
    ok: false,
    code: 'label_not_ready',
    message: 'Etiket yok.',
  }))
  printHost()
  const { run, jobs, dispatched } = await dispatchDecision([suratOrder()])
  expect(dispatched).toEqual([])
  expect(jobs.every((job) => job.ok === false)).toBe(true)
  expect(run.debug.printedOrderNumbers).toEqual([])
  // Sessiz atlama YOK: sebep taşınır.
  expect(run.skipped).toHaveLength(1)
}, 20000)

test('DISPATCH-4: toplu 49 basılan + 1 atlanan → tam 49 TEKİL geçiş', async () => {
  const orders = Array.from({ length: 50 }, (_, index) =>
    suratOrder({
      id: `o-${index}`,
      orderNumber: `ORD-${index}`,
    } as Partial<CargoOrder>),
  )
  stubFetch((body) => {
    if (body.orderId === 'o-49') {
      return { ok: false, code: 'label_not_ready', message: 'Etiket yok.' }
    }
    // Her geçerli gönderi 3 FİZİKSEL sayfa üretir.
    return multiPageArtifact(2)
  })
  printHost()
  const { run, dispatched } = await dispatchDecision(orders)
  // 49 × 3 = 147 fiziksel sayfa, ama 49 SİPARİŞ geçişi.
  expect(dispatched).toHaveLength(49)
  expect(new Set(dispatched).size).toBe(49)
  expect(dispatched).not.toContain('ORD-49')
  // MÜKERRER ÇAĞRI YOK: dedupe sıra koruyarak yapılır.
  expect(run.debug.printedOrderNumbers).toEqual(
    orders.slice(0, 49).map((order) => order.orderNumber),
  )
  // Atlanan AÇIKÇA raporlanır.
  expect(run.skipped.map((item) => item.orderNumber)).toEqual(['ORD-49'])
}, 60000)

test('DISPATCH-5: kullanıcı metni "Baskıya Gönderildi" — fiziksel başarı iddiası YOK', async () => {
  const source = await import('../services/orderWorkflowService?raw')
  const text = String((source as { default: string }).default)
  // Baskı sonucu mesajları artık kesin fiziksel başarı İDDİA ETMEZ.
  expect(text).toContain('etiket baskıya gönderildi')
  expect(text).not.toContain('etiket yazdırıldı')
  expect(text).not.toContain('etiket tekrar basıldı.')
  // Kanonik durum ve uç DEĞİŞMEDİ (migration yok).
  expect(text).toContain('label-printed')
})
