// ETİKET BELGESİ — KANONİK, SÜRÜMLÜ, GEOMETRİK ŞABLON MODELİ.
//
// ═══ NEDEN YENİ BİR MODEL ════════════════════════════════════════════════
// Mevcut kiracı şablonu (`LabelFieldConfig`) bir AKIŞ modelidir: blok aç/kapa,
// sırala, punto ver, üst/alt yerleşim seç. Bu model "adresi 4 mm sola al" veya
// "barkodu sağ üste taşı" sorusunu YANITLAYAMAZ — koordinat taşımaz.
//
// Bu modül, CargoFlow'un KENDİ bastığı 10×10 cm HTML etiketi için gerçek bir
// yerleşim belgesi tanımlar: her öğe kararlı bir kimlik ve FİZİKSEL koordinat
// taşır.
//
// ═══ NEDEN MİLİMETRE ═════════════════════════════════════════════════════
// Piksel, tarayıcı yakınlaştırmasına ve ekran DPI'ına bağlıdır. Aynı belge
// hem ekranda hem 203 dpi termal yazıcıda AYNI fiziksel yeri göstermelidir.
// Bu yüzden kanonik birim MİLİMETREDİR; piksel ve dot yalnız TÜRETİLİR
// (bkz. `labelGeometry`).
//
// ═══ KİMLİK DOKUNULMAZ ═══════════════════════════════════════════════════
// Kiracı SUNUMU değiştirir, KİMLİĞİ değil. Barkodun DEĞERİ, QR yükü ve takip
// numarası şablondan gelemez: yanlış barkod, yanlış paketi taşıyan bir etiket
// demektir. Doğrulama bunu FAIL-CLOSED uygular.
//
// SAF: ağ yok, DOM yok, DB yok, rastgelelik yok.

import {
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
  MIN_BARCODE_HEIGHT_MM,
  MIN_BARCODE_WIDTH_MM,
  MIN_ELEMENT_SIZE_MM,
  MIN_QR_SIZE_MM,
} from './labelGeometry.ts'

/** Beyaz liste. Bu kümenin DIŞINDA hiçbir öğe belgeye giremez. */
export const LABEL_ELEMENT_TYPES = [
  'recipientName',
  'buyerName',
  'address',
  'cityDistrict',
  'phone',
  'orderNumber',
  'packageId',
  'orderDate',
  'orderTime',
  'marketplace',
  'trackingText',
  'barcode',
  'qr',
  'productList',
  'cargoMeta',
  'staticText',
] as const

export type LabelElementType = (typeof LABEL_ELEMENT_TYPES)[number]

/**
 * DEĞERİ KİLİTLİ öğeler.
 *
 * Konum/boyut/görünürlük (izin verilen ölçüde) değiştirilebilir; İÇERİK
 * taşıyıcı/pazaryeri kimliğinden gelir ve kiracı tarafından DEĞİŞTİRİLEMEZ.
 */
export const IDENTITY_LOCKED_ELEMENTS: readonly LabelElementType[] = [
  'barcode',
  'qr',
  'trackingText',
]

/** Etiketten KALDIRILAMAZ öğeler — güvenli teslimat için zorunlu. */
export const REQUIRED_ELEMENTS: readonly LabelElementType[] = [
  'barcode',
  'recipientName',
  'address',
]

/** Serbest metin YALNIZ bu türde taşınır. */
export const FREE_TEXT_ELEMENTS: readonly LabelElementType[] = ['staticText']

export const ELEMENT_ALIGNMENTS = ['left', 'center', 'right'] as const
export type LabelElementAlign = (typeof ELEMENT_ALIGNMENTS)[number]

/** Okunabilirlik tabanı — bunun altına inen punto KABUL EDİLMEZ. */
export const MIN_FONT_PT = 5
export const MAX_FONT_PT = 48
export const MIN_LINE_HEIGHT = 0.8
export const MAX_LINE_HEIGHT = 2.5

