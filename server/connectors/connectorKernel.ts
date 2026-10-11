// SAĞLAYICI-NÖTR BAĞLAYICI ÇEKİRDEĞİ (CONNECTOR-KERNEL-001).
//
// ═══ NEDEN MEVCUT SEAM'İN YERİNE GEÇMİYOR ════════════════════════════════
//
// `marketplaces/marketplaceOrderSource.ts` ÜÇ doğrulanmış pazaryeri
// sözleşmesinden (Trendyol · Hepsiburada · n11) türetilmiş, çalışan bir
// seam'dir. Bu çekirdek onu SİLMEZ, SARAR: pazaryeri adaptörleri aynen
// kalır, üzerine (a) e-ticaret platformları (WooCommerce · ikas · Ticimax)
// ve (b) taşıyıcılar için ORTAK bir yetenek/kimlik/bağlantı modeli eklenir.
//
// Trendyol + Sürat üretim yolu bu dosyadan ETKİLENMEZ: buradaki hiçbir şey
// mevcut sync/etiket/worker akışına çağrı yapmaz.
//
// ═══ İKİ KAVRAM AYRIDIR ══════════════════════════════════════════════════
//
//   BAĞLANTI DURUMU  : kimlik doğrulandı mı, kanal sağlıklı mı
//   YETENEK          : bu sağlayıcı ŞU işi yapabiliyor mu
//
// "Bağlı" olmak her yeteneğin çalıştığı ANLAMINA GELMEZ. WooCommerce
// anahtarı sipariş okuyabilir ama ürün yazamayabilir; Ticimax'ın bazı
// uçları müşteriye özel servis kimliği ister. Bu yüzden yetenek, bağlantı
// durumundan BAĞIMSIZ olarak beyan edilir ve UI yalnız BEYAN EDİLMİŞ
// yeteneği "destekleniyor" diye gösterir.

/** Sağlayıcı ailesi — üç ayrı rol, üç ayrı sözleşme. */
export const PROVIDER_KINDS = [
  /** Pazaryeri: siparişi satan ve statüyü yöneten taraf (Trendyol, n11...). */
  'marketplace',
  /** Kendi mağazası: satıcının kendi e-ticaret altyapısı (WooCommerce, ikas...). */
  'commerce_platform',
  /** Taşıyıcı: gönderi/etiket/takip (Sürat, Aras...). */
  'shipping',
] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/**
 * YETENEK SÖZLÜĞÜ — sabit ve kapalı.
 *
 * Serbest dize KULLANILMAZ: UI bir yeteneği "var" diye gösteriyorsa, o
 * yeteneğin adı burada TANIMLI olmalıdır. Yazım hatası sessizce
 * "desteklenmiyor" değil, DERLEME HATASI üretir.
 */
export const CONNECTOR_CAPABILITIES = [
  'orders.read',
  'orders.webhook',
  'orders.status.write',
  'products.read',
  'products.write',
  'inventory.read',
  'inventory.write',
  'shipments.tracking.write',
  'returns.read',
  'finance.read',
  'questions.read',
] as const
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number]

/**
 * Bir yeteneğin YAŞAM DÖNGÜSÜ durumu.
 *
 * BÜYÜK PATLAMA YOK: yeni bağlayıcı `off` ile doğar, `internal_test` →
 * `shadow` → `pilot` → `ga` diye ilerler. `shadow` OKUR ve NORMALLEŞTİRİR
 * ama canlı sevkiyat davranışını DEĞİŞTİRMEZ.
 */
export const CAPABILITY_STAGES = ['off', 'internal_test', 'shadow', 'pilot', 'ga'] as const
export type CapabilityStage = (typeof CAPABILITY_STAGES)[number]

/** Canlı sevkiyat davranışını etkilemeye İZİNLİ aşamalar. */
const LIVE_STAGES: readonly CapabilityStage[] = ['pilot', 'ga']

export function stageAffectsLiveBehavior(stage: CapabilityStage): boolean {
  return LIVE_STAGES.includes(stage)
}

