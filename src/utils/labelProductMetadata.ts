// Etiket alt ürün alanı için renk / beden / SKU çözümlemesi — SAF (IO YOK).
//
// KÖK NEDEN (canlı baskı): sipariş satırında color/size yapısal olarak BOŞ
// geliyordu; SKU alanına ise ya alan ADI ("merchantSku") ya da serbest metin
// ("taşlı") düşmüştü. Eski kod bu değerleri DOĞRULAMADAN basıyordu ve ürün
// başlığının sonundaki "SECIL-334, 36" eki temizlenmiyordu. Sonuç:
//   "1 x Taşlı Simli Tesettür Abiye SECIL-334, 36"  /  "[taşlı]"
//
// SÖZLEŞME (çözümleme önceliği):
//  1) Sipariş satırındaki YAPISAL color / size alanları.
//  2) variantAttributes içindeki DOĞRULANMIŞ anahtarlar
//     (Renk / Renk Seçeneği / Color / Colour — Beden / Size / Numara /
//     Ebat / Ölçü).
//  3) Organizasyon kapsamındaki ÜRÜN KATALOĞU varyantı — YALNIZ kesin
//     kod/barkod eşleşmesiyle (bkz. labelVariantCatalog.ts). Fuzzy ad
//     eşleşmesi ve çelişkili adaylarda tahmin YOKTUR.
//  4) SON ÇARE ürün başlığından, YALNIZ çapalı (anchored) ve doğrulanmış
//     parçalar çıkarılır: sondaki ", <beden>", sondaki model kodu, sondaki
//     bilinen renk token'ı.
//  Marketplace satır kodları (merchantSku/sku/stockCode/productCode) YALNIZ
//  SKU alanı için kullanılır.
//  4) Placeholder/alan-adı metinleri ("merchantSku", "sku", "undefined", …)
//     HİÇBİR koşulda basılmaz.
//  5) SKU olmayan serbest metin ("taşlı") SKU alanına KONMAZ.
//  6) Değer yoksa o bölüm hiç basılmaz — boş "Renk:", boş "[]" veya boş
//     parantez ÜRETİLMEZ.
//  7) Başlıktan yalnız META'DA GERÇEKTEN KULLANILAN ek kaldırılır; ürün adının
//     gerçek parçası silinmez.

export interface ProductMetadataSource {
  productName?: unknown
  color?: unknown
  size?: unknown
  sku?: unknown
  merchantSku?: unknown
  stockCode?: unknown
  productCode?: unknown
  variantAttributes?: Array<{ name?: unknown; value?: unknown }> | null
}

// Katalogdan (kesin eşleşmeyle) gelen doğrulanmış varyant değerleri.
export interface CatalogMetadataInput {
  color?: unknown
  size?: unknown
}

export interface ResolvedProductMetadata {
  productName: string
  color: string
  size: string
  sku: string
  /** Teşhis: her alanın hangi kaynaktan çözüldüğü (PII içermez). */
  sources: { color: string; size: string; sku: string }
}

// Alan adı / boş değer yer tutucuları. Hiçbiri etikete BASILMAZ.
const PLACEHOLDER_TOKENS = new Set([
  'merchantsku', 'merchant_sku', 'sku', 'stockcode', 'stock_code',
  'productcode', 'product_code', 'barcode', 'color', 'colour', 'size',
  'renk', 'beden', 'undefined', 'null', 'none', 'nil', 'n/a', 'na',
  '-', '--', 'yok', 'bilinmiyor',
])

// TR-duyarlı katlama (yalnız karşılaştırma için; GÖSTERİM orijinal kalır).
function fold(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .trim()
}

export function isPlaceholderValue(value: unknown): boolean {
  const text = String(value ?? '').trim()
  if (!text) return true
  return PLACEHOLDER_TOKENS.has(fold(text))
}

// Gerçek bir model/stok kodu mu? Serbest metin ("taşlı") ve saf sayı ("36")
// REDDEDİLİR: kod en az bir harf VE en az bir rakam içermelidir.
export function looksLikeSkuCode(value: unknown): boolean {
  const text = String(value ?? '').trim()
  if (!text || isPlaceholderValue(text)) return false
  if (text.length < 3 || text.length > 48) return false
  if (/\s{2,}/.test(text)) return false
  // Boşluklu serbest metin kod değildir (tek kelime ya da kod-benzeri ayraç).
  if (/\s/.test(text)) return false
  if (!/[0-9]/.test(text)) return false
  if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(text)) return false
  return true
}

// Beden değeri makul mü? ("36", "XL", "3XL", "40/42")
export function looksLikeSizeValue(value: unknown): boolean {
  const text = String(value ?? '').trim()
  if (!text || isPlaceholderValue(text)) return false
  if (text.length > 12) return false
  return /^(\d{1,3}([/-]\d{1,3})?|[0-9]?X{0,3}[SML]|XXS|XXL|XXXL|STD|TEK EBAT)$/i
    .test(text)
}

