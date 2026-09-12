// RESMÎ SÜRAT ZPL'İNE ÜRÜN SATIRI EKLEME — SAF (IO/DOM/ağ YOK).
//
// KANIT (referans canlı çıktı): resmî Sürat etiketi AYNEN korunuyor; tek
// eklenen şey etiketin en altındaki ürün satırı:
//   "1 x Önü Drapeli Loş Tesettür Takım (Renk: Krem, Beden: 40) [6496]"
// Header, 1D barkod, barkod altı numara, alıcı/adres, ödeme tipi, birim, desi,
// iki QR/DataMatrix, rota/aktarma ve dikey sipariş rayı DEĞİŞMİYOR; ikinci
// etiket veya yeni kutu YOK.
//
// SÖZLEŞME:
//  - technicalZpl KUTSAL KAYNAKTIR: üzerine yazılmaz, normalize edilmez,
//    satır sonları değiştirilmez, komutlar yeniden sıralanmaz.
//  - Türetilmiş printZpl üretilir: kaynak komutlar AYNEN + ürün komutları,
//    final ^PQ'den (yoksa final ^XZ'den) HEMEN ÖNCE.
//  - Yerleşim TAHMİN DEĞİLDİR: kaynak ZPL ölçülür (suratZplGeometry) ve ürün
//    satırı yalnız resmî içeriğin ALTINDAKİ boş alana, ^LL sınırı içinde
//    yazılır. Güvenli alan yoksa ekleme YAPILMAZ (fallback).
//  - Şablon bilinen Sürat şablonu değilse ürün yazılmaz; kaynak aynen kullanılır.
import { parseSuratZplGeometry, type ZplGeometry } from './suratZplGeometry.ts'

export interface SuratProductLineItem {
  productName: string
  quantity: number
  color?: string
  size?: string
  sku?: string
}

export const PRODUCT_LINE_UNSPECIFIED = 'Belirtilmemiş'
export const PRODUCT_LINE_OVERFLOW_MESSAGE =
  'Ürün bilgileri resmî kargo etiketinin alt alanına sığmıyor.'

export type SuratFooterProfileKey =
  | 'wrapped-mid'
  | 'single-line-standard'
  | 'wrapped-standard'
  | 'single-line-compact'
  | 'single-line-dense'
  | 'wrapped-compact'
  | 'wrapped-dense'
  | 'single-line-micro'
  | 'wrapped-micro'

export interface SuratFooterProfile {
  key: SuratFooterProfileKey
  fontHeight: number
  fontWidth: number
  /** Ürün başına kaç satıra izin verilir (1 = tek satır zorunlu). */
  maxLinesPerItem: number
  /** Satırlar arası dikey aralık (dot). */
  lineGap: number
}