/**
 * Yetenek beyanı. `supported=false` ise NEDEN bilinmelidir: "bilmiyoruz" ile
 * "sağlayıcı sunmuyor" farklı şeylerdir ve UI'da farklı görünmelidir.
 */
export interface CapabilityDeclaration {
  capability: ConnectorCapability
  supported: boolean
  stage: CapabilityStage
  /**
   * Sözleşmede doğrulanamadıysa `false`. DÜRÜSTLÜK KURALI: resmî dokümanla
   * kanıtlanmamış yetenek `supported: true` YAPILMAZ.
   */
  contractVerified: boolean
  /** Desteklenmiyorsa kullanıcıya gösterilebilir KISA sebep. */
  reason?: string
}

export interface ConnectorDescriptor {
  /** Kanonik anahtar — DB kapsam anahtarı, görünen ad DEĞİL. */
  providerKey: string
  kind: ProviderKind
  displayName: string
  capabilities: readonly CapabilityDeclaration[]
}

export function declareCapability(
  capability: ConnectorCapability,
  options: Partial<Omit<CapabilityDeclaration, 'capability'>> = {},
): CapabilityDeclaration {
  const supported = options.supported ?? true
  const contractVerified = options.contractVerified ?? supported
  return {
    capability,
    supported,
    stage: options.stage ?? 'off',
    contractVerified,
    ...(options.reason ? { reason: options.reason } : {}),
  }
}

/**
 * Yetenek ARAMA — tek doğru yol.
 *
 * `switch(provider)` blokları YASAK: sağlayıcıya özel karar adaptörün
 * beyanından okunur. Böylece yeni sağlayıcı eklemek, uygulamanın her
 * yerindeki switch'leri güncellemeyi GEREKTİRMEZ.
 */
export function findCapability(
  descriptor: ConnectorDescriptor,
  capability: ConnectorCapability,
): CapabilityDeclaration | null {
  return descriptor.capabilities.find((entry) => entry.capability === capability) ?? null
}

/** UI "destekleniyor" diyebilir mi? Beyan YOKSA HAYIR (varsayılan kapalı). */
export function supportsCapability(
  descriptor: ConnectorDescriptor,
  capability: ConnectorCapability,
): boolean {
  const found = findCapability(descriptor, capability)
  return found !== null && found.supported && found.contractVerified
}

/**
 * Yetenek CANLI davranışta kullanılabilir mi?
 *
 * Beyan edilmiş olması YETMEZ: aşama da canlı olmalıdır. `shadow` bir
 * bağlayıcı sipariş okuyabilir, ama o veriden sevkiyat üretilemez.
 */
export function capabilityIsLive(
  descriptor: ConnectorDescriptor,
  capability: ConnectorCapability,
): boolean {
  const found = findCapability(descriptor, capability)
  return (
    found !== null &&
    found.supported &&
    found.contractVerified &&
    stageAffectsLiveBehavior(found.stage)
  )
}

/** Kayıt defteri — adaptörler burada toplanır, uygulamanın her yerinde DEĞİL. */
export class ConnectorRegistry {
  readonly #byKey = new Map<string, ConnectorDescriptor>()

  register(descriptor: ConnectorDescriptor): void {
    const key = normalizeProviderKey(descriptor.providerKey)
    if (this.#byKey.has(key)) {
      throw new Error(`Bağlayıcı zaten kayıtlı: ${key}`)
    }
    const seen = new Set<string>()
    for (const entry of descriptor.capabilities) {
      if (seen.has(entry.capability)) {
        throw new Error(`Yinelenen yetenek beyanı: ${key}/${entry.capability}`)
      }
      seen.add(entry.capability)
    }
    this.#byKey.set(key, { ...descriptor, providerKey: key })
  }

  get(providerKey: string): ConnectorDescriptor | null {
    return this.#byKey.get(normalizeProviderKey(providerKey)) ?? null
  }

  list(kind?: ProviderKind): ConnectorDescriptor[] {
    const all = [...this.#byKey.values()]
    const filtered = kind ? all.filter((entry) => entry.kind === kind) : all
    return filtered.sort((left, right) => left.providerKey.localeCompare(right.providerKey))
  }
}

export function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}
