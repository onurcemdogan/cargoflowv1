import type { MarketplaceStatus } from '../types/cargoflow'
import {
  ACTIVE_MARKETPLACE_STATUSES,
  ARCHIVE_MARKETPLACE_STATUSES,
} from './orderStatus'

export type QuickTab =
  | 'currentSync'
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
