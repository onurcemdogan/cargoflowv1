import JsBarcode from 'jsbarcode'
import {
  applyScalableQuietZone,
  CODE128_QUIET_ZONE_MODULES,
} from './barcodeQuietZone'
import qrcode from 'qrcode-generator'
import type {
  CargoOrder,
  CargoProduct,
  LabelTemplate,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import { buildLabelData, type LabelData } from './labelData'
import {
  AUGMENTATION_FALLBACK_WARNING,
  deriveAugmentedSuratZplWithHashes,
} from './augmentedSuratZpl'
import { resolveSuratProductLineItems } from './suratProductLineItems'
import {
  LEGACY_ZPL_MISSING_MESSAGE,
  resolveSuratPrintEligibility,
} from './suratPrintEligibility'
import { formatDesi } from './desi'
import { PRINT_HOST_UNAVAILABLE_MESSAGE } from './suratPrintFailureReasons'
import {
  buildProductMetaText,
  buildProductTitleText,
} from './labelProductFit'
import { resolveLabelLayout } from './labelLayoutResolver'
import {
  buildOfficialSuratPrintDocument,
  type OfficialSuratPage,
  type OfficialSuratSkip,
} from './officialSuratPrintDocument'

// Her etiket sayfası kendi bağımsız (immutable) modelini kullanır; bir
// siparişin kodları başka siparişe sızamaz.
export interface SuratPrintItemLine {
  productName: string
  quantity: number
  color?: string
  size?: string
  sku?: string
}

export interface SuratPrintPageModel {
  orderNumber: string
  trackingNumber: string
  barcodeNumber: string
  ozelKargoTakipNo: string
  zpl: string
  recipient: string
  address: string
  desi: number | null
  packageCount: number
  // Yalnız ÇOK ürünlü siparişlerde doldurulur; tekli sipariş modeli
  // (regression baseline) bu alanlar olmadan aynen devam eder. Satırlar
  // shipment'ı mutate etmeden ayrı normalize edilir.
  items?: SuratPrintItemLine[]
  totalQuantity?: number
  contentLines?: string[]
  // carrier_zpl: taşıyıcının gerçek ZPL'i var; canonical_html: legacy kayıt,
  // etiket canonical alanlardan HTML olarak basılır (ZPL İndir kapalı).
  printSource?: 'carrier_zpl' | 'canonical_html'
  // TÜRETİLMİŞ baskı ZPL'i: resmî kaynak AYNEN + en alta ürün satırı.
  // `zpl` alanı bu türetilmiş çıktıdır (indirme, native ve önizleme AYNI
  // artefaktı kullanır). Kaynak ZPL audit için ayrıca taşınır.
  sourceZpl?: string
  printZplSha256?: string
  printZplSourceSha256?: string
  printZplVersion?: string
  printZplFooterProfile?: string
  /** Ürün satırı eklenemediyse güvenli sebep (PII içermez). */
  printZplFallbackReason?: string
  /** success | overflow | unsupported_template | unavailable */
  augmentationStatus?: string
  /** Fallback kullanıldıysa gösterilecek GÜVENLİ uyarı (PII içermez). */
  augmentationWarning?: string
}

export interface SuratPrintSkip {
  orderNumber: string
  reason: string
}

export interface SuratPrintSelection {
  printable: Array<{ order: CargoOrder; model: SuratPrintPageModel }>
  skipped: SuratPrintSkip[]
}

export interface SuratBulkPrintResult {
  printedOrderNumbers: string[]
  models: SuratPrintPageModel[]
  skipped: SuratPrintSkip[]
  printCalled: boolean
  debug?: BrowserLabelPrintDebug
}

export function buildSuratPrintPageModel(
  order: CargoOrder,
  // Organizasyon kapsamlı ürün kataloğu: ZPL ürün satırı HTML etiketiyle
  // AYNI metadata zincirini kullanır (ayrı tahmin algoritması YOK).
  products: CargoProduct[] = [],
): {
  model?: SuratPrintPageModel
  reason?: string
} {
  const eligibility = resolveSuratPrintEligibility(order)
  if (!eligibility.canPrint) {
    return { reason: eligibility.reason }
  }
  const shipment = order.shipment
  const zplAnalysis =
    shipment?.zplAnalysis ?? shipment?.suratCreateLog?.zplAnalysis
  // T.No ve barkod bağımsız kaynak ailelerinden çözülür; birbirinin yerine
  // kullanılamaz. Kanıt (11424170556): eski parser 016 ZPL'indeki ilk numeric
  // ^FD'yi (T.No) üst seviye Barcode alanlarına da yazabiliyor. Bu yüzden
  // canonical barkod önceliği zplAnalysis.acceptedFinalBarcode'dadır ve
  // T.No ile çakışan barkod adayları reddedilir.
  const trackingNumber = firstString(
    shipment?.trackingNumber,
    shipment?.tNo,
    shipment?.kargoTakipNo,
    zplAnalysis?.acceptedTNo,
  )
  const collidesWithTracking = (value: string): boolean =>
    Boolean(
      value &&
        (value === trackingNumber ||
          value === firstString(zplAnalysis?.acceptedTNo)),
    )
  const barcodeCandidates = [
    zplAnalysis?.acceptedFinalBarcode,
    shipment?.codeMapping?.barcodeValue,
    shipment?.barkodNo,
    shipment?.barcode,
    shipment?.barcodeValue,
    shipment?.finalSuratBarcode,
  ]
  const barcodeNumber = firstString(
    ...barcodeCandidates.map((value) =>
      collidesWithTracking(firstString(value)) ? '' : value,
    ),
  )
  const ozelKargoTakipNo = firstString(
    shipment?.ozelKargoTakipNo,
    order.cargoTrackingNumber,
  )
  if (!trackingNumber || !barcodeNumber) {
    suratPrintTrace('PRINT_SKIPPED_REASON', {
      reason: 'FIELD_MAPPING_COLLISION',
      orderNumber: String(order.orderNumber ?? ''),
      trackingNumber,
      barcodeNumber,
      acceptedTNo: firstString(zplAnalysis?.acceptedTNo),
      acceptedFinalBarcode: firstString(zplAnalysis?.acceptedFinalBarcode),
    })
    return {
      reason:
        'Etiket yazdırılamadı: T.No ve barkod alanları yanlış eşleştirilmiş.',
    }
  }
  if (trackingNumber === barcodeNumber) {
    suratPrintTrace('PRINT_SKIPPED_REASON', {
      reason: 'FIELD_MAPPING_COLLISION',
      orderNumber: String(order.orderNumber ?? ''),
      trackingNumber,
      barcodeNumber,
      acceptedTNo: firstString(zplAnalysis?.acceptedTNo),
      acceptedFinalBarcode: firstString(zplAnalysis?.acceptedFinalBarcode),
    })
    return {
      reason:
        'Etiket yazdırılamadı: T.No ve barkod alanları yanlış eşleştirilmiş.',
    }
  }
  // Çoklu ürün satırları shipment'a DOKUNMADAN ayrı bir modelde normalize
  // edilir; ZPL/tracking/barkod alanları ürün satırlarınca asla ezilmez.
  const normalizedItems: SuratPrintItemLine[] = (order.items ?? []).map(
    (item) => ({
      productName: String(item.productName ?? '').trim(),
      quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
      color: item.color ? String(item.color) : undefined,
      size: item.size ? String(item.size) : undefined,
      sku: item.merchantSku || item.sku || undefined,
    }),
  )
  const multiItemFields =
    normalizedItems.length > 1
      ? {
          items: normalizedItems,
          totalQuantity: normalizedItems.reduce(
            (total, item) => total + item.quantity,
            0,
          ),
          contentLines: normalizedItems.map(
            (item) => `${item.quantity} x ${item.productName}`,
          ),
        }
      : {}
  // TÜRETİLMİŞ printZpl: resmî ZPL byte-for-byte korunur, yalnız final ^PQ /
  // ^XZ öncesine ürün satırı eklenir. Deterministiktir: aynı sipariş + aynı
  // kaynak ZPL HER ZAMAN aynı çıktıyı ve aynı SHA'yı verir; bu yüzden
  // önizleme, indirme, native baskı ve reprint AYNI artefaktı kullanır.
  const productLineItems = resolveSuratProductLineItems(order, products)
  const augmented = deriveAugmentedSuratZplWithHashes(
    eligibility.barcodeRaw,
    productLineItems,
  )
  // CANLI REGRESYON DÜZELTMESİ: ürün satırı ekleme EK BİR ÖZELLİKTİR ve
  // BASKIYI ASLA BLOKLAMAZ. Önceki sürüm footer sığmadığında siparişi
  // tamamen atlıyordu; gerçek Sürat şablonunda footer alanı 0 çıktığı için
  // TÜM baskılar (yeni ve eski READY/PRINTED etiketler dâhil) durdu.
  // Yeni sözleşme: augmentation başarısızsa resmî kaynak ZPL kullanılır ve
  // sonuç SESSİZ DEĞİLDİR — augmentationStatus + güvenli uyarı taşınır.
  return {
    model: {
      orderNumber: String(order.orderNumber ?? ''),
      trackingNumber,
      barcodeNumber,
      ozelKargoTakipNo,
      zpl: augmented.printZpl,
      sourceZpl: augmented.sourceZpl,
      printZplSha256: augmented.printZplSha256,
      printZplSourceSha256: augmented.printZplSourceSha256,
      printZplVersion: augmented.printZplVersion,
      printZplFooterProfile: augmented.printZplFooterProfile ?? undefined,
      printZplFallbackReason: augmented.fallbackMessage,
      augmentationStatus: augmented.augmentationStatus,
      augmentationWarning: augmented.augmented
        ? undefined
        : AUGMENTATION_FALLBACK_WARNING,
      recipient: String(order.customerName ?? ''),
      address: String(order.address ?? ''),
      desi: order.desi ?? null,
      packageCount: order.packageCount ?? 1,
      printSource:
        eligibility.source === 'canonical_html'
          ? 'canonical_html'
          : 'carrier_zpl',
      ...multiItemFields,
    },
  }
}

export function resolveSuratPrintableSelection(
  orders: CargoOrder[],
  products: CargoProduct[] = [],
): SuratPrintSelection {
  const printable: SuratPrintSelection['printable'] = []
  const skipped: SuratPrintSkip[] = []
  const seen = new Set<string>()
  for (const order of orders) {
    const dedupeKey = String(order.id || order.orderNumber || '')
    if (dedupeKey && seen.has(dedupeKey)) continue
    if (dedupeKey) seen.add(dedupeKey)
    const { model, reason } = buildSuratPrintPageModel(order, products)
    suratPrintTrace('PAGE_RESOLUTION_RESULT', {
      orderNumber: String(order.orderNumber ?? order.id ?? '-'),
      lifecycleStatus: order.shipment?.lifecycleStatus ?? '',
      printEnabled: order.shipment?.printEnabled === true,
      canPrint: Boolean(model),
      trackingNumber: model?.trackingNumber ?? '',
      barcode: model?.barcodeNumber ?? '',
      hasZpl: Boolean(model?.zpl),
      reason: reason ?? '',
    })
    if (model) {
      printable.push({ order, model })
    } else {
      const skipReason = reason || 'Etiket yazdırmaya uygun değil.'
      suratPrintTrace('PRINT_SKIPPED_REASON', {
        orderNumber: String(order.orderNumber ?? order.id ?? '-'),
        reason: skipReason,
      })
      skipped.push({
        orderNumber: String(order.orderNumber ?? order.id ?? '-'),
        reason: skipReason,
      })
    }
  }
  return { printable, skipped }
}

export interface SuratZplDownload {
  fileName: string
  content: string
  models: SuratPrintPageModel[]
  skipped: SuratPrintSkip[]
}

// ZPL İndir: yalnız .zpl dosyası içeriğini çözer. Modal açmaz, window.print
// çağırmaz, create tetiklemez. Print ile aynı eligibility/seçim mantığını
// kullanır ki iki aksiyon tutarlı olsun.
export function buildSuratZplDownload(
  orders: CargoOrder[],
  products: CargoProduct[] = [],
): SuratZplDownload | null {
  const selection = resolveSuratPrintableSelection(orders, products)
  // ZPL dosyasına yalnız taşıyıcının GERÇEK ZPL'i girer. canonical_html
  // kaynaklı (legacy, ZPL'siz) etiketler yazdırılabilir olsa da indirme
  // listesinden açıklamayla düşer.
  const zplModels = selection.printable
    .map((item) => item.model)
    .filter((model) => model.zpl.trim().length > 0)
  const legacySkipped = selection.printable
    .filter((item) => !item.model.zpl.trim())
    .map((item) => ({
      orderNumber: item.model.orderNumber,
      reason: LEGACY_ZPL_MISSING_MESSAGE,
    }))
  const skipped = [...selection.skipped, ...legacySkipped]
  if (zplModels.length === 0) {
    return zplModels.length === 0 && skipped.length > 0
      ? { fileName: '', content: '', models: [], skipped }
      : null
  }
  const content = zplModels.map((model) => model.zpl).join('\n')
  const fileName =
    zplModels.length === 1
      ? `surat-${sanitizeFilePart(zplModels[0].orderNumber)}-${sanitizeFilePart(
          zplModels[0].barcodeNumber,
        )}.zpl`
      : `surat-toplu-${zplModels.length}.zpl`
  return { fileName, content, models: zplModels, skipped }
}

function sanitizeFilePart(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'label'
}

// Tekli ve toplu yazdırmanın tek giriş noktası. Uygun etiketleri tek print
// dokümanında toplar, window.print() yalnız bir kez çağrılır ve pencere
// otomatik kapatılmaz.
export async function printSuratLabels(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
  products: CargoProduct[] = [],
): Promise<SuratBulkPrintResult> {
  const selection = resolveSuratPrintableSelection(orders, products)
  if (selection.printable.length === 0) {
    return {
      printedOrderNumbers: [],
      models: [],
      skipped: selection.skipped,
      printCalled: false,
    }
  }
  try {
    const debug = await printCleanLabelDocument(
      selection.printable.map((item) => item.order),
      template,
      mappingConfig,
      products,
    )
    // Belgeye giren siparisler basarili; render'da atlananlar skipped'a eklenir.
    // Bir siparisin hatasi DIGERLERINI basarisiz gostermez.
    const renderedNumbers = new Set(debug.printedOrderNumbers ?? [])
    const printedModels = selection.printable
      .map((item) => item.model)
      .filter((model) => renderedNumbers.size === 0
        || renderedNumbers.has(model.orderNumber))
    return {
      printedOrderNumbers: debug.printCalled
        ? printedModels.map((model) => model.orderNumber)
        : [],
      models: printedModels,
      skipped: [...selection.skipped, ...(debug.skipped ?? [])],
      printCalled: debug.printCalled,
      debug,
    }
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : 'Yazdırma başlatılamadı.'
    return {
      printedOrderNumbers: [],
      models: [],
      skipped: [
        ...selection.skipped,
        ...selection.printable.map((item) => ({
          orderNumber: item.model.orderNumber,
          reason,
        })),
      ],
      printCalled: false,
      debug:
        error instanceof BrowserLabelPrintError ? error.debug : undefined,
    }
  }
}

export interface BrowserLabelPrintDebug {
  /** Render asamasinda atlanan siparisler (siparis numarasi + sebep). */
  skipped?: SuratPrintSkip[]
  /** Belgeye GERCEKTEN giren siparis numaralari. */
  printedOrderNumbers?: string[]
  printRequested: boolean
  printMode: 'chrome-html' | 'zpl-native' | 'test-label' | 'surat-official-png'
  labelHtmlGenerated: boolean
  labelHtmlLength: number
  barcodeValue: string
  zplAvailable: boolean
  printableContentPreview: string
  printWindowOpened: boolean
  printCalled: boolean
  rejectionReason?: string
}

export class BrowserLabelPrintError extends Error {
  debug: BrowserLabelPrintDebug

  constructor(message: string, debug: BrowserLabelPrintDebug) {
    super(message)
    this.name = 'BrowserLabelPrintError'
    this.debug = debug
  }
}

// ---------------------------------------------------------------------------
// Print motoru: KALICI gizli iframe. Popup yaklaşımı tamamen kaldırıldı.
// Kurallar:
// - iframe DOM'da kalıcıdır; her print aynı iframe'i yeniden kullanır.
// - Başarılı print yolunda HİÇBİR cleanup yoktur: window.close yok,
//   iframe.remove yok, afterprint yalnız tanı logu üretir.
// - Tek click = tek execution: activePrintExecution guard'ı çift çağrıyı
//   (React StrictMode dahil) engeller.
// - Her yaşam döngüsü adımı timestamp + executionId ile console'a loglanır.
// ---------------------------------------------------------------------------

let printExecutionCounter = 0
let activePrintExecution: string | null = null
let persistentPrintFrame: HTMLIFrameElement | null = null

export function suratPrintTrace(
  event: string,
  details: Record<string, unknown> = {},
): void {
  try {
    // Ayrıntılı baskı izleri (PRINT_BUTTON_CLICK / PRINT_ELIGIBILITY_RESULT vb.)
    // YALNIZ non-production'da konsola yazılır. Bu izler yalnız güvenli status/
    // boolean/tanımlayıcı metadata taşır; ham ZPL, müşteri adı/adres/telefon/
    // e-posta veya secret HİÇBİR ortamda loglanmaz.
    const isProduction =
      typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true
    if (isProduction) return
    console.info(`[surat-print] ${new Date().toISOString()} ${event}`, details)
  } catch {
    // console erişilemiyorsa akışı bozma
  }
}

function ensurePersistentPrintFrame(executionId: string): HTMLIFrameElement {
  if (
    persistentPrintFrame &&
    persistentPrintFrame.isConnected !== false &&
    persistentPrintFrame.contentWindow
  ) {
    suratPrintTrace('IFRAME_REUSED', { executionId })
    return persistentPrintFrame
  }
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('data-surat-print-frame', 'persistent')
  iframe.style.position = 'fixed'
  iframe.style.left = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.visibility = 'hidden'
  document.body.appendChild(iframe)
  persistentPrintFrame = iframe
  suratPrintTrace('WINDOW_REFERENCE_CREATED', {
    executionId,
    mode: 'persistent-iframe',
  })
  return iframe
}

// ---------------------------------------------------------------------------
// PRINT HOST'U İLK CLICK STACK'İNDE HAZIRLA
//
// Bu projede baskı motoru KALICI GİZLİ IFRAME'dir; window.open KULLANILMAZ,
// bu yüzden klasik popup engeli SÖZ KONUSU DEĞİLDİR. Yine de host'un gerçekten
// oluşturulabildiği, create mutasyonuna BAŞLAMADAN ÖNCE ve ilk await'ten ÖNCE
// senkron olarak doğrulanır: host kurulamıyorsa Sürat gönderisi OLUŞTURULMAZ,
// hiçbir statü/sayaç değişmez.
//
// Aynı iframe daha sonra printCleanLabelDocument tarafından YENİDEN KULLANILIR;
// ikinci bir pencere/iframe AÇILMAZ.
// ---------------------------------------------------------------------------
export interface SuratPrintHost {
  /** Host hazır mı? false ise create BAŞLATILMAMALIDIR. */
  ready: boolean
  /** Güvenli kullanıcı mesajı (PII/ZPL içermez). */
  reason?: string
  /** Baskı yapılmadan çıkılırsa host içeriğini temizler. */
  release: () => void
}

const PRINT_HOST_PLACEHOLDER =
  '<!doctype html><html lang="tr"><head><meta charset="utf-8">' +
  '<title>Etiketler hazırlanıyor…</title></head>' +
  '<body><p>Etiketler hazırlanıyor…</p></body></html>'

export function prepareSuratPrintHostSynchronously(): SuratPrintHost {
  const noop = () => {}
  if (typeof document === 'undefined') {
    suratPrintTrace('PRINT_HOST_UNAVAILABLE', { reason: 'no-document' })
    return {
      ready: false,
      reason: PRINT_HOST_UNAVAILABLE_MESSAGE,
      release: noop,
    }
  }
  try {
    const iframe = ensurePersistentPrintFrame('host-prepare')
    const frameDocument = iframe.contentDocument
    if (!frameDocument) {
      suratPrintTrace('PRINT_HOST_UNAVAILABLE', { reason: 'no-content-document' })
      return {
        ready: false,
        reason: PRINT_HOST_UNAVAILABLE_MESSAGE,
        release: noop,
      }
    }
    writePrintDocument(frameDocument, PRINT_HOST_PLACEHOLDER)
    suratPrintTrace('PRINT_HOST_READY', { mode: 'persistent-iframe' })
    return {
      ready: true,
      release: () => {
        try {
          const target = iframe.contentDocument
          if (target) writePrintDocument(target, PRINT_HOST_PLACEHOLDER)
          suratPrintTrace('PRINT_HOST_RELEASED', { printed: false })
        } catch {
          // temizlenemezse akışı bozma
        }
      },
    }
  } catch {
    suratPrintTrace('PRINT_HOST_UNAVAILABLE', { reason: 'iframe-create-failed' })
    return {
      ready: false,
      reason: PRINT_HOST_UNAVAILABLE_MESSAGE,
      release: noop,
    }
  }
}

// Geriye dönük uyumluluk: popup rezervasyonu kaldırıldı. Bu fonksiyonlar
// artık pencere AÇMAZ ve KAPATMAZ; yalnız tanı logu üretir.
export function reserveCleanLabelPrintWindow(): Window | null {
  suratPrintTrace('WINDOW_RESERVED', {
    deprecated: true,
    mode: 'persistent-iframe',
    note: 'Popup rezervasyonu kaldırıldı; kalıcı iframe kullanılıyor.',
  })
  return null
}

export function cancelReservedCleanLabelPrintWindow(): void {
  suratPrintTrace('CANCEL_RESERVED_CALLED', {
    deprecated: true,
    action: 'none',
    note: 'Kapatılacak popup yok; kalıcı iframe DOM\'da bırakılır.',
  })
}

export async function printCleanLabelDocument(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
  products: CargoProduct[] = [],
): Promise<BrowserLabelPrintDebug> {
  const executionId = `print-${++printExecutionCounter}`
  const orderNumbers = orders.map((order) => String(order.orderNumber ?? ''))
  const debug: BrowserLabelPrintDebug = {
    printRequested: true,
    printMode: 'chrome-html',
    labelHtmlGenerated: false,
    labelHtmlLength: 0,
    barcodeValue: '',
    zplAvailable: orders.some((order) =>
      Boolean(order.shipment?.barcodeRaw || order.label?.zplContent),
    ),
    printableContentPreview: '',
    printWindowOpened: false,
    printCalled: false,
  }
  suratPrintTrace('PRINT_FLOW_START', {
    executionId,
    orderNumbers,
    activePrintExecution,
  })

  if (activePrintExecution) {
    suratPrintTrace('PRINT_ERROR', {
      executionId,
      orderNumbers,
      reason: 'in-flight-guard',
      activePrintExecution,
    })
    return failPrint(
      debug,
      'Devam eden bir yazdırma işlemi var; aynı anda ikinci yazdırma başlatılmadı.',
    )
  }

  if (typeof document === 'undefined') {
    return failPrint(
      debug,
      'Tarayıcı baskı belgesi yalnızca kullanıcı arayüzünde açılabilir.'
    )
  }
  if (orders.length === 0) {
    return failPrint(debug, 'Yazdırılacak etiket bulunamadı.')
  }

  activePrintExecution = executionId
  try {
    suratPrintTrace('HTML_BUILD_START', { executionId, orderNumbers })
    // SIPARIS BAZINDA izolasyon: render edilemeyen siparis BUTUN batch'i
    // dusurmez; yalniz kendisi atlanir ve sebebi debug.skipped'a yazilir.
    const document_ = buildCleanLabelDocument(
      orders,
      template,
      mappingConfig,
      products,
    )
    const printHtml = document_.html
    debug.skipped = document_.skipped
    debug.printedOrderNumbers = document_.printable.map(
      (item) => item.model.orderNumber,
    )
    debug.labelHtmlGenerated = Boolean(printHtml.trim())
    debug.labelHtmlLength = printHtml.length
    debug.barcodeValue = firstString(
      orders[0]?.shipment?.barcode,
      orders[0]?.shipment?.barcodeValue,
      orders[0]?.label?.barcodeValue,
    )
    debug.printableContentPreview = previewPrintableContent(printHtml)
    suratPrintTrace('HTML_BUILD_SUCCESS', {
      executionId,
      htmlLength: printHtml.length,
    })

    if (!isPrintableLabelHtml(printHtml)) {
      return failPrint(debug, 'Yazdırılacak etiket içeriği oluşturulamadı.')
    }

    return await dispatchPrintDocument(printHtml, debug, executionId, orderNumbers)
  } catch (error) {
    if (!(error instanceof BrowserLabelPrintError)) {
      suratPrintTrace('PRINT_ERROR', {
        executionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    activePrintExecution = null
  }
}


// ---------------------------------------------------------------------------
// ORTAK BASKI YAŞAM DÖNGÜSÜ — kalıcı gizli iframe + window.print.
//
// HEM CargoFlow HTML şablonu HEM resmî Sürat PNG belgesi BU fonksiyonu
// kullanır. İkinci pencere/iframe AÇILMAZ, popup KULLANILMAZ, başarılı yolda
// cleanup YAPILMAZ. Davranış HTML yolundan AYNEN taşınmıştır.
// ---------------------------------------------------------------------------
async function dispatchPrintDocument(
  printHtml: string,
  debug: BrowserLabelPrintDebug,
  executionId: string,
  orderNumbers: string[],
  /** Resmî Sürat yolunda BEKLENEN fiziksel sayfa sayısı. */
  expectedPhysicalPages?: number,
): Promise<BrowserLabelPrintDebug> {
  const iframe = ensurePersistentPrintFrame(executionId)
  const frameDocument = iframe.contentDocument
  const frameWindow = iframe.contentWindow
  if (!frameDocument || !frameWindow) {
    suratPrintTrace('PRINT_ERROR', {
      executionId,
      reason: 'iframe-content-unavailable',
    })
    return failPrint(debug, 'Baskı iframe belgesi oluşturulamadı.')
  }
  debug.printWindowOpened = true

  suratPrintTrace('DOCUMENT_WRITE_START', { executionId })
  writePrintDocument(frameDocument, printHtml)
  suratPrintTrace('DOCUMENT_WRITE_END', { executionId })
  await waitForPrintDocument(frameDocument)

  // FİZİKSEL SAYFA KARDİNALİTESİ — baskıdan ÖNCE doğrulanır.
  if (typeof expectedPhysicalPages === 'number') {
    const images = await waitForLabelImages(frameDocument)
    const actualPhysicalPages = countOfficialSuratPages(frameDocument)
    suratPrintTrace('PRINT_DOCUMENT_CARDINALITY', {
      executionId,
      expectedPhysicalPages,
      actualPhysicalPages,
      imagesTotal: images.total,
      imagesReady: images.ready,
    })
    if (actualPhysicalPages !== expectedPhysicalPages) {
      // SESSİZ KAYIP YOK: eksik sayfayla baskı YAPILMAZ.
      return failPrint(
        debug,
        `Baskı belgesi eksik oluştu (${actualPhysicalPages}/${expectedPhysicalPages} sayfa).`,
      )
    }
  }

  // Tanı: afterprint/beforeunload yalnız LOGLANIR; hiçbir cleanup yapılmaz.
  try {
    frameWindow.onafterprint = () =>
      suratPrintTrace('AFTERPRINT_FIRED', {
        executionId,
        action: 'none',
        windowClosed: false,
      })
    frameWindow.onbeforeunload = () =>
      suratPrintTrace('WINDOW_BEFOREUNLOAD', { executionId })
  } catch {
    // bazı ortamlarda listener atanamayabilir; kritik değil
  }

  const frameFonts = (
    frameDocument as Document & { fonts?: { ready?: Promise<unknown> } }
  ).fonts
  if (frameFonts?.ready) {
    await frameFonts.ready
  }
  suratPrintTrace('FONTS_READY', { executionId })

  // Kritik (canlı enstrümantasyonla doğrulandı): gizli/0x0 iframe'in kendi
  // rAF'i Chrome'da HİÇ tetiklenmez; arka plan sekmelerde PARENT rAF de
  // duraklatılır. Akış RAF beklemesinde asılı kalıyordu. Bu yüzden rAF her
  // zaman kısa bir timeout ile YARIŞTIRILIR — hangisi önce gelirse akış
  // ilerler, asla asılı kalmaz.
  const raf =
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : typeof frameWindow.requestAnimationFrame === 'function'
        ? frameWindow.requestAnimationFrame.bind(frameWindow)
        : null
  const nextPaintTick = (): Promise<'raf' | 'timeout'> =>
    new Promise((resolve) => {
      let settled = false
      const settle = (source: 'raf' | 'timeout') => {
        if (settled) return
        settled = true
        resolve(source)
      }
      if (raf) raf(() => settle('raf'))
      setTimeout(() => settle('timeout'), 100)
    })
  suratPrintTrace('RAF_1', { executionId, source: await nextPaintTick() })
  suratPrintTrace('RAF_2', { executionId, source: await nextPaintTick() })
  await new Promise<void>((resolve) => setTimeout(resolve, 250))

  frameWindow.focus()
  suratPrintTrace('PRINT_CALL_START', {
    executionId,
    orderNumbers,
    printTriggered: true,
  })
  frameWindow.print()
  debug.printCalled = true
  suratPrintTrace('PRINT_CALL_END', {
    executionId,
    orderNumbers,
    printTriggered: true,
    cleanup: 'none',
  })
  // Print sonrası HİÇBİR cleanup yok: iframe DOM'da kalır, pencere
  // kapatılmaz; Chrome dialogunu kullanıcı kapatır.
  return debug
}

// ---------------------------------------------------------------------------
// RESMÎ SÜRAT ŞABLONU BASKISI
//
// render endpoint PNG'si → 100 × 100 mm belge → KALICI gizli iframe →
// window.print → Chrome yazdırma penceresi.
//
// Harici servis çağrısı YOKTUR (PNG zaten CargoFlow sunucusundan gelir).
// Resmî modda CargoFlow HTML etiketi YENİDEN ÇİZİLMEZ. Dönüş sözleşmesi HTML
// yoluyla AYNIDIR, bu yüzden jobs[].ok, kısmi batch izolasyonu ve printCount
// sözleşmesi DEĞİŞMEZ.
// ---------------------------------------------------------------------------
export async function printOfficialSuratDocument(
  pages: OfficialSuratPage[],
  skipped: OfficialSuratSkip[] = [],
): Promise<BrowserLabelPrintDebug> {
  const executionId = `print-official-${++printExecutionCounter}`
  // BİR SİPARİŞ ARTIK BİRDEN ÇOK FİZİKSEL SAYFA üretebilir (taşıyıcı + ürün
  // detayları). Sipariş kimlikleri TEKİLLEŞTİRİLİR: aksi hâlde 8 ürünlü tek
  // sipariş, sayım ve "basıldı" işaretlemesinde birden çok kez görünürdü.
  // Sıra KORUNUR (ilk görülme).
  const orderNumbers = Array.from(
    new Set(pages.map((page) => String(page.orderNumber ?? ''))),
  )
  const debug: BrowserLabelPrintDebug = {
    printRequested: true,
    printMode: 'surat-official-png',
    labelHtmlGenerated: false,
    labelHtmlLength: 0,
    barcodeValue: '',
    zplAvailable: true,
    printableContentPreview: '',
    printWindowOpened: false,
    printCalled: false,
    skipped,
    printedOrderNumbers: [],
  }
  suratPrintTrace('PRINT_FLOW_START', {
    executionId,
    orderNumbers,
    activePrintExecution,
    template: 'surat_official_zpl',
  })
  if (activePrintExecution) {
    return failPrint(
      debug,
      'Devam eden bir yazdırma işlemi var; aynı anda ikinci yazdırma başlatılmadı.',
    )
  }
  if (typeof document === 'undefined') {
    return failPrint(
      debug,
      'Tarayıcı baskı belgesi yalnızca kullanıcı arayüzünde açılabilir.',
    )
  }
  // KÖK NEDEN (canlı, resmî şablon): burada sayfa üretilemeyen HER durum
  // `failPrint` ile fırlatılıyordu. Fırlatılan hata sağlayıcının catch dalında
  // yakalanıp TÜM işlerin sebebini "Yazdırılacak etiket bulunamadı." yapıyor,
  // koşucunun sipariş bazında topladığı GERÇEK render sebebini SİLİYORDU.
  // Artık: render sebebi varsa o sebep KORUNUR (fırlatma yok, baskı da yok);
  // yalnız hiç sipariş verilmemişse (sayfa da sebep de yok) hata üretilir.
  if (pages.length === 0) {
    if (skipped.length > 0) {
      suratPrintTrace('PRINT_SKIPPED_ALL', {
        executionId,
        template: 'surat_official_zpl',
        renderRequested: true,
        renderSucceeded: false,
        printDocumentDispatched: false,
        skipCount: skipped.length,
      })
      return debug
    }
    return failPrint(debug, 'Yazdırılacak etiket bulunamadı.')
  }
  activePrintExecution = executionId
  try {
    const documentModel = buildOfficialSuratPrintDocument(pages, skipped)
    debug.labelHtmlGenerated = true
    debug.labelHtmlLength = documentModel.html.length
    // MÜKERRER SAYIM YOK: bir sipariş birden çok FİZİKSEL sayfa üretebilir
    // (taşıyıcı + ürün detayları). "Basıldı" muhasebesi SİPARİŞ bazındadır;
    // aksi hâlde 3 sayfalık tek sipariş üç kez basılmış sayılır ve
    // label-printed geçişi üç kez tetiklenirdi. Sıra korunur (ilk görülme).
    debug.printedOrderNumbers = Array.from(
      new Set(documentModel.pages.map((page) => page.orderNumber)),
    )
    // Güvenli önizleme: ham ZPL veya PII TAŞIMAZ.
    debug.printableContentPreview = `surat-official-png pages=${documentModel.pages.length}`
    return await dispatchPrintDocument(
      documentModel.html,
      debug,
      executionId,
      orderNumbers,
      documentModel.pages.length,
    )
  } finally {
    activePrintExecution = null
  }
}

// Toplu baski belgesi: HER SIPARIS KENDI try/catch'inde render edilir.
// KOK NEDEN (canli): eskiden `selection.printable.map(...)` korumasizdi; TEK
// bir siparisin product-fit hatasi ("Urun bilgileri tek etikete sigmiyor")
// map'ten disari firlayip BUTUN toplu baskiyi iptal ediyordu. Hata Zebra'ya
// gonderim ONCESINDE olustugu icin printCalled=false kaliyor, 40 siparisin
// 40'i da basilmamis sayiliyordu ve hangi siparisin suclu oldugu KAYBOLUYORDU.
export interface CleanLabelDocument {
  html: string
  printable: Array<{ order: CargoOrder; model: SuratPrintPageModel }>
  skipped: SuratPrintSkip[]
}

export function buildCleanLabelDocument(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
  // Organizasyon kapsamli urun katalogu. Siparis satirinda eksik olan
  // renk/beden YALNIZ kesin kod eslesmesiyle buradan tamamlanir; onizleme ve
  // baski AYNI veriyi gorur.
  products: CargoProduct[] = [],
): CleanLabelDocument {
  const widthMm = template.widthMm || 100
  const heightMm = template.heightMm || 100
  const selection = resolveSuratPrintableSelection(orders, products)
  const skipped: SuratPrintSkip[] = [...selection.skipped]
  const printable: Array<{ order: CargoOrder; model: SuratPrintPageModel }> = []
  const pages: string[] = []

  for (const entry of selection.printable) {
    const { order, model } = entry
    try {
      const data = buildLabelData(
        order,
        order.shipment,
        template,
        mappingConfig,
        products,
      )
      pages.push(
        renderPrintableLabelHtml({
          ...data,
          tNo: model.trackingNumber,
          trackingNumber: model.trackingNumber,
          kargoTakipNo: model.trackingNumber,
          barcodeValue: model.barcodeNumber,
          mainBarcodeValue: model.barcodeNumber,
          barcode: model.barcodeNumber,
          qrPayload: model.ozelKargoTakipNo,
        }),
      )
      printable.push(entry)
    } catch (error) {
      // Bu siparis atlanir; DIGERLERI etkilenmez. Sebep siparis numarasiyla
      // birlikte tasinir (PII yok).
      const reason =
        error instanceof Error ? error.message : 'Etiket olusturulamadi.'
      suratPrintTrace('PRINT_SKIPPED_REASON', {
        orderNumber: model.orderNumber,
        reason,
        stage: 'label-render',
      })
      skipped.push({ orderNumber: model.orderNumber, reason })
    }
  }

  if (pages.length === 0) {
    const reasons = skipped
      .map((item) => `${item.orderNumber}: ${item.reason}`)
      .join(' | ')
    throw new Error(reasons || 'Yazdırılacak etiket içeriği oluşturulamadı.')
  }

  const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>CargoFlow Etiket</title>
  <style>
    @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: ${widthMm}mm;
      min-height: ${heightMm}mm;
      background: #fff;
    }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; }
    /* Referans termal etiket: sert, yüksek kontrast, yuvarlatma YOK.
       --label-mono  : yapısal/küçük bilgiler (daktilo hissi)
       --label-display: en baskın bloklar (rota, ödeme değerleri) — referansta
       bu satırlar ağır grotesk görünür. */
    .label-page {
      --label-mono: "Courier New", "DejaVu Sans Mono", monospace;
      --label-display: "Arial Black", "Helvetica Neue", Arial, sans-serif;
      width: ${widthMm}mm;
      height: ${heightMm}mm;
      overflow: hidden;
      display: grid;
      grid-template-columns: 5.6mm minmax(0, 1fr);
      border: .5mm solid #000;
      break-after: page;
      page-break-after: always;
      font-family: var(--label-mono);
      line-height: 1.05;
    }
    .label-page:last-child { break-after: auto; page-break-after: auto; }
    .surat-rail {
      display: grid;
      grid-template-rows: 1fr 1fr;
      place-items: center;
      overflow: hidden;
      border-right: .5mm solid #000;
    }
    .surat-rail strong,
    .surat-rail span {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      white-space: nowrap;
    }
    .surat-rail strong { font-size: 10pt; font-weight: 900; letter-spacing: .35mm; }
    .surat-rail span { max-height: 96%; font-size: 7.2pt; font-weight: 900; }
    /* Satır dağılımı referansa göre yeniden dengelendi. SABİT satır TOPLAMI
       87mm OLARAK KORUNUR; böylece alt ürün alanının yüksekliği ve
       resolveProductFit'in 9.4mm varsayımı DEĞİŞMEZ. */
    /* Satir yukseklikleri PROFILDEN gelir; toplam etiket 100x100mm ve
       barkod satiri (20.5mm) HER PROFILDE AYNI kalir. */
    .surat-body {
      display: grid;
      grid-template-rows:
        12mm 20.5mm var(--layout-address-row, 21.5mm) 10mm
        var(--layout-delivery-row, 23mm) 1fr;
      min-width: 0;
      min-height: 0;
    }
    .surat-section {
      min-width: 0;
      overflow: hidden;
      border-bottom: .5mm solid #000;
    }
    .surat-section:last-child { border-bottom: 0; }
    .surat-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 35mm;
      gap: 2mm;
      padding: 1.5mm 2mm .8mm;
    }
    .surat-header div { min-width: 0; overflow: hidden; }
    .surat-header span,
    .surat-header b {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .surat-header span { font-size: 6.8pt; font-weight: 800; }
    /* Gönderici adı üst bloğun EN baskın metnidir. */
    .surat-header b { font-size: 11.5pt; font-weight: 900; text-transform: uppercase; }
    .surat-header-right { text-align: right; }
    /* T.No değeri net ve kalın (orta güçlü kademe). */
    .surat-header-right span strong { font-size: 8.6pt; font-weight: 900; }
    /* Çubuklar geniş alana yayılır; ISO 10X sessiz alan SVG viewBox'ı içinde
       taşınır (barcodeQuietZone.ts). Buradaki 1mm yalnız fiziksel kenar
       payıdır, sessiz alanın YERİNE geçmez. */
    .surat-barcode {
      display: grid;
      place-items: stretch;
      /* Alt bosluk (2mm) ZORUNLU: insan-okunur barkod numarasi ile bolum
         ayirici cizgisi arasinda net beyaz alan birakir. Onceki 0 degeri
         rakamlarin tabanini cizgiye yapistiriyordu. Negatif margin YOK;
         sayi ve cizgi ayri layout akisinda. */
      padding: .4mm 1mm 2.3mm;
      overflow: visible;
    }
    /* Yukseklik 20.5 -> 18.5mm: alt bosluk eklendigi icin satir yuksekligi
       (21.5mm) asilmaz. YATAY geometri (cubuk genisligi, 10X sessiz alan)
       preserveAspectRatio='none' sayesinde bundan ETKILENMEZ. */
    .surat-barcode svg { width: 100%; height: 17.2mm; display: block; }
    /* Referans: adres kutusu TEK bölmedir; sağda ayrı kutu YOKTUR.
       Alt satırda solda alıcı telefonu, sağda il/ilçe bulunur. */
    .surat-address {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }
    .surat-address-copy {
      min-width: 0;
      overflow: hidden;
      padding: 1.6mm 2mm;
    }
    .surat-address-footer {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 2mm;
      margin-top: .6mm;
    }
    .surat-address-footer .surat-address-phone { flex: 0 0 auto; }
    .surat-address-footer .surat-address-region {
      flex: 1 1 auto;
      text-align: right;
      font-size: 8pt;
      font-weight: 900;
    }
    .surat-address-copy b,
    .surat-address-copy span,
    .surat-address-copy strong {
      display: block;
      text-transform: uppercase;
      white-space: normal;
      word-break: normal;
      overflow-wrap: break-word;
    }
    /* Alıcı adı adres satırlarından BASKIN (orta güçlü kademe). */
    .surat-address-copy b,
    .surat-address-copy strong { font-size: 9.2pt; font-weight: 900; line-height: 1.15; }
    .surat-address-copy span { font-size: 7pt; font-weight: 800; line-height: 1.15; }
    /* Adres kayıpsız sarılır; uzunluk arttıkça font kademeli küçülür.
       Ellipsis/kesme YOKTUR. */
    .surat-address-normal .surat-address-line { font-size: 7pt; }
    .surat-address-long .surat-address-line { font-size: 6.2pt; }
    .surat-address-long .surat-recipient-name { font-size: 7.6pt; }
    .surat-address-xlong .surat-address-line { font-size: 5.6pt; line-height: 1.1; }
    .surat-address-xlong .surat-recipient-name { font-size: 7pt; }
    .surat-address-xlong .surat-address-phone { font-size: 5.6pt; }
    /* Referans: tek satırlık sade blok; hücreler arasında dikey ayraç YOK. */
    .surat-cargo {
      display: grid;
      grid-template-columns: 22mm 22mm minmax(0, 1fr);
    }
    .surat-cargo div {
      display: grid;
      align-content: center;
      padding: .6mm 0 .6mm 2mm;
    }
    .surat-cargo span { font-size: 6.6pt; font-weight: 800; }
    /* POCH / KOLI / desi referansta en güçlü kademededir. */
    .surat-cargo strong {
      font-family: var(--label-display);
      font-size: 14.5pt;
      font-weight: 900;
      letter-spacing: -.05mm;
    }
    .surat-delivery {
      display: grid;
      grid-template-columns:
        var(--layout-large-qr, 21mm) minmax(0, 1fr)
        var(--layout-small-qr, 12.5mm);
      align-items: center;
      gap: 1.8mm;
      padding: 1mm 2mm;
    }
    .surat-qr-large,
    .surat-qr-small {
      width: 100%;
      aspect-ratio: 1 / 1;
      display: block;
      border: .5mm solid #000;
    }
    /* Parça adedi bloğu: her bilgi AYRI satırda, sabit line-height ile.
       Metinler üst üste binmez, QR/DataMatrix alanına taşmaz. */
    .surat-delivery-copy {
      min-width: 0;
      display: grid;
      grid-template-rows: auto auto auto auto auto;
      align-content: center;
      row-gap: .2mm;
      font-weight: 900;
    }
    .surat-delivery-copy span,
    .surat-delivery-copy b,
    .surat-delivery-copy strong,
    .surat-delivery-copy em {
      display: block;
      min-width: 0;
      text-transform: uppercase;
      white-space: normal;
      word-break: normal;
      overflow-wrap: break-word;
      line-height: 1.05;
    }
    /* Referans: "1 / 1" ile "Adrese Teslim" AYNI satırdadır. */
    .surat-parcel-row {
      display: flex;
      align-items: baseline;
      gap: 2.5mm;
      min-width: 0;
    }
    .surat-parcel-label { font-size: 6.2pt; }
    .surat-parcel-count { font-size: 12pt; flex: 0 0 auto; }
    .surat-delivery-type { font-size: 9.5pt; }
    /* EN GÜÇLÜ görsel vurgu: rota / aktarma satırları. */
    .surat-destination,
    .surat-transfer {
      font-family: var(--label-display);
      font-style: normal;
      letter-spacing: -.08mm;
    }
    /* Punto resolveRouteFit'ten gelir; SESSIZ KIRPMA YOK. Gucu once
       font-weight saglar, punto yalniz gerektigi kadar duser. */
    .surat-destination {
      font-size: var(--route-destination-size, 13pt);
      line-height: var(--route-line-height, 1);
    }
    .surat-transfer {
      font-size: var(--route-transfer-size, 11.5pt) !important;
      line-height: var(--route-line-height, 1);
    }
    /* Rota blogu kendi bolumunde kalir: komsulara TASMAZ. */
    .surat-delivery-copy { min-height: 0; }
    /* Urun alani: SESSIZ KIRPMA YOK. Metin sarilir; sigmazsa punto
       resolveProductFit ile kademeli kucultulur (--product-* degiskenleri).
       Hicbir kademede sigmazsa render ACIK hata verir. */
    .surat-product {
      padding: var(--layout-product-padding, 1.2mm) 2mm;
      overflow: visible;
    }
    .surat-product strong,
    .surat-product span {
      display: block;
      font-weight: 900;
      white-space: normal;
      overflow-wrap: break-word;
      word-break: normal;
      line-height: var(--product-line-height, 1.15);
    }
    .surat-product strong { font-size: var(--product-title-size, 8pt); }
    .surat-product span {
      font-size: var(--product-meta-size, 7pt);
      margin-top: .3mm;
    }
    /* Coklu urun: satirlar kayipsiz sarilir. overflow:hidden KALDIRILDI —
       icerik sessizce gizlenmez; sigdirma punto kademesiyle yapilir. */
    .surat-product-multi { overflow: visible; }
    .surat-product-multi .surat-product-line { margin-top: .4mm; }
    .surat-product-multi .surat-product-line:first-child { margin-top: 0; }
    .surat-product-multi strong,
    .surat-product-multi span {
      white-space: normal;
      overflow-wrap: break-word;
      word-break: normal;
      line-height: var(--product-line-height, 1.05);
    }
    .surat-product-multi strong { font-size: var(--product-title-size, 6.5pt); }
    .surat-product-multi span {
      font-size: var(--product-meta-size, 6pt);
      margin-top: 0;
    }
    @media print {
      html, body {
        width: ${widthMm}mm;
        height: ${heightMm}mm;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
      }
      .label-page { margin: 0; box-shadow: none; }
    }
  </style>
</head>
<body>${pages.join('')}</body>
</html>`
  return { html, printable, skipped }
}

// Geriye donuk sozlesme: yalnizca HTML dondurur. Hicbir etiket
// olusturulamazsa (eskisi gibi) hata firlatir.
export function buildCleanLabelHtml(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
  products: CargoProduct[] = [],
): string {
  return buildCleanLabelDocument(orders, template, mappingConfig, products).html
}

export function renderPrintableLabelHtml(data: LabelData): string {
  const barcodeSvg = renderBarcodeSvg(data.barcodeValue)
  const item = data.items[0]
  const leftReference =
    data.leftVerticalReference || data.shipmentReference || data.orderNumber
  const routeCenter =
    data.routeCenter ||
    [data.city, data.district].filter(Boolean).join(' / ')
  const transferCenter = data.transferCenter || routeCenter
  // Adres KAYIPSIZ sarılır; '...' veya substring kesmesi yoktur. Uzun
  // adreslerde font kademesi küçülür.
  const addressLines =
    data.fullAddressLines && data.fullAddressLines.length > 0
      ? data.fullAddressLines
      : splitAddress(data.address)
  const addressScaleClass = `surat-address-${data.addressFontScale || 'normal'}`
  // Üst bölüm GÖNDERİCİ adıdır; alıcı adı yalnız adres bloğunda görünür.
  const senderName = data.senderName || ''
  const phoneDisplay = data.recipientPhone
    ? maskPhone(data.recipientPhone)
    : '-'
  // Rota bloğunun GERÇEK bütçesi: delivery satırı 23mm, dikey padding 2mm,
  // parça-adedi etiketi + "1/1 Adrese Teslim" satırı ve satır boşlukları
  // düşülür. Sütun genişliği: gövde 93.9 - yatay padding 4 - büyük QR 21 -
  // küçük QR 12.5 - iki boşluk 3.6 = 52.8mm (kötümser 52mm).
  // Profil secimi ON KONTROL ile AYNI cozumleyiciden gelir (tek kaynak).
  const layout = resolveLabelLayout({
    items: (data.items ?? []).map((line) => ({
      productName: String(line.productName ?? ''),
      quantity: Number(line.quantity) || 1,
      color: line.color,
      size: line.size,
      sku: line.sku,
    })),
    destination: routeCenter,
    transfer: transferCenter,
  })
  if (!layout.ok) {
    // Sessiz kirpma YOK: hicbir guvenli profil sigdiramadi.
    throw new Error(layout.reason)
  }
  const selectedProfile = layout.profile
  const routeFit = layout.routeFit
  const productTitle = item ? buildProductTitleText(item) : 'Ürün bilgisi yok'
  const productMeta = buildProductMetaText(item ?? {
    productName: '',
    quantity: 1,
  })
  const productFit = layout.productFit
  const productStyle =
    `--layout-address-row:${selectedProfile.addressRowMm}mm;` +
    `--layout-delivery-row:${selectedProfile.deliveryRowMm}mm;` +
    `--layout-product-padding:${selectedProfile.productPaddingMm}mm;` +
    `--layout-large-qr:${selectedProfile.largeQrMm}mm;` +
    `--layout-small-qr:${selectedProfile.smallQrMm}mm;` +
    `--product-title-size:${productFit.tier.titlePt}pt;` +
    `--product-meta-size:${productFit.tier.metaPt}pt;` +
    `--product-line-height:${productFit.tier.lineHeight};` +
    `--route-destination-size:${routeFit.tier.destinationPt}pt;` +
    `--route-transfer-size:${routeFit.tier.transferPt}pt;` +
    `--route-line-height:${routeFit.tier.lineHeight}`
  // Çoklu ürün: tüm satırlar footer'da listelenir (kayıpsız, sarmalı).
  // Tekli sipariş markup'ı regression baseline'dır ve birebir korunur.
  const multipleItems = data.items.length > 1
  const productFooter = multipleItems
    ? `<footer class="surat-section surat-product surat-product-multi">
            ${data.items
              .map((line) => {
                // Çoklu üründe de ÖZET DEĞİL tam detay: ad + adet + renk +
                // beden + sku. "+X ürün daha" ÜRETİLMEZ.
                const lineMeta = buildProductMetaText({
                  productName: String(line.productName ?? ''),
                  quantity: Number(line.quantity) || 1,
                  color: line.color,
                  size: line.size,
                  sku: line.sku,
                })
                return `<div class="surat-product-line"><strong>${escapeHtml(
                  `${line.quantity || 1} x ${line.productName}`,
                )}</strong>${
                  lineMeta ? `<span>${escapeHtml(lineMeta)}</span>` : ''
                }</div>`
              })
              .join('')}
          </footer>`
    : `<footer class="surat-section surat-product">
            <strong>${escapeHtml(productTitle)}</strong>
            <span>${escapeHtml(productMeta)}</span>
          </footer>`

  return `
      <article class="label-page" data-layout-profile="${selectedProfile.key}" style="${productStyle}">
        <aside class="surat-rail">
          <strong>SURAT KARGO</strong>
          <span>Siparis No: ${escapeHtml(leftReference)}</span>
        </aside>
        <div class="surat-body">
          <header class="surat-section surat-header">
            <div>
              <span>Şube: <strong>${escapeHtml(data.branchName || 'FERAH')}</strong></span>
              <b class="surat-sender-name">${escapeHtml(senderName)}</b>
              <span>MUST.IRS.NO: ${escapeHtml(data.orderNumber)}</span>
            </div>
            <div class="surat-header-right">
              <span>T.No: <strong>${escapeHtml(data.tNo || data.trackingNumber || '-')}</strong></span>
              <span>TEL: ${escapeHtml(phoneDisplay)}</span>
            </div>
          </header>
          <section class="surat-section surat-barcode">${barcodeSvg}</section>
          <section class="surat-section surat-address ${addressScaleClass}">
            <div class="surat-address-copy">
              <b class="surat-recipient-name">${escapeHtml(data.recipientName)}</b>
              ${addressLines.map((line) => `<span class="surat-address-line">${escapeHtml(line)}</span>`).join('')}
              <div class="surat-address-footer">
                <span class="surat-address-phone">TEL: ${escapeHtml(phoneDisplay)}</span>
                <strong class="surat-address-region">${escapeHtml(routeCenter)}</strong>
              </div>
            </div>
          </section>
          <section class="surat-section surat-cargo">
            <div><span>OdemeTipi</span><strong>POCH</strong></div>
            <div><span>Birim</span><strong>KOLI</strong></div>
            <div><span>Top Ds/Kg</span><strong>${escapeHtml(formatDesi(data.desi).replace('.', ','))}</strong></div>
          </section>
          <section class="surat-section surat-delivery">
            ${renderQrSvg(data.qrPayload || data.trendyolCargoTrackingNumber || data.shipmentReference, 'surat-qr-large')}
            <div class="surat-delivery-copy">
              <span class="surat-parcel-label">Parca Adedi</span>
              <div class="surat-parcel-row">
                <b class="surat-parcel-count">1 / 1</b>
                <strong class="surat-delivery-type">Adrese Teslim</strong>
              </div>
              <em class="surat-destination">${escapeHtml(routeCenter)}</em>
              <strong class="surat-transfer">${escapeHtml(transferCenter)}</strong>
            </div>
            ${renderQrSvg(data.qrPayload || data.trendyolCargoTrackingNumber || data.shipmentReference, 'surat-qr-small')}
          </section>
          ${productFooter}
        </div>
      </article>
    `
}

export function renderLegacyPrintableLabelHtml(data: LabelData): string {
  const barcodeSvg = renderBarcodeSvg(data.barcodeValue)
  const item = data.items[0]
  return `
      <article class="label-page">
        <header class="label-header">
          <div>
            <small>${escapeHtml(data.marketplaceName)}</small>
            <strong>${escapeHtml(data.orderNumber)}</strong>
          </div>
          <div class="tracking">
            <small>SÜRAT TAKİP NO</small>
            <strong>${escapeHtml(data.trackingNumber)}</strong>
          </div>
        </header>
        <section class="barcode">${barcodeSvg}</section>
        <section class="recipient">
          <strong>${escapeHtml(data.recipientName)}</strong>
          <p>${escapeHtml(data.address)}</p>
          <b>${escapeHtml([data.district, data.city].filter(Boolean).join(' / '))}</b>
          ${
            data.recipientPhone
              ? `<span>Tel: ${escapeHtml(data.recipientPhone)}</span>`
              : ''
          }
        </section>
        <section class="shipment-meta">
          <div><small>TOP DS/KG</small><strong>${formatDesi(data.desi)}</strong></div>
          <div><small>T.NO</small><strong>${escapeHtml(data.tNo || '-')}</strong></div>
          <div><small>SİPARİŞ REFERANSI</small><strong>${escapeHtml(data.shipmentReference)}</strong></div>
        </section>
        <footer>
          <strong>${escapeHtml(
            item ? `${item.quantity || 1} x ${item.productName}` : 'Ürün bilgisi yok',
          )}</strong>
          <span>${escapeHtml(
            item
              ? buildProductMetaText({
                  productName: String(item.productName ?? ''),
                  quantity: Number(item.quantity) || 1,
                  color: item.color,
                  size: item.size,
                  sku: item.sku,
                })
              : '',
          )}</span>
        </footer>
      </article>
    `
}

function failPrint(
  debug: BrowserLabelPrintDebug,
  message: string,
): never {
  debug.rejectionReason = message
  throw new BrowserLabelPrintError(message, debug)
}

// JsBarcode'a verilen modül (dar çubuk) genişliği — intrinsic birim.
// Sessiz alan bu değerden türetilir: 10 modül = 10 * BARCODE_MODULE_WIDTH.
const BARCODE_MODULE_WIDTH = 2.2

function renderBarcodeSvg(value: string): string {
  if (
    typeof document === 'undefined' ||
    typeof document.createElementNS !== 'function'
  ) {
    return `<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" data-quiet-zone-modules="${CODE128_QUIET_ZONE_MODULES}" data-barcode-value="${escapeHtml(
      value,
    )}" aria-label="${escapeHtml(value)}"></svg>`
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  JsBarcode(svg, value, {
    format: 'CODE128',
    height: 72,
    width: BARCODE_MODULE_WIDTH,
    // margin: 0 — sessiz alan JsBarcode margin'i ile DEĞİL, viewBox ile
    // verilir; böylece kapsayıcıya esnetildiğinde 10X oranı korunur.
    margin: 0,
    displayValue: true,
    fontSize: 16,
    // Cubuklar ile insan-okunur sayi arasindaki bosluk (intrinsic birim).
    // 3 -> 8: 20.5mm'lik alanda ~0.7mm yerine ~1.8mm gorsel bosluk verir;
    // termal baskida rakamlarin tepesi cubuklara degmez.
    textMargin: 8,
  })
  // Çubuklar gövdeye yayılır AMA her iki yanda 10X sessiz alan korunur.
  // Sessiz alan viewBox'a gömüldüğü için çubuklarla AYNI katsayıyla ölçeklenir
  // (bkz. barcodeQuietZone.ts). PAYLOAD DEĞİŞMEZ.
  const quiet = applyScalableQuietZone(svg, BARCODE_MODULE_WIDTH)
  if (quiet.applied) {
    svg.setAttribute('data-quiet-zone-units', String(quiet.quietZoneUnits))
  }
  svg.setAttribute('data-barcode-value', value)
  return svg.outerHTML
}

function renderQrSvg(value: string, className: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(value || '-')
  qr.make()

  const moduleCount = qr.getModuleCount()
  const quietZone = 3
  const viewBoxSize = moduleCount + quietZone * 2
  const cells: string[] = []
  for (let y = 0; y < moduleCount; y += 1) {
    for (let x = 0; x < moduleCount; x += 1) {
      if (qr.isDark(y, x)) {
        cells.push(
          `<rect x="${x + quietZone}" y="${y + quietZone}" width="1" height="1" fill="#111" />`,
        )
      }
    }
  }

  return `<svg class="${className}" data-qr-value="${escapeHtml(value)}" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#fff" />${cells.join('')}</svg>`
}

function splitAddress(address: string): string[] {
  const words = String(address || '-').split(/\s+/).filter(Boolean)
  const lines: string[] = []

  for (const word of words) {
    const current = lines[lines.length - 1] ?? ''
    if (!current || current.length + word.length > 42) {
      if (lines.length < 3) lines.push(word)
    } else {
      lines[lines.length - 1] = `${current} ${word}`
    }
  }

  return lines.length > 0 ? lines : ['-']
}

function maskPhone(phone: string): string {
  const normalized = String(phone ?? '').replace(/\s+/g, '')
  if (normalized.length < 7) return phone || '-'
  return `${normalized.slice(0, 3)}*****${normalized.slice(-2)}`
}

function writePrintDocument(targetDocument: Document, html: string): void {
  targetDocument.open()
  targetDocument.write(html)
  targetDocument.close()
}

/**
 * BASKI ÖNCESİ SAYFA KARDİNALİTE KİLİDİ + GÖRÜNTÜ YÜKLEME BEKLEMESİ.
 *
 * ÜRETİM HATASI (kanıtlı): N PNG render edildiği, DOM'da N bölüm olduğu ve
 * N sipariş "basıldı" sayıldığı hâlde Chrome TEK sayfa basıyordu. Sebep
 * belge CSS'iydi (gövde tek etiket boyunda + overflow:hidden). Bu kontrol,
 * aynı sınıftan bir hatanın bir daha SESSİZ kalmasını engeller: beklenen
 * ile gerçekleşen fiziksel sayfa sayısı tutmuyorsa BASKI YAPILMAZ.
 *
 * Ayrıca tüm etiket görüntüleri yüklenmeden `print()` çağrılmaz; yarı
 * yüklenmiş belge boş sayfa basardı. Bekleme SINIRLIDIR (asılı kalmaz).
 */
async function waitForLabelImages(
  targetDocument: Document,
  timeoutMs = 3000,
): Promise<{ total: number; ready: number }> {
  const images = Array.from(
    targetDocument.querySelectorAll<HTMLImageElement>('.surat-official-page img'),
  )
  if (images.length === 0) return { total: 0, ready: 0 }
  let ready = 0
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            ready += 1
            resolve()
            return
          }
          const done = (loaded: boolean) => {
            if (loaded) ready += 1
            resolve()
          }
          image.addEventListener('load', () => done(true), { once: true })
          image.addEventListener('error', () => done(false), { once: true })
          // SINIRLI bekleme: ortam yükleme olayını hiç üretmezse asılmayız.
          setTimeout(() => done(image.complete), timeoutMs)
        }),
    ),
  )
  return { total: images.length, ready }
}

export function countOfficialSuratPages(targetDocument: Document): number {
  return targetDocument.querySelectorAll('.surat-official-page').length
}

async function waitForPrintDocument(targetDocument: Document): Promise<void> {
  if (targetDocument.readyState !== 'complete') {
    await new Promise<void>((resolve) => {
      targetDocument.defaultView?.addEventListener?.('load', () => resolve(), {
        once: true,
      })
      setTimeout(resolve, 250)
    })
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
}

function isPrintableLabelHtml(html: string): boolean {
  return (
    html.includes('class="label-page"') &&
    html.includes('<body>') &&
    stripHtml(html).trim().length > 20
  )
}

function previewPrintableContent(html: string): string {
  return stripHtml(html).replace(/\s+/g, ' ').trim().slice(0, 500)
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function firstString(...values: unknown[]): string {
  return (
    values
      .map((value) =>
        typeof value === 'string' || typeof value === 'number'
          ? String(value).trim()
          : '',
      )
      .find(Boolean) ?? ''
  )
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