// productImage.ts'teki katalog eşleme sözlüğüyle AYNI renk kelimeleri.
// Yalnız başlığın SONUNDAKİ renk ekini ayıklamak için kullanılır.
const KNOWN_COLOR_TOKENS = [
  'zumrut yesil', 'acik mavi', 'koyu yesil', 'koyu mavi', 'acik pembe',
  'siyah', 'beyaz', 'lacivert', 'bordo', 'yesil', 'kirmizi', 'mavi',
  'bej', 'ekru', 'vizon', 'pudra', 'gri', 'haki', 'mor', 'lila',
  'pembe', 'sax', 'camel', 'kahverengi', 'kahve', 'turuncu',
  'sari', 'fusya', 'murdum', 'antrasit', 'krem', 'gumus', 'altin',
  'indigo', 'petrol', 'somon', 'mint', 'turkuaz',
]

const COLOR_ATTRIBUTE_NAMES = ['renk', 'renk secenegi', 'color', 'colour']
const SIZE_ATTRIBUTE_NAMES = ['beden', 'size', 'numara', 'ebat', 'olcu']

function readAttribute(
  attributes: ProductMetadataSource['variantAttributes'],
  names: string[],
): string {
  if (!Array.isArray(attributes)) return ''
  for (const attribute of attributes) {
    const name = fold(String(attribute?.name ?? ''))
    if (!names.includes(name)) continue
    const value = String(attribute?.value ?? '').trim()
    if (value && !isPlaceholderValue(value)) return value
  }
  return ''
}

function firstUsable(values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text && !isPlaceholderValue(text)) return text
  }
  return ''
}

export function resolveLabelProductMetadata(
  item: ProductMetadataSource,
  catalog?: CatalogMetadataInput | null,
): ResolvedProductMetadata {
  const sources = { color: 'none', size: 'none', sku: 'none' }

  // 1) Yapısal alanlar.
  let color = firstUsable([item.color])
  if (color) sources.color = 'field'
  let size = firstUsable([item.size])
  if (size && looksLikeSizeValue(size)) sources.size = 'field'
  else if (size) size = ''

  // 2) Varyant/attribute listesi.
  if (!color) {
    color = readAttribute(item.variantAttributes, COLOR_ATTRIBUTE_NAMES)
    if (color) sources.color = 'variantAttribute'
  }
  if (!size) {
    const fromAttr = readAttribute(item.variantAttributes, SIZE_ATTRIBUTE_NAMES)
    if (fromAttr && looksLikeSizeValue(fromAttr)) {
      size = fromAttr
      sources.size = 'variantAttribute'
    }
  }

  // 3) ÜRÜN KATALOĞU varyantı (kesin kod/barkod eşleşmesi). Yalnız EKSİK
  //    alanları doldurur; satırın kendi yapısal değerini EZMEZ.
  if (!color) {
    const fromCatalog = firstUsable([catalog?.color])
    if (fromCatalog) {
      color = fromCatalog
      sources.color = 'catalogVariant'
    }
  }
  if (!size) {
    const fromCatalog = firstUsable([catalog?.size])
    if (fromCatalog && looksLikeSizeValue(fromCatalog)) {
      size = fromCatalog
      sources.size = 'catalogVariant'
    }
  }

  // 4) Marketplace satır metadata'sı — YALNIZ gerçek kod biçimindekiler.
  let sku = ''
  for (const [key, value] of [
    ['merchantSku', item.merchantSku],
    ['sku', item.sku],
    ['stockCode', item.stockCode],
    ['productCode', item.productCode],
  ] as Array<[string, unknown]>) {
    if (looksLikeSkuCode(value)) {
      sku = String(value).trim()
      sources.sku = key
      break
    }
  }

  // 5) SON ÇARE: başlıktan çapalı ayrıştırma. Yalnız EKSİK alanlar doldurulur
  //    ve YALNIZ meta'da kullanılan ek başlıktan kaldırılır.
  let productName = String(item.productName ?? '').trim()

  // 5a) Sondaki ", <beden>"
  const sizeMatch = productName.match(/,\s*([0-9]{1,3}([/-][0-9]{1,3})?)\s*$/u)
  if (sizeMatch) {
    const candidate = sizeMatch[1]
    if (!size && looksLikeSizeValue(candidate)) {
      size = candidate
      sources.size = 'productName'
    }
    // Beden meta'da gösteriliyorsa (hangi kaynaktan olursa olsun) ek kalkar.
    if (size) productName = productName.slice(0, sizeMatch.index).trim()
  }

  // 5b) Sondaki model/stok kodu.
  const tokens = productName.split(/\s+/)
  const lastToken = tokens[tokens.length - 1] ?? ''
  if (looksLikeSkuCode(lastToken)) {
    if (!sku) {
      sku = lastToken
      sources.sku = 'productName'
    }
    if (fold(sku) === fold(lastToken)) {
      productName = tokens.slice(0, -1).join(' ').trim()
    }
  }

  // 5c) Sondaki bilinen renk token'ı (tek veya iki kelimelik).
  if (!color) {
    const folded = fold(productName)
    for (const token of KNOWN_COLOR_TOKENS) {
      if (folded.endsWith(` ${token}`)) {
        // Orijinal metinden kes (gösterim büyük/küçük harfi korunur).
        const words = token.split(' ').length
        const parts = productName.split(/\s+/)
        color = parts.slice(parts.length - words).join(' ')
        productName = parts.slice(0, parts.length - words).join(' ').trim()
        sources.color = 'productName'
        break
      }
    }
  }

  // Artık sondaki virgül/tire gibi bağlaçları temizle.
  productName = productName.replace(/[\s,;-]+$/u, '').trim()

  return { productName, color, size, sku, sources }
}
