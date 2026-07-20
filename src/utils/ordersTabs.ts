import type { MarketplaceStatus } from '../types/cargoflow'
import {
  ACTIVE_MARKETPLACE_STATUSES,
  ARCHIVE_MARKETPLACE_STATUSES,
} from './orderStatus'

export type QuickTab =
  // Sadeleştirilmiş görünür sekmeler (mevcut classifier'ların birleşimi):
  | 'newOrders' // aktif açık, henüz etiket hazır/basılı olmayan siparişler
  | 'labelStage' // Etiket Hazır: labelReady ∪ labelPrinted
  // Mevcut (teknik) key'ler korunur; filtre ve compat için kullanılır.
  | 'currentSync'
  | 'today'
  | 'open'
  | 'barcodePending'
  | 'shipmentPending'
  | 'suratVerificationPending'
  | 'labelReady'
  | 'labelPrinted'
  | 'handedToCargo'
  | 'delivered'
  | 'cancelReturn'
  | 'archive'
  | 'all'

export function statusesForFetch(tab: QuickTab): MarketplaceStatus[] {
  void tab
  return [...ACTIVE_MARKETPLACE_STATUSES, ...ARCHIVE_MARKETPLACE_STATUSES]
}

// "İşlem Durumu" filtresi tipi: teknik yaşam-döngüsü durumlarına erişim.
export type OperationTabFilter = QuickTab | 'all'

// Eski/persisted seçili tab state'ini görünür sekme + teknik filtreye güvenli
// eşler. Boş liste veya runtime error oluşmaz; dashboard drill-down alt-durum
// amacı teknik filtreyle korunur.
export function resolveLegacyTab(tab: QuickTab | undefined): {
  tab: QuickTab
  operationTab: OperationTabFilter
} {
  switch (tab) {
    case 'newOrders':
    case 'labelStage':
    case 'handedToCargo':
    case 'delivered':
    case 'cancelReturn':
    case 'all':
      return { tab, operationTab: 'all' }
    case 'labelReady':
    case 'labelPrinted':
      return { tab: 'labelStage', operationTab: tab }
    case 'barcodePending':
    case 'shipmentPending':
    case 'suratVerificationPending':
      return { tab: 'newOrders', operationTab: tab }
    case 'archive':
      return { tab: 'all', operationTab: 'archive' }
    case 'currentSync':
    case 'today':
    case 'open':
    default:
      return { tab: 'newOrders', operationTab: 'all' }
  }
}
