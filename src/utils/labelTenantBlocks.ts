// KİRACI BLOK KATMANI — kodsuz etiket özelleştirmesinin GERÇEK render yolu.
//
// ═══ NEDEN AYRI BİR KATMAN ═══════════════════════════════════════════════
// Sürat etiketinin gövdesini TAŞIYICI basar. Adres, alıcı adı, Code128,
// DataMatrix, rota ve aktarma taşıyıcının komutlarıdır; composer bunlara
// yalnız beyaz listedeki altı düzenlemeyi uygular ve invariant doğrulaması
// yapar. Bu yüzden kiracıya "adresin puntosunu büyüt" gibi bir düğme
// SUNULAMAZ: o metni biz üretmiyoruz.
//
// Kiracının GERÇEKTEN sahip olduğu alan, taşıyıcı içeriğinin ALTINDA kalan
// composer bandıdır (ürün satırlarının basıldığı yer). Bu modül o bandı
// paylaşılabilir hale getirir: operatör blok açar/kapar, sıralar, punto ve
// kalınlık verir, üst/alt yerleşim seçer — HEPSİ kod değişikliği olmadan.
//
// ═══ KİMLİK DOKUNULMAZ ═══════════════════════════════════════════════════
// Barkod / QR / takip numarası bu katmanda ASLA üretilmez. Operatör bir
// barkodun DEĞERİNİ packageId, orderNumber veya rastgele bir jetona
// çeviremez; bu anahtarlar katalogda carrierOwned işaretlidir ve buradan
// tek bir komut bile yazmazlar.
//
// ═══ SESSİZ KIRPMA YOK ═══════════════════════════════════════════════════
// Bant dolduğunda blok KÜÇÜLTÜLMEZ ve KIRPILMAZ; plan `dropped` listesiyle
// açıkça taşma bildirir ve çağıran katman bunu operatöre gösterir.

import type {
  CargoOrder,
  LabelFieldConfig,
  LabelFieldKey,
  LabelTemplate,
} from '../types/cargoflow.ts'
import { IDENTITY_LOCKED_LABEL_FIELDS } from '../types/cargoflow.ts'
import type { LabelData } from './labelData.ts'
import {
  DEFAULT_PRODUCT_LINE_PARTS,
  escapeZplData,
  transliterateTurkish,
  type ProductLineParts,
} from './suratZplProductLine.ts'

/** Bandda kaplanan dikey alanın satır yüksekliği çarpanı (ZPL ^A0 ile uyumlu). */
const LINE_HEIGHT_RATIO = 1.05
/** Punto verilmediğinde kullanılan taban yükseklik (dot). */
export const TENANT_BLOCK_DEFAULT_FONT = 18
/** Operatörün seçebileceği punto aralığı — okunabilirlik tabanı 10 dot. */
export const TENANT_BLOCK_MIN_FONT = 10
export const TENANT_BLOCK_MAX_FONT = 60
/** Kalın vuruşun yatay ofseti (çift baskı). */
const BOLD_OFFSET = 1

/**
 * NOMİNAL bant kapasitesi (dot) — düzenleyicideki ÖN UYARI için.
 *
 * ÖLÇÜM (gerçek üretim etiketi, surat-real-success-11415535074.zpl):
 *   footer bandı  = 725 → 791  (66 dot)
 *   ürün satırı   = 25 dot
 *   kiracıya kalan= 41 dot
 *
 * Gerçek kapasite ETİKETTEN ETİKETE DEĞİŞİR (taşıyıcı içeriği ne kadar
 * aşağı iniyorsa bant o kadar dardır) ve KESİN karar baskı anında
 * `planTenantBlocks` ile verilir. Bu sabit yalnız operatöre "bu şablon
 * muhtemelen sığmayacak" UYARISI göstermek içindir; hiçbir bloğu
 * kırpmaz veya küçültmez.
 */
export const TENANT_BAND_NOMINAL_HEIGHT = 41

/** Blokların isteyeceği toplam dikey alan (dot). */
export function tenantBlocksHeight(blocks: readonly TenantBlock[]): number {
  return blocks.reduce(
    (total, block) => total + Math.round(block.fontHeight * LINE_HEIGHT_RATIO),
    0,
  )
}

export type TenantBlockPlacement = 'top' | 'body' | 'bottom'

/**
 * Katalog: her blok anahtarının bu bantta basılıp basılamayacağı.
 *
 * `carrierOwned: true` → metni TAŞIYICI basar. Kiracı bu bloğu bu katmanda
 * yeniden üretemez (çift baskı ve kimlik karışıklığı riski). Düzenleyicide
 * kilitli görünür.
 */
export type TenantBlockKind =
  /** Metni TAŞIYICI basar; kiracı ne değerini ne sunumunu değiştirebilir. */
  | 'carrier'
  /** Mevcut ÜRÜN SATIRININ bir parçası; ayrı satır olarak basılmaz. */
  | 'productLine'
  /** Composer bandına AYRI bir satır olarak basılan kiracı bloğu. */
  | 'block'

