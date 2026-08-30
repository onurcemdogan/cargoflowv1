// TEK RENDERER — ÖNİZLEME VE BASKI AYNI KAYNAKTAN ÇIKAR.
//
// ═══ NEDEN TEK RENDERER ══════════════════════════════════════════════════
// Bir düzenleyicinin en sinsi hatası, tuvalde gösterdiği yerleşimin baskıda
// başka çıkmasıdır. Bu, iki ayrı çizim yolu (biri DOM önizlemesi, biri baskı
// belgesi) olduğunda KAÇINILMAZDIR: sarma kuralı, satır yüksekliği ve kırpma
// er ya da geç ayrışır.
//
// Bu modül aradaki tek gerçeği üretir: belge + etiket verisi → KONUMLANMIŞ
// İLKELLER (primitives). Düzenleyici tuvali de, baskı belgesi de AYNI ilkel
// listesini çizer. Yerleşim farkı MİMARİ OLARAK mümkün değildir.
//
// ═══ NEDEN DOM ÖLÇÜMÜ YOK ════════════════════════════════════════════════
// Metin sarması `measureText`/`getBoundingClientRect` ile ölçülseydi sonuç
// bağlama göre değişirdi: düzenleyici iframe'i, gizli baskı iframe'i ve
// yazıcı sürücüsü aynı fontu aynı şekilde ölçmez. Bu yüzden sarma SAF ve
// DETERMİNİSTİK bir genişlik tahminiyle yapılır: her ortamda AYNI satırlar.
//
// SAF: ağ yok, DOM yok, taşıyıcı çağrısı yok, rastgelelik yok.

import type { CargoOrder } from '../types/cargoflow.ts'
import type { LabelData } from '../utils/labelData.ts'
import { resolveTenantBlockValues } from '../utils/labelTenantBlocks.ts'
import {
  isIdentityLocked,
  type LabelDocument,
  type LabelElement,
  type LabelElementAlign,
  type LabelElementType,
} from './labelDocument.ts'
import {
  ptToMm,
  rectsOverlap,
  rectWithinCanvas,
  type RectMm,
} from './labelGeometry.ts'

/**
 * Ortalama glif genişliği (punto oranı).
 *
 * Etiket font yığını (Arial/Helvetica türevi) için ölçülmüş yaklaşık değer.
 * Kesin değil — KESİN OLMASI GEREKMİYOR: önemli olan her iki yolda AYNI
 * sonucu vermesidir. Fazla iyimser bir değer taşmayı gizlerdi, bu yüzden
 * hafif TEMKİNLİ seçilmiştir.
 */
const AVERAGE_GLYPH_RATIO = 0.54
const DEFAULT_LINE_HEIGHT = 1.2
const DEFAULT_FONT_PT = 9

export type LabelPrimitive =
  | {
      kind: 'text'
      elementId: string
      type: LabelElementType
      rect: RectMm
      lines: string[]
      fontSizePt: number
      bold: boolean
      align: LabelElementAlign
      lineHeight: number
      /** İçerik `maxLines` veya kutu yüksekliği yüzünden KIRPILDI mı? */
      truncated: boolean
      /** Sarılmış içeriğin gerçek yüksekliği (mm). */
      contentHeightMm: number
    }
  | {
      kind: 'barcode'
      elementId: string
      type: 'barcode'
      rect: RectMm
      value: string
      humanReadable: string | null
      fontSizePt: number
    }
  | {
      kind: 'qr'
      elementId: string
      type: 'qr'
      rect: RectMm
      value: string
    }

export const LABEL_GUARD_CODES = [
  'PRINT_BOUNDS_GUARD',
  'BARCODE_OVERLAP_GUARD',
  'QR_OVERLAP_GUARD',
  'LONG_ADDRESS_OVERFLOW_GUARD',
] as const

export type LabelGuardCode = (typeof LABEL_GUARD_CODES)[number]

export interface LabelGuardViolation {
  code: LabelGuardCode
  elementId: string
  detail: string
  /**
   * YAYINLAMAYI ENGELLER Mİ?
   *
   * ═══ NEDEN İKİ SINIF ═══════════════════════════════════════════════════
   * İhlallerin bir kısmı VERİDEN BAĞIMSIZ yerleşim hatasıdır: öğe tuvalin
   * dışına taşmış ya da barkodun/QR'ın üzerine binmiş. Bunlar HANGİ sipariş
   * basılırsa basılsın bozuktur — okunmayan kimlik, kaybolmuş pakettir. Bu
   * yüzden YAYINLAMA ENGELLENİR.
   *
   * Diğerleri VERİYE BAĞLIDIR: çok uzun bir adres ya da sekiz kalemlik bir
   * sipariş kutuya sığmaz. Bunlar uç örneklerdir; yerleşimin kendisi bozuk
   * değildir. Operatöre AÇIKÇA bildirilir (sessiz kırpma YOK) ama yayınlama
   * engellenmez — aksi halde tek bir aykırı sipariş tüm şablonu kilitlerdi.
   */
  blocking: boolean
}

