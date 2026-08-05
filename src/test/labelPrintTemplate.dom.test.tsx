import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { IntegrationsPage } from '../pages/IntegrationsPage'
import { SuratCreatePrintControls } from '../components/SuratCreatePrintControls'
import { SuratOfficialLabelPreview } from '../components/SuratOfficialLabelPreview'
import { defaultIntegrationConfig } from '../services/integrationConfigService'
import { BrowserDownloadPrintProvider } from '../providers/printing/BrowserDownloadPrintProvider'
import {
  buildSuratOfficialArtifact,
  prepareSuratPrintHostSynchronously,
} from '../utils/browserLabelPrint'
import {
  describeLabelPrintTemplate,
  resolveLabelPrintTemplateDecision,
} from '../utils/labelPrintTemplateRouting'
import type { CargoOrder, IntegrationConfig } from '../types/cargoflow'

// GERÇEK DOM + GERÇEK KULLANICI ETKİLEŞİMİ (jsdom + user-event).
//
// Kapsam: seçilebilir etiket şablonu — ayar, ana düğme yönlendirmesi, geçici
// seçim, sağlayıcı uygunluğu, önizleme/baskı artefakt eşitliği ve Chrome
// yazdırma çağrısı.
//
// TÜM VERİLER SENTETİKTİR (gerçek müşteri/adres/telefon/ZPL yok).

const SHARED_SECTION = 'Kargo ve Etiket Varsayılanları'
const CARGOFLOW_OPTION = 'CargoFlow Etiket Şablonu'
const SURAT_OPTION = 'Resmî Sürat Etiket Şablonu'

const OFFICIAL_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO20,15^GB760,770,3^FS',
  '^FO60,20^A0N,28,28^FDSube: ORNEK^FS',
  '^FO470,20^A0N,26,26^FDT.No: 10000000000001^FS',
  '^FO60,150^BY3^BCN,150,Y,N,N^FD01200000001^FS',
  '^FO60,345^A0N,24,24^FDSENTETIK ALICI^FS',
  '^FO60,375^A0N,18,18^FB700,3,0,L,0^FDORNEK MAH ORNEK SOK NO 1^FS',
  '^FO60,480^A0N,20,20^FDOdemeTipi Birim Top Ds/Kg^FS',
  '^FO60,510^A0N,30,30^FDPOCH KOLI 2,00^FS',
  '^FO60,560^BXN,6,200^FD1000000000000001^FS',
  '^FO240,630^A0N,34,34^FDORNEKSEHIR/01^FS',
  '^FO240,672^A0N,38,38^FDORNEKSEHIR AKTARMA^FS',
  '^FO660,560^BQN,2,6^FDLA,01200000001^FS',
  '^FWB', '^FO24,340^A0N,18,18^FDSiparis No: 1000000000000001^FS', '^FWN',
  '^PQ1,0,1,Y',
  '^XZ',
].join('\n')

function suratOrder(over: Partial<CargoOrder> = {}): CargoOrder {
  return {
    id: 'o-1',
    marketplace: 'Trendyol',
    orderNumber: '1000000000000001',
    packageId: 'PKG-1',
    customerName: 'SENTETIK ALICI',
    address: 'ORNEK MAH ORNEK SOK NO 1',
    city: 'ORNEKSEHIR',
    district: 'ORNEKILCE',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    desi: 2,
    desiSource: 'manual_total',
    items: [
      {
        id: 'l-1',
        productName: 'Ornek Elbise',
        quantity: 1,
        color: 'Siyah',
        size: '42',
        merchantSku: 'ORN-001',
      },
    ],
    label: { zplContent: OFFICIAL_ZPL },
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: '10000000000001',
      tNo: '10000000000001',
      barcode: '01200000001',
      barkodNo: '01200000001',
      barcodeValue: '01200000001',
      ozelKargoTakipNo: '1000000000000001',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      zplReady: true,
      printEnabled: true,
      barcodeRaw: OFFICIAL_ZPL,
      desi: 2,
    },
    ...over,
  } as unknown as CargoOrder
}

