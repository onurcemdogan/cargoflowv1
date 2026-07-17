import type { CargoOrder, Shipment } from '../types/cargoflow'
import { resolveSuratBarcodeRawZpl } from './zpl'
import { verifySuratShipment } from './suratVerification'

// Baskı izninin tek kaynağı. ZPL İndir ve Etiketi Yazdır aynı sonucu kullanır.
//
// Kanıt (17.07.2026): create/label yanıtındaki ön-atanmış T.No ve barkod,
// fiziksel tesellümde birebir korunuyor (6/6 canlı eşleşme). Bu nedenle
// LABEL_READY_AWAITING_ACCEPTANCE durumunda etiket, Serendip kaydı oluşmadan
// önce ön-atanmış kodlarla yazdırılabilir; VERIFIED tesellüm sonrası
// otomatik teyittir.
export interface SuratPrintEligibility {
  canPrint: boolean
  canDownloadZpl: boolean
  verified: boolean
  awaitingAcceptance: boolean
  trackingNumber: string
  barcode: string
  barcodeRaw: string
  statusLabel: string
  reason: string
}

export function isPreassignedAwaitingAcceptance(
  shipment?: Shipment,
): boolean {
  if (!shipment) return false
  return Boolean(
    shipment.printEnabled === true &&
      (shipment.lifecycleStatus === 'LABEL_READY_AWAITING_ACCEPTANCE' ||
        shipment.candidateVerificationStatus ===
          'PREASSIGNED_AWAITING_ACCEPTANCE'),
  )
}

export function resolveSuratPrintEligibility(
  order: CargoOrder,
  shipmentOverride?: Shipment,
): SuratPrintEligibility {
  const shipment = shipmentOverride ?? order.shipment
  const verification = verifySuratShipment(order, shipment)
  const barcodeRaw = resolveSuratBarcodeRawZpl(
    shipment?.barcodeRaw,
    verification.barcodeRaw,
  )
  const verified = Boolean(
    verification.verifiedShipment &&
      verification.operationalPrintAllowed &&
      (verification.barcode || verification.finalSuratBarcode),
  )
  const awaitingAcceptance =
    !verified && isPreassignedAwaitingAcceptance(shipment)
  const zplAnalysis =
    shipment?.zplAnalysis ?? shipment?.suratCreateLog?.zplAnalysis
  const trackingNumber = verified
    ? firstNonEmpty(
        verification.kargoTakipNo,
        verification.trackingNumber,
        verification.tNo,
      )
    : awaitingAcceptance
      ? firstNonEmpty(
          shipment?.tNo,
          shipment?.kargoTakipNo,
          shipment?.trackingNumber,
          shipment?.candidateTNo,
          zplAnalysis?.acceptedTNo,
        )
      : ''
  // Barkod önceliği ZPL analizindedir; T.No ile çakışan aday reddedilir
  // (016 yanıtında üst seviye Barcode alanına T.No sızabiliyor).
  const rejectTrackingCollision = (value: string): string =>
    value && value === trackingNumber ? '' : value
  const barcode = verified
    ? firstNonEmpty(verification.barcode, verification.finalSuratBarcode)
    : awaitingAcceptance
      ? firstNonEmpty(
          rejectTrackingCollision(
            firstNonEmpty(zplAnalysis?.acceptedFinalBarcode),
          ),
          rejectTrackingCollision(firstNonEmpty(shipment?.barkodNo)),
          rejectTrackingCollision(firstNonEmpty(shipment?.barcode)),
          rejectTrackingCollision(firstNonEmpty(shipment?.barcodeValue)),
          rejectTrackingCollision(
            firstNonEmpty(shipment?.candidateBarkodNo),
          ),
        )
      : ''
  const eligible = Boolean(
    (verified || awaitingAcceptance) &&
      trackingNumber &&
      barcode &&
      barcodeRaw,
  )
  const statusLabel = verified
    ? 'Etiket hazır — Sürat doğrulandı'
    : awaitingAcceptance
      ? 'Etiket hazır — fiziksel Sürat kabulü bekleniyor'
      : ''
  const reason = eligible
    ? verified
      ? 'Canonical T.No ve barkod Sürat tarafından doğrulandı.'
      : 'Etiket yazdırılabilir; Serendip kaydı fiziksel tesellümden sonra doğrulanacaktır.'
    : !shipment
      ? 'Önce Sürat gönderisi oluşturulmalı.'
      : !barcodeRaw
        ? 'Geçerli ^XA...^XZ ZPL bulunamadı.'
        : !trackingNumber || !barcode
          ? 'Ön-atanmış T.No/barkod eksik; aday kodlar doğrulanmadan yazdırılamaz.'
          : 'Bu kodlar Serendip kaydı doğrulanmadan yazdırılamaz.'

  return {
    canPrint: eligible,
    canDownloadZpl: eligible,
    verified,
    awaitingAcceptance,
    trackingNumber,
    barcode,
    barcodeRaw,
    statusLabel,
    reason,
  }
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  return (
    values.map((value) => String(value ?? '').trim()).find(Boolean) ?? ''
  )
}
