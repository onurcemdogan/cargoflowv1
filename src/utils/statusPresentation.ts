import type { CargoOrder } from '../types/cargoflow'
import { getOrderOperationStatus } from './orderStatus'
import { verifySuratShipment } from './suratVerification'
import { isPreassignedAwaitingAcceptance } from './suratPrintEligibility'
import {
  resolveOrderStatus,
  type OrderStatusSource,
} from './shipmentStatus'

export type StatusTone =
  | 'blue'
  | 'yellow'
  | 'teal'
  | 'green'
  | 'red'
  | 'gray'

export interface StatusPresentation {
  label: string
  description: string
  color: StatusTone
  source?: OrderStatusSource
  sourceLabel?: string
}

const trendyolStatuses: Record<string, StatusPresentation> = {
  Created: {
    label: 'Sipariş Oluştu',
    description: 'Pazaryerinde sipariş paketi oluşturuldu.',
    color: 'blue',
  },
  Picking: {
    label: 'Hazırlanıyor',
    description: 'Sipariş satıcı tarafından hazırlanıyor.',
    color: 'yellow',
  },
  Invoiced: {
    label: 'Faturalandı',
    description: 'Sipariş faturası oluşturuldu.',
    color: 'teal',
  },
  Shipped: {
    label: 'Kargoya Verildi',
    description: 'Sipariş pazaryerinde kargoya verildi.',
    color: 'green',
  },
  Delivered: {
    label: 'Teslim Edildi',
    description: 'Sipariş müşteriye teslim edildi.',
    color: 'green',
  },
  Cancelled: {
    label: 'İptal',
    description: 'Sipariş pazaryerinde iptal edildi.',
    color: 'red',
  },
  Returned: {
    label: 'İade',
    description: 'Sipariş iade edildi.',
    color: 'red',
  },
  UnDelivered: {
    label: 'Teslim Edilemedi',
    description: 'Sipariş müşteriye teslim edilemedi.',
    color: 'red',
  },
  UnSupplied: {
    label: 'Tedarik Edilemedi',
    description: 'Sipariş ürünü tedarik edilemedi.',
    color: 'red',
  },
  AtCollectionPoint: {
    label: 'Teslimat Noktasında',
    description: 'Sipariş teslimat noktasında bekliyor.',
    color: 'yellow',
  },
}

export function mapMarketplaceStatus(
  providerKey: string,
  rawStatus: string,
): StatusPresentation {
  if (providerKey.toLocaleLowerCase('tr-TR').includes('trendyol')) {
    return (
      trendyolStatuses[rawStatus] ?? {
        label: rawStatus || 'Bilinmeyen Durum',
        description: 'Pazaryerinden gelen ham durum.',
        color: 'gray',
      }
    )
  }
  return {
    label: rawStatus || 'Bilinmeyen Durum',
    description: 'Pazaryerinden gelen durum.',
    color: 'gray',
  }
}

export function mapOperationStatus(order: CargoOrder): StatusPresentation {
  const operationStatus = getOrderOperationStatus(order)
  const verification = verifySuratShipment(order)
  const resolvedStatus = resolveOrderStatus(order)

  if (resolvedStatus.statusSource !== 'localOperation') {
    return {
      label: resolvedStatus.label,
      description:
        resolvedStatus.statusSource === 'suratTracking'
          ? 'Gerçek Sürat Kargo takip hareketinden alındı.'
          : 'Pazaryerinin gerçek paket durumundan alındı.',
      color:
        resolvedStatus.delivered || resolvedStatus.shipped
          ? 'green'
          : resolvedStatus.canceledOrReturned
            ? 'red'
            : 'yellow',
      source: resolvedStatus.statusSource,
      sourceLabel: resolvedStatus.sourceLabel,
    }
  }
  if (operationStatus === 'SURAT_TRACKING_MISSING') {
    return {
      label: 'Takip no/T.No Alınamadı',
      description:
        'SÃ¼rat teknik cevap verdi ancak operasyonel takip no, T.No veya numeric barkod dÃ¶nmedi.',
      color: 'red',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  if (operationStatus === 'LABEL_CREATED_NOT_REGISTERED') {
    return {
      label: 'Etiket Oluştu, Kayıt Yok',
      description:
        'Etiket adayları alındı ancak Serendip gönderi kaydı açılmadı. Yazdırma kapalıdır.',
      color: 'red',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  if (
    order.status === 'Hata' ||
    operationStatus === 'ERROR' ||
    operationStatus === 'SURAT_DISPATCH_REJECTED' ||
    operationStatus === 'SURAT_BARCODE_FAILED'
  ) {
    return {
      label: 'Hatalı',
      description: 'Operasyon kontrolü gerekiyor.',
      color: 'red',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  if (
    order.labelStatus === 'PRINTED' &&
    Boolean(order.label?.printedAt)
  ) {
    return {
      label: 'Etiket Basıldı',
      description: 'Etiket başarıyla yazdırıldı.',
      color: 'green',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  if (
    verification.barcodeRaw &&
    (verification.verifiedShipment ||
      order.matchStatus ||
      order.shipment?.verifiedShipment)
  ) {
    return {
      label: 'Etiket Hazır',
      description: 'Takip no, barkod ve ZPL verisi hazır.',
      color: 'teal',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  if (
    isPreassignedAwaitingAcceptance(order.shipment) &&
    verification.barcodeRaw
  ) {
    return {
      label: 'Etiket Hazır',
      description:
        'Etiket hazır — fiziksel Sürat kabulü bekleniyor. Serendip kaydı tesellümden sonra doğrulanacaktır.',
      color: 'yellow',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  if (
    order.shipment &&
    [
      'SHIPMENT_CREATED',
      'SURAT_CREATED_NO_TRACKING',
      'SURAT_TRANSFERRED_BUT_NO_BARCODE',
      'TRACKING_CONFIRMED',
    ].includes(operationStatus)
  ) {
    return {
      label: 'Sürat Doğrulama Bekliyor',
      description: 'Sürat ortak barkod alanları doğrulanıyor.',
      color: 'yellow',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  if (operationStatus === 'SHIPMENT_PENDING') {
    return {
      label: 'Ortak Barkod Oluşturulacak',
      description: 'Sürat ortak barkod işlemi başlatılacak.',
      color: 'yellow',
      source: 'localOperation',
      sourceLabel: 'CargoFlow',
    }
  }
  return {
    label: 'Barkod Bekliyor',
    description: 'Kargo barkodu oluşturulması gerekiyor.',
    color: 'blue',
    source: 'localOperation',
    sourceLabel: 'CargoFlow',
  }
}