// ÖNCELİK SIRASI: BÜYÜK FONT → WRAP → ancak son çare olarak SHRINK.
//
// FİZİKSEL KANIT (kullanıcının Zebra çıktısı, 203 dpi): referans çıktının ürün
// satırı İKİ SATIR ve belirgin şekilde daha büyük okunuyor; CargoFlow'un
// tek satırı küçük kalıyordu. Eski politika "ne olursa olsun tek satıra
// sığdır ve küçült" idi — merdivende her `wrapped-*` profili, kendinden
// küçük fontlu `single-line-*` profilinin ARDINDA geliyordu.
//
// İKİ DÜZELTME (ikisi de ölçüme dayanır, footer bandı 771 × 66 dot):
//   1) `wrapped-standard` EKLENDİ: tipik ürün satırı (~76 karakter) 20 dot'ta
//      tek satıra sığmıyor ve eskiden 18 dot TEK satıra düşüyordu. Artık
//      20 dot İKİ SATIR seçilir (50 dot; banda sığar) — referans görünüm.
//   2) SIRA düzeltildi: 18 dot iki satır, 16 dot tek satırdan ÖNCE denenir.
//
// Fontlar, alan hesabı ve taşma güvenliği DEĞİŞMEDİ; yalnız tercih sırası
// ve bir profil eklendi. Ürün toplama (aggregation) mantığına DOKUNULMADI.
//
// 203 dpi'de dot → mm: 20 ≈ 2,5 mm · 18 ≈ 2,25 mm · 16 ≈ 2,0 mm · 14 ≈ 1,75 mm.
export const SURAT_FOOTER_PROFILES: SuratFooterProfile[] = [
  // SHORT — tek satır, en büyük okunabilir font.
  { key: 'single-line-standard', fontHeight: 20, fontWidth: 20, maxLinesPerItem: 1, lineGap: 4 },
  // MEDIUM — tek satıra sığmıyorsa KÜÇÜLTME: 20 dot'ta İKİ SATIR.
  //
  // ÖLÇÜM (maskeli gerçek şablon, footer bandı 771 × 66 dot): tipik ürün
  // satırı (~76 karakter) 20 dot'ta tek satıra sığmıyordu ve eski merdiven
  // onu 18 dot TEK satıra düşürüyordu. Fiziksel referansta referans çıktı aynı
  // içeriği İKİ SATIR ve daha büyük fontla basıyor. İki satır 20 dot
  // 50 dot yer tutar (66 dot banda sığar).
  { key: 'wrapped-standard', fontHeight: 20, fontWidth: 20, maxLinesPerItem: 2, lineGap: 4 },
  // MEDIUM — tek satır 18 dot.
  { key: 'single-line-compact', fontHeight: 18, fontWidth: 16, maxLinesPerItem: 1, lineGap: 3 },
  // MEDIUM/LONG — SIĞMIYORSA KÜÇÜLTME, SAR: 18 dot iki satır.
  { key: 'wrapped-compact', fontHeight: 18, fontWidth: 16, maxLinesPerItem: 2, lineGap: 3 },
  // LONG — okunabilirlik tabanı 16 dot; önce tek satır, sonra iki satır.
  { key: 'single-line-dense', fontHeight: 16, fontWidth: 14, maxLinesPerItem: 1, lineGap: 2 },
  { key: 'wrapped-dense', fontHeight: 16, fontWidth: 14, maxLinesPerItem: 2, lineGap: 2 },
  // ── SON ÇARE KADEMELERİ (canlı 4057121401 vakası) ────────────────────
  // KANIT: gerçek gönderide resmî içerik etiketin çok altına iniyor ve
  // yukarıdaki beş profilin EN AZ İHTİYACI olan 38 dot bile kalmıyordu →
  // still_overflow. Ölçüm (106 karakterlik gerçek ürün metni, 731 dot alan):
  //   single-line-standard/compact/dense : 106 karakter TEK SATIRA sığmıyor
  //                                        (en fazla 87 kar/satır) → reddedilir
  //   wrapped-compact                    : 44 dot gerekiyor
  //   wrapped-dense                      : 38 dot gerekiyor
  //   single-line-micro                  : 14 dot  (106 kar TEK satıra sığar)
  //   wrapped-micro                      : 28 dot
  //
  // Bu kademeler merdivenin SONUNDADIR: yeri olan etiketlerde ÖNCEKİ profil
  // aynen seçilir, mevcut çıktı DEĞİŞMEZ. Yalnız daha önce hiç ürün satırı
  // basılamayan dar etiketlerde devreye girer.
  //
  // OKUNABİLİRLİK TABANI: 12 dot ≈ 1,5 mm (203 dpi). Bunun ALTINA İNİLMEZ;
  // sığmıyorsa ürün satırı yine EKLENMEZ (sessiz kırpma YOK).
  // ARA KADEME: 16 → 12 sıçramasını kapatır. Yer varsa DAHA BÜYÜK okunur
  // fontu (14 dot) iki satırda kullanmak, 12 dot'luk tek satırdan daha
  // profesyonel görünür — referans çıktı da iki satırlıdır.
  { key: 'wrapped-mid', fontHeight: 14, fontWidth: 12, maxLinesPerItem: 2, lineGap: 2 },
  { key: 'single-line-micro', fontHeight: 12, fontWidth: 10, maxLinesPerItem: 1, lineGap: 1 },
  { key: 'wrapped-micro', fontHeight: 12, fontWidth: 10, maxLinesPerItem: 2, lineGap: 1 },
]

