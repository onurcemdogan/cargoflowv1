import type { CargoOrder, Shipment } from '../types/cargoflow'
import { resolveSuratBarcodeRawZpl } from './zpl'
import { verifySuratShipment } from './suratVerification'
import { resolveNormalizedDesi } from './desi'

// Baskı izninin TEK kaynağı. ZPL İndir ve Etiketi Yazdır aynı sonucu
// kullanır; iki yetenek AYRIŞTIRILMIŞTIR:
// - canDownloadZpl: yalnız taşıyıcının gerçek ^XA...^XZ ZPL'i varsa.
// - canPrint: gerçek ZPL varsa (carrier_zpl) VEYA eski/legacy kayıtta ZPL
//   bulunmasa bile tüm canonical alanlar eksiksizse (canonical_html) —
//   HTML etiket aynı renderer ile canonical T.No/barkod/QR alanlarından
//   üretilir; yeni Sürat create çağrısı YAPILMAZ.
//
// Kanıt (17.07.2026): create/label yanıtındaki ön-atanmış T.No ve barkod,
// fiziksel tesellümde birebir korunuyor (6/6 canlı eşleşme). Bu nedenle
// LABEL_READY_AWAITING_ACCEPTANCE durumunda etiket, Serendip kaydı oluşmadan
// önce ön-atanmış kodlarla yazdırılabilir; VERIFIED tesellüm sonrası
// otomatik teyittir.
export type SuratPrintSourceKind =
  | 'carrier_zpl'
  | 'canonical_html'
  | 'unavailable'

export const LEGACY_ZPL_MISSING_MESSAGE =
  'Bu eski kayıtta taşıyıcının ham ZPL verisi bulunamadı.'

export interface SuratPrintEligibility {
  canPrint: boolean
  canDownloadZpl: boolean
  source: SuratPrintSourceKind
  missingFields: string[]
  verified: boolean
  awaitingAcceptance: boolean
  trackingNumber: string
  barcode: string
  barcodeRaw: string
  statusLabel: string
  reason: string
}

export interface SuratPrintSource {
  source: SuratPrintSourceKind
  canPrint: boolean
  canDownloadZpl: boolean
  reason: string
  missingFields: string[]
  eligibility: SuratPrintEligibility
}

// Kompakt baskı-kaynağı sözleşmesi: A) geçerli raw ZPL → carrier_zpl,
// B) ZPL yok ama canonical model eksiksiz → canonical_html (ZPL İndir
// kapalı), C) kritik alan eksik → unavailable.
export function resolveSuratPrintSource(
  order: CargoOrder,
  shipmentOverride?: Shipment,
): SuratPrintSource {
  const eligibility = resolveSuratPrintEligibility(order, shipmentOverride)
  return {
    source: eligibility.source,
    canPrint: eligibility.canPrint,
    canDownloadZpl: eligibility.canDownloadZpl,
    reason: eligibility.reason,
    missingFields: eligibility.missingFields,
    eligibility,
  }
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
  const statusOk = Boolean(
    (verified || awaitingAcceptance) && trackingNumber && barcode,
  )
  // A) Taşıyıcının gerçek ZPL'i: baskı + ZPL indirme.
  const carrierZplEligible = Boolean(statusOk && barcodeRaw)
  // B) Legacy kayıt: ZPL yok ama canonical HTML modeli eksiksizse baskıya
  //    izin verilir; ZPL indirme KAPALI kalır. Eksik alanlar açıkça listelenir.
  const missingFields: string[] = []
  if (statusOk && !barcodeRaw) {
    if (
      !firstNonEmpty(shipment?.ozelKargoTakipNo, order.cargoTrackingNumber)
    ) {
      missingFields.push('OzelKargoTakipNo')
    }
    if (!String(order.customerName ?? '').trim()) {
      missingFields.push('alıcı adı')
    }
    if (!String(order.address ?? '').trim()) {
      missingFields.push('açık adres')
    }
    if (
      !String(order.city ?? '').trim() ||
      !String(order.district ?? '').trim()
    ) {
      missingFields.push('il/ilçe')
    }
    if (resolveNormalizedDesi(order).desi == null) {
      missingFields.push('desi')
    }
    if ((order.items ?? []).length === 0) {
      missingFields.push('ürün satırları')
    }
  }
  const canonicalHtmlEligible = Boolean(
    statusOk && !barcodeRaw && missingFields.length === 0,
  )
  const source: SuratPrintSourceKind = carrierZplEligible
    ? 'carrier_zpl'
    : canonicalHtmlEligible
      ? 'canonical_html'
      : 'unavailable'
  const eligible = carrierZplEligible || canonicalHtmlEligible
  const statusLabel = verified
    ? 'Etiket hazır — Sürat doğrulandı'
    : awaitingAcceptance
      ? 'Etiket hazır — fiziksel Sürat kabulü bekleniyor'
      : ''
  const reason = eligible
    ? source === 'canonical_html'
      ? `${LEGACY_ZPL_MISSING_MESSAGE} Etiket, canonical T.No/barkod/QR alanlarından HTML olarak yazdırılır.`
      : verified
        ? 'Canonical T.No ve barkod Sürat tarafından doğrulandı.'
        : 'Etiket yazdırılabilir; Serendip kaydı fiziksel tesellümden sonra doğrulanacaktır.'
    : !shipment
      ? 'Önce Sürat gönderisi oluşturulmalı.'
      : !trackingNumber || !barcode
        ? 'Ön-atanmış T.No/barkod eksik; aday kodlar doğrulanmadan yazdırılamaz.'
        : !verified && !awaitingAcceptance
          ? 'Bu kodlar Serendip kaydı doğrulanmadan yazdırılamaz.'
          : `Etiket yazdırılamıyor: kritik alanlar eksik (${missingFields.join(', ') || 'ZPL'}).`

  return {
    canPrint: eligible,
    canDownloadZpl: carrierZplEligible,
    source,
    missingFields,
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
