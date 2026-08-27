// KİRACI ETİKET ŞABLONU — BEYAZ LİSTELİ, KODSUZ.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// "Sipariş saatini göster", "alıcı adını altta büyük yaz", "SKU'yu gizle"
// gibi istekler bugün KOD DEĞİŞİKLİĞİ gerektiriyor. Bu modül o istekleri
// YAPILANDIRMAYA çevirir.
//
// ═══ GÜVENLİK SINIRLARI ══════════════════════════════════════════════════
//
//   · Rasgele JavaScript YOK.
//   · Rasgele backend nesne yolu YOK — yalnız BEYAZ LİSTE token'ları.
//   · Taşıyıcı kimlik alanlarının DEĞERİ değiştirilemez: kiracı SUNUMU
//     değiştirir, KİMLİĞİ değil. Barkod bloğuna `packageId` yazdırmak,
//     yanlış paketi taşıyan bir etiket demektir.
//
// SAF: ağ yok, DB yok, render yok. Bu modül ŞABLONU DOĞRULAR ve ÇÖZER.

/** Beyaz liste. Bu kümenin DIŞINDA hiçbir alan şablona giremez. */
export const LABEL_BLOCKS = [
  'BARCODE', 'BARCODE_TEXT', 'QR',
  'RECIPIENT_NAME', 'BUYER_NAME',
  'DELIVERY_ADDRESS', 'CITY', 'DISTRICT',
  'ORDER_NUMBER', 'ORDER_DATE', 'ORDER_TIME', 'PACKAGE_ID',
  'CARGO_TRACKING_NUMBER', 'CARRIER_TRACKING_NUMBER',
  'PRODUCT_LIST', 'PRODUCT_NAME', 'VARIANT', 'SKU', 'QUANTITY',
  'BRANCH', 'ROUTE', 'TRANSFER_CENTER',
  'STATIC_TEXT', 'FOOTER',
] as const

export type LabelBlockId = (typeof LABEL_BLOCKS)[number]

/**
 * DEĞERİ KİLİTLİ bloklar.
 *
 * Görünürlük/konum/boyut değiştirilebilir; İÇERİK taşıyıcıdan gelir ve
 * kiracı tarafından DEĞİŞTİRİLEMEZ. Yanlış barkod = yanlış gönderi.
 */
export const IDENTITY_LOCKED_BLOCKS: readonly LabelBlockId[] = [
  'BARCODE', 'BARCODE_TEXT', 'QR',
  'CARGO_TRACKING_NUMBER', 'CARRIER_TRACKING_NUMBER',
  'BRANCH', 'ROUTE', 'TRANSFER_CENTER',
] as const

/** Etikette KALDIRILAMAZ bloklar — güvenli teslimat için zorunlu. */
export const REQUIRED_BLOCKS: readonly LabelBlockId[] = [
  'BARCODE', 'RECIPIENT_NAME', 'DELIVERY_ADDRESS',
] as const

export const BLOCK_ALIGNMENTS = ['left', 'center', 'right'] as const

export interface LabelBlockConfig {
  block: LabelBlockId
  visible?: boolean
  order?: number
  x?: number
  y?: number
  width?: number
  height?: number
  fontSize?: number
  bold?: boolean
  align?: (typeof BLOCK_ALIGNMENTS)[number]
  maxLines?: number
  wrap?: boolean
  /** YALNIZ `STATIC_TEXT` ve `FOOTER` için. */
  text?: string
}

export interface LabelTemplateDefinition {
  blocks: LabelBlockConfig[]
}

export interface LabelTemplate {
  templateId: string
  organizationId: string
  name: string
  version: number
  definition: LabelTemplateDefinition
  active: boolean
  marketplace?: string | null
  carrier?: string | null
}

export const TEMPLATE_VALIDATION_CODES = [
  'UNKNOWN_BLOCK',
  'DUPLICATE_BLOCK',
  'REQUIRED_BLOCK_HIDDEN',
  'LOCKED_BLOCK_TEXT_OVERRIDE',
  'TEXT_ON_NON_TEXT_BLOCK',
  'INVALID_NUMBER',
  'INVALID_ALIGN',
] as const

export type TemplateValidationCode = (typeof TEMPLATE_VALIDATION_CODES)[number]

export interface TemplateValidation {
  valid: boolean
  errors: { code: TemplateValidationCode; block?: string; detail: string }[]
}

const NUMERIC_FIELDS: (keyof LabelBlockConfig)[] = [
  'order', 'x', 'y', 'width', 'height', 'fontSize', 'maxLines',
]

