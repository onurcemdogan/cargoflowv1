// ADRES BLOĞU — KİRACI SUNUMU, GÜVENLİ YERLEŞİM.
//
// ═══ NEDEN AYRI BİR MOTOR ════════════════════════════════════════════════
// Kiracı "adresi büyüt" diyebilmeli. Ama adres, taşıyıcı etiketinin en dar
// bandındadır: hemen altında rota kutusu, DataMatrix ve aktarma satırı
// vardır. Puntoyu körlemesine büyütmek, adresi makine-okunur alanların
// ÜZERİNE bindirir ve etiketi TARANAMAZ hâle getirir.
//
// Bu modül kararı GEOMETRİYE bağlar: metin sarılır, kutu ölçülür, engellerle
// kesişim aranır. Sığmıyorsa CEVAP HAYIRDIR ve sebebi söylenir.
//
// ═══ İKİ RENDER MODU ═════════════════════════════════════════════════════
//   RAW_SURAT_FALLBACK — taşıyıcı ZPL'i AYNEN basılır; bu motor DEVREDE
//                        DEĞİLDİR ve adres taşıyıcının fontuyla çıkar.
//   COMPOSED           — composer bandı bizimdir; adresin sunumunu bu motor
//                        belirler (taşıyıcının ^FD gövdesi BOŞALTILIR,
//                        komut yapısı YERİNDE kalır → deletions = 0).
//
// ═══ SESSİZ KIRPMA YOK ═══════════════════════════════════════════════════
// Satır sayısı aşılırsa metin KESİLMEZ; yerleşim REDDEDİLİR. Operatör
// düzenleyicide "bu boyutta adres etikete sığmıyor" uyarısını görür ve
// puntoyu/satırı kendisi azaltır.

import { estimateA0Width } from './suratDurusoftComposer.ts'

export type LabelRenderMode = 'RAW_SURAT_FALLBACK' | 'COMPOSED'

export type AddressAlignment = 'left' | 'center' | 'right'

/** Kiracının adres bloğu için verebileceği GÜVENLİ özellikler. */
export interface AddressBlockStyle {
  readonly visible?: boolean
  /** ZPL dot cinsinden yükseklik. */
  readonly fontSize?: number
  readonly bold?: boolean
  /** Satır yüksekliği çarpanı (1.0 = sıkı). */
  readonly lineHeight?: number
  /** En fazla kaç satır. Aşılırsa yerleşim REDDEDİLİR. */
  readonly maxLines?: number
  readonly wrap?: boolean
  /** Blok genişliği (dot). Verilmezse banda sığdırılır. */
  readonly width?: number
  readonly align?: AddressAlignment
}

export const ADDRESS_STYLE_LIMITS = {
  minFontSize: 12,
  maxFontSize: 48,
  minLineHeight: 1,
  maxLineHeight: 2,
  minMaxLines: 1,
  maxMaxLines: 6,
} as const

export const DEFAULT_ADDRESS_STYLE: Required<
  Pick<AddressBlockStyle, 'visible' | 'fontSize' | 'bold' | 'lineHeight' | 'maxLines' | 'wrap' | 'align'>
> = {
  visible: true,
  // Taşıyıcının bugünkü adres yüksekliği ile aynı — varsayılan çıktı DEĞİŞMEZ.
  fontSize: 16,
  bold: true,
  lineHeight: 1,
  maxLines: 3,
  wrap: true,
  align: 'left',
}