// ═══ ALANA GÖRE MAKSİMAL FONT — DETERMİNİSTİK AZALAN ARAMA ══════════════
//
// ═══ ÜRETİMDE ÖLÇÜLEN KUSUR ══════════════════════════════════════════════
// Tek ürünlü etiketlerde, ürün bandında bol boş alan KALMASINA rağmen ürün
// metni gereksiz küçük basılıyordu.
//
// Sebep yukarıdaki SABİT merdivendi. Alan hesabı (`resolveFooterArea`)
// zaten gerçek geometriden türüyordu; kusur ADAY KÜMESİNDEYDİ:
//
//   1. TAVAN 20 dot'ta sabitti. Bant 93 dot boş olsa bile 20'den büyük bir
//      font HİÇ denenmiyordu — kullanılabilir alanın üçte ikisi boş kalıyordu.
//   2. `maxLinesPerItem` her profilde ≤ 2 idi. 3 satır RAHATÇA sığarken
//      içerik 20 dot'tan 12 dot'a düşürülüyordu; oysa 20 dot üç satır hem
//      sığıyor hem çok daha okunaklı.
//
// ═══ YENİ KURAL ══════════════════════════════════════════════════════════
// Soru artık "sığıyor mu?" değil, "BU BÖLGEYE SIĞAN EN BÜYÜK okunabilir
// font hangisi?" Yükseklikler TAVANDAN TABANA taranır; her aday için satır
// sayısı ÖLÇÜLÜR (karakter sayısı eşiğiyle TAHMİN EDİLMEZ) ve gerçek
// yükseklik alana sığıyorsa O aday seçilir. İlk sığan = en büyük sığan.
//
// Satır tavanı ARTIK PROFİLDEN GELMEZ: sınırı alanın kendisi koyar. Eski
// `maxLinesPerItem` kapağı, alan uygunken bile büyük fontu reddeden şeydi.
//
// ═══ MEVCUT ÇIKTI NEDEN BOZULMAZ ═════════════════════════════════════════
// ≤ 20 dot yükseklikler için genişlik/aralık tablosu eski profillerin
// DEĞERLERİNİ birebir üretir (20→20/4, 18→16/3, 16→14/2, 14→12/2, 12→10/1).
// Dar bantlarda (ör. ölçülen 66 dot) 20 dot üç satır 75 dot tutar ve yine
// REDDEDİLİR — o etiketlerin çıktısı AYNEN kalır. Değişen yalnız GERÇEKTEN
// boş alanı olan etiketlerdir.

/** Fiziksel baskıda kabul edilen ALT okunabilirlik sınırı (dot @203 dpi). */
export const FOOTER_MIN_FONT_HEIGHT = 12

/**
 * ÜST sınır (dot @203 dpi ≈ 3,2 mm).
 *
 * NEDEN 26: etiketin kendi görsel hiyerarşisi korunur. Taşıyıcının aktarma
 * merkezi metni 34–38 dot ile en baskın bloktur; ürün satırı YARDIMCI
 * bilgidir ve ondan belirgin biçimde küçük kalmalıdır. 26 dot, bugünkü
 * 20 dot'tan %30 daha okunaklıdır ama rota bloğunun önüne GEÇMEZ.
 */
export const FOOTER_MAX_FONT_HEIGHT = 26

/** Yükseklikten genişlik — ≤ 20 için eski profillerin AYNI değerleri. */
export function footerFontWidthFor(fontHeight: number): number {
  if (fontHeight >= 20) return fontHeight
  if (fontHeight >= 18) return 16
  if (fontHeight >= 16) return 14
  if (fontHeight >= 14) return 12
  return 10
}

/** Yükseklikten satır aralığı — ≤ 20 için eski profillerin AYNI değerleri. */
export function footerLineGapFor(fontHeight: number): number {
  if (fontHeight >= 20) return 4
  if (fontHeight >= 18) return 3
  if (fontHeight >= 14) return 2
  return 1
}

/** Bir yükseklik adayı için satır yüksekliği (dot). */
export function footerLineHeightFor(fontHeight: number): number {
  return Math.round(fontHeight * 1.05) + footerLineGapFor(fontHeight)
}

/** Taranacak yükseklik adayları — TAVANDAN TABANA, deterministik. */
export function footerFontCandidates(): number[] {
  const out: number[] = []
  for (let h = FOOTER_MAX_FONT_HEIGHT; h >= FOOTER_MIN_FONT_HEIGHT; h -= 1) {
    out.push(h)
  }
  return out
}

// ── Metin ────────────────────────────────────────────────────────────────
function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Ürün satırının hangi parçalarının basılacağı — KİRACI AYARI.
 *
 * Bu parçalar kodsuz düzenleyicideki "Adet / Varyant / SKU" bloklarına
 * karşılık gelir. Ürün ADI kapatılamaz: adı olmayan bir ürün satırı depoda
 * hiçbir işe yaramaz ve satırın tamamı anlamsız olurdu.
 *
 * Varsayılan, bugünkü çıktının BİREBİR aynısıdır (üçü de açık); bu yüzden
 * ayar verilmeyen kiracıların etiketi DEĞİŞMEZ.
 */
