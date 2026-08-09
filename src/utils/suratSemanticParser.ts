// GERÇEK SÜRAT ŞABLONU — SEMANTIC PARSER.
//
// Kaynak sözleşme: server/fixtures/real-template-masked.zpl (RT-6 alan haritası).
// Şablon, taşıyıcı tarafından SABİT koordinat/font ile üretilir. Bu parser o
// haritayı kilitler: her semantic alan tam olarak BİR ZPL alanına, beklenen
// komut ailesi ve font imzasıyla eşlenmelidir.
//
// GÜVENLİK KURALI: belirsizlik = DESTEKLENMİYOR. Bir slot birden çok alana
// uyuyorsa, koordinat tutup font tutmuyorsa veya kritik slot yoksa model
// `supported: false` döner ve composer ÇALIŞMAZ (fail-safe, AŞAMA 3).
//
// Parser hiçbir zaman veri ÜRETMEZ; yalnız kaynakta yazılı olanı okur.

import {
  collectZplFields,
  decodeFieldHex,
  parseZplDocument,
  type ZplDocument,
  type ZplField,
  type ZplFieldKind,
  type ZplOrientation,
} from './zplCommandModel.ts'

export interface SuratFontSignature {
  readonly fontId: string
  readonly orientation: ZplOrientation
  readonly height: number
  readonly width: number
  readonly fontName?: string
}

interface SuratSlotSpec {
  readonly key: SuratSemanticKey
  readonly label: string
  readonly x: number
  readonly y: number
  readonly kind: ZplFieldKind
  readonly font?: SuratFontSignature
  /** Kaynakta HER ZAMAN boş olması beklenen slot (bold adres bölgesi). */
  readonly mustBeEmpty?: boolean
}

export type SuratSemanticKey =
  | 'branch'
  | 'tNo'
  | 'sender'
  | 'senderInvoice'
  | 'senderPhone'
  | 'code128Payload'
  | 'recipient'
  | 'addressLine1'
  | 'addressLine2'
  | 'recipientPhone'
  | 'cityDistrict'
  | 'paymentType'
  | 'unit'
  | 'desiKg'
  | 'parcelCount'
  | 'deliveryType'
  | 'routeCode'
  | 'transferCenter'
  | 'orderReference'
  | 'dataMatrixPayload'

const TEXT_FONT = (
  height: number,
  width: number,
  orientation: ZplOrientation = 'N',
): SuratFontSignature => ({ fontId: '0', orientation, height, width })

const ADDRESS_FONT: SuratFontSignature = {
  fontId: '@',
  orientation: 'N',
  height: 15,
  width: 10,
  fontName: 'TT0003M_',
}

/** Gerçek şablonun 20 semantic alanı — RT-6 haritasıyla BİREBİR. */
const SLOTS: readonly SuratSlotSpec[] = [
  { key: 'branch', label: 'şube', x: 113, y: 78, kind: 'text', font: TEXT_FONT(28, 28) },
  { key: 'tNo', label: 'T.No', x: 514, y: 79, kind: 'text', font: TEXT_FONT(28, 28) },
  { key: 'sender', label: 'gönderici', x: 53, y: 106, kind: 'text', font: TEXT_FONT(20, 28) },
  { key: 'senderInvoice', label: 'gönderici irsaliye', x: 54, y: 129, kind: 'text', font: TEXT_FONT(17, 24) },
  { key: 'senderPhone', label: 'gönderici tel', x: 487, y: 150, kind: 'text', font: TEXT_FONT(17, 24) },
  { key: 'code128Payload', label: 'Code128', x: 48, y: 300, kind: 'code128' },
  { key: 'recipient', label: 'alıcı', x: 63, y: 354, kind: 'text', font: TEXT_FONT(18, 25) },
  { key: 'addressLine1', label: 'adres 1', x: 63, y: 376, kind: 'text', font: ADDRESS_FONT },
  { key: 'addressLine2', label: 'adres 2', x: 63, y: 396, kind: 'text', font: ADDRESS_FONT },
  { key: 'recipientPhone', label: 'alıcı tel', x: 115, y: 470, kind: 'text', font: TEXT_FONT(18, 20) },
  { key: 'cityDistrict', label: 'il/ilçe', x: 507, y: 470, kind: 'text', font: TEXT_FONT(22, 22) },
  { key: 'paymentType', label: 'ödeme tipi', x: 63, y: 531, kind: 'text', font: TEXT_FONT(32, 31) },
  { key: 'unit', label: 'birim', x: 184, y: 531, kind: 'text', font: TEXT_FONT(25, 42) },
  { key: 'desiKg', label: 'desi', x: 340, y: 530, kind: 'text', font: TEXT_FONT(25, 50) },
  { key: 'parcelCount', label: 'parça adedi', x: 220, y: 602, kind: 'text', font: TEXT_FONT(44, 62) },
  { key: 'deliveryType', label: 'teslim tipi', x: 340, y: 599, kind: 'text', font: TEXT_FONT(35, 33) },
  { key: 'routeCode', label: 'rota', x: 220, y: 636, kind: 'text', font: TEXT_FONT(44, 52) },
  { key: 'transferCenter', label: 'aktarma merkezi', x: 220, y: 705, kind: 'text', font: TEXT_FONT(70, 50) },
  { key: 'orderReference', label: 'dikey sipariş no', x: 25, y: 706, kind: 'text', font: TEXT_FONT(20, 28, 'B') },
  { key: 'dataMatrixPayload', label: 'DataMatrix', x: 59, y: 706, kind: 'datamatrix' },
]

