import type {
  IntegrationConfig,
  LabelTemplate,
  LabelTypographyConfig,
  PrinterSettings,
} from '../types/cargoflow'
import { loadFromStorage, saveToStorage } from '../utils/storage'

const INTEGRATION_KEY = 'cargoflow.integrationConfig'
const PRINTER_KEY = 'cargoflow.printerSettings'
const LABEL_TEMPLATE_KEY = 'cargoflow.labelTemplate'
const LOCAL_CONFIG_ENDPOINT =
  'http://127.0.0.1:8787/api/local-config/integration'

export function mmToDots(mm: number): number {
  return Math.round((mm / 25.4) * 203)
}

export const defaultIntegrationConfig: IntegrationConfig = {
  trendyol: {
    sellerId: '',
    apiKey: '',
    apiSecret: '',
    environment: 'prod',
    userAgentName: '',
  },
  surat: {
    kullaniciAdi: '',
    sifre: '',
    webPassword: '',
    sellerPaysKullaniciAdi: '',
    sellerPaysSifre: '',
    sellerPaysWebPassword: '',
    codKullaniciAdi: '',
    codSifre: '',
    codWebPassword: '',
    firmaId: '',
    restBasicUsername: '',
    restBasicPassword: '',
    restSenderMusteriId: '',
    restSenderAdi: '',
    restSenderSoyadi: '',
    restSenderTelefon: '',
    restSenderEmail: '',
    restSenderAdres: '',
    restSenderIlId: 0,
    restSenderIlceAdi: '',
    testKullaniciAdi: '',
    testSifre: '',
    testWebPassword: '',
    testFirmaId: '',
    liveKullaniciAdi: '',
    liveSifre: '',
    liveWebPassword: '',
    liveFirmaId: '',
    entegrasyonSozlesme: '',
    entegrasyonMusteri: '',
    entegrasyonFirmasi: 'Trendyol',
    whoPays: '',
    odemeTipi: '1',
    kWebGonderiGirisiKaynak: 'PazaryeriOrtakBarkod',
    ortam: 'test',
    serviceMode: 'ORTAK_BARKOD_SOAP',
    serviceType: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    createShipmentPath:
      '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    trackingServiceType: 'KargoTakipHareketDetayiSoap',
    trackingPath: '/api/KargoTakipHareketDetayi',
    trackingCodeField: 'auto',
    barcodeCodeField: 'auto',
    tNoCodeField: 'auto',
    trackingVerificationDelaysMs: [0, 3000, 10000, 30000, 60000],
    labelRegistrationGraceMs: 30 * 60 * 1000,
  },
}

export const defaultPrinterSettings: PrinterSettings = {
  printerName: 'ZDesigner ZD220-203dpi ZPL',
  mode: 'browser-print',
  labelSize: '100x100',
  defaultFormat: 'zpl',
}

export const defaultLabelTypography: LabelTypographyConfig = {
  headerName: 14,
  address: 10,
  route: 14,
  cargoValue: 19,
  deliveryTitle: 14,
  deliveryRoute: 18,
  transfer: 16,
  productTitle: 11,
  productMeta: 9,
}

export const defaultLabelTemplate: LabelTemplate = {
  id: 'tpl_zebra_100x100',
  name: '10x10 cm Zebra Code128',
  widthMm: 100,
  heightMm: 100,
  widthDots: 799,
  heightDots: 799,
  barcodeX: 80,
  barcodeY: 560,
  barcodeModuleWidth: 3,
  barcodeHeight: 120,
  fontSize: 24,
  lineGap: 38,
  fieldStartX: 32,
  fieldStartY: 120,
  typography: defaultLabelTypography,
  updatedAt: new Date().toISOString(),
  fields: [
    { key: 'marketplace', label: 'Pazaryeri adı', visible: true, order: 1 },
    { key: 'orderNumber', label: 'Sipariş no', visible: true, order: 2 },
    { key: 'shippingProvider', label: 'Kargo firması', visible: true, order: 3 },
    { key: 'customerName', label: 'Alıcı adı', visible: true, order: 4 },
    { key: 'customerPhone', label: 'Telefon', visible: true, order: 5 },
    { key: 'cityDistrict', label: 'İl / İlçe', visible: true, order: 6 },
    { key: 'address', label: 'Açık adres', visible: true, order: 7 },
    { key: 'productName', label: 'Ürün adı', visible: true, order: 8 },
    { key: 'quantity', label: 'Adet', visible: true, order: 9 },
    { key: 'trackingNumber', label: 'Takip numarası', visible: true, order: 10 },
    { key: 'shipmentCode', label: 'Gönderi kodu', visible: true, order: 11 },
  ],
}

