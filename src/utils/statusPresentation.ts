import type { CargoOrder } from '../types/cargoflow'
import { classifyCanonicalOrderStatus } from './orderClassification'
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
  Unknown: {
    label: 'Bilinmeyen Durum',
    description: 'Pazaryerinin tanımlı durum listesinde olmayan ham durum.',
    color: 'gray',
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

const PRESENTATION_LABEL: Record<string, string> = {
  canceledOrReturned: 'İptal / İade',
  delivered: 'Teslim Edildi',
  handedToCargo: 'Kargoya Verildi',
  labelPrinted: 'Etiket Basıldı',
  labelReady: 'Etiket Hazır',
  archived: 'Arşiv',
  error: 'Kontrol Gerekli',
  barcodeWaiting: 'Barkod Bekliyor',
  open: 'Açık Operasyon',
  unknown: 'Bilinmiyor',
}

// TEK CANONICAL KAYNAK: sipariş operasyon rozeti classifyCanonicalOrderStatus
// üzerinden belirlenir. Böylece Siparişler tablosu, Tümü sekmesi ve sipariş
// detay drawer'ı; Dashboard Operasyon Akışı/Son Operasyonlar ile AYNI canonical
// statüyü gösterir (eski legacy mapOperationStatus dallanması canonical sonucu
// artık EZMEZ). Terminal/forward aşamalarda (teslim/kargoya verildi/iptal) gerçek
// kaynak atfı (Sürat takip / pazaryeri) korunur.
export function mapOperationStatus(order: CargoOrder): StatusPresentation {
  const { stage } = classifyCanonicalOrderStatus(order)
  const resolved = resolveOrderStatus(order)
  const local = (color: StatusTone, description: string): StatusPresentation => ({
    label: PRESENTATION_LABEL[stage],
    description,
    color,
    source: 'localOperation',
    sourceLabel: 'CargoFlow',
  })
  const attributed = (
    color: StatusTone,
    fallbackDesc: string,
  ): StatusPresentation =>
    resolved.statusSource !== 'localOperation'
      ? {
          label: PRESENTATION_LABEL[stage],
          description:
            resolved.statusSource === 'suratTracking'
              ? 'Gerçek Sürat Kargo takip hareketinden alındı.'
              : 'Pazaryerinin gerçek paket durumundan alındı.',
          color,
          source: resolved.statusSource,
          sourceLabel: resolved.sourceLabel,
        }
      : local(color, fallbackDesc)
  switch (stage) {
    case 'canceledOrReturned':
      return attributed('red', 'Sipariş iptal edildi veya iade sürecinde.')
    case 'delivered':
      return attributed('green', 'Sipariş müşteriye teslim edildi.')
    case 'handedToCargo':
      return attributed('green', 'Sipariş kargoya verildi / taşımada.')
    case 'labelPrinted':
      return local('green', 'Etiket basıldı. Gerektiğinde tekrar yazdırabilirsiniz.')
    case 'labelReady':
      return local('teal', 'Etiket hazır ve yazdırılabilir.')
    case 'archived':
      return local('gray', 'Arşivlenmiş sipariş.')
    case 'error':
      return local('red', 'Operasyon kontrolü gerekiyor.')
    case 'open':
      return local('blue', 'Aktif operasyon; işlem bekliyor.')
    case 'barcodeWaiting':
      return local('blue', 'Kargo barkodu oluşturulması gerekiyor.')
    default:
      return local('gray', 'Durum belirlenemedi.')
  }
}