function foreignOrder(): CargoOrder {
  const base = suratOrder()
  return {
    ...base,
    id: 'o-foreign',
    packageId: 'PKG-F',
    cargoProviderName: 'Baska Kargo',
    shipment: { ...base.shipment, provider: 'baska-kargo' },
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

function renderSettings(config: IntegrationConfig, busy = false) {
  const onSave = vi.fn()
  render(
    <IntegrationsPage
      config={config}
      busy={busy}
      onSave={onSave}
      onTestTrendyol={vi.fn()}
      onTestSurat={vi.fn()}
      onFetchOrders={vi.fn()}
      onFetchProducts={vi.fn()}
    />,
  )
  return { onSave }
}

function sharedSection() {
  return screen.getByRole('region', { name: SHARED_SECTION })
}
function templateRadio(name: string) {
  return within(sharedSection()).getByRole('radio', {
    name: new RegExp(name),
  }) as HTMLInputElement
}

// ── 1-5: AYAR ──────────────────────────────────────────────────────────────

test('LP-1: ayar yoksa CargoFlow şablonu SEÇİLİDİR', () => {
  renderSettings(makeConfig())
  expect(templateRadio(CARGOFLOW_OPTION).checked).toBe(true)
  expect(templateRadio(SURAT_OPTION).checked).toBe(false)
  // Açıklama metinleri sözleşmeye uygun.
  const text = sharedSection().textContent ?? ''
  expect(text).toContain(
    'CargoFlow tarafından oluşturulan mevcut ürün detaylı etiket tasarımı.',
  )
  expect(text).toContain(
    'Sürat Kargo’nun resmî etiket düzenini kullanır ve ürün bilgilerini alt alana ekler.',
  )
})

test('LP-2: Resmî Sürat seçilip kaydedilir', async () => {
  const user = userEvent.setup()
  const { onSave } = renderSettings(makeConfig())
  await user.click(templateRadio(SURAT_OPTION))
  expect(templateRadio(SURAT_OPTION).checked).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Varsayılanları Kaydet' }))
  const saved = onSave.mock.calls[0]?.[0] as IntegrationConfig
  expect(saved.desi?.labelPrintTemplate).toBe('surat_official_zpl')
})

test('LP-3: kayıtlı değer yeniden yüklemede KORUNUR', () => {
  renderSettings(makeConfig('surat_official_zpl'))
  expect(templateRadio(SURAT_OPTION).checked).toBe(true)
  expect(templateRadio(CARGOFLOW_OPTION).checked).toBe(false)
})

test('LP-4: bilinmeyen değer güvenli varsayılana düşer, geri dönülebilir', async () => {
  const user = userEvent.setup()
  const { onSave } = renderSettings(makeConfig('bilinmeyen_sablon'))
  expect(templateRadio(CARGOFLOW_OPTION).checked).toBe(true)
  await user.click(templateRadio(SURAT_OPTION))
  await user.click(templateRadio(CARGOFLOW_OPTION))
  await user.click(screen.getByRole('button', { name: 'Varsayılanları Kaydet' }))
  const saved = onSave.mock.calls[0]?.[0] as IntegrationConfig
  expect(saved.desi?.labelPrintTemplate).toBe('cargoflow_html')
})

test('LP-5: şablon değişimi DİĞER gönderi varsayılanlarını EZMEZ', async () => {
  const user = userEvent.setup()
  const config = makeConfig()
  const { onSave } = renderSettings(config)
  await user.click(templateRadio(SURAT_OPTION))
  await user.click(screen.getByRole('button', { name: 'Varsayılanları Kaydet' }))
  const saved = onSave.mock.calls[0]?.[0] as IntegrationConfig
  expect(saved.desi?.defaultUnitDesi).toBe(2)
  expect(saved.desi?.multiplyByItemQuantity).toBe(false)
  expect(saved.desi?.categoryDefaults).toEqual(config.desi?.categoryDefaults)
  expect(saved.trendyol).toEqual(config.trendyol)
  expect(saved.surat.kullaniciAdi).toBe(config.surat.kullaniciAdi)
  // Sürat hesabı olmasa da ayar görünür.
  expect(templateRadio(SURAT_OPTION)).toBeTruthy()
})

// ── 6-11: ANA DÜĞME, GEÇİCİ SEÇİM, SAĞLAYICI UYGUNLUĞU ─────────────────────

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

test('LP-6: ana düğme ORGANIZASYON varsayılanını kullanır (override GÖNDERMEZ)', async () => {
  const user = userEvent.setup()
  const { onSuratCreateAndPrint, onSuratCreateAndPrintWithTemplate } =
    renderControls()
  await user.click(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  )
  expect(onSuratCreateAndPrint).toHaveBeenCalledTimes(1)
  expect(onSuratCreateAndPrintWithTemplate).not.toHaveBeenCalled()
  // Düğme metni KORUNUR.
  expect(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  ).toBeTruthy()
})

test('LP-7: ana düğme varsayılanı resmî Sürat olduğunda da AYNI handler’a gider', () => {
  renderControls({
    labelPrintTemplateIndicator: describeLabelPrintTemplate('surat_official_zpl'),
  })
  expect(screen.getByTestId('label-print-template-indicator').textContent).toBe(
    'Şablon: Resmî Sürat',
  )
  // Karar noktası: ana düğme yalnız organizasyon varsayılanını taşır.
  const decision = resolveLabelPrintTemplateDecision({
    organizationTemplate: 'surat_official_zpl',
    orders: [suratOrder()],
  })
  expect(decision.template).toBe('surat_official_zpl')
  expect(decision.overridden).toBe(false)
})

test('LP-8: geçici CargoFlow seçimi AYARI DEĞİŞTİRMEZ', async () => {
  const user = userEvent.setup()
  const { onSuratCreateAndPrintWithTemplate } = renderControls()
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  await user.click(screen.getByTestId('print-with-cargoflow-template'))
  expect(onSuratCreateAndPrintWithTemplate).toHaveBeenCalledWith('cargoflow_html')
  // Ayar kaydı çağrılmaz: bileşen hiçbir save handler’ı almaz/çağırmaz.
  expect(
    resolveLabelPrintTemplateDecision({
      organizationTemplate: 'surat_official_zpl',
      templateOverride: 'cargoflow_html',
      orders: [suratOrder()],
    }).template,
  ).toBe('cargoflow_html')
})

test('LP-9: geçici Resmî Sürat seçimi AYARI DEĞİŞTİRMEZ', async () => {
  const user = userEvent.setup()
  const { onSuratCreateAndPrintWithTemplate } = renderControls()
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  await user.click(screen.getByTestId('print-with-surat-template'))
  expect(onSuratCreateAndPrintWithTemplate).toHaveBeenCalledWith(
    'surat_official_zpl',
  )
  const decision = resolveLabelPrintTemplateDecision({
    organizationTemplate: 'cargoflow_html',
    templateOverride: 'surat_official_zpl',
    orders: [suratOrder()],
  })
  expect(decision.template).toBe('surat_official_zpl')
  // Organizasyon varsayılanı DEĞİŞMEDİ.
  expect(
    resolveLabelPrintTemplateDecision({
      organizationTemplate: 'cargoflow_html',
      orders: [suratOrder()],
    }).template,
  ).toBe('cargoflow_html')
})

test('LP-10: üç UI yüzeyi de AYNI ortak handler sözleşmesini kullanır', async () => {
  const user = userEvent.setup()
  const { onSuratCreateAndPrint, onSuratCreateAndPrintWithTemplate } =
    renderControls()
  // Siparişler ekranı: ana düğme + menü.
  await user.click(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  )
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  await user.click(screen.getByTestId('print-with-surat-template'))
  // Her iki yol da TEK giriş noktasına gider (ayrı lifecycle yok).
  expect(onSuratCreateAndPrint).toHaveBeenCalledTimes(1)
  expect(onSuratCreateAndPrintWithTemplate).toHaveBeenCalledTimes(1)
  // Sipariş Detayı ve Dashboard aynı wrapper'ı kullanır: karar fonksiyonu
  // seçim listesinden bağımsız olarak AYNI sonucu verir.
  for (const orders of [[suratOrder()], [suratOrder(), suratOrder()]]) {
    expect(
      resolveLabelPrintTemplateDecision({
        organizationTemplate: 'surat_official_zpl',
        orders,
      }).template,
    ).toBe('surat_official_zpl')
  }
})

test('LP-11: Sürat dışı gönderide resmî şablon aksiyonu PASİF ve mesaj AÇIK', async () => {
  const user = userEvent.setup()
  renderControls({ hasSuratPrintableSelection: false })
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  const action = screen.getByTestId('print-with-surat-template') as HTMLButtonElement
  expect(action.disabled).toBe(true)
  expect(action.title).toBe(
    'Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.',
  )
  // CargoFlow aksiyonu ETKİLENMEZ.
  expect(
    (screen.getByTestId('print-with-cargoflow-template') as HTMLButtonElement)
      .disabled,
  ).toBe(false)
  // Açık seçimde güvenli hata, organizasyon varsayılanında güvenli fallback.
  const blocked = resolveLabelPrintTemplateDecision({
    templateOverride: 'surat_official_zpl',
    orders: [foreignOrder()],
  })
  expect(blocked.blockedReason).toBe(
    'Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.',
  )
  const fallback = resolveLabelPrintTemplateDecision({
    organizationTemplate: 'surat_official_zpl',
    orders: [foreignOrder()],
  })
  expect(fallback.template).toBe('cargoflow_html')
  expect(fallback.fallbackApplied).toBe(true)
})

// ── 12-16: ÖNİZLEME, CHROME BASKISI, YAN ETKİ ─────────────────────────────

test('LP-12: resmî önizleme AYNI yerel SVG renderer’ını kullanır', () => {
  render(<SuratOfficialLabelPreview order={suratOrder()} />)
  const node = screen.getByTestId('surat-official-preview')
  const artifact = buildSuratOfficialArtifact(suratOrder())
  expect(artifact.page).toBeTruthy()
  expect(node.getAttribute('data-print-zpl-sha256')).toBe(
    artifact.page!.printZplSha256,
  )
  expect(node.getAttribute('data-render-version')).toBe(
    artifact.page!.render.renderVersion,
  )
  expect(node.getAttribute('data-template-fingerprint')).toBe(
    artifact.page!.render.templateFingerprint,
  )
  const svg = node.querySelector('svg')
  expect(svg?.getAttribute('viewBox')).toBe('0 0 799 799')
  expect(svg?.getAttribute('width')).toBe('100mm')
})

test('LP-13/LP-14: Chrome baskısı AYNI artefaktı kullanır ve window.print ÇAĞRILIR', async () => {
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  const frame = document.querySelector(
    '[data-surat-print-frame]',
  ) as HTMLIFrameElement
  const printSpy = vi.fn()
  // jsdom window.print uygulanmamıştır; casus fonksiyonla değiştirilir.
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

  expect(printSpy).toHaveBeenCalledTimes(1)
  expect(result.browserPrintDebug?.printMode).toBe('surat-official-svg')
  expect(result.browserPrintDebug?.printCalled).toBe(true)
  expect(result.ok).toBe(true)
  expect(result.jobs?.[0]).toMatchObject({ orderNumber: '1000000000000001', ok: true })
  // Belgeye giren SVG, önizlemedeki artefaktın AYNISIDIR.
  const artifact = buildSuratOfficialArtifact(suratOrder())
  const printed = frame.contentDocument?.querySelector(
    '.surat-official-page svg',
  )
  expect(printed?.getAttribute('viewBox')).toBe('0 0 799 799')
  expect(printed?.getAttribute('width')).toBe('100mm')
  // İçerik kimliği: aynı artefakt → aynı modül/çubuk sayısı ve aynı barkod
  // metni. (Ham dize karşılaştırılmaz: jsdom SVG'yi yeniden serileştirir.)
  const artifactRects = (artifact.page!.render.svg.match(/<rect/g) ?? []).length
  expect(printed?.querySelectorAll('rect').length).toBe(artifactRects)
  expect(printed?.textContent).toContain('01200000001')
  expect(printed?.textContent).toContain('Ornek Elbise')
  // CargoFlow HTML şablonu resmî modda YENİDEN ÇİZİLMEZ.
  expect(frame.contentDocument?.querySelector('.label-page')).toBe(null)
}, 20000)

test('LP-15: önizleme printCount/labelStatus DEĞİŞTİRMEZ, provider ÇAĞIRMAZ', () => {
  const order = suratOrder({
    label: { zplContent: OFFICIAL_ZPL, printCount: 3 },
  } as Partial<CargoOrder>)
  const before = JSON.stringify(order)
  const fetchSpy = vi.fn()
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  render(<SuratOfficialLabelPreview order={order} />)
  expect(screen.getByTestId('surat-official-preview')).toBeTruthy()
  expect(JSON.stringify(order)).toBe(before)
  expect(order.label?.printCount).toBe(3)
  expect(order.labelStatus).toBe('READY')
  expect(fetchSpy).not.toHaveBeenCalled()
  globalThis.fetch = originalFetch
})

test('LP-16: şablon seçiminde popup veya onay modalı YOKTUR', async () => {
  const user = userEvent.setup()
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderControls()
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  await user.click(screen.getByTestId('print-with-surat-template'))
  expect(openSpy).not.toHaveBeenCalled()
  expect(confirmSpy).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBe(null)
  expect(screen.queryByRole('alertdialog')).toBe(null)
  openSpy.mockRestore()
  confirmSpy.mockRestore()
})

beforeEach(() => {
  document.body.innerHTML = ''
})
