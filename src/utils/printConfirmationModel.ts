// Bekleyen baskı doğrulaması — YALNIZ UI modeli.
//
// KÖK NEDEN (canlı): baskı sonrası tarayıcının BLOKLAYAN window.confirm
// dialogu açılıyordu ("Etiketler yazıcıdan doğru şekilde çıktı mı?").
// Popup kaldırıldı; onay artık sonuç panelindeki bloklamayan inline alandan
// alınır. Başarı sözleşmesi GEVŞETİLMEDİ: onay gelmeden hiçbir sipariş
// PRINTED olmaz, printCount artmaz, seçim korunur.
//
// GİZLİLİK: bu model müşteri adı/adres/telefon, ürün açıklaması, ham ZPL veya
// provider payload TAŞIMAZ. Yeni bir backend lifecycle/status DEĞİLDİR.
import type { PendingPrintConfirmationRequest } from '../providers/printing/PrintProvider'
import { PRINT_NOT_CONFIRMED_MESSAGE } from './suratPrintFailureReasons'

export interface PendingPrintConfirmation {
  provider: 'browser-print'
  /** Canonical paket kimlikleri (marketplace:package:<id>). */
  orderIdentities: string[]
  orderNumbers: string[]
  /** Baskı belgesine GERÇEKTEN giren siparişler (doğrulama grubu). */
  documentOrderIdentities: string[]
  documentOrderNumbers: string[]
  createdCount: number
  reprintCount: number
  /** Render sırasında atlananlar (güvenli sebep; doğrulama grubuna GİRMEZ). */
  skipped: Array<{ orderNumber: string; reason: string }>
}

export interface PendingConfirmationContext {
  /** orderNumber -> canonical kimlik eşlemesi (PII YOK). */
  identityByOrderNumber: Map<string, string>
  createdCount: number
  reprintCount: number
}

export function buildPendingPrintConfirmation(
  request: PendingPrintConfirmationRequest,
  context: PendingConfirmationContext,
): PendingPrintConfirmation {
  const identity = (orderNumber: string) =>
    context.identityByOrderNumber.get(orderNumber) ?? ''
  return {
    provider: 'browser-print',
    orderIdentities: request.orderNumbers.map(identity).filter(Boolean),
    orderNumbers: [...request.orderNumbers],
    documentOrderIdentities: request.documentOrderNumbers
      .map(identity)
      .filter(Boolean),
    documentOrderNumbers: [...request.documentOrderNumbers],
    createdCount: context.createdCount,
    reprintCount: context.reprintCount,
    skipped: (request.skipped ?? []).map((item) => ({
      orderNumber: item.orderNumber,
      reason: item.reason,
    })),
  }
}

// Sonuç panelinde "kullanıcı doğrulamadı" ile GERÇEK hata (provider/create/
// render) AYRI kategoridir; ikisi aynı kovaya konmaz.
export interface PartitionedPrintOutcome {
  notConfirmed: Array<{ orderNumber: string; reason: string }>
  skipped: Array<{ orderNumber: string; reason: string }>
  failed: Array<{ orderNumber: string; reason: string }>
}

export function partitionPrintOutcome(outcome: {
  skipped?: Array<{ orderNumber: string; reason: string }>
  failed?: Array<{ orderNumber: string; reason: string }>
}): PartitionedPrintOutcome {
  const isNotConfirmed = (item: { reason: string }) =>
    item.reason === PRINT_NOT_CONFIRMED_MESSAGE
  const skipped = outcome.skipped ?? []
  const failed = outcome.failed ?? []
  return {
    notConfirmed: [
      ...skipped.filter(isNotConfirmed),
      ...failed.filter(isNotConfirmed),
    ],
    skipped: skipped.filter((item) => !isNotConfirmed(item)),
    failed: failed.filter((item) => !isNotConfirmed(item)),
  }
}