/** Bold adres tekrarının yazılacağı, kaynakta BOŞ olan taşıyıcı slotları. */
const BOLD_ADDRESS_SLOTS: readonly SuratSlotSpec[] = [
  { key: 'addressLine1', label: 'bold adres 1', x: 63, y: 417, kind: 'text', font: TEXT_FONT(15, 25), mustBeEmpty: true },
  { key: 'addressLine2', label: 'bold adres 2', x: 63, y: 433, kind: 'text', font: TEXT_FONT(15, 25), mustBeEmpty: true },
  { key: 'addressLine1', label: 'bold adres 3', x: 63, y: 449, kind: 'text', font: TEXT_FONT(15, 25), mustBeEmpty: true },
]

/** Alıcı kutusunun alt çizgisi — bold adres bölgesinin fiziksel tavanı. */
export const RECIPIENT_BOX_BOTTOM = 476

/** Bold adres slot koordinatları (y), kaynaktaki sırasıyla. */
export const BOLD_ADDRESS_BASELINES: readonly number[] = [417, 433, 449]
export const BOLD_ADDRESS_X = 63

export interface SuratSemanticField {
  readonly key: SuratSemanticKey
  readonly label: string
  readonly x: number
  readonly y: number
  /** `^FD` gövdesi HAM haliyle — çıktı karşılaştırmalarında bu kullanılır. */
  readonly raw: string
  /** `^FH` kaçışları çözülmüş okunabilir metin (yalnız uzunluk/analiz için). */
  readonly text: string
  readonly empty: boolean
  readonly field: ZplField
}

export interface SuratSemanticModel {
  readonly supported: boolean
  readonly reason: string | null
  readonly document: ZplDocument
  readonly zplFields: readonly ZplField[]
  readonly fields: Readonly<Partial<Record<SuratSemanticKey, SuratSemanticField>>>
  /** Kaynaktaki dolu adres satırları (sırayla). */
  readonly addressLines: readonly SuratSemanticField[]
  /** Bold adres için ayrılmış boş slotlar (üçü de bulunduysa 3 eleman). */
  readonly boldAddressSlots: readonly ZplField[]
  /** Şablon parmak izi — destek kararının makine-okunur özeti. */
  readonly fingerprint: string
  readonly printWidth: number
  readonly labelLength: number
}

function fontMatches(field: ZplField, expected: SuratFontSignature): boolean {
  const font = field.font
  if (!font) return false
  if (font.fontId !== expected.fontId) return false
  // Yön açıkça yazılmamışsa şablon `^FW` yürürlüktedir; gerçek şablonda her
  // font komutu yönü AÇIKÇA yazar, bu yüzden eksik yön = uyumsuzluk.
  if (font.orientation !== expected.orientation) return false
  if (font.height !== expected.height) return false
  if (font.width !== expected.width) return false
  if (expected.fontName !== undefined && font.fontName !== expected.fontName) return false
  return true
}

