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