export interface LabelElement {
  /** Kararlı kimlik — geri al/yinele ve seçim bu kimliğe dayanır. */
  id: string
  type: LabelElementType
  /** Kanonik geometri: milimetre, etiketin SOL ÜST köşesinden. */
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  /** Çizim sırası (büyük olan üstte). */
  z: number
  fontSize?: number
  bold?: boolean
  align?: LabelElementAlign
  lineHeight?: number
  wrap?: boolean
  maxLines?: number
  /** YALNIZ `staticText`. */
  text?: string
  /** YALNIZ `barcode`: insan okunur metin gösterilsin mi? */
  showHumanReadable?: boolean
}

export interface LabelDocument {
  schemaVersion: 1
  id: string
  name: string
  /** Türetildiği sistem şablonu (varsa) — yalnız bilgi amaçlı. */
  basedOn?: string
  elements: LabelElement[]
}

export const LABEL_DOCUMENT_SCHEMA_VERSION = 1

export const DOCUMENT_VALIDATION_CODES = [
  'UNKNOWN_ELEMENT',
  'DUPLICATE_ELEMENT_ID',
  'REQUIRED_ELEMENT_HIDDEN',
  'REQUIRED_ELEMENT_MISSING',
  'LOCKED_ELEMENT_TEXT_OVERRIDE',
  'TEXT_ON_NON_TEXT_ELEMENT',
  'INVALID_NUMBER',
  'INVALID_ALIGN',
  'OUT_OF_BOUNDS',
  'BELOW_MIN_SIZE',
  'FONT_OUT_OF_RANGE',
  'SCHEMA_VERSION',
] as const

export type DocumentValidationCode = (typeof DOCUMENT_VALIDATION_CODES)[number]