export const TENANT_BLOCK_CATALOG: Readonly<
  Record<LabelFieldKey, { kind: TenantBlockKind }>
> = {
  marketplace: { kind: 'block' },
  orderNumber: { kind: 'block' },
  shippingProvider: { kind: 'carrier' },
  customerName: { kind: 'carrier' },
  customerPhone: { kind: 'carrier' },
  cityDistrict: { kind: 'carrier' },
  address: { kind: 'carrier' },
  // ÜRÜN SATIRI PARÇALARI: bunlar zaten basılan "2 x Ürün A (Renk: …) [SKU]"
  // satırının bileşenleridir. Ayrı blok olarak basılsalardı aynı bilgi
  // etikette İKİ KEZ görünürdü.
  productName: { kind: 'productLine' },
  quantity: { kind: 'productLine' },
  variant: { kind: 'productLine' },
  sku: { kind: 'productLine' },
  trackingNumber: { kind: 'carrier' },
  shipmentCode: { kind: 'carrier' },
  orderDate: { kind: 'block' },
  orderTime: { kind: 'block' },
  buyerName: { kind: 'block' },
  packageId: { kind: 'block' },
}

export function tenantBlockKind(key: LabelFieldKey): TenantBlockKind {
  if (IDENTITY_LOCKED_LABEL_FIELDS.includes(key)) return 'carrier'
  return TENANT_BLOCK_CATALOG[key]?.kind ?? 'carrier'
}

/** Composer bandına AYRI satır olarak basılabilen bloklar. */
export function isTenantRenderableBlock(key: LabelFieldKey): boolean {
  return tenantBlockKind(key) === 'block'
}

/** Ürün satırının parçalarını yapılandıran bloklar. */
export function isProductLinePart(key: LabelFieldKey): boolean {
  return tenantBlockKind(key) === 'productLine'
}

/**
 * Şablondan ürün satırı parçalarını çözer.
 *
 * Şablon YOKSA bugünkü çıktı aynen korunur (üç parça da açık) — sessiz bir
 * davranış değişikliği olmaz.
 */
export function resolveProductLineParts(
  template: Pick<LabelTemplate, 'fields'> | undefined,
): ProductLineParts {
  const fields = Array.isArray(template?.fields) ? template.fields : []
  if (fields.length === 0) return DEFAULT_PRODUCT_LINE_PARTS
  const read = (key: LabelFieldKey, fallback: boolean) => {
    const field = fields.find((entry) => entry.key === key)
    return field ? field.visible === true : fallback
  }
  return {
    quantity: read('quantity', DEFAULT_PRODUCT_LINE_PARTS.quantity),
    variant: read('variant', DEFAULT_PRODUCT_LINE_PARTS.variant),
    sku: read('sku', DEFAULT_PRODUCT_LINE_PARTS.sku),
  }
}

export interface TenantBlockValues {
  readonly [key: string]: string
}

