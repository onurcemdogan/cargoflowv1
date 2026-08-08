// RESMÎ SÜRAT ZPL'İNE ÜRÜN SATIRI EKLEME — SAF (IO/DOM/ağ YOK).
//
// KANIT (DuruSoft canlı çıktısı): resmî Sürat etiketi AYNEN korunuyor; tek
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
  | 'single-line-standard'
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

// DuruSoft kanıtı: tek ürün için ÖNCELİK TEK SATIRDIR. Sırayla denenir, İLK
// güvenli profil seçilir; seçim DETERMINISTIKTIR.
export const SURAT_FOOTER_PROFILES: SuratFooterProfile[] = [
  { key: 'single-line-standard', fontHeight: 20, fontWidth: 20, maxLinesPerItem: 1, lineGap: 4 },
  { key: 'single-line-compact', fontHeight: 18, fontWidth: 16, maxLinesPerItem: 1, lineGap: 3 },
  { key: 'single-line-dense', fontHeight: 16, fontWidth: 14, maxLinesPerItem: 1, lineGap: 2 },
  { key: 'wrapped-compact', fontHeight: 18, fontWidth: 16, maxLinesPerItem: 2, lineGap: 3 },
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
  { key: 'single-line-micro', fontHeight: 12, fontWidth: 10, maxLinesPerItem: 1, lineGap: 1 },
  { key: 'wrapped-micro', fontHeight: 12, fontWidth: 10, maxLinesPerItem: 2, lineGap: 1 },
]

// ── Metin ────────────────────────────────────────────────────────────────
function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * DuruSoft biçimi: `{adet} x {ürün adı} (Renk: X, Beden: Y) [SKU]`.
 * Renk/beden bulunamazsa "Belirtilmemiş" yazılır (TAHMİN YOK). SKU yoksa
 * köşeli parantez HİÇ basılmaz; boş "()", "[]" veya sarkan ayraç oluşmaz.
 */
export function buildProductLineTitle(item: SuratProductLineItem): string {
  const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1))
  const name = clean(item.productName) || 'Ürün'
  return `${quantity} x ${name}`
}

export function buildProductLineMeta(item: SuratProductLineItem): string {
  const color = clean(item.color) || PRODUCT_LINE_UNSPECIFIED
  const size = clean(item.size) || PRODUCT_LINE_UNSPECIFIED
  const sku = clean(item.sku)
  const grouped = `(Renk: ${color}, Beden: ${size})`
  return sku ? `${grouped} [${sku}]` : grouped
}

export function buildProductLineText(item: SuratProductLineItem): string {
  return `${buildProductLineTitle(item)} ${buildProductLineMeta(item)}`
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
  const x = Math.max(
    geometry.leftRailRight + FOOTER_LEFT_GAP,
    FOOTER_LEFT_GAP * 2,
  )
  const top = geometry.contentBottom + FOOTER_TOP_GAP
  const bottom = geometry.labelLength - FOOTER_BOTTOM_MARGIN
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

export function planSuratFooter(
  items: SuratProductLineItem[],
  geometry: ZplGeometry,
): SuratFooterPlan {
  const area = resolveFooterArea(geometry)
  const source = Array.isArray(items) ? items.filter(Boolean) : []
  if (source.length === 0) {
    return { ok: false, reason: 'Ürün satırı yok.' }
  }
  if (area.height <= 0 || area.width <= 0) {
    return { ok: false, area, reason: PRODUCT_LINE_OVERFLOW_MESSAGE }
  }

  // Bir ürün bloğunun kaplayabileceği EN FAZLA fiziksel satır. Ürün adı
  // kesilmez; gerekirse ad kendi içinde sarar (^FB), meta ayrı satırda kalır.
  const MAX_PHYSICAL_LINES_PER_ITEM = 3

  for (const profile of SURAT_FOOTER_PROFILES) {
    const lineHeight = Math.round(profile.fontHeight * 1.05) + profile.lineGap
    const blocks: SuratFooterBlockLine[][] = []
    let fits = true
    for (const item of source) {
      const full = buildProductLineText(item)
      const singleLines = estimateLines(full, profile.fontWidth, area.width)
      if (singleLines === 1) {
        // DuruSoft kanıtı: mümkün olduğunda TEK kompakt satır.
        blocks.push([{ text: full, lines: 1 }])
        continue
      }
      if (profile.maxLinesPerItem < 2) {
        fits = false
        break
      }
      // İki bölümlü biçim: başlık (gerekirse kendi içinde sarar) + meta.
      const title = buildProductLineTitle(item)
      const meta = buildProductLineMeta(item)
      const titleLines = estimateLines(title, profile.fontWidth, area.width)
      const metaLines = estimateLines(meta, profile.fontWidth, area.width)
      if (titleLines + metaLines > MAX_PHYSICAL_LINES_PER_ITEM) {
        fits = false
        break
      }
      blocks.push([
        { text: title, lines: titleLines },
        { text: meta, lines: metaLines },
      ])
    }
    if (!fits) continue
    const totalLines = blocks.reduce(
      (total, block) =>
        total + block.reduce((sum, entry) => sum + entry.lines, 0),
      0,
    )
    const usedHeight = totalLines * lineHeight
    if (usedHeight > area.height) continue
    return { ok: true, profile, area, blocks, usedHeight }
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
