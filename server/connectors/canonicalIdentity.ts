// SAĞLAYICI-NÖTR KANONİK KİMLİK (CONNECTOR-KERNEL-001).
//
// ═══ NEDEN DEĞİŞKEN ALANLAR KİMLİK OLAMAZ ════════════════════════════════
//
// Ürün adı, müşteri adı ve görünen etiketler sağlayıcı tarafında DEĞİŞİR.
// Kimliği onlara bağlamak, satıcı ürün başlığını düzenlediğinde kaydın
// KOPYALANMASINA yol açar. Bu kusurun bu depoda ölçülmüş bir örneği var:
// `order_line` duplication kök nedeni, yol-bağımlı (`ty_line_` önekli) id
// üretimiydi — kimlik İÇERİKTEN değil, SAĞLAYICININ KARARLI ID'sinden
// türetilmelidir.
//
// Kanonik kimlik DÖRT parçadır ve hepsi ZORUNLUDUR:
//
//   organizasyon  → kiracı sınırı (asla atlanmaz)
//   sağlayıcı     → trendyol | woocommerce | ikas | ticimax | surat...
//   mağaza/hesap  → aynı sağlayıcıda İKİ farklı mağaza olabilir
//   varlık        → entity türü + sağlayıcının KARARLI dış id'si
//
// Mevcut `marketplaceScopeKey` bu kuralın pazaryeri özel hâliydi; burada
// tüm sağlayıcı aileleri için genelleştirilir. Mevcut anahtar ÜRETİLMEYE
// devam eder (aşağıdaki `marketplaceCompatibleScopeKey`), böylece Trendyol
// kapsam anahtarı BİT DÜZEYİNDE aynı kalır.
import { normalizeProviderKey } from './connectorKernel.ts'

/** Kanonik varlık türleri — serbest dize DEĞİL. */
export const CANONICAL_ENTITY_TYPES = [
  'order',
  'order_line',
  'product',
  'variant',
  'customer',
  'shipment',
  'store',
] as const
export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number]

export interface CanonicalIdentityInput {
  organizationId: string
  providerKey: string
  /** Mağaza/hesap kapsamı. Legacy (hesapsız) kayıtlar için null olabilir. */
  storeAccountId?: string | null
  entityType: CanonicalEntityType
  /** Sağlayıcının KARARLI dış id'si. Ad/başlık/etiket KULLANILMAZ. */
  externalId: string
}

export class UnstableIdentityError extends Error {}

/** Kimlik olarak kullanılması YASAK, değişken alan adları. */
const FORBIDDEN_IDENTITY_HINTS = [
  'name',
  'title',
  'label',
  'displayname',
  'description',
]

/**
 * Kararlı dış id doğrulaması.
 *
 * BOŞ id kimlik ÜRETMEZ: "bilinmiyor" bir kimlik değildir ve iki bilinmeyen
 * kaydın AYNI varlık sayılmasına yol açardı.
 */
export function assertStableExternalId(value: unknown, context: string): string {
  const text = String(value ?? '').trim()
  if (text === '') {
    throw new UnstableIdentityError(
      `${context}: sağlayıcı kararlı dış id'si BOŞ — kimlik üretilmez.`,
    )
  }
  return text
}

/**
 * Kanonik kimlik anahtarı.
 *
 * Ayraç `::` bilinçlidir: sağlayıcı id'lerinde tek `:` görülebilir, ama
 * parça sınırı çift karakterle ayrılır ve parçalar ayrıca kaçışlanır —
 * böylece `a::b` içeren bir id komşu parçaya TAŞAMAZ.
 */
export function canonicalIdentityKey(input: CanonicalIdentityInput): string {
  const organizationId = String(input.organizationId ?? '').trim()
  if (organizationId === '') {
    throw new UnstableIdentityError('Kanonik kimlik KİRACISIZ üretilemez.')
  }
  const provider = normalizeProviderKey(input.providerKey)
  if (provider === '') {
    throw new UnstableIdentityError('Kanonik kimlik SAĞLAYICISIZ üretilemez.')
  }
  const externalId = assertStableExternalId(
    input.externalId,
    `${provider}/${input.entityType}`,
  )
  const store = String(input.storeAccountId ?? '').trim() || 'legacy'
  return [
    escapePart(organizationId),
    escapePart(provider),
    escapePart(store),
    escapePart(input.entityType),
    escapePart(externalId),
  ].join('::')
}

function escapePart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

/**
 * MEVCUT pazaryeri kapsam anahtarıyla BİREBİR uyumlu üretim.
 *
 * `marketplaceScopeKey` üretimde kullanılan biçimdir
 * (`provider::account::packageId`). Yeni çekirdek onu DEĞİŞTİRMEZ; bu
 * fonksiyon aynı diziyi üretir ve parite testiyle kilitlenir.
 */
export function marketplaceCompatibleScopeKey(params: {
  providerKey: string
  marketplaceAccountId?: string | null
  marketplacePackageId: string
}): string {
  const provider = normalizeProviderKey(params.providerKey)
  const account = String(params.marketplaceAccountId ?? '').trim() || 'legacy'
  const pkg = String(params.marketplacePackageId ?? '').trim()
  return `${provider}::${account}::${pkg}`
}

/**
 * MAĞAZA PARMAK İZİ — aynı mağazanın İKİ KEZ bağlanmasını engeller.
 *
 * Sağlayıcıya göre "aynı mağaza" farklı alanlardan okunur (WooCommerce'te
 * site kökü, ikas'ta mağaza id'si, Trendyol'da sellerId). Bu yüzden parmak
 * izi, adaptörün verdiği KARARLI mağaza kimliğinden üretilir; URL gibi
 * yazımı değişebilen değerler NORMALLEŞTİRİLİR.
 */
export function storeFingerprint(params: {
  providerKey: string
  externalStoreId: string
}): string {
  const provider = normalizeProviderKey(params.providerKey)
  const store = assertStableExternalId(params.externalStoreId, `${provider}/store`)
  return `${provider}::${normalizeStoreIdentifier(store)}`
}

/**
 * Mağaza kimliği normalleştirme.
 *
 * URL biçimli kimlikler (WooCommerce/Ticimax site kökü) şu farklarla AYNI
 * mağazayı gösterir: şema, `www.`, sondaki `/`, harf büyüklüğü, port.
 * Normalleştirilmezse aynı mağaza iki kez bağlanabilirdi.
 */
export function normalizeStoreIdentifier(value: string): string {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  if (!/^https?:\/\//i.test(text)) return text.toLowerCase()
  try {
    const url = new URL(text)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    const port =
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
        ? ''
        : url.port
    const path = url.pathname.replace(/\/+$/, '')
    return `${host}${port ? `:${port}` : ''}${path}`.toLowerCase()
  } catch {
    return text.toLowerCase()
  }
}

/**
 * Kimlik alanı SEÇİMİ denetimi — değişken alandan kimlik üretimini engeller.
 *
 * Adaptör yazarı `externalIdField: 'name'` derse bu, testte DERHAL patlar.
 */
export function assertIdentityFieldIsStable(fieldName: string): void {
  const normalized = String(fieldName ?? '').trim().toLowerCase().replace(/[_\s-]/g, '')
  for (const hint of FORBIDDEN_IDENTITY_HINTS) {
    if (normalized === hint || normalized.endsWith(hint)) {
      throw new UnstableIdentityError(
        `Kimlik alanı DEĞİŞKEN olamaz: "${fieldName}" — sağlayıcının kararlı id'sini kullanın.`,
      )
    }
  }
}