export interface RenderedLabel {
  primitives: LabelPrimitive[]
  violations: LabelGuardViolation[]
  /** Hiçbir ihlal yoksa etiket olduğu gibi basılabilir. */
  printable: boolean
  /** Yerleşim hatası (veriden bağımsız) var mı? Yayınlama buna bakar. */
  hasBlockingViolation: boolean
}

/**
 * Etiket verisi + sipariş → görüntülenecek içerik.
 *
 * Sipariş bağımlı alanlar (satın alan, sipariş tarihi/saati) ZPL yolunun
 * kullandığı AYNI çözümleyiciden (`resolveTenantBlockValues`) gelir; ikinci
 * bir türetme yazmak iki yolun ayrışmasının garantisi olurdu.
 */
export interface LabelRenderSource {
  data: LabelData
  order?: CargoOrder
}

/** Belgede tanımlı öğe için etiket verisinden içerik çözer. */
export function resolveElementContent(
  element: LabelElement,
  source: LabelRenderSource,
): string[] {
  const { data, order } = source
  const blocks = resolveTenantBlockValues(order, data)
  switch (element.type) {
    case 'recipientName':
      return [String(data.recipientName ?? '')]
    case 'buyerName':
      return [String(blocks.buyerName || data.recipientName || '')]
    case 'address':
      return splitAddressLines(String(data.address ?? ''))
    case 'cityDistrict': {
      const city = String(data.city ?? '').trim()
      const district = String(data.district ?? '').trim()
      return [[district, city].filter(Boolean).join(' / ')]
    }
    case 'phone':
      return [String(data.recipientPhone ?? '')]
    case 'orderNumber':
      return [String(data.orderNumber ?? '')]
    case 'packageId':
      return [String(data.packageId ?? '')]
    case 'orderDate':
      return [String(blocks.orderDate ?? '')]
    case 'orderTime':
      return [String(blocks.orderTime ?? '')]
    case 'marketplace':
      return [String(data.marketplaceName ?? '')]
    case 'trackingText':
      return [String(data.tNo || data.trackingNumber || '')]
    case 'cargoMeta': {
      const parts: string[] = []
      if (data.desi != null) parts.push(`Desi: ${data.desi}`)
      if (data.packageCount) parts.push(`Paket: ${data.packageCount}`)
      if (data.cargoProviderName) parts.push(String(data.cargoProviderName))
      return [parts.join('  ')]
    }
    case 'productList':
      return (data.items ?? []).map((item) => {
        const variant = [item.color, item.size].filter(Boolean).join(' / ')
        return [
          `${item.quantity} x ${item.productName}`,
          variant ? `(${variant})` : '',
          item.sku ? `[${item.sku}]` : '',
        ]
          .filter(Boolean)
          .join(' ')
      })
    case 'staticText':
      return String(element.text ?? '').split('\n')
    // Kimlik öğeleri metin olarak çözülmez.
    case 'barcode':
    case 'qr':
      return []
    default:
      return []
  }
}