export interface ProductLineParts {
  readonly quantity: boolean
  readonly variant: boolean
  readonly sku: boolean
}

export const DEFAULT_PRODUCT_LINE_PARTS: ProductLineParts = {
  quantity: true,
  variant: true,
  sku: true,
}

/**
 * referans biçim: `{adet} x {ürün adı} (Renk: X, Beden: Y) [SKU]`.
 * Renk/beden bulunamazsa "Belirtilmemiş" yazılır (TAHMİN YOK). SKU yoksa
 * köşeli parantez HİÇ basılmaz; boş "()", "[]" veya sarkan ayraç oluşmaz.
 */
export function buildProductLineTitle(
  item: SuratProductLineItem,
  parts: ProductLineParts = DEFAULT_PRODUCT_LINE_PARTS,
): string {
  const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1))
  const name = clean(item.productName) || 'Ürün'
  return parts.quantity ? `${quantity} x ${name}` : name
}

export function buildProductLineMeta(
  item: SuratProductLineItem,
  parts: ProductLineParts = DEFAULT_PRODUCT_LINE_PARTS,
): string {
  const color = clean(item.color) || PRODUCT_LINE_UNSPECIFIED
  const size = clean(item.size) || PRODUCT_LINE_UNSPECIFIED
  const sku = clean(item.sku)
  // Kapatılan parça HİÇ basılmaz: boş "()" veya sarkan "[]" oluşmaz.
  const grouped = parts.variant ? `(Renk: ${color}, Beden: ${size})` : ''
  const tail = parts.sku && sku ? `[${sku}]` : ''
  return [grouped, tail].filter(Boolean).join(' ')
}

export function buildProductLineText(
  item: SuratProductLineItem,
  parts: ProductLineParts = DEFAULT_PRODUCT_LINE_PARTS,
): string {
  return [buildProductLineTitle(item, parts), buildProductLineMeta(item, parts)]
    .filter(Boolean)
    .join(' ')
}

/**
 * SUNUM AŞAMASINDA TEKİLLEŞTİRME (referans çıktı).
 *
 * AYNI ürünün birden çok sipariş satırı tek satırda toplanır:
 *   "1 x Elbise (Renk: Lacivert, Beden: 40)" ×2  →  "2 x Elbise (...)"
 *
 * BİRLEŞTİRME KOŞULU KATIDIR: ürün adı, renk, beden ve SKU'nun DÖRDÜ DE
 * aynı olmalıdır. Farklı varyant (renk/beden) veya farklı SKU ASLA
 * birleştirilmez — etiket yanlış ürün gösteremez.
 *
 * Karşılaştırma yalnız boşluk/büyük-küçük harf normalizasyonu yapar; içerik
 * DEĞİŞTİRİLMEZ. Sıra korunur: ilk görülen satır konumunu tutar (çıktı
 * DETERMINISTIKTIR). Bu YALNIZ bir sunum işlemidir; sipariş satırları,
 * stok veya adet hesapları ETKİLENMEZ.
 */
export function aggregateProductLineItems(
  items: SuratProductLineItem[],
): SuratProductLineItem[] {
  const key = (item: SuratProductLineItem) =>
    [
      clean(item.productName).toLocaleLowerCase('tr'),
      clean(item.color).toLocaleLowerCase('tr'),
      clean(item.size).toLocaleLowerCase('tr'),
      clean(item.sku).toLocaleLowerCase('tr'),
    ].join('')
  const order: string[] = []
  const merged = new Map<string, SuratProductLineItem>()
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue
    const id = key(item)
    const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1))
    const existing = merged.get(id)
    if (existing) {
      existing.quantity += quantity
      continue
    }
    order.push(id)
    merged.set(id, { ...item, quantity })
  }
  return order.map((id) => merged.get(id) as SuratProductLineItem)
}

// ── Türkçe karakter ──────────────────────────────────────────────────────
// Kaynak Sürat ZPL'i ^CI28 (UTF-8) kullanıyorsa Türkçe karakterler AYNEN
// yazılır. Kullanmıyorsa bozuk karakter basmak yerine AÇIK ve DETERMINISTIK
// transliterasyon uygulanır (yazıcıya yeni font yüklemek GEREKMEZ).
const TRANSLITERATION: Record<string, string> = {
  ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I',
  ç: 'c', Ç: 'C', ö: 'o', Ö: 'O', ü: 'u', Ü: 'U',
  â: 'a', Â: 'A', î: 'i', Î: 'I', û: 'u', Û: 'U',
}