/** Sipariş saatini yerel biçimde verir; geçersiz tarihte BOŞ döner. */
function formatClock(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

function formatDay(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(parsed.getDate())}.${pad(parsed.getMonth() + 1)}.${parsed.getFullYear()}`
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Blok DEĞERLERİ tek yerde çözülür; ZPL ve HTML önizleme AYNI kaynaktan
 * beslenir, böylece önizleme ile baskı ayrışamaz.
 */
export function resolveTenantBlockValues(
  order: CargoOrder | undefined,
  data:
    | Pick<LabelData, 'items' | 'totalQuantity' | 'packageId' | 'marketplaceName'>
    | undefined,
): TenantBlockValues {
  const item = data?.items?.[0]
  const buyer = clean(
    [order?.customerFirstName, order?.customerLastName].filter(Boolean).join(' '),
  )
  const variant = clean(
    [item?.color, item?.size]
      .map((part) => clean(part))
      .filter(Boolean)
      .join(' / '),
  )
  const orderedAt = order?.orderDate ?? order?.createdAt
  return {
    marketplace: clean(data?.marketplaceName ?? order?.marketplace),
    orderNumber: clean(order?.orderNumber),
    productName: clean(item?.productName),
    quantity: data?.totalQuantity ? `${data.totalQuantity} adet` : '',
    orderDate: formatDay(orderedAt),
    orderTime: formatClock(orderedAt),
    buyerName: buyer,
    variant,
    sku: clean(item?.sku || item?.merchantSku || item?.stockCode),
    packageId: clean(data?.packageId ?? order?.packageId),
  }
}

export interface TenantBlock {
  readonly key: LabelFieldKey
  readonly label: string
  readonly text: string
  readonly fontHeight: number
  readonly fontWidth: number
  readonly bold: boolean
  readonly placement: TenantBlockPlacement
}

export interface PlacedTenantBlock extends TenantBlock {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface TenantBlockPlan {
  readonly blocks: readonly PlacedTenantBlock[]
  /** Bandda yer kalmadığı için BASILAMAYAN bloklar — sessizce yutulmaz. */
  readonly dropped: readonly TenantBlock[]
  readonly usedHeight: number
}

export interface TenantBlockArea {
  readonly x: number
  readonly top: number
  readonly bottom: number
  readonly width: number
}

function clampFont(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return TENANT_BLOCK_DEFAULT_FONT
  return Math.min(
    TENANT_BLOCK_MAX_FONT,
    Math.max(TENANT_BLOCK_MIN_FONT, Math.round(numeric)),
  )
}

/**
 * Şablon yapılandırmasını, gerçekten basılabilir bloklara çevirir.
 *
 * Görünmeyen, taşıyıcıya ait ve DEĞERİ BOŞ olan bloklar elenir: boş bir
 * "Sipariş Saati" satırı basmak etikette anlamsız bir boşluk bırakır.
 */
export function resolveTenantBlocks(
  template: Pick<LabelTemplate, 'fields'> | undefined,
  values: TenantBlockValues,
): TenantBlock[] {
  const fields: LabelFieldConfig[] = Array.isArray(template?.fields)
    ? template.fields
    : []
  return fields
    .slice()
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .filter((field) => field.visible === true && isTenantRenderableBlock(field.key))
    .map((field) => {
      const fontHeight = clampFont(field.fontSize)
      return {
        key: field.key,
        label: field.label,
        text: clean(values[field.key]),
        fontHeight,
        // ^A0 için genişlik yüksekliğe orantılı verilir (Sürat şablonuyla
        // tutarlı ~0,85 oran); ayrı bir düğme gerektirmez.
        fontWidth: Math.max(TENANT_BLOCK_MIN_FONT, Math.round(fontHeight * 0.85)),
        bold: field.bold === true,
        placement: field.placement ?? 'body',
      }
    })
    .filter((block) => block.text.length > 0)
}

const PLACEMENT_RANK: Record<TenantBlockPlacement, number> = {
  top: 0,
  body: 1,
  bottom: 2,
}

/**
 * Blokları banda yerleştirir.
 *
 * `top`/`body` bandın ÜSTÜNDEN aşağı, `bottom` bandın ALTINDAN yukarı
 * dizilir; ikisi ortada buluşur. Yer kalmazsa blok `dropped` listesine
 * düşer — küçültme veya kırpma YOKTUR.
 */
export function planTenantBlocks(
  blocks: readonly TenantBlock[],
  area: TenantBlockArea,
): TenantBlockPlan {
  if (area.width <= 0 || area.bottom <= area.top) {
    return { blocks: [], dropped: blocks.slice(), usedHeight: 0 }
  }
  const placed: PlacedTenantBlock[] = []
  const dropped: TenantBlock[] = []
  const ordered = blocks
    .map((block, index) => ({ block, index }))
    .sort(
      (left, right) =>
        PLACEMENT_RANK[left.block.placement] -
          PLACEMENT_RANK[right.block.placement] || left.index - right.index,
    )
  let topCursor = area.top
  let bottomCursor = area.bottom
  const bottomBlocks = ordered.filter((entry) => entry.block.placement === 'bottom')
  const flowBlocks = ordered.filter((entry) => entry.block.placement !== 'bottom')

  for (const entry of flowBlocks) {
    const height = Math.round(entry.block.fontHeight * LINE_HEIGHT_RATIO)
    if (topCursor + height > bottomCursor) {
      dropped.push(entry.block)
      continue
    }
    placed.push({ ...entry.block, x: area.x, y: topCursor, width: area.width, height })
    topCursor += height
  }
  // `bottom` blokları TERS sırada yerleştirilir ki etikette yukarıdan aşağı
  // okunan sıra, operatörün listede verdiği sırayla AYNI olsun.
  for (const entry of bottomBlocks.slice().reverse()) {
    const height = Math.round(entry.block.fontHeight * LINE_HEIGHT_RATIO)
    if (bottomCursor - height < topCursor) {
      dropped.push(entry.block)
      continue
    }
    bottomCursor -= height
    placed.push({
      ...entry.block,
      x: area.x,
      y: bottomCursor,
      width: area.width,
      height,
    })
  }
  placed.sort((left, right) => left.y - right.y)
  const usedHeight = placed.reduce((total, block) => total + block.height, 0)
  return { blocks: placed, dropped, usedHeight }
}

/**
 * Plandan ZPL üretir. Kaynak komutlara DOKUNMAZ, yalnız EKLER.
 *
 * Kalın istendiğinde aynı metin +1 dot kaydırılıp ikinci kez basılır —
 * composer'ın bold adres tekniğiyle AYNI yöntem; yeni bir font indirmez.
 */
export function buildTenantBlockZplCommands(
  plan: TenantBlockPlan,
  options: { utf8: boolean },
): string[] {
  const commands: string[] = []
  for (const block of plan.blocks) {
    const prepared = escapeZplData(
      options.utf8 ? block.text : transliterateTurkish(block.text),
    )
    const offsets = block.bold ? [0, BOLD_OFFSET] : [0]
    for (const offset of offsets) {
      commands.push(
        `^FO${block.x + offset},${block.y}` +
          `^A0N,${block.fontHeight},${block.fontWidth}` +
          `^FB${block.width},1,0,L,0^FD${prepared}^FS`,
      )
    }
  }
  return commands
}