/**
 * Şablon doğrulama — FAIL-CLOSED.
 *
 * Bilinmeyen token, kilitli bloğa metin yazma ya da zorunlu bloğu gizleme
 * KABUL EDİLMEZ. Kaydedilemeyen şablon, basılamayan etiketten iyidir.
 */
export function validateLabelTemplate(
  definition: LabelTemplateDefinition | null | undefined,
): TemplateValidation {
  const errors: TemplateValidation['errors'] = []
  const blocks = definition?.blocks ?? []
  const seen = new Set<string>()

  for (const entry of blocks) {
    const block = String(entry?.block ?? '')
    if (!(LABEL_BLOCKS as readonly string[]).includes(block)) {
      errors.push({
        code: 'UNKNOWN_BLOCK', block,
        detail: 'Beyaz listede olmayan blok; rasgele alan yolu KABUL EDİLMEZ.',
      })
      continue
    }
    if (seen.has(block)) {
      errors.push({ code: 'DUPLICATE_BLOCK', block, detail: 'Blok tekrar edildi.' })
    }
    seen.add(block)

    // Kilitli blokların METNİ değiştirilemez — kimlik kiracıdan gelmez.
    if (
      entry.text !== undefined
      && (IDENTITY_LOCKED_BLOCKS as readonly string[]).includes(block)
    ) {
      errors.push({
        code: 'LOCKED_BLOCK_TEXT_OVERRIDE', block,
        detail: 'Taşıyıcı kimlik bloğunun değeri değiştirilemez.',
      })
    }
    // Serbest metin YALNIZ metin bloklarında.
    if (
      entry.text !== undefined && block !== 'STATIC_TEXT' && block !== 'FOOTER'
    ) {
      errors.push({
        code: 'TEXT_ON_NON_TEXT_BLOCK', block,
        detail: 'Bu blok serbest metin taşımaz.',
      })
    }
    for (const field of NUMERIC_FIELDS) {
      const value = entry[field]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push({
          code: 'INVALID_NUMBER', block,
          detail: `${String(field)} sayısal ve negatif olmayan olmalı.`,
        })
      }
    }
    if (
      entry.align !== undefined
      && !(BLOCK_ALIGNMENTS as readonly string[]).includes(entry.align)
    ) {
      errors.push({ code: 'INVALID_ALIGN', block, detail: 'Geçersiz hizalama.' })
    }
  }

  // Zorunlu bloklar GİZLENEMEZ.
  for (const required of REQUIRED_BLOCKS) {
    const entry = blocks.find((item) => item?.block === required)
    if (entry && entry.visible === false) {
      errors.push({
        code: 'REQUIRED_BLOCK_HIDDEN', block: required,
        detail: 'Güvenli teslimat için zorunlu blok gizlenemez.',
      })
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Kiracı kapsamına göre şablon seçimi.
 *
 * Öncelik: organizasyon+pazaryeri+taşıyıcı → organizasyon+taşıyıcı →
 * organizasyon varsayılanı. Aşırı mühendislik YOK.
 *
 * BAŞKA kiracının şablonu HİÇBİR koşulda seçilmez.
 */
export function resolveActiveTemplate(params: {
  templates: LabelTemplate[]
  organizationId: string
  marketplace?: string | null
  carrier?: string | null
}): LabelTemplate | null {
  const norm = (value: unknown): string =>
    String(value ?? '').trim().toLocaleLowerCase('tr-TR')
  const mine = params.templates.filter(
    (template) => template.active
      && template.organizationId === params.organizationId,
  )
  const marketplace = norm(params.marketplace)
  const carrier = norm(params.carrier)

  const exact = mine.find(
    (t) => norm(t.marketplace) === marketplace && norm(t.carrier) === carrier
      && marketplace !== '' && carrier !== '',
  )
  if (exact) return exact
  const byCarrier = mine.find(
    (t) => !t.marketplace && norm(t.carrier) === carrier && carrier !== '',
  )
  if (byCarrier) return byCarrier
  return mine.find((t) => !t.marketplace && !t.carrier) ?? null
}

/**
 * Render önbellek anahtarı.
 *
 * Ham taşıyıcı artefaktı + şablon sürümü. Şablon değişince YEREL yeniden
 * render yapılır; TAŞIYICIYA ÇAĞRI YOKTUR.
 */
export function renderCacheKey(params: {
  rawArtifactId: string
  templateId?: string | null
  templateVersion?: number | null
}): string {
  return [
    String(params.rawArtifactId ?? '').trim(),
    String(params.templateId ?? 'raw'),
    String(params.templateVersion ?? 0),
  ].join(':')
}

/** Şablon değişikliği ASLA taşıyıcı çağrısı gerektirmez. */
export function templateChangeRequiresCarrierCall(): false {
  return false
}