export class IntegrationConfigService {
  loadIntegrationConfig(): IntegrationConfig {
    const stored = loadFromStorage<IntegrationConfig>(
      INTEGRATION_KEY,
      defaultIntegrationConfig,
    )
    const normalizedSurat = normalizeSuratConfig(stored.surat)
    const normalized = {
      ...defaultIntegrationConfig,
      ...stored,
      trendyol: {
        ...defaultIntegrationConfig.trendyol,
        ...stored.trendyol,
      },
      surat: {
        ...defaultIntegrationConfig.surat,
        ...stored.surat,
        ...normalizedSurat,
      },
    }
    if (
      stored.surat?.serviceMode !== normalized.surat.serviceMode ||
      stored.surat?.serviceType !== normalized.surat.serviceType ||
      stored.surat?.createShipmentPath !== normalized.surat.createShipmentPath
    ) {
      saveToStorage(INTEGRATION_KEY, normalized)
    }
    return normalized
  }

  async hydrateIntegrationConfig(): Promise<IntegrationConfig> {
    const localConfig = this.loadIntegrationConfig()
    if (!isLoopbackBrowser()) return localConfig

    try {
      const response = await fetch(LOCAL_CONFIG_ENDPOINT, {
        headers: localConfigHeaders(),
      })
      const payload = await response.json()
      if (response.ok && payload?.configured && payload?.config) {
        const normalized = normalizeIntegrationConfig(payload.config)
        saveToStorage(INTEGRATION_KEY, normalized)
        return normalized
      }
      if (hasIntegrationCredentials(localConfig)) {
        await this.persistIntegrationConfig(localConfig)
      }
    } catch {
      // Backend kapalı olsa bile tarayıcıdaki mevcut ayarlar kullanılmaya devam eder.
    }
    return localConfig
  }

  saveIntegrationConfig(config: IntegrationConfig): IntegrationConfig {
    const normalized = normalizeIntegrationConfig(config)
    saveToStorage(INTEGRATION_KEY, normalized)
    void this.persistIntegrationConfig(normalized)
    return normalized
  }

  async persistIntegrationConfig(config: IntegrationConfig): Promise<boolean> {
    if (!isLoopbackBrowser()) return false
    try {
      const response = await fetch(LOCAL_CONFIG_ENDPOINT, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...localConfigHeaders(),
        },
        body: JSON.stringify({ config: normalizeIntegrationConfig(config) }),
      })
      return response.ok
    } catch {
      return false
    }
  }

  loadPrinterSettings(): PrinterSettings {
    const stored = loadFromStorage<PrinterSettings>(
      PRINTER_KEY,
      defaultPrinterSettings,
    )
    const shouldUseBrowserPrint =
      stored.mode === 'local-agent' || stored.mode === 'browser-print'
    const isLegacyDefault =
      (stored.printerName === 'Zebra ZD220' &&
        stored.mode === 'download') ||
      (stored.printerName === 'ZDesigner ZD220-203dpi ZPL' &&
        stored.mode === 'local-agent' &&
        stored.labelSize === '100x100')
    const normalized = isLegacyDefault
      ? defaultPrinterSettings
      : {
          ...defaultPrinterSettings,
          ...stored,
          mode: shouldUseBrowserPrint
            ? 'browser-print'
            : stored.mode ?? defaultPrinterSettings.mode,
        }
    if (isLegacyDefault || stored.mode !== normalized.mode) {
      saveToStorage(PRINTER_KEY, normalized)
    }
    return normalized
  }

  savePrinterSettings(settings: PrinterSettings): PrinterSettings {
    saveToStorage(PRINTER_KEY, settings)
    return settings
  }

  loadLabelTemplate(): LabelTemplate {
    const stored = loadFromStorage<LabelTemplate>(
      LABEL_TEMPLATE_KEY,
      defaultLabelTemplate,
    )
    const typography = normalizeLabelTypography(stored.typography)
    const normalized = {
      ...defaultLabelTemplate,
      ...stored,
      typography,
      fields: stored.fields?.length
        ? stored.fields
        : defaultLabelTemplate.fields,
    }
    if (JSON.stringify(stored.typography) !== JSON.stringify(typography)) {
      saveToStorage(LABEL_TEMPLATE_KEY, normalized)
    }
    return normalized
  }

  saveLabelTemplate(template: LabelTemplate): LabelTemplate {
    const normalized = {
      ...template,
      widthDots: mmToDots(template.widthMm),
      heightDots: mmToDots(template.heightMm),
      typography: {
        ...normalizeLabelTypography(template.typography),
      },
      updatedAt: new Date().toISOString(),
    }
    saveToStorage(LABEL_TEMPLATE_KEY, normalized)
    return normalized
  }
}

