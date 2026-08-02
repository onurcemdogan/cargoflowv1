import type { CargoOrder } from '../types/cargoflow'
import { resolveSuratBarcodeRawZpl } from './zpl'
import { verifySuratShipment } from './suratVerification'

// Kayıtlı (persisted) etiket artifact'inin TEK merkezî çözümleyicisi. Hem
// "ZPL İndir" hem "Etiketi Yazdır (tekrar)" bu resolver'dan geçer; iki buton
// aynı ham ZPL kaynağını kullanır. Öncelik:
//   1) order.shipment.barcodeRaw (full order API görünümündeki kalıcı ZPL)
//   2) suratCreateLog.BarcodeRaw / verification.barcodeRaw (aynı kalıcı kaynak)
// Ham ZPL bellekte yoksa (hasPrintableLabel=true olsa bile) zpl=null döner ve
// çağıran güvenli tenant-scoped uçtan (GET /api/orders/:id/label) getirir.
// "etiket yok" olarak yorumlanmaz.
export interface PersistedLabelArtifact {
  hasPrintableLabel: boolean
  zpl: string | null
  source: string
}

// Reprint (kayıtlı etiketi yeniden yazdırma) uygun mu? Canonical operasyon
// durumu LABEL_READY/LABEL_PRINTED VE yazdırılabilir etiket bayrağı/artifact'i
// olmalı. Fresh-create (henüz etiketi olmayan) siparişler bu kapıdan GEÇMEZ.
export function isReprintEligible(order: CargoOrder): boolean {
  const status = String(order.operationStatus ?? '').toUpperCase()
  const hasLabel =
    order.hasPrintableLabel === true || Boolean(order.shipment?.barcodeRaw)
  return (status === 'LABEL_READY' || status === 'LABEL_PRINTED') && hasLabel
}

export function resolvePersistedLabelArtifact(
  order: CargoOrder,
): PersistedLabelArtifact {
  const shipment = order.shipment
  const verification = verifySuratShipment(order, shipment)
  const zpl = resolveSuratBarcodeRawZpl(
    shipment?.barcodeRaw,
    // Persistence katmanı BarcodeRaw'ı `technicalZpl` adıyla saklar.
    shipment?.technicalZpl,
    shipment?.suratCreateLog?.BarcodeRaw,
    shipment?.suratCreateLog?.technicalZpl,
    verification.barcodeRaw,
  )
  if (zpl) {
    return { hasPrintableLabel: true, zpl, source: 'order.shipment.barcodeRaw' }
  }
  const hasPrintableLabel = order.hasPrintableLabel === true
  return {
    hasPrintableLabel,
    zpl: null,
    source: hasPrintableLabel ? 'pending-fetch' : 'none',
  }
}

// Kayıtlı ham ZPL'i (ve varsa kalıcı desiyi) sipariş nesnesine enjekte eder
// (immutable kopya). Uçtan gelen ZPL, order.shipment.barcodeRaw'a yazılır; böylece
// mevcut print/eligibility zinciri taşıyıcı-ZPL (carrier_zpl) yolunu kullanır ve
// desi İSTEMEZ. Kalıcı desi de order.desi'ye yansıtılır ki reprint etiketinin
// "Top Ds/Kg" alanı orijinal değeri korusun (reload sonrası "-" olmasın). Order'da
// zaten geçerli bir desi varsa KORUNUR (overwrite yok).
export function injectPersistedZpl(
  order: CargoOrder,
  zpl: string,
  desi: number | null = null,
): CargoOrder {
  const existingDesi =
    typeof order.desi === 'number' && Number.isFinite(order.desi) && order.desi > 0
      ? order.desi
      : null
  const resolvedDesi = existingDesi ?? (desi != null && desi > 0 ? desi : null)
  return {
    ...order,
    hasPrintableLabel: true,
    ...(resolvedDesi != null ? { desi: resolvedDesi } : {}),
    shipment: {
      ...(order.shipment ?? {}),
      barcodeRaw: zpl,
      zplReady: true,
      printEnabled: true,
      ...(resolvedDesi != null ? { desi: resolvedDesi } : {}),
    },
  } as CargoOrder
}
