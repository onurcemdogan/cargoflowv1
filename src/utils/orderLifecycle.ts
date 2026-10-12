// Toplu "Kargo Etiketi Oluştur ve Yazdır" için sipariş yaşam döngüsü.
//
// YENİ kural yazılmaz: kanonik durum çözümü (`resolveOrderStatus`, Sürat
// takip + pazaryeri statüsü) ve mevcut create kuralı (`canCreateShipment`)
// kullanılır. Amaç tek: kargoya verilmiş / gönderi izi olan siparişin
// create'e düşmemesi.
import type { CargoOrder } from '../types/cargoflow'
import type { OrderLifecycle } from './suratCreatePrintPlan'
import {
  canCreateShipment,
  hasCarrierTracking,
  isArchiveMarketplaceStatus,
  isCancelledOrReturnedStatus,
} from './orderStatus'
import { resolveOrderStatus } from './shipmentStatus'

export function resolveOrderLifecycle(order: CargoOrder): OrderLifecycle {
  const status = resolveOrderStatus(order)
  if (status.canceledOrReturned || isCancelledOrReturnedStatus(order.marketplaceStatus)) {
    return 'CLOSED'
  }
  if (status.shipped || status.delivered || isArchiveMarketplaceStatus(order.marketplaceStatus)) {
    return 'POST_CREATE'
  }
  return 'ACTIVE'
}

/**
 * Taşıyıcı tarafında gönderi izi var VE mevcut kural yeni create'e izin
 * vermiyor. (Barkod hatası / eski ön kayıt gibi yeniden denenebilir hâller
 * `canCreateShipment` ile create yolunda KALIR.)
 */
export function hasCarrierShipmentEvidence(order: CargoOrder): boolean {
  return hasCarrierTracking(order) && !canCreateShipment(order)
}
