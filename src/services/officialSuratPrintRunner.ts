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
import { printOfficialSuratDocument } from '../utils/browserLabelPrint'
import type {
  OfficialSuratPage,
  OfficialSuratSkip,
} from '../utils/officialSuratPrintDocument'
import type { BrowserLabelPrintDebug } from '../utils/browserLabelPrint'

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

  for (const order of orders) {
    const orderNumber = String(order.orderNumber ?? order.id ?? '-')
    try {
      const artifact = await fetchSuratRenderArtifact(String(order.id ?? ''))
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
