// Alt ürün alanının TEK etikete sığdırılması — SAF hesap (DOM/IO YOK).
//
// SÖZLEŞME:
//  1) Önce normal font/satır aralığıyla dene.
//  2) Sığmıyorsa tanımlı MİNİMUMA kadar font-size ve line-height kademeli azalt.
//  3) Ürün adı satırlara SARILIR (kelime kırpma yok, "..." yok).
//  4) Renk / Beden / SKU bilgisi korunur — meta satırı ASLA atılmaz.
//  5) "+X ürün daha" ÜRETİLMEZ, CSS ellipsis veya sessiz kırpma KULLANILMAZ.
//  6) En küçük kademede bile sığmıyorsa `fits:false` döner; çağıran baskıyı
//     SESSİZCE üretmez, açık hata verir. Tek sayfa invaryantı korunur.
//
// Ölçüm modeli: etiket gövdesi "Courier New" (monospace) kullanır; bu yüzden
// karakter genişliği font boyutunun sabit bir oranıdır ve satır sayısı
// güvenilir biçimde tahmin edilebilir. Tahmin bilinçli olarak KARAMSARDIR
// (yukarı yuvarlar) — böylece sessiz taşma yerine bir alt kademeye iner.

export const PRODUCT_OVERFLOW_MESSAGE =
  'Ürün bilgileri tek etikete sığmıyor.'

/** Courier New yatay ilerleme genişliği = 0.6 × font-size. */
const MONO_ADVANCE_RATIO = 0.6
const MM_TO_PT = 2.834645669

export interface ProductFitItem {
  productName: string
  quantity: number
  color?: string
  size?: string
  sku?: string
}

export interface ProductFitTier {
  titlePt: number
  metaPt: number
  lineHeight: number
}

// Normalden minimuma kademeler. En küçük kademe 203 DPI termal baskıda hâlâ
// okunabilir kabul edilen alt sınırdır; altına İNİLMEZ.
export const PRODUCT_FIT_TIERS: ProductFitTier[] = [
  { titlePt: 8, metaPt: 7, lineHeight: 1.15 },
  { titlePt: 7.5, metaPt: 6.5, lineHeight: 1.12 },
  { titlePt: 7, metaPt: 6, lineHeight: 1.1 },
  { titlePt: 6.5, metaPt: 5.5, lineHeight: 1.08 },
  { titlePt: 6, metaPt: 5.2, lineHeight: 1.05 },
  { titlePt: 5.5, metaPt: 5, lineHeight: 1.02 },
  { titlePt: 5, metaPt: 4.6, lineHeight: 1 },
]

export interface ProductFitResult {
  fits: boolean
  tier: ProductFitTier
  /** Seçilen kademede tahmini toplam yükseklik (pt). */
  estimatedHeightPt: number
  availableHeightPt: number
  lineCount: number
}

export function buildProductTitleText(item: ProductFitItem): string {
  return `${Math.max(1, Math.round(Number(item.quantity) || 1))} x ${item.productName}`
}

// Eksik renk/beden için TEK metin. Sahte değer ÜRETİLMEZ; alanın gerçekten
// bulunamadığı AÇIKÇA gösterilir (sessizce gizlemek yerine).
export const UNSPECIFIED_METADATA_VALUE = 'Belirtilmemiş'

// Referans biçim: "(Renk: X, Beden: Y) [SKU]".
//
// TUTARLILIK KURALI: renk ve beden HER ürün satırında yazılır. Tüm güvenilir
// kaynaklar (satır alanı → variantAttributes → katalog varyantı → çapalı
// başlık ayrıştırması) denendikten sonra hâlâ bulunamayan alan sessizce
// KALDIRILMAZ, "Belirtilmemiş" olarak gösterilir. Böylece bazı etiketlerde
// "(Beden: 42)", bazılarında "(Renk: X, Beden: Y)" çıkması sona erer.
//
// SKU yoksa köşeli parantez HİÇ basılmaz (boş "[]" üretilmez).
export function buildProductMetaText(item: ProductFitItem): string {
  const color = String(item.color ?? '').trim() || UNSPECIFIED_METADATA_VALUE
  const size = String(item.size ?? '').trim() || UNSPECIFIED_METADATA_VALUE
  const grouped = `(Renk: ${color}, Beden: ${size})`
  const sku = String(item.sku ?? '').trim()
  return sku ? `${grouped} [${sku}]` : grouped
}

// Bir metnin verilen genişlik/puntoda kaç satır SARACAĞINI tahmin eder.
// Kelime kırpılmaz; tek kelime satırdan uzunsa zorunlu bölünme sayılır.
export function estimateWrappedLineCount(
  text: string,
  widthPt: number,
  fontPt: number,
): number {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return 0
  const charWidth = fontPt * MONO_ADVANCE_RATIO
  const charsPerLine = Math.max(1, Math.floor(widthPt / charWidth))
  let lines = 1
  let used = 0
  for (const word of trimmed.split(/\s+/)) {
    // Satırdan uzun tek kelime: kendi içinde bölünür.
    if (word.length > charsPerLine) {
      if (used > 0) lines += 1
      const chunks = Math.ceil(word.length / charsPerLine)
      lines += chunks - 1
      used = word.length % charsPerLine || charsPerLine
      continue
    }
    const needed = used === 0 ? word.length : used + 1 + word.length
    if (needed > charsPerLine) {
      lines += 1
      used = word.length
    } else {
      used = needed
    }
  }
  return lines
}

// Tüm ürünler için sığan ilk kademeyi seçer. Hiçbir kademe sığmazsa
// fits=false döner (çağıran açık hata verir; sessiz kırpma YOK).
export function resolveProductFit(input: {
  items: ProductFitItem[]
  availableWidthMm: number
  availableHeightMm: number
  /** Satırlar arası ek boşluk (mm) — çoklu üründe her ürün arası. */
  itemGapMm?: number
}): ProductFitResult {
  const widthPt = input.availableWidthMm * MM_TO_PT
  const availableHeightPt = input.availableHeightMm * MM_TO_PT
  const gapPt = (input.itemGapMm ?? 0.4) * MM_TO_PT
  const items = input.items ?? []

  let last: ProductFitResult = {
    fits: false,
    tier: PRODUCT_FIT_TIERS[PRODUCT_FIT_TIERS.length - 1],
    estimatedHeightPt: 0,
    availableHeightPt,
    lineCount: 0,
  }

  for (const tier of PRODUCT_FIT_TIERS) {
    let height = 0
    let lineCount = 0
    items.forEach((item, index) => {
      const titleLines = estimateWrappedLineCount(
        buildProductTitleText(item),
        widthPt,
        tier.titlePt,
      )
      const metaText = buildProductMetaText(item)
      const metaLines = estimateWrappedLineCount(metaText, widthPt, tier.metaPt)
      lineCount += titleLines + metaLines
      height += titleLines * tier.titlePt * tier.lineHeight
      height += metaLines * tier.metaPt * tier.lineHeight
      if (index > 0) height += gapPt
    })
    last = {
      fits: height <= availableHeightPt,
      tier,
      estimatedHeightPt: height,
      availableHeightPt,
      lineCount,
    }
    if (last.fits) return last
  }
  return last
}
