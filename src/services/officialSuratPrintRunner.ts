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

export interface OfficialSuratPrintResult {
  debug: BrowserLabelPrintDebug
  /** Belgeye GERÇEKTEN giren sipariş numaraları. */
  printedOrderNumbers: string[]
  skipped: OfficialSuratSkip[]
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

  let renderRequested = 0
  let renderSucceeded = 0
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
      pages.push({
        orderNumber,
        imageBase64: artifact.imageBase64,
        mimeType: artifact.mimeType,
      })
    } catch (error) {
      // Bir siparişin hatası DİĞERLERİNİ düşürmez.
      skipped.push({
        orderNumber,
        reason:
          error instanceof Error && error.message
            ? error.message
            : SURAT_RENDER_UNAVAILABLE_MESSAGE,
      })
    }
  }

  // GÜVENLİ TELEMETRİ (§9): yalnız şablon, sayım ve mevcut güvenli kimlik
  // (sipariş numarası). Ham ZPL, imageBase64, müşteri bilgisi, takip numarası
  // veya şifreli payload LOGLANMAZ.
  suratPrintTrace('OFFICIAL_TEMPLATE_ROUTED', {
    template: 'surat_official_zpl',
    orderNumbers: orders.map((order) => String(order.orderNumber ?? '')),
    renderRequested,
    renderSucceeded,
    skipCount: skipped.length,
  })

  const debug = await printOfficialSuratDocument(pages, skipped)
  return {
    debug,
    printedOrderNumbers: debug.printCalled
      ? (debug.printedOrderNumbers ?? [])
      : [],
    skipped: [...skipped, ...((debug.skipped as OfficialSuratSkip[]) ?? [])].filter(
      (item, index, all) =>
        all.findIndex((other) => other.orderNumber === item.orderNumber) === index,
    ),
  }
}
