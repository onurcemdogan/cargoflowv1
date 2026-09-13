import type { CargoOrder } from '../types/cargoflow.ts'
import { verifySuratShipment } from './suratVerification.ts'
import {
  isPreassignedAwaitingAcceptance,
  resolveSuratPrintEligibility,
} from './suratPrintEligibility.ts'
import { isOrderOperationallyActive } from './orderStatus.ts'

// ═══ DAHİLİ HAZIRLIK ≠ KULLANICI İŞ AKIŞI DURUMU ═══════════════════════════
//
// ÖLÇÜLEN KUSUR: arka plan worker'ı yeni siparişin taşıyıcı etiketini önceden
// hazırlıyor (kalıcı artefakt). Artefakt doğrulanır doğrulanmaz
// `getOrderOperationStatus` onu `LABEL_READY`'ye TÜRETİYOR, sınıflandırıcı da
// siparişi "Etiket Hazır" gösteriyordu. Oysa kullanıcı o siparişe HİÇ
// dokunmamıştı: "Barkod Oluştur'a bastım mı?" sorusu UI'dan yanıtlanamıyordu.
//
// İKİ AYRI KAVRAM:
//
//   DAHİLİ HAZIRLIK  (preparation)  — worker/queue üretir. "Gerektiğinde anında
//                                     kullanılabilir taşıyıcı artefakt VAR."
//   KULLANICI AKIŞI  (workflow)     — YALNIZ açık kullanıcı aksiyonu ilerletir.
//                                     BARKOD_BEKLIYOR → ETIKET_HAZIR → ETIKET_BASILDI
//
// Bu modül İKİNCİSİNİN tek canonical kaynağıdır.
//
// ═══ AKTİVASYON KANITI — HEPSİ YALNIZ KULLANICI TARAFINDAN ÜRETİLEBİLİR ═════
//
//   1) `userLabelActivatedAt`  — açık damga. Sunucuda TEK yazarı
//      `markOrderLabelReady`, ona da yalnız POST /api/orders/:id/label-ready
//      ulaşır. Worker `orders` tablosuna HİÇ yazmaz.
//   2) baskı kanıtı            — `label.printedAt` / `labelStatus === 'PRINTED'`.
//      Baskı tanım gereği kullanıcı aksiyonudur ve aktivasyonu KAPSAR.
//
// DİKKAT — `order.operationStatus` BURADA KANIT DEĞİLDİR: istemci/sunucu
// projeksiyonu `withDerivedOperationStatus` ile onu artefakttan ÜRETİR
// (`hasLiveOrtakBarkodShipment` → 'LABEL_READY'). Kanıt olarak kullanılsaydı
// kapı VAKUM olurdu. Eski kayıtların canonical durum kanıtı, TÜRETMENİN
// ULAŞAMADIĞI yerde — sunucu okuma yolunda (orderMapper.rowToOrder) —
// `userLabelActivatedAt`e çevrilir.

export type LabelWorkflowState =
  | 'BARKOD_BEKLIYOR'
  | 'ETIKET_HAZIR'
  | 'ETIKET_BASILDI'

export type LabelActivationSource = 'explicit' | 'printed' | 'none'

export interface LabelWorkflowActivation {
  activated: boolean
  activatedAt: string | null
  source: LabelActivationSource
}

const NOT_ACTIVATED: LabelWorkflowActivation = Object.freeze({
  activated: false,
  activatedAt: null,
  source: 'none',
})

function trimmed(value: unknown): string {
  return String(value ?? '').trim()
}

/** Baskı = kullanıcı aksiyonu; aktivasyonu KAPSAR (etiket zaten akışa alınmıştır). */
function printedEvidenceAt(order: CargoOrder): string | null {
  const printedAt = trimmed(order.label?.printedAt)
  if (printedAt) return printedAt
  if (trimmed(order.labelStatus).toUpperCase() === 'PRINTED') {
    return trimmed(order.label?.lastPrintedAt) || null
  }
  return null
}

/**
 * Siparişin etiketi KULLANICI iş akışına alınmış mı?
 *
 * Artefakt hazırlığı bu sorunun yanıtını DEĞİŞTİRMEZ.
 */
export function resolveLabelWorkflowActivation(
  order: CargoOrder,
): LabelWorkflowActivation {
  const explicit = trimmed(order.userLabelActivatedAt)
  if (explicit) {
    return { activated: true, activatedAt: explicit, source: 'explicit' }
  }
  const printedAt = printedEvidenceAt(order)
  if (printedAt !== null) {
    return { activated: true, activatedAt: printedAt, source: 'printed' }
  }
  return NOT_ACTIVATED
}

export function isLabelWorkflowActivated(order: CargoOrder): boolean {
  return resolveLabelWorkflowActivation(order).activated
}

/**
 * DAHİLİ hazırlık durumu: kullanıcıya gerekmeden BASILABİLİR kalıcı taşıyıcı
 * artefakt var mı? Kullanıcı durumu DEĞİLDİR; operasyon/debug bilgisidir ve
 * hızlı yolun ön koşuludur.
 */
export function hasPreparedLabelArtifact(order: CargoOrder): boolean {
  const verification = verifySuratShipment(order)
  const verified = Boolean(
    order.shipment?.dispatchRegistrationConfirmed === true &&
      verification.verifiedShipment,
  )
  const preassignedReady = Boolean(
    isPreassignedAwaitingAcceptance(order.shipment) &&
      resolveSuratPrintEligibility(order).canPrint,
  )
  if (!verified && !preassignedReady) return false
  return Boolean(
    trimmed(verification.barcode) ||
      trimmed(verification.finalSuratBarcode) ||
      trimmed(order.shipment?.barcode) ||
      trimmed(order.shipment?.barcodeValue),
  )
}

/**
 * "Barkod Oluştur" HIZLI YOLU: artefakt hazır ama kullanıcı henüz almamış.
 *
 * Bu siparişte tıklama TAŞIYICIYA ÇIKMAZ, pazaryeri mutasyonu YAPMAZ, yeni
 * gönderi AÇMAZ; YALNIZ kullanıcı aktivasyonunu yazar.
 */
export function canActivateLabelWorkflow(order: CargoOrder): boolean {
  // Kapanmış süreçte (kargoya verildi / teslim / iptal-iade) aktivasyon YOK:
  // mevcut terminal davranışı aynen korunur.
  return (
    isOrderOperationallyActive(order) &&
    hasPreparedLabelArtifact(order) &&
    !isLabelWorkflowActivated(order)
  )
}