function locate(
  fields: readonly ZplField[],
  slot: SuratSlotSpec,
): { field: ZplField } | { error: string } {
  const atPosition = fields.filter(
    (field) => field.positionType === 'FT' && field.x === slot.x && field.y === slot.y,
  )
  if (atPosition.length === 0) {
    return { error: `${slot.label} slotu yok (^FT${slot.x},${slot.y})` }
  }
  if (atPosition.length > 1) {
    return { error: `${slot.label} slotu BELİRSİZ (^FT${slot.x},${slot.y} ${atPosition.length} kez)` }
  }
  const [field] = atPosition
  if (field.kind !== slot.kind) {
    return { error: `${slot.label} beklenen komut ailesi değil (${field.kind} ≠ ${slot.kind})` }
  }
  if (slot.font && !fontMatches(field, slot.font)) {
    return { error: `${slot.label} font imzası uyuşmuyor (^${slot.x},${slot.y})` }
  }
  if (slot.kind !== 'graphic' && field.dataCommand === null) {
    return { error: `${slot.label} alanında ^FD yok` }
  }
  return { field }
}

export interface SuratFieldExtraction {
  readonly fields: Readonly<Partial<Record<SuratSemanticKey, SuratSemanticField>>>
  readonly errors: readonly string[]
}

/**
 * 20 semantic slotu İSKELET SAYIMI YAPMADAN çözer.
 *
 * Composed çıktı, kaynağa göre fazladan komut taşır (^BQ, ek metin alanları);
 * bu yüzden `^FD`/`^BQ` sayımı gibi iskelet kontrolleri çıktı üzerinde
 * ANLAMSIZDIR. Invariant doğrulaması yalnız slotların yerinde, tek ve aynı
 * gövdeyle durduğunu sorar — bunu bu fonksiyon sağlar.
 */
export interface SuratFieldExpectations {
  /**
   * Aktarma merkezi metninin BEKLENEN font genişliği.
   *
   * Composed çıktıda bu genişlik, sağ kolona QR sığdırmak için kaynağa göre
   * DARALTILMIŞ olabilir (transform whitelist madde 5). Doğrulayıcı beklenen
   * değeri bilmezse kendi bilinçli dönüşümümüzü "font imzası uyuşmuyor" diye
   * reddeder. Verilmezse kaynaktaki özgün genişlik beklenir.
   */
  readonly transferFontWidth?: number
}

export function extractSuratSemanticFields(
  zpl: string,
  expectations: SuratFieldExpectations = {},
): SuratFieldExtraction {
  return extractFromZplFields(
    collectZplFields(parseZplDocument(zpl)),
    expectations,
  )
}

/**
 * Slot çözümünün çekirdeği. ÖNEMLİ: çağıran kendi `ZplField` listesini verir,
 * böylece dönen `field` referansları ÇAĞIRANIN belgesine aittir — composer
 * düzenlemeleri komut kimliğiyle hedeflediği için bu şarttır.
 */
function extractFromZplFields(
  zplFields: readonly ZplField[],
  expectations: SuratFieldExpectations = {},
): SuratFieldExtraction {
  const fields: Partial<Record<SuratSemanticKey, SuratSemanticField>> = {}
  const errors: string[] = []
  for (const baseSlot of SLOTS) {
    // Yalnız BEKLENTİ değişir; koordinat, komut ailesi ve gövde kontrolü aynı.
    const slot: SuratSlotSpec =
      baseSlot.key === 'transferCenter' &&
      expectations.transferFontWidth !== undefined &&
      baseSlot.font
        ? { ...baseSlot, font: { ...baseSlot.font, width: expectations.transferFontWidth } }
        : baseSlot
    const found = locate(zplFields, slot)
    if ('error' in found) {
      errors.push(found.error)
      continue
    }
    const raw = found.field.data ?? ''
    fields[slot.key] = {
      key: slot.key,
      label: slot.label,
      x: slot.x,
      y: slot.y,
      raw,
      text: decodeFieldHex(raw),
      empty: raw.trim() === '',
      field: found.field,
    }
  }
  return { fields, errors }
}