export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface AddressBand {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export interface AddressPlacement {
  readonly text: string
  readonly x: number
  /** ^FO üst kenarı. */
  readonly y: number
  readonly fontHeight: number
  readonly fontWidth: number
  readonly bold: boolean
}

export type AddressLayoutRejection =
  | 'ADDRESS_EMPTY'
  | 'TOO_MANY_LINES'
  | 'EXCEEDS_BAND_HEIGHT'
  | 'EXCEEDS_BAND_WIDTH'
  | 'OVERLAPS_PROTECTED_ELEMENT'

export interface AddressLayoutResult {
  readonly ok: boolean
  readonly placements: readonly AddressPlacement[]
  readonly bbox: Box | null
  readonly rejection: AddressLayoutRejection | null
  /** Operatöre gösterilecek Türkçe açıklama (PII İÇERMEZ). */
  readonly message: string | null
  readonly requiredHeight: number
  readonly availableHeight: number
  readonly lineCount: number
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/** Kiracı girdisini GÜVENLİ aralığa indirger. */
export function normalizeAddressStyle(
  style?: AddressBlockStyle | null,
): Required<Omit<AddressBlockStyle, 'width'>> & { width?: number } {
  const source = style ?? {}
  return {
    visible: source.visible !== false,
    fontSize: clamp(
      source.fontSize,
      ADDRESS_STYLE_LIMITS.minFontSize,
      ADDRESS_STYLE_LIMITS.maxFontSize,
      DEFAULT_ADDRESS_STYLE.fontSize,
    ),
    bold: source.bold ?? DEFAULT_ADDRESS_STYLE.bold,
    lineHeight: Math.min(
      ADDRESS_STYLE_LIMITS.maxLineHeight,
      Math.max(
        ADDRESS_STYLE_LIMITS.minLineHeight,
        Number(source.lineHeight) || DEFAULT_ADDRESS_STYLE.lineHeight,
      ),
    ),
    maxLines: clamp(
      source.maxLines,
      ADDRESS_STYLE_LIMITS.minMaxLines,
      ADDRESS_STYLE_LIMITS.maxMaxLines,
      DEFAULT_ADDRESS_STYLE.maxLines,
    ),
    wrap: source.wrap !== false,
    align: (['left', 'center', 'right'] as const).includes(
      source.align as AddressAlignment,
    )
      ? (source.align as AddressAlignment)
      : DEFAULT_ADDRESS_STYLE.align,
    ...(Number.isFinite(Number(source.width))
      ? { width: Math.max(1, Math.round(Number(source.width))) }
      : {}),
  }
}

/**
 * Metni verilen genişliğe KELİME sınırlarında sarar.
 *
 * Kırpma YOKTUR: tek bir kelime bile sığmıyorsa kendi satırına konur ve
 * genişlik aşımı çağırana RAPOR EDİLİR.
 */
export function wrapAddressText(
  lines: readonly string[],
  fontWidth: number,
  maxWidth: number,
  wrap: boolean,
): { lines: string[]; overflowWidth: boolean } {
  const out: string[] = []
  let overflowWidth = false
  for (const raw of lines) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (!wrap) {
      out.push(text)
      if (estimateA0Width(text, fontWidth) > maxWidth) overflowWidth = true
      continue
    }
    let current = ''
    for (const word of text.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`
      if (current !== '' && estimateA0Width(candidate, fontWidth) > maxWidth) {
        out.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    if (current !== '') {
      out.push(current)
      if (estimateA0Width(current, fontWidth) > maxWidth) overflowWidth = true
    }
  }
  return { lines: out, overflowWidth }
}

function intersects(a: Box, b: Box): boolean {
  return !(
    a.right <= b.left ||
    a.left >= b.right ||
    a.bottom <= b.top ||
    a.top >= b.bottom
  )
}

/**
 * Adres bloğunu banda yerleştirir.
 *
 * `protectedBoxes` — barkod, barkod insan metni, DataMatrix, QR, rota ve
 * aktarma gibi ZORUNLU taşıyıcı öğeleri. Adres bunların ÜZERİNE binemez;
 * binerse yerleşim reddedilir (etiket taranamaz hâle gelirdi).
 */
export function resolveAddressBlockLayout(params: {
  lines: readonly string[]
  style?: AddressBlockStyle | null
  band: AddressBand
  protectedBoxes?: readonly Box[]
}): AddressLayoutResult {
  const style = normalizeAddressStyle(params.style)
  const band = params.band
  const availableHeight = Math.max(0, band.bottom - band.top)
  const bandWidth = Math.max(0, band.right - band.left)
  const width = Math.min(style.width ?? bandWidth, bandWidth)

  const reject = (
    rejection: AddressLayoutRejection,
    message: string,
    requiredHeight = 0,
    lineCount = 0,
  ): AddressLayoutResult => ({
    ok: false,
    placements: [],
    bbox: null,
    rejection,
    message,
    requiredHeight,
    availableHeight,
    lineCount,
  })

  const source = params.lines.filter((line) => String(line ?? '').trim())
  if (source.length === 0) {
    return reject('ADDRESS_EMPTY', 'Adres verisi yok.')
  }

  // ^A0 genişliği yüksekliğe orantılıdır (Sürat şablonuyla tutarlı oran).
  const fontHeight = style.fontSize
  const fontWidth = Math.max(1, Math.round(fontHeight * 0.85))
  const wrapped = wrapAddressText(source, fontWidth, width, style.wrap)

  if (wrapped.overflowWidth) {
    return reject(
      'EXCEEDS_BAND_WIDTH',
      'Bu boyutta adres etiket genişliğine sığmıyor; puntoyu küçült.',
      0,
      wrapped.lines.length,
    )
  }
  if (wrapped.lines.length > style.maxLines) {
    return reject(
      'TOO_MANY_LINES',
      `Adres ${wrapped.lines.length} satır sürüyor; sınır ${style.maxLines}. `
        + 'Puntoyu küçült veya satır sınırını artır.',
      0,
      wrapped.lines.length,
    )
  }

  const lineStep = Math.round(fontHeight * style.lineHeight)
  const requiredHeight = wrapped.lines.length * lineStep
  if (requiredHeight > availableHeight) {
    return reject(
      'EXCEEDS_BAND_HEIGHT',
      'Bu boyutta adres etikete sığmıyor; puntoyu, satır sayısını veya '
        + 'satır aralığını azalt.',
      requiredHeight,
      wrapped.lines.length,
    )
  }

  const placements: AddressPlacement[] = wrapped.lines.map((text, index) => {
    const textWidth = estimateA0Width(text, fontWidth)
    const x =
      style.align === 'center'
        ? band.left + Math.max(0, Math.round((width - textWidth) / 2))
        : style.align === 'right'
          ? band.left + Math.max(0, width - textWidth)
          : band.left
    return {
      text,
      x,
      y: band.top + index * lineStep,
      fontHeight,
      fontWidth,
      bold: style.bold,
    }
  })

  const bbox: Box = {
    left: Math.min(...placements.map((line) => line.x)),
    top: band.top,
    right: Math.max(
      ...placements.map((line) => line.x + estimateA0Width(line.text, fontWidth)),
    ),
    bottom: band.top + requiredHeight,
  }

  for (const box of params.protectedBoxes ?? []) {
    if (intersects(bbox, box)) {
      return reject(
        'OVERLAPS_PROTECTED_ELEMENT',
        'Bu boyutta adres barkod/QR gibi zorunlu alanların üzerine biner; '
          + 'etiket taranamaz hâle gelir.',
        requiredHeight,
        wrapped.lines.length,
      )
    }
  }

  return {
    ok: true,
    placements,
    bbox,
    rejection: null,
    message: null,
    requiredHeight,
    availableHeight,
    lineCount: wrapped.lines.length,
  }
}

/** Yerleşimden ZPL üretir. Kalın = +1 dot ikinci vuruş (yeni font YOK). */
export function buildAddressZplCommands(
  layout: AddressLayoutResult,
  options: { escape: (value: string) => string },
): string[] {
  if (!layout.ok) return []
  const commands: string[] = []
  for (const line of layout.placements) {
    const data = options.escape(line.text)
    for (const offset of line.bold ? [0, 1] : [0]) {
      commands.push(
        `^FO${line.x + offset},${line.y}`
          + `^A0N,${line.fontHeight},${line.fontWidth}`
          + `^FD${data}^FS`,
      )
    }
  }
  return commands
}