function normalizeIntegrationConfig(
  config: IntegrationConfig,
): IntegrationConfig {
  return {
    ...defaultIntegrationConfig,
    ...config,
    trendyol: {
      ...defaultIntegrationConfig.trendyol,
      ...config.trendyol,
    },
    surat: {
      ...defaultIntegrationConfig.surat,
      ...config.surat,
      ...normalizeSuratConfig(config.surat),
    },
  }
}

function isLoopbackBrowser(): boolean {
  if (typeof window === 'undefined' || !window.location?.hostname) return false
  return ['127.0.0.1', 'localhost', '::1'].includes(
    window.location.hostname.toLocaleLowerCase('en-US'),
  )
}

function localConfigHeaders(): Record<string, string> {
  return {
    'X-CargoFlow-Client-Host': window.location?.hostname || '',
  }
}

function hasIntegrationCredentials(config: IntegrationConfig): boolean {
  return Boolean(
    config.trendyol.sellerId ||
      config.trendyol.apiKey ||
      config.trendyol.apiSecret ||
      config.surat.kullaniciAdi ||
      config.surat.sifre ||
      config.surat.webPassword ||
      config.surat.sellerPaysKullaniciAdi ||
      config.surat.sellerPaysSifre ||
      config.surat.sellerPaysWebPassword ||
      config.surat.codKullaniciAdi ||
      config.surat.codSifre ||
      config.surat.codWebPassword ||
      config.surat.firmaId,
  )
}

function normalizeLabelTypography(
  typography?: Partial<LabelTypographyConfig>,
): LabelTypographyConfig {
  const value = {
    ...defaultLabelTypography,
    ...typography,
  }
  return {
    headerName: clamp(value.headerName, 10, 18),
    address: clamp(value.address, 8, 13),
    route: clamp(value.route, 11, 16),
    cargoValue: clamp(value.cargoValue, 15, 22),
    deliveryTitle: clamp(value.deliveryTitle, 12, 16),
    deliveryRoute: clamp(value.deliveryRoute, 13, 20),
    transfer: clamp(value.transfer, 12, 18),
    productTitle: clamp(value.productTitle, 9, 14),
    productMeta: clamp(value.productMeta, 8, 12),
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number(value) || minimum))
}

function normalizeSuratConfig(
  surat?: Partial<IntegrationConfig['surat']>,
): IntegrationConfig['surat'] {
  const serviceMode =
    surat?.serviceMode === 'ORTAK_BARKOD_SOAP' ||
    surat?.serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP' ||
    surat?.serviceMode === 'PRE_REGISTRATION_REST' ||
    surat?.serviceMode === 'GONDERI_YENI_SOAP' ||
    surat?.serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL'
      ? surat.serviceMode
      : 'ORTAK_BARKOD_SOAP'
  const route = routeFromServiceMode(serviceMode)

  return {
    ...defaultIntegrationConfig.surat,
    ...surat,
    serviceMode,
    ...route,
    trackingServiceType: 'KargoTakipHareketDetayiSoap',
  }
}

export function routeFromServiceMode(
  serviceMode: IntegrationConfig['surat']['serviceMode'],
): Pick<IntegrationConfig['surat'], 'serviceType' | 'createShipmentPath'> {
  if (serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP') {
    return {
      serviceType: 'KargoBarkoduSiparisSoap',
      createShipmentPath: '/api/KargoBarkoduSiparis',
    }
  }
  if (serviceMode === 'PRE_REGISTRATION_REST') {
    return {
      serviceType: 'GonderiyiKargoyaGonderRestJson',
      createShipmentPath: '/api/GonderiyiKargoyaGonder',
    }
  }
  if (serviceMode === 'GONDERI_YENI_SOAP') {
    return {
      serviceType: 'GonderiyiKargoyaGonderYeniSoap',
      createShipmentPath: '/api/GonderiyiKargoyaGonderYeni',
    }
  }
  if (serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL') {
    return {
      serviceType: 'GonderiOlusturV2',
      createShipmentPath: '/api/Gonderi/GonderiOlustur',
    }
  }
  return {
    serviceType: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    createShipmentPath:
      '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  }
}