/** Adres satırlara ayrılır; içerik KAYBOLMAZ. */
function splitAddressLines(address: string): string[] {
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * DETERMİNİSTİK sarma. Aynı girdi her ortamda AYNI satırları verir.
 *
 * Kelime kutuya sığmıyorsa KIRPILMAZ, taşırılır ve `truncated` ile bildirilir
 * — sessiz küçültme veya sessiz kesme YOK.
 */
export function wrapLines(
  source: string[],
  widthMm: number,
  fontSizePt: number,
  wrap: boolean,
): string[] {
  const glyphMm = ptToMm(fontSizePt) * AVERAGE_GLYPH_RATIO
  if (!wrap || glyphMm <= 0) return source
  const maxChars = Math.max(1, Math.floor(widthMm / glyphMm))
  const out: string[] = []
  for (const line of source) {
    if (line.length <= maxChars) {
      out.push(line)
      continue
    }
    let current = ''
    for (const word of line.split(/\s+/)) {
      if (!current) {
        current = word
        continue
      }
      if (current.length + 1 + word.length <= maxChars) {
        current = `${current} ${word}`
      } else {
        out.push(current)
        current = word
      }
    }
    if (current) out.push(current)
  }
  return out
}

export function renderLabelDocument(
  document: LabelDocument,
  source: LabelRenderSource,
): RenderedLabel {
  const { data } = source
  const primitives: LabelPrimitive[] = []
  const violations: LabelGuardViolation[] = []

  const visible = [...(document.elements ?? [])]
    .filter((element) => element.visible !== false)
    .sort((left, right) => left.z - right.z)

  for (const element of visible) {
    const rect: RectMm = {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    }

    if (element.type === 'barcode') {
      // DEĞER ŞABLONDAN GELMEZ: kimlik taşıyıcıdan okunur.
      const value = String(data.barcodeValue ?? data.mainBarcodeValue ?? '')
      primitives.push({
        kind: 'barcode',
        elementId: element.id,
        type: 'barcode',
        rect,
        value,
        humanReadable:
          element.showHumanReadable === false
            ? null
            : String(data.tNo || data.trackingNumber || value || ''),
        fontSizePt: element.fontSize ?? 8,
      })
      continue
    }
    if (element.type === 'qr') {
      primitives.push({
        kind: 'qr',
        elementId: element.id,
        type: 'qr',
        rect,
        value: String(data.qrPayload ?? data.barcodeValue ?? ''),
      })
      continue
    }

    const fontSizePt = element.fontSize ?? DEFAULT_FONT_PT
    const lineHeight = element.lineHeight ?? DEFAULT_LINE_HEIGHT
    const raw = resolveElementContent(element, source)
    const wrapped = wrapLines(raw, rect.width, fontSizePt, element.wrap !== false)
    const lineHeightMm = ptToMm(fontSizePt) * lineHeight
    // Kutuya kaç satır sığar? `maxLines` verilmişse o da üst sınırdır.
    const fitLines = Math.max(1, Math.floor(rect.height / lineHeightMm))
    const limit = element.maxLines
      ? Math.min(element.maxLines, fitLines)
      : fitLines
    const lines = wrapped.slice(0, limit)
    const truncated = wrapped.length > lines.length

    primitives.push({
      kind: 'text',
      elementId: element.id,
      type: element.type,
      rect,
      lines,
      fontSizePt,
      bold: element.bold === true,
      align: element.align ?? 'left',
      lineHeight,
      truncated,
      contentHeightMm: lines.length * lineHeightMm,
    })
  }

  // ═══ MUHAFIZLAR ════════════════════════════════════════════════════════
  for (const primitive of primitives) {
    if (!rectWithinCanvas(primitive.rect)) {
      // YERLEŞİM hatası: veriden bağımsız, her baskıda bozuk.
      violations.push({
        code: 'PRINT_BOUNDS_GUARD',
        elementId: primitive.elementId,
        detail: 'Öğe etiket alanının dışına taşıyor; baskıda kesilir.',
        blocking: true,
      })
    }
    if (
      primitive.kind === 'text' &&
      primitive.contentHeightMm > primitive.rect.height + 0.001
    ) {
      violations.push({
        code: 'PRINT_BOUNDS_GUARD',
        elementId: primitive.elementId,
        detail: 'Metin kutu yüksekliğini aşıyor.',
        blocking: false,
      })
    }
    if (primitive.kind === 'text' && primitive.truncated) {
      violations.push({
        code:
          primitive.type === 'address'
            ? 'LONG_ADDRESS_OVERFLOW_GUARD'
            : 'PRINT_BOUNDS_GUARD',
        elementId: primitive.elementId,
        detail:
          'İçerik kutuya sığmıyor. Kutuyu büyütün veya puntoyu düşürün — ' +
          'otomatik küçültme UYGULANMAZ (sessiz kırpma yok).',
        blocking: false,
      })
    }
  }

  // Barkod ve QR üzerine hiçbir şey BİNEMEZ: okunamayan kimlik = kayıp paket.
  for (const primitive of primitives) {
    if (primitive.kind !== 'barcode' && primitive.kind !== 'qr') continue
    for (const other of primitives) {
      if (other.elementId === primitive.elementId) continue
      if (!rectsOverlap(primitive.rect, other.rect)) continue
      violations.push({
        code:
          primitive.kind === 'barcode'
            ? 'BARCODE_OVERLAP_GUARD'
            : 'QR_OVERLAP_GUARD',
        elementId: primitive.elementId,
        detail: `Başka bir öğe (${other.elementId}) kimlik alanının üzerine biniyor.`,
        // Okunamayan kimlik = kaybolmuş paket. YAYINLANAMAZ.
        blocking: true,
      })
    }
  }

  return {
    primitives,
    violations,
    printable: violations.length === 0,
    hasBlockingViolation: violations.some((violation) => violation.blocking),
  }
}

/** Kilitli öğe mi? Düzenleyici bunu içerik alanlarını kapatmak için kullanır. */
export function elementContentEditable(type: LabelElementType): boolean {
  return !isIdentityLocked(type) && type === 'staticText'
}
