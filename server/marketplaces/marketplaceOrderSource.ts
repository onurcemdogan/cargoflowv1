// PAZARYERİ-NÖTR SEAM — ÜÇ GERÇEK MODELDEN TÜRETİLDİ.
//
// P4 denetiminde bu arayüz BİLEREK yazılmamıştı: tek gerçek uygulaması olan
// bir soyutlama, ikinci uygulamanın şeklini TAHMİN eder. Artık üç doğrulanmış
// sözleşme var (Trendyol · Hepsiburada · n11), dolayısıyla ortak seam
// TAHMİNLE değil FARKLARLA çizilebiliyor.
//
// ═══ ÖLÇÜLEN FARKLAR — soyutlamanın ŞEKLİNİ bunlar belirledi ══════════════
//
//  sayfalama : Trendyol `page`/`size` · Hepsiburada `offset`/`limit`
//              · n11 `page`(0 tabanlı)/`size`(≤100)
//  pencere   : Trendyol ≤30 gün · Hepsiburada paket ucunda 24 saat
//              · n11 15 gün (tek uçlu sorguda yön değiştirir)
//  statü     : üç sağlayıcının statü SÖZLÜĞÜ AYRI; ortak dize YOK
//  kimlik    : Trendyol `packageId` · Hepsiburada `packageNumber`
//              (`orderNumber`dan AYRI) · n11 `id`
//  barkod    : n11'de barkod `cargoTrackingNumber`, takip
//              `cargoSenderNumber` — Trendyol sezgisinin TERSİ
//
// Bu yüzden seam, "ortak bir istek nesnesi" DAYATMAZ. Her sağlayıcı KENDİ
// sayfa/pencere isteğini üretir; ortak olan yalnız ÇIKTININ şekli ve
// yeteneklerin VARLIĞIDIR.
//
// ZORUNLU YETENEK YALNIZ `MarketplaceOrderSource`tur. Paket yönetimi, etiket
// ve mutasyon OPSİYONELDİR: Hepsiburada'nın ortak barkodu vardır, n11'in
// yoktur; n11'in sipariş güncelleme ucu vardır, onu da KULLANMIYORUZ.

/** Kanonik pazaryeri anahtarı — DB kapsam anahtarıdır, görünen ad DEĞİLDİR. */
export const MARKETPLACE_PROVIDER_KEYS = ['trendyol', 'hepsiburada', 'n11'] as const
export type MarketplaceProviderKey = (typeof MARKETPLACE_PROVIDER_KEYS)[number]

/**
 * Sağlayıcıdan bağımsız NORMALLEŞTİRİLMİŞ sipariş.
 *
 * Aşağı akış (persistSyncResult → reconcile → hesap kapsamı) P2'de zaten
 * sağlayıcıdan bağımsızdı; bu tip o sınırın ADIDIR.
 */
export interface NormalizedMarketplaceOrder {
  marketplace: string
  externalOrderId: string
  orderNumber: string
  marketplacePackageId: string
  marketplaceBarcode: string
  marketplaceTrackingNumber: string
  marketplaceCarrier: string | null
  rawMarketplaceStatus: string
  rawOrder: Record<string, unknown>
}

/** Oran-sınırı politikası — sağlayıcıya ÖZEL, tek global sabit YOK. */
export interface MarketplaceRatePolicy {
  /** Dakikadaki istek tavanı biliniyorsa; bilinmiyorsa null. */
  requestsPerMinute: number | null
  /** Aile bazında farklı limit yayımlanıyorsa true (ör. Hepsiburada). */
  perFamilyLimits: boolean
  /** `429` dışında oran sınırı bildiren kod varsa. */
  rateLimitStatusCodes: number[]
}

/** ZORUNLU yetenek. */
export interface MarketplaceOrderSource {
  providerKey: MarketplaceProviderKey
  /** Sağlayıcının KENDİ sayfa isteğini üretir; ortak şekil DAYATILMAZ. */
  buildPageRequest: (params: Record<string, unknown>) => Record<string, unknown>
  /** Sağlayıcının KENDİ pencere kuralını uygular. */
  resolveWindow: (params: Record<string, unknown>) => {
    ok: boolean
    startMs: number
    endMs: number
    clamped: boolean
  }
  normalizeOrders: (raw: unknown) => {
    orders: NormalizedMarketplaceOrder[]
    duplicateRemovedCount: number
  }
  /** Ham statü → CargoFlow operasyon statüsü; bilinmiyorsa null. */
  mapStatus: (status: unknown) => string | null
  identifyPackage: (order: NormalizedMarketplaceOrder) => string
  identifyCarrier: (order: NormalizedMarketplaceOrder) => string | null
  ratePolicy: MarketplaceRatePolicy
}

/** OPSİYONEL — her sağlayıcı uygulamaz. */
export interface MarketplacePackageManager {
  providerKey: MarketplaceProviderKey
  /** Paket listelemesinde pencere üst sınırı (ör. Hepsiburada 24 saat). */
  packageWindowMaxMs: number
}

/** OPSİYONEL — yalnız pazaryeri yönetimli etiket sağlayanlar. */
export interface MarketplaceLabelProvider {
  providerKey: MarketplaceProviderKey
  capability: string
  supportedCarriers: readonly string[]
  supportedFormats: readonly string[]
}

/**
 * OPSİYONEL — pazaryeri MUTASYONU.
 *
 * KAPALI: `marketplaceWritesEnabled=false`. Tip burada TANIMLIDIR ki ileride
 * açılırsa sözleşme yerinde olsun; ama hiçbir uygulama ağa çıkmaz ve hiçbir
 * arka plan süreci bunu çağırmaz.
 */
export interface MarketplaceOrderMutation {
  providerKey: MarketplaceProviderKey
  enabled: false
}

/** Pazaryeri yazmaları GLOBAL olarak kapalıdır. */
export const marketplaceWritesEnabled = false

/**
 * Aynı sipariş numarası FARKLI pazaryerlerinde çakışmaz.
 *
 * Kapsam anahtarı `(provider, account, packageId)` üçlüsüdür. Yalnız
 * `orderNumber` ile anahtarlamak, iki pazaryerinde aynı numaranın aynı
 * siparişmiş gibi birleşmesine yol açardı.
 */
export function marketplaceScopeKey(params: {
  providerKey: string
  marketplaceAccountId?: string | null
  marketplacePackageId: string
}): string {
  const provider = String(params.providerKey ?? '').trim().toLowerCase()
  const account = String(params.marketplaceAccountId ?? '').trim() || 'legacy'
  const pkg = String(params.marketplacePackageId ?? '').trim()
  return `${provider}::${account}::${pkg}`
}
