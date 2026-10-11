// ÜRÜN TURU TERCİHİ — TARAYICI YEREL, SÜRÜMLÜ, ORGANİZASYON + KULLANICI KAPSAMLI.
//
// Tur tamamlanması/kapatılması bir SUNUM TERCİHİDİR; iş gerçeği DEĞİLDİR.
// Bu yüzden `organization_settings.onboarding_completed`, entegrasyon durumu
// veya sipariş/ürün tablolarına YAZILMAZ ve sunucu ucu/göç gerektirmez.
//
// Anahtar organizasyon + kimliği doğrulanmış kullanıcı adıyla kapsamlanır:
// aynı tarayıcıyı kullanan başka bir hesap ilk kullanıcının tercihini
// DEVRALMAZ. Kayıtta yalnız sürüm, durum ve zaman vardır — sır, belirteç,
// sağlayıcı ya da sipariş/müşteri verisi YOKTUR.
//
// Depolama kullanılamazsa tur oturum boyunca yine çalışır; yazım hatası
// CargoFlow'u BOZMAZ.
import { PRODUCT_TOUR_VERSION } from './productTourDefinition'

export interface ProductTourScope {
  organizationId: string
  username: string
}

export type ProductTourMarkerStatus = 'completed' | 'dismissed'

export interface ProductTourMarker {
  version: typeof PRODUCT_TOUR_VERSION
  status: ProductTourMarkerStatus
  at: string
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** Oturum içi yedek: depolama yazılamasa da aynı oturumda tur TEKRAR açılmaz. */
const sessionMarkers = new Map<string, ProductTourMarker>()

export function productTourStorageKey(scope: ProductTourScope): string {
  return [
    `cargoflow.productTour.${PRODUCT_TOUR_VERSION}`,
    encodeURIComponent(scope.organizationId),
    encodeURIComponent(scope.username),
  ].join('::')
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function isMarker(value: unknown): value is ProductTourMarker {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.version === PRODUCT_TOUR_VERSION &&
    (record.status === 'completed' || record.status === 'dismissed') &&
    typeof record.at === 'string'
  )
}

/** Bozuk JSON / beklenmeyen şekil → `null` (güvenli; uygulama çökmez). */
export function readProductTourMarker(
  scope: ProductTourScope,
  storage: StorageLike | null = defaultStorage(),
): ProductTourMarker | null {
  const key = productTourStorageKey(scope)
  const inSession = sessionMarkers.get(key)
  if (inSession) return inSession
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isMarker(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Yazım başarısızsa `false` döner; oturum yedeği yine güncellenir. */
export function writeProductTourMarker(
  scope: ProductTourScope,
  status: ProductTourMarkerStatus,
  storage: StorageLike | null = defaultStorage(),
  now: () => Date = () => new Date(),
): boolean {
  const key = productTourStorageKey(scope)
  const marker: ProductTourMarker = {
    version: PRODUCT_TOUR_VERSION,
    status,
    at: now().toISOString(),
  }
  sessionMarkers.set(key, marker)
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(marker))
    return true
  } catch {
    return false
  }
}

/** Yalnız testler için: oturum yedeğini temizler. */
export function resetProductTourSessionMarkers(): void {
  sessionMarkers.clear()
}
