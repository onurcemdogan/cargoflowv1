// Onboarding durum türetme + tamamlanma koşulları. Durum GERÇEK DB
// kayıtlarından türetilir: integration_credentials (configured),
// integration_sync_state (başarılı sync) ve organization ürün/sipariş sayıları.
// Secret/credential DÖNMEZ. org yalnız çağıran taraftan (req.auth) gelir.
import { getMaskedIntegrationStatus } from '../integrations/credentialService.ts'
import { countOrdersByOrganization } from '../orders/orderRepository.ts'
import { countProducts } from '../products/productRepository.ts'
import {
  ensureSettings,
  getSyncStates,
  setOnboardingCompleted,
} from './onboardingRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

// Sürat için gönderi OLUŞTURMAYAN güvenli bir bağlantı testi persistence'ı
// bulunmadığından, suratConnectionVerified configured durumunu yansıtır ve bu
// AÇIKÇA belirtilir (gerçek create denenmez).
export const SURAT_VERIFICATION_NOTE =
  'Sürat için gönderi oluşturmayan kalıcı bağlantı doğrulaması yoktur; ' +
  'configured durumu doğrulama olarak kabul edilir (create çağrısı yapılmaz).'

export interface OnboardingStatus {
  completed: boolean
  steps: {
    trendyolConfigured: boolean
    trendyolConnectionVerified: boolean
    suratConfigured: boolean
    suratConnectionVerified: boolean
    productsSynced: boolean
    ordersSynced: boolean
  }
  counts: { products: number; orders: number }
  suratVerificationNote: string
}

export async function deriveOnboardingStatus(
  db: Db,
  organizationId: string,
): Promise<OnboardingStatus> {
  const settings = await ensureSettings(db, organizationId)
  const [masked, syncStates, productCount, orderCount] = await Promise.all([
    getMaskedIntegrationStatus(db, organizationId),
    getSyncStates(db, organizationId),
    countProducts(db, organizationId),
    countOrdersByOrganization(db, organizationId),
  ])

  const productsSyncState = syncStates.products
  const ordersSyncState = syncStates.orders
  const productsSyncSucceeded =
    Boolean(productsSyncState) &&
    String(productsSyncState.lastSyncStatus) === 'success'
  const ordersSyncSucceeded =
    Boolean(ordersSyncState) &&
    String(ordersSyncState.lastSyncStatus) === 'success'

  // İlk sync boş sonuç dönebilir: kayıt sayısı > 0 VEYA başarılı sync metadata.
  const productsSynced = productCount > 0 || productsSyncSucceeded
  const ordersSynced = orderCount > 0 || ordersSyncSucceeded

  const trendyolConfigured = masked.trendyol.configured
  const suratConfigured = masked.surat.configured
  // Başarılı bir ürün/sipariş sync'i Trendyol bağlantısının çalıştığını kanıtlar.
  const trendyolConnectionVerified =
    trendyolConfigured && (productsSyncSucceeded || ordersSyncSucceeded)

  return {
    completed: Boolean(settings.onboardingCompleted),
    steps: {
      trendyolConfigured,
      trendyolConnectionVerified,
      suratConfigured,
      // Belgelenmiş kısıt: güvenli create-suz test persistence yok.
      suratConnectionVerified: suratConfigured,
      productsSynced,
      ordersSynced,
    },
    counts: { products: productCount, orders: orderCount },
    suratVerificationNote: SURAT_VERIFICATION_NOTE,
  }
}

// Tamamlanma koşulları: Trendyol configured + en az bir başarılı products/orders
// sync + Sürat configured. Sağlanmıyorsa eksik adımlar döner.
export function evaluateCompletion(status: OnboardingStatus): {
  eligible: boolean
  missing: string[]
} {
  const missing: string[] = []
  if (!status.steps.trendyolConfigured) missing.push('trendyolConfigured')
  if (!status.steps.productsSynced && !status.steps.ordersSynced) {
    // En az bir başarılı ürün VEYA sipariş sync'i gerekir.
    missing.push('firstSyncCompleted')
  }
  if (!status.steps.suratConfigured) missing.push('suratConfigured')
  return { eligible: missing.length === 0, missing }
}

export async function completeOnboarding(
  db: Db,
  organizationId: string,
): Promise<{ ok: boolean; missing?: string[]; status: OnboardingStatus }> {
  const status = await deriveOnboardingStatus(db, organizationId)
  const { eligible, missing } = evaluateCompletion(status)
  if (!eligible) {
    return { ok: false, missing, status }
  }
  await setOnboardingCompleted(db, organizationId)
  const updated = await deriveOnboardingStatus(db, organizationId)
  return { ok: true, status: updated }
}