function unsupported(
  reason: string,
  document: ZplDocument,
  zplFields: readonly ZplField[],
  printWidth: number,
  labelLength: number,
): SuratSemanticModel {
  return {
    supported: false,
    reason,
    document,
    zplFields,
    fields: {},
    addressLines: [],
    boldAddressSlots: [],
    fingerprint: 'unsupported',
    printWidth,
    labelLength,
  }
}

function readDimension(document: ZplDocument, name: string): number {
  const command = document.commands.find((entry) => entry.name === name)
  if (!command) return 0
  const value = Number.parseInt(command.args.replace(/[^0-9].*$/, ''), 10)
  return Number.isFinite(value) ? value : 0
}

/**
 * Gerçek Sürat şablonunu semantic modele çevirir.
 * Herhangi bir kritik belirsizlikte `supported: false` döner.
 */
export function resolveSuratSemanticModel(zpl: string): SuratSemanticModel {
  const document = parseZplDocument(zpl)
  const zplFields = collectZplFields(document)
  const printWidth = readDimension(document, 'PW')
  const labelLength = readDimension(document, 'LL')

  const fail = (reason: string): SuratSemanticModel =>
    unsupported(reason, document, zplFields, printWidth, labelLength)

  // ── İskelet sözleşmesi ────────────────────────────────────────────────
  const count = (name: string): number =>
    document.commands.reduce((total, entry) => total + (entry.name === name ? 1 : 0), 0)
  if (count('XA') !== 1 || count('XZ') !== 1) return fail('tek etiket değil (^XA/^XZ)')
  if (printWidth !== 799) return fail(`beklenmeyen ^PW (${printWidth})`)
  if (labelLength !== 799) return fail(`beklenmeyen ^LL (${labelLength})`)
  if (count('GB') !== 9) return fail(`beklenmeyen çizgi sayısı (^GB ${count('GB')})`)
  if (count('BC') !== 1) return fail(`beklenmeyen Code128 sayısı (^BC ${count('BC')})`)
  if (count('BX') !== 1) return fail(`beklenmeyen DataMatrix sayısı (^BX ${count('BX')})`)
  if (count('BQ') !== 0) return fail(`kaynakta beklenmeyen QR var (^BQ ${count('BQ')})`)

  // ── 20 semantic alan ──────────────────────────────────────────────────
  const extraction = extractFromZplFields(zplFields)
  if (extraction.errors.length > 0) return fail(extraction.errors[0])
  const fields = extraction.fields

  // ── Composer'ın VERİ olarak bağımlı olduğu alanlar ────────────────────
  if (fields.code128Payload?.empty !== false) {
    return fail('Code128 gövdesi boş')
  }
  const addressLines = [fields.addressLine1, fields.addressLine2].filter(
    (entry): entry is SuratSemanticField => Boolean(entry) && !entry!.empty,
  )
  if (addressLines.length === 0) return fail('kaynakta adres satırı yok')

  // ── Bold adres bölgesi: üç slot da var ve BOŞ olmalı ──────────────────
  const boldAddressSlots: ZplField[] = []
  for (const slot of BOLD_ADDRESS_SLOTS) {
    const found = locate(zplFields, slot)
    if ('error' in found) return fail(found.error)
    if ((found.field.data ?? '').trim() !== '') {
      return fail(`${slot.label} slotu kaynakta DOLU — yazılamaz`)
    }
    boldAddressSlots.push(found.field)
  }

  const fingerprint = [
    'surat-real-v1',
    `pw${printWidth}`,
    `ll${labelLength}`,
    `gb${count('GB')}`,
    `bc${count('BC')}`,
    `bx${count('BX')}`,
    `fd${count('FD')}`,
    `slots${SLOTS.length}`,
    `bold${boldAddressSlots.length}`,
  ].join('.')

  return {
    supported: true,
    reason: null,
    document,
    zplFields,
    fields,
    addressLines,
    boldAddressSlots,
    fingerprint,
    printWidth,
    labelLength,
  }
}

/** Şablon parmak izinin composer tarafından desteklenen sabit değeri. */
export const SUPPORTED_TEMPLATE_FINGERPRINT =
  'surat-real-v1.pw799.ll799.gb9.bc1.bx1.fd38.slots20.bold3'