export function transliterateTurkish(value: string): string {
  return value.replace(/[şŞğĞıİçÇöÖüÜâÂîÎûÛ]/g, (char) => TRANSLITERATION[char] ?? char)
}

/** ^FD verisini güvenli hale getirir: ZPL kontrol karakterleri kaçırılır. */
export function escapeZplData(value: string): string {
  return value.replace(/[\^~]/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── Şablon parmak izi ────────────────────────────────────────────────────
export interface SuratTemplateFingerprint {
  supported: boolean
  printWidth: number
  labelLength: number
  hasSinglePage: boolean
  hasCode128: boolean
  hasMatrixCode: boolean
  hasVerticalRail: boolean
  hasFinalPq: boolean
  /** Kararlı şablon imzası (koordinat/komut iskeleti; PII veya kod İÇERMEZ). */
  signature: string
  reason?: string
}

export function resolveSuratTemplateFingerprint(
  rawZpl: unknown,
  geometry?: ZplGeometry,
): SuratTemplateFingerprint {
  const zpl = String(rawZpl ?? '')
  const measured = geometry ?? parseSuratZplGeometry(zpl)
  const startCount = (zpl.match(/\^XA/g) ?? []).length
  const endCount = (zpl.match(/\^XZ/g) ?? []).length
  const hasSinglePage = startCount === 1 && endCount === 1
  const hasCode128 = /\^BC/i.test(zpl)
  const hasMatrixCode = /\^B[QX]/i.test(zpl)
  const hasVerticalRail = measured.leftRailRight > 0
  const hasFinalPq = /\^PQ[^^]*\s*\^XZ\s*$/i.test(zpl.trim())
  // İmza: yalnız komut iskeleti (veri ^FD içerikleri HARİÇ).
  const signature = (zpl.match(/\^[A-Z][A-Z0-9@]?/gi) ?? [])
    .map((token) => token.toUpperCase())
    .join('')
    .slice(0, 512)

  const failures: string[] = []
  if (!hasSinglePage) failures.push('tek ^XA/^XZ değil')
  if (measured.printWidth !== 799) failures.push('^PW799 değil')
  if (measured.labelLength !== 799) failures.push('^LL799 değil')
  if (!hasCode128) failures.push('^BC bloğu yok')
  if (!hasMatrixCode) failures.push('^BQ/^BX bloğu yok')
  if (!hasVerticalRail) failures.push('dikey sipariş rayı yok')
  if (!measured.ok) failures.push('geometri ölçülemedi')

  return {
    supported: failures.length === 0,
    printWidth: measured.printWidth,
    labelLength: measured.labelLength,
    hasSinglePage,
    hasCode128,
    hasMatrixCode,
    hasVerticalRail,
    hasFinalPq,
    signature,
    reason: failures.length > 0 ? failures.join(', ') : undefined,
  }
}

// ── Yerleşim ─────────────────────────────────────────────────────────────
/** Resmî içerik ile ürün satırı arasındaki güvenlik boşluğu (dot). */
export const FOOTER_TOP_GAP = 6
/** Etiketin alt kenarından bırakılan güvenlik payı (dot). */
export const FOOTER_BOTTOM_MARGIN = 8
/** Sol rayın sağından bırakılan boşluk (dot). */
export const FOOTER_LEFT_GAP = 8
/** Sağ kenardan bırakılan boşluk (dot). */
export const FOOTER_RIGHT_MARGIN = 12

export interface SuratFooterArea {
  x: number
  top: number
  bottom: number
  width: number
  height: number
}

export function resolveFooterArea(geometry: ZplGeometry): SuratFooterArea {
  const top = geometry.contentBottom + FOOTER_TOP_GAP
  const bottom = geometry.labelLength - FOOTER_BOTTOM_MARGIN
  // SOL SINIR — referans çıktı footer'ı etiketin sol fiziksel kenarına
  // yakın başlatır. Bunu yapabilmek için rayın GERÇEK dikey uzanımı bilinir:
  // dikey "Sipariş No" rayı ^FWB ile alttan üste uzanır, yani `leftRailBottom`
  // origin'dir ve footer bunun ALTINDA kalıyorsa ray artık yolda DEĞİLDİR.
  //
  // GÜVENLİK: genişletme YALNIZ ray ölçülebildiyse VE footer rayın alt
  // kenarının altında başlıyorsa yapılır. Ölçülemediyse veya hizalar
  // çakışıyorsa ESKİ muhafazakâr sınır (rayın sağı) korunur — ürün metni
  // dikey rayın üzerine ASLA binmez.
  const clearsRail =
    geometry.leftRailBottom > 0 && top >= geometry.leftRailBottom
  const x = clearsRail
    ? FOOTER_LEFT_GAP * 2
    : Math.max(geometry.leftRailRight + FOOTER_LEFT_GAP, FOOTER_LEFT_GAP * 2)
  return {
    x,
    top,
    bottom,
    width: Math.max(0, geometry.printWidth - FOOTER_RIGHT_MARGIN - x),
    height: Math.max(0, bottom - top),
  }
}

// Ölçeklenebilir ZPL fontunda karakter genişliği ≈ ^A0 genişlik parametresi.
// Sürat şablonundaki mevcut ^A0 kullanımıyla tutarlı, muhafazakâr oran.
const CHAR_WIDTH_RATIO = 0.6

function estimateLines(text: string, fontWidth: number, widthDots: number): number {
  const charsPerLine = Math.max(
    1,
    Math.floor(widthDots / Math.max(1, fontWidth * CHAR_WIDTH_RATIO)),
  )
  if (text.length <= charsPerLine) return 1
  // Kelime bazlı sarma (kesme YOK).
  let lines = 1
  let used = 0
  for (const word of text.split(' ')) {
    const needed = used === 0 ? word.length : used + 1 + word.length
    if (needed <= charsPerLine) {
      used = needed
    } else {
      lines += 1
      used = word.length
    }
  }
  return lines
}

/** Bir ^FB bloğu: metin ve kaç fiziksel satır kaplayacağı. Metin ASLA kesilmez. */
export interface SuratFooterBlockLine {
  text: string
  lines: number
}

export interface SuratFooterPlan {
  ok: boolean
  profile?: SuratFooterProfile
  area?: SuratFooterArea
  /** Her ürün için üretilecek bloklar (kesme/ellipsis YOK). */
  blocks?: SuratFooterBlockLine[][]
  usedHeight?: number
  reason?: string
}

/**
 * TEK ADAY İÇİN ÖLÇÜM — maksimallik kanıtının dayanağı.
 *
 * Verilen font yüksekliğinde ürün metninin GERÇEKTEN kaç satır sardığını ve
 * ne kadar dikey yer tuttuğunu döner. `planSuratFooter` bunu tavandan tabana
 * çağırır; testler de "bir sonraki BÜYÜK font da sığıyor mu?" sorusunu AYNI
 * fonksiyonla sorar — yani kanıt, seçimle aynı ölçümden gelir.
 */
export interface FooterFitMeasurement {
  readonly fontHeight: number
  readonly fontWidth: number
  readonly lineHeight: number
  readonly totalLines: number
  readonly usedHeight: number
  readonly fits: boolean
  readonly blocks: SuratFooterBlockLine[][]
}

export function measureFooterFit(
  source: readonly SuratProductLineItem[],
  area: SuratFooterArea,
  fontHeight: number,
  parts?: ProductLineParts,
): FooterFitMeasurement {
  const fontWidth = footerFontWidthFor(fontHeight)
  const lineHeight = footerLineHeightFor(fontHeight)
  const blocks: SuratFooterBlockLine[][] = []
  let totalLines = 0
  for (const item of source) {
    const full = buildProductLineText(item, parts)
    const lines = estimateLines(full, fontWidth, area.width)
    blocks.push([{ text: full, lines }])
    totalLines += lines
  }
  const usedHeight = totalLines * lineHeight
  return {
    fontHeight,
    fontWidth,
    lineHeight,
    totalLines,
    usedHeight,
    fits: totalLines > 0 && usedHeight <= area.height,
    blocks,
  }
}

/**
 * Tanısal profil anahtarı.
 *
 * Anahtar artık SEÇİMİ yönlendirmez (seçim ölçüme dayanır); yalnız izlerde
 * ve raporlarda okunabilir bir ad taşır. Mevcut sözlük KORUNUR.
 */
export function footerProfileKeyFor(
  fontHeight: number,
  totalLines: number,
  itemCount: number,
): SuratFooterProfileKey {
  const wrapped = totalLines > itemCount
  if (fontHeight >= 20) {
    return wrapped ? 'wrapped-standard' : 'single-line-standard'
  }
  if (fontHeight >= 18) {
    return wrapped ? 'wrapped-compact' : 'single-line-compact'
  }
  if (fontHeight >= 16) {
    return wrapped ? 'wrapped-dense' : 'single-line-dense'
  }
  if (fontHeight >= 14) return 'wrapped-mid'
  return wrapped ? 'wrapped-micro' : 'single-line-micro'
}

export function planSuratFooter(
  items: SuratProductLineItem[],
  geometry: ZplGeometry,
  parts: ProductLineParts = DEFAULT_PRODUCT_LINE_PARTS,
): SuratFooterPlan {
  const area = resolveFooterArea(geometry)
  // Aynı ürünün tekrar eden satırları TEK satırda toplanır (yalnız sunum).
  // Farklı varyant/SKU birleşmez; bkz. aggregateProductLineItems.
  const source = aggregateProductLineItems(
    Array.isArray(items) ? items.filter(Boolean) : [],
  )
  if (source.length === 0) {
    return { ok: false, reason: 'Ürün satırı yok.' }
  }
  if (area.height <= 0 || area.width <= 0) {
    return { ok: false, area, reason: PRODUCT_LINE_OVERFLOW_MESSAGE }
  }

  // Bir ürün bloğunun kaplayabileceği EN FAZLA fiziksel satır. Ürün adı
  // kesilmez; gerekirse ad kendi içinde sarar (^FB), meta ayrı satırda kalır.

  // ═══ MAKSİMAL FIT — "sığan EN BÜYÜK font" ═════════════════════════════
  //
  // Adaylar TAVANDAN TABANA taranır; ilk sığan aday AYNI ZAMANDA en büyük
  // sığan adaydır. Satır sayısı tahmin edilmez, ÖLÇÜLÜR; satır tavanını
  // alanın kendi yüksekliği koyar.
  for (const fontHeight of footerFontCandidates()) {
    const fit = measureFooterFit(source, area, fontHeight, parts)
    // TEK KAPI: gerçek yükseklik gerçek alana sığıyor mu? Kelime ortasından
    // kesme YOK; hiçbir aday sığmazsa plan `ok:false` döner ve çağıran katman
    // bunu AÇIK overflow olarak raporlar (sessiz düşürme YOK).
    if (!fit.fits) continue
    return {
      ok: true,
      profile: {
        key: footerProfileKeyFor(fontHeight, fit.totalLines, source.length),
        fontHeight,
        fontWidth: fit.fontWidth,
        // Seçilen adayda ürün başına GERÇEKTEN kullanılan en yüksek satır
        // sayısı — tanı ve regresyon için taşınır.
        maxLinesPerItem: fit.blocks.reduce(
          (max, block) =>
            Math.max(max, block.reduce((sum, entry) => sum + entry.lines, 0)),
          1,
        ),
        lineGap: footerLineGapFor(fontHeight),
      },
      area,
      blocks: fit.blocks,
      usedHeight: fit.usedHeight,
    }
  }

  return { ok: false, area, reason: PRODUCT_LINE_OVERFLOW_MESSAGE }
}

/** Plandan ZPL komutları üretir. Kaynak komutlara DOKUNMAZ. */
export function buildFooterZplCommands(
  plan: SuratFooterPlan,
  options: { utf8: boolean },
): string[] {
  if (!plan.ok || !plan.profile || !plan.area || !plan.blocks) return []
  const { profile, area, blocks } = plan
  const lineHeight = Math.round(profile.fontHeight * 1.05) + profile.lineGap
  const commands: string[] = []
  let y = area.top
  for (const block of blocks) {
    for (const entry of block) {
      const prepared = escapeZplData(
        options.utf8 ? entry.text : transliterateTurkish(entry.text),
      )
      // ^FB satır sayısı GERÇEK ihtiyaca göre verilir: metin KESİLMEZ.
      commands.push(
        `^FO${area.x},${y}^A0N,${profile.fontHeight},${profile.fontWidth}` +
          `^FB${area.width},${entry.lines},0,L,0^FD${prepared}^FS`,
      )
      y += lineHeight * entry.lines
    }
  }
  return commands
}
