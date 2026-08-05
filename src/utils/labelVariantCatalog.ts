// Etiket renk/beden için KATALOG VARYANT çözümlemesi — SAF (IO/DOM YOK).
//
// KÖK NEDEN (canlı gözlem): bazı etiketlerde "(Beden: 42)" çıkarken renk
// çıkmıyordu. Şema kanıtı:
//   order_lines  → variant_attributes JSONB var, AMA color/size KOLONU YOK
//                  (server/db/schema.ts). Renk yalnız satır attribute'unda
//                  varsa gelir; Trendyol bazı satırlarda yalnız "Beden"
//                  gönderiyor.
//   product_variants → color TEXT ve size TEXT KOLONLARI VAR
//                  (server/db/schema.ts), organization_id kapsamlı.
// Yani renk çoğu zaman KATALOGDA var, sipariş satırında yok.
//
// BU MODÜLÜN SÖZLEŞMESİ — TAHMİN YOK:
//  1) YALNIZ kesin kod/barkod eşleşmesi kullanılır:
//     barcode → merchantSku → sku → stockCode → productCode
//  2) Ürün ADI ile eşleşme YOKTUR (fuzzy yok, model/parent fallback yok).
//  3) Bir anahtar birden çok ADAY veriyor ve adaylar farklı renk/beden
//     taşıyorsa TAHMİN EDİLMEZ: o alan boş bırakılır (ambiguous).
//  4) Verilen `products` dizisi ÇAĞIRAN katmanda zaten organizasyon (ve varsa
//     marketplace hesabı) kapsamında yüklenmiştir; bu modül o diziyi GENİŞLETMEZ
//     ve dışarıdan veri OKUMAZ. Ek güvenlik olarak sipariş satırının
//     marketplace'i verilirse yalnız aynı marketplace ürünleri değerlendirilir.
//  5) PII veya credential OKUNMAZ/LOGLANMAZ; yalnız kod, renk ve beden alanları.
import type { CargoProduct, MarketplaceName, OrderItem } from '../types/cargoflow'
import { normalizeProductIdentifier } from './productImage.ts'

/** Kesin eşleşme anahtarları — SIRALI denenir. Ürün adı DAHİL DEĞİLDİR. */
export type CatalogVariantMatchKey =
  | 'barcode'
  | 'merchantSku'
  | 'sku'
  | 'stockCode'
  | 'productCode'

export interface CatalogVariantMetadata {
  color: string
  size: string
  /** Hangi kesin anahtarla eşleşildi; eşleşme yoksa 'none'. */
  matchedBy: CatalogVariantMatchKey | 'none'
  /** Birden çok çelişkili aday bulundu mu (bu durumda değer ÜRETİLMEZ). */
  ambiguous: boolean
}

export interface CatalogVariantScope {
  /** Verilirse yalnız aynı pazaryerinin ürünleri değerlendirilir. */
  marketplace?: MarketplaceName
}

const EMPTY: CatalogVariantMetadata = {
  color: '',
  size: '',
  matchedBy: 'none',
  ambiguous: false,
}

// Ürün üzerindeki eşleşme anahtarının değeri. Katalog varyantı hem ürün
// düzeyinde (CargoProduct.barcode/sku/...) hem de düzleştirilmiş varyant
// kaydı olarak gelir; her ikisi de aynı alan adlarını taşır.
function productKeyValue(
  product: CargoProduct,
  key: CatalogVariantMatchKey,
): string {
  switch (key) {
    case 'barcode':
      return normalizeProductIdentifier(product.barcode)
    case 'merchantSku':
      // Katalog tarafında merchantSku ayrı alan değildir; stok kodu ve sku
      // aynı kimliği taşır. Yanlış eşleşme olmaması için ikisi de denenir.
      return normalizeProductIdentifier(product.stockCode || product.sku)
    case 'sku':
      return normalizeProductIdentifier(product.sku)
    case 'stockCode':
      return normalizeProductIdentifier(product.stockCode)
    case 'productCode':
      return normalizeProductIdentifier(product.productCode)
  }
}

function itemKeyValue(item: OrderItem, key: CatalogVariantMatchKey): string {
  switch (key) {
    case 'barcode':
      return normalizeProductIdentifier(item.barcode)
    case 'merchantSku':
      return normalizeProductIdentifier(item.merchantSku)
    case 'sku':
      return normalizeProductIdentifier(item.sku)
    case 'stockCode':
      return normalizeProductIdentifier(item.stockCode)
    case 'productCode':
      return normalizeProductIdentifier(item.productCode)
  }
}

function cleanValue(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

// Aday kümesinden ÇELİŞKİSİZ tek değer. Adaylar farklı değer taşıyorsa boş
// döner (tahmin YOK). Boş değer taşıyan adaylar oylamayı bozmaz.
function uniqueValue(values: string[]): { value: string; conflict: boolean } {
  const distinct = new Set(
    values.map((value) => cleanValue(value)).filter(Boolean),
  )
  if (distinct.size === 0) return { value: '', conflict: false }
  if (distinct.size > 1) return { value: '', conflict: true }
  return { value: [...distinct][0], conflict: false }
}

const MATCH_ORDER: CatalogVariantMatchKey[] = [
  'barcode',
  'merchantSku',
  'sku',
  'stockCode',
  'productCode',
]

export function resolveCatalogVariantMetadata(
  item: OrderItem | null | undefined,
  products: CargoProduct[] | null | undefined,
  scope: CatalogVariantScope = {},
): CatalogVariantMetadata {
  if (!item) return EMPTY
  const pool = (Array.isArray(products) ? products : []).filter((product) =>
    scope.marketplace ? product.marketplace === scope.marketplace : true,
  )
  if (pool.length === 0) return EMPTY

  for (const key of MATCH_ORDER) {
    const needle = itemKeyValue(item, key)
    if (!needle) continue
    const candidates = pool.filter(
      (product) => productKeyValue(product, key) === needle,
    )
    if (candidates.length === 0) continue

    const color = uniqueValue(candidates.map((product) => product.color ?? ''))
    const size = uniqueValue(candidates.map((product) => product.size ?? ''))
    // Hiçbir alan çözülemediyse bu anahtar bilgi taşımıyor; sıradakine geç.
    if (!color.value && !size.value && !(color.conflict || size.conflict)) {
      continue
    }
    return {
      color: color.value,
      size: size.value,
      matchedBy: key,
      ambiguous: color.conflict || size.conflict,
    }
  }

  return EMPTY
}
