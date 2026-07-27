import type { CargoOrder } from '../types/cargoflow'
import { getOrderOperationStatus, isOrderOperationallyActive } from './orderStatus'
import { resolveSuratPrintEligibility } from './suratPrintEligibility'

// Dashboard "Son Operasyonlar" aksiyon yetkileri (görüntüle/yazdır/indir).
//
// Kök sorun: yetki eskiden YALNIZ geçici tarayıcı shipment/ZPL nesnesinin
// ince-taneli alanlarından (printEnabled + lifecycleStatus + candidateVerification
// + trackingNumber + barcode) türetiliyordu. Sayfa yenilenince bu geçici state
// tam hidratlanmadığında butonlar pasifleşiyordu.
//
// Çözüm — kalıcı öncelik zinciri:
//   1) canonical order.operationStatus (LABEL_READY / LABEL_PRINTED): DB'de kalıcı,
//      backend-doğrulamalı; sayfa yenilemesinde DB'den gelir.
//   2) persisted shipment/label metadata: yazdırılabilir etiket kanıtı (barcodeRaw/
//      zplReady/printEnabled) — kalıcı payload'dan.
//   3) legacy türetilmiş eligibility (verified/awaiting) — geriye dönük uyumluluk.
//
// Güvenlik: bu resolver raw ZPL/SOAP/PII ÜRETMEZ; yalnız boolean capability +
// durum etiketleri döner. Butona basıldığında ZPL mevcut tenant-scoped sipariş
// verisinden getirilir; yeni Sürat provider create çağrısı YAPILMAZ.

export interface OrderActionCapabilities {
  operationStatus: string
  labelStatus: string
  hasPrintableLabel: boolean
  canViewDetails: boolean
  canPrintLabel: boolean
  canDownloadLabel: boolean
}

const CANONICAL_LABEL_STATES = new Set(['LABEL_READY', 'LABEL_PRINTED'])

export function resolveOrderActionCapabilities(
  order: CargoOrder,
): OrderActionCapabilities {
  const operationStatus = getOrderOperationStatus(order)
  const labelStatus = String(order.labelStatus ?? '')
  const shipment = order.shipment

  // (1) canonical durum: LABEL_READY/LABEL_PRINTED yalnız backend yazdırılabilir
  // etiket ürettiğinde yazılır ve forward pazaryeri statüsüne (Shipped/Delivered)
  // dönüşmediği sürece korunur (getOrderOperationStatus forward statüyü önceler).
  const canonicalLabelState = CANONICAL_LABEL_STATES.has(operationStatus)
  // (2) persisted yazdırılabilir etiket kanıtı (kalıcı payload'dan gelir).
  const persistedPrintable = Boolean(
    shipment?.barcodeRaw ||
      shipment?.zplReady ||
      shipment?.printEnabled ||
      order.zplReady ||
      order.printEnabled,
  )
  // Gerçek indirilebilir ZPL yalnız taşıyıcı ham ZPL'i (barcodeRaw) varsa.
  const persistedCarrierZpl = Boolean(shipment?.barcodeRaw)

  // (3) legacy eligibility yalnız operasyonel-aktif siparişte fallback olur
  // (Shipped/Delivered/arşiv siparişte baskı açılmaz — mevcut davranış korunur).
  const active = isOrderOperationallyActive(order)
  const eligibility = resolveSuratPrintEligibility(order)

  const hasPrintableLabel = Boolean(
    (canonicalLabelState && persistedPrintable) ||
      (active && eligibility.canPrint),
  )
  const canPrintLabel = hasPrintableLabel
  const canDownloadLabel = Boolean(
    (canonicalLabelState && persistedCarrierZpl) ||
      (active && eligibility.canDownloadZpl),
  )

  return {
    operationStatus,
    labelStatus,
    hasPrintableLabel,
    // Detay her zaman aktif: mevcut sipariş kaydını gösterir.
    canViewDetails: true,
    canPrintLabel,
    canDownloadLabel,
  }
}