export interface DocumentValidation {
  valid: boolean
  errors: Array<{
    code: DocumentValidationCode
    elementId?: string
    type?: string
    detail: string
  }>
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function minSizeFor(type: LabelElementType): { width: number; height: number } {
  if (type === 'barcode') {
    return { width: MIN_BARCODE_WIDTH_MM, height: MIN_BARCODE_HEIGHT_MM }
  }
  if (type === 'qr') return { width: MIN_QR_SIZE_MM, height: MIN_QR_SIZE_MM }
  return { width: MIN_ELEMENT_SIZE_MM, height: MIN_ELEMENT_SIZE_MM }
}

/**
 * Belge doğrulama — FAIL-CLOSED.
 *
 * Kaydedilemeyen bir şablon, basılamayan (veya YANLIŞ basılan) bir etiketten
 * iyidir. Bilinmeyen öğe, kilitli öğeye metin yazma, zorunlu öğeyi gizleme,
 * tuvali taşma ve okunamayacak kadar küçük barkod KABUL EDİLMEZ.
 */
export function validateLabelDocument(
  document: LabelDocument | null | undefined,
): DocumentValidation {
  const errors: DocumentValidation['errors'] = []
  if (!document || document.schemaVersion !== LABEL_DOCUMENT_SCHEMA_VERSION) {
    errors.push({
      code: 'SCHEMA_VERSION',
      detail: 'Desteklenmeyen şablon sürümü.',
    })
    return { valid: false, errors }
  }

  const seenIds = new Set<string>()
  const presentTypes = new Set<string>()

  for (const element of document.elements ?? []) {
    const type = String(element?.type ?? '')
    if (!(LABEL_ELEMENT_TYPES as readonly string[]).includes(type)) {
      errors.push({
        code: 'UNKNOWN_ELEMENT',
        type,
        detail: 'Beyaz listede olmayan öğe; rasgele alan yolu KABUL EDİLMEZ.',
      })
      continue
    }
    const elementType = type as LabelElementType
    presentTypes.add(elementType)

    const id = String(element.id ?? '')
    if (!id) {
      errors.push({
        code: 'DUPLICATE_ELEMENT_ID',
        type,
        detail: 'Öğe kimliği boş olamaz.',
      })
    } else if (seenIds.has(id)) {
      errors.push({
        code: 'DUPLICATE_ELEMENT_ID',
        elementId: id,
        detail: 'Öğe kimliği tekrar edildi.',
      })
    }
    seenIds.add(id)

    if (
      element.text !== undefined &&
      (IDENTITY_LOCKED_ELEMENTS as readonly string[]).includes(elementType)
    ) {
      errors.push({
        code: 'LOCKED_ELEMENT_TEXT_OVERRIDE',
        elementId: id,
        detail: 'Taşıyıcı kimlik öğesinin değeri değiştirilemez.',
      })
    }
    if (
      element.text !== undefined &&
      !(FREE_TEXT_ELEMENTS as readonly string[]).includes(elementType)
    ) {
      errors.push({
        code: 'TEXT_ON_NON_TEXT_ELEMENT',
        elementId: id,
        detail: 'Bu öğe serbest metin taşımaz.',
      })
    }

    for (const field of ['x', 'y', 'width', 'height', 'z'] as const) {
      if (!isFiniteNonNegative(element[field])) {
        errors.push({
          code: 'INVALID_NUMBER',
          elementId: id,
          detail: `${field} sayısal ve negatif olmayan olmalı.`,
        })
      }
    }

    if (
      element.align !== undefined &&
      !(ELEMENT_ALIGNMENTS as readonly string[]).includes(element.align)
    ) {
      errors.push({
        code: 'INVALID_ALIGN',
        elementId: id,
        detail: 'Geçersiz hizalama.',
      })
    }

    if (element.fontSize !== undefined) {
      if (
        typeof element.fontSize !== 'number' ||
        !Number.isFinite(element.fontSize) ||
        element.fontSize < MIN_FONT_PT ||
        element.fontSize > MAX_FONT_PT
      ) {
        errors.push({
          code: 'FONT_OUT_OF_RANGE',
          elementId: id,
          detail: `Punto ${MIN_FONT_PT}–${MAX_FONT_PT} aralığında olmalı.`,
        })
      }
    }
    if (element.lineHeight !== undefined) {
      if (
        typeof element.lineHeight !== 'number' ||
        !Number.isFinite(element.lineHeight) ||
        element.lineHeight < MIN_LINE_HEIGHT ||
        element.lineHeight > MAX_LINE_HEIGHT
      ) {
        errors.push({
          code: 'INVALID_NUMBER',
          elementId: id,
          detail: 'Satır yüksekliği geçersiz.',
        })
      }
    }

    // Tuval sınırları — taşan öğe baskıda KESİLİR.
    if (
      isFiniteNonNegative(element.x) &&
      isFiniteNonNegative(element.width) &&
      element.x + element.width > LABEL_CANVAS_WIDTH_MM + 0.001
    ) {
      errors.push({
        code: 'OUT_OF_BOUNDS',
        elementId: id,
        detail: 'Öğe etiketin sağ kenarını aşıyor.',
      })
    }
    if (
      isFiniteNonNegative(element.y) &&
      isFiniteNonNegative(element.height) &&
      element.y + element.height > LABEL_CANVAS_HEIGHT_MM + 0.001
    ) {
      errors.push({
        code: 'OUT_OF_BOUNDS',
        elementId: id,
        detail: 'Öğe etiketin alt kenarını aşıyor.',
      })
    }

    // Okunabilir asgari ölçü — otomatik küçültme YOK, açık hata VAR.
    const min = minSizeFor(elementType)
    if (element.visible !== false) {
      if (isFiniteNonNegative(element.width) && element.width < min.width) {
        errors.push({
          code: 'BELOW_MIN_SIZE',
          elementId: id,
          detail: `Genişlik en az ${min.width} mm olmalı (okunabilirlik).`,
        })
      }
      if (isFiniteNonNegative(element.height) && element.height < min.height) {
        errors.push({
          code: 'BELOW_MIN_SIZE',
          elementId: id,
          detail: `Yükseklik en az ${min.height} mm olmalı (okunabilirlik).`,
        })
      }
    }
  }

  for (const required of REQUIRED_ELEMENTS) {
    const element = (document.elements ?? []).find(
      (item) => item?.type === required,
    )
    if (!element) {
      errors.push({
        code: 'REQUIRED_ELEMENT_MISSING',
        type: required,
        detail: 'Güvenli teslimat için zorunlu öğe şablonda yok.',
      })
      continue
    }
    if (element.visible === false) {
      errors.push({
        code: 'REQUIRED_ELEMENT_HIDDEN',
        elementId: element.id,
        type: required,
        detail: 'Güvenli teslimat için zorunlu öğe gizlenemez.',
      })
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Güvenli normalizasyon.
 *
 * Kiracının yapılandıramadığı her anahtar ATILIR: bozuk veya kötü niyetli bir
 * istemci gövdesi barkod/QR/takip öğesine bir DEĞER yazamaz. Geometri tuvale
 * KENETLENİR (clamp) — dışarıda öğe DOĞMAZ.
 */
export function normalizeLabelDocument(input: unknown): LabelDocument | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const rawElements = Array.isArray(record.elements) ? record.elements : []
  const elements: LabelElement[] = []
  const seen = new Set<string>()

  for (const [index, raw] of rawElements.entries()) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const type = String(entry.type ?? '')
    if (!(LABEL_ELEMENT_TYPES as readonly string[]).includes(type)) continue
    const elementType = type as LabelElementType
    let id = String(entry.id ?? '').trim() || `${elementType}-${index}`
    while (seen.has(id)) id = `${id}-${index}`
    seen.add(id)

    const num = (value: unknown, fallback: number): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const min = minSizeFor(elementType)
    const width = Math.min(
      LABEL_CANVAS_WIDTH_MM,
      Math.max(min.width, num(entry.width, min.width)),
    )
    const height = Math.min(
      LABEL_CANVAS_HEIGHT_MM,
      Math.max(min.height, num(entry.height, min.height)),
    )
    const x = Math.min(
      LABEL_CANVAS_WIDTH_MM - width,
      Math.max(0, num(entry.x, 0)),
    )
    const y = Math.min(
      LABEL_CANVAS_HEIGHT_MM - height,
      Math.max(0, num(entry.y, 0)),
    )

    const element: LabelElement = {
      id,
      type: elementType,
      x: round2(x),
      y: round2(y),
      width: round2(width),
      height: round2(height),
      // Zorunlu öğeler gizlenemez: bozuk gövde onları kapatamaz.
      visible: (REQUIRED_ELEMENTS as readonly string[]).includes(elementType)
        ? true
        : entry.visible !== false,
      z: Math.max(0, Math.trunc(num(entry.z, index))),
    }
    if (entry.fontSize !== undefined) {
      element.fontSize = clamp(num(entry.fontSize, 9), MIN_FONT_PT, MAX_FONT_PT)
    }
    if (entry.bold !== undefined) element.bold = entry.bold === true
    if (
      typeof entry.align === 'string' &&
      (ELEMENT_ALIGNMENTS as readonly string[]).includes(entry.align)
    ) {
      element.align = entry.align as LabelElementAlign
    }
    if (entry.lineHeight !== undefined) {
      element.lineHeight = clamp(
        num(entry.lineHeight, 1.2),
        MIN_LINE_HEIGHT,
        MAX_LINE_HEIGHT,
      )
    }
    if (entry.wrap !== undefined) element.wrap = entry.wrap !== false
    if (entry.maxLines !== undefined) {
      element.maxLines = Math.max(1, Math.trunc(num(entry.maxLines, 1)))
    }
    // Serbest metin YALNIZ metin öğesinde; kilitli öğede SESSİZCE ATILIR.
    if (
      typeof entry.text === 'string' &&
      (FREE_TEXT_ELEMENTS as readonly string[]).includes(elementType)
    ) {
      element.text = entry.text.slice(0, 240)
    }
    if (elementType === 'barcode' && entry.showHumanReadable !== undefined) {
      element.showHumanReadable = entry.showHumanReadable !== false
    }
    elements.push(element)
  }

  return {
    schemaVersion: LABEL_DOCUMENT_SCHEMA_VERSION,
    id: String(record.id ?? '').trim() || 'custom',
    name: String(record.name ?? '').trim().slice(0, 80) || 'Özel şablon',
    basedOn:
      typeof record.basedOn === 'string' && record.basedOn.trim()
        ? record.basedOn.trim().slice(0, 80)
        : undefined,
    elements,
  }
}

export function isIdentityLocked(type: LabelElementType): boolean {
  return (IDENTITY_LOCKED_ELEMENTS as readonly string[]).includes(type)
}

export function isRequiredElement(type: LabelElementType): boolean {
  return (REQUIRED_ELEMENTS as readonly string[]).includes(type)
}

export function minimumSizeMm(type: LabelElementType): {
  width: number
  height: number
} {
  return minSizeFor(type)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
