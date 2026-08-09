// RESMÎ SÜRAT TOPLU BASKI KOŞUCUSU.
//
// Her shipment için AYRI endpoint çağrısı yapılır (tek sabit ZPL şablonu
// YOKTUR — her gönderi KENDİ persisted printZpl'ini kullanır). Başarılı
// PNG'ler tek belgede ayrı 100 × 100 mm sayfalar olarak toplanır ve MEVCUT
// kalıcı gizli iframe + window.print yaşam döngüsüne verilir.
//
// KISMİ BATCH İZOLASYONU: bir siparişin render hatası diğerlerini DURDURMAZ;
// yalnız o sipariş atlanır ve güvenli sebebiyle raporlanır.
import type { CargoOrder } from '../types/cargoflow'
import {
  fetchSuratRenderArtifact,
  SuratRenderRequestError,
  SURAT_RENDER_UNAVAILABLE_MESSAGE,
} from './suratLabelRenderClient'
import {
  printOfficialSuratDocument,
  suratPrintTrace,
} from '../utils/browserLabelPrint'
import { SURAT_ONLY_TEMPLATE_MESSAGE } from '../utils/labelPrintTemplateRouting'
import type {
  OfficialSuratPage,
  OfficialSuratSkip,
} from '../utils/officialSuratPrintDocument'
import type { BrowserLabelPrintDebug } from '../utils/browserLabelPrint'

/**
 * SAĞLAYICI KONTROLÜ (§6): KANONİK kalıcı gönderi kaydındaki `shipment.provider`
 * alanı kullanılır. UI satır metni veya görünen kargo adı (`cargoProviderName`)
 * KULLANILMAZ.
 *
 * Alan boşsa istemci karar VERMEZ: sunucu kendi kanonik kaydından doğrular ve
 * Sürat değilse 409 `not_surat_shipment` döner (tek otorite orada kalır).
 */
function isNonSuratShipment(order: CargoOrder): boolean {
  const provider = String(order.shipment?.provider ?? '').trim()
  return provider.length > 0 && !/surat|sürat/i.test(provider)
}

/** Ürün detay sayfası servis edilemedi — ANA etiket engellenmez. */
export const PRODUCT_DETAIL_UNAVAILABLE_MESSAGE =
  'Ürün detay etiketi hazırlanamadı.'

export interface OfficialSuratPrintResult {
  debug: BrowserLabelPrintDebug
  /** Belgeye GERÇEKTEN giren sipariş numaraları. */
  printedOrderNumbers: string[]
  skipped: OfficialSuratSkip[]
  /**
   * Ana etiketi BASILAN ama ürün detay sayfası eksik kalan gönderiler.
   * Atlanan (skipped) DEĞİLDİR: bunlar basıldı, yalnız eksik bilgiyle.
   */
  productDetailWarnings: OfficialSuratSkip[]
}

/**
 * Seçili siparişler için resmî Sürat PNG'lerini toplar ve TEK baskı belgesi
 * olarak Chrome'a gönderir. window.print YALNIZ BİR KEZ çağrılır.
 */
export async function printOfficialSuratLabels(
  orders: CargoOrder[],
): Promise<OfficialSuratPrintResult> {
  const pages: OfficialSuratPage[] = []
  const skipped: OfficialSuratSkip[] = []
  const productDetailWarnings: OfficialSuratSkip[] = []

  let renderRequested = 0
  let renderSucceeded = 0
  const renderHttpStatuses: number[] = []
  let authFailure = false
  for (const order of orders) {
    const orderNumber = String(order.orderNumber ?? order.id ?? '-')
    // Sürat OLMAYAN gönderi için render ucu HİÇ çağrılmaz.
    if (isNonSuratShipment(order)) {
      skipped.push({ orderNumber, reason: SURAT_ONLY_TEMPLATE_MESSAGE })
      continue
    }
    try {
      renderRequested += 1
      const artifact = await fetchSuratRenderArtifact(String(order.id ?? ''))
      renderSucceeded += 1
      // CANONICAL KAYNAK `pages[]`. Sıra SUNUCUDA doğrulanmıştır (taşıyıcı
      // ilk, ürün detayları izler) ve BURADA DEĞİŞTİRİLMEZ. Eski yanıt
      // biçiminde istemci tek taşıyıcı sayfa görür → davranış aynı kalır.
      for (const page of artifact.pages) {
        pages.push({
          orderNumber,
          imageBase64: page.imageBase64,
          mimeType: page.mimeType,
        })
      }
      // FAIL-OPEN: ürün detay sayfası eksikse ANA etiket basılır, ama
      // eksiklik kullanıcıya GÖRÜNÜR olur — sessiz kayıp YOK.
      if (artifact.productDetailStatus === 'failed') {
        productDetailWarnings.push({
          orderNumber,
          reason: artifact.warning ?? PRODUCT_DETAIL_UNAVAILABLE_MESSAGE,
        })
      }
    } catch (error) {
      // Bir siparişin hatası DİĞERLERİNİ düşürmez.
      const renderError =
        error instanceof SuratRenderRequestError ? error : undefined
      if (renderError) {
        renderHttpStatuses.push(renderError.status)
        if (renderError.code === 'auth_required') authFailure = true
      }
      skipped.push({
        orderNumber,
        reason:
          error instanceof Error && error.message
            ? error.message
            : SURAT_RENDER_UNAVAILABLE_MESSAGE,
      })
    }
  }

  // GÜVENLİ TELEMETRİ (§8): yalnız şablon, sayım, HTTP durumu, auth bayrağı ve
  // mevcut güvenli kimlik (sipariş numarası). Authorization header değeri,
  // cookie, ham ZPL, imageBase64, müşteri adı/adres/telefon, takip numarası
  // veya barkod LOGLANMAZ.
  suratPrintTrace('OFFICIAL_TEMPLATE_ROUTED', {
    template: 'surat_official_zpl',
    orderNumbers: orders.map((order) => String(order.orderNumber ?? '')),
    renderRequested,
    renderSucceeded,
    renderHttpStatus: renderHttpStatuses,
    authFailure,
    skipCount: skipped.length,
    productDetailWarningCount: productDetailWarnings.length,
    physicalPageCount: pages.length,
  })

  const debug = await printOfficialSuratDocument(pages, skipped)
  return {
    debug,
    productDetailWarnings,
    printedOrderNumbers: debug.printCalled
      ? (debug.printedOrderNumbers ?? [])
      : [],
    skipped: [...skipped, ...((debug.skipped as OfficialSuratSkip[]) ?? [])].filter(
      (item, index, all) =>
        all.findIndex((other) => other.orderNumber === item.orderNumber) === index,
    ),
  }
}
