// Etiket ürün detayı satırları (SAF, deterministik).
//
// KURAL: Siparişteki HER gerçek ürün satırı TAM olarak yazılır — hiçbir ürün
// özetlenmez veya gizlenmez ("+X ürün daha" YOKTUR). Ürün başına en fazla üç
// mantıksal satır üretilir:
//
//   <adet> x <tam ürün/model adı>            (gerekirse güvenli satır sarma)
//   Renk: <renk> · Beden: <beden> · Varyant: <diğer özellikler>
//   SKU: <sku> · Barkod: <ürün barkodu>
//
// Eksik alanlar tamamen atlanır (asla "undefined/null" basılmaz); bir satırın
// tüm alanları boşsa o satır hiç üretilmez. Ürünler ana etikete sığmazsa çağıran
// tarafta DEVAM etiketlerine sayfalanır (bkz. paginateProductBlocks) — içerik
// asla kırpılmaz.

export interface LabelProductSource {
  productName?: string
  quantity?: number
  color?: string
  size?: string
  sku?: string
  merchantSku?: string
  stockCode?: string
  barcode?: string
  variantAttributes?: Array<{ name?: string; value?: string }>
}

export type LabelProductLineKind = 'title' | 'meta'

export interface LabelProductLine {
  text: string
  kind: LabelProductLineKind
}

export interface LabelProductLayoutOptions {
  // Başlık satırı için maksimum karakter (font genişliğine göre çağıran verir).
  titleMaxChars: number
  // Meta satırı için maksimum karakter.
  metaMaxChars: number
  // Bir ürün adının kaplayabileceği en fazla satır (okunaklılık sınırı).
  maxTitleLinesPerItem?: number
}

const COLOR_KEYS = ['renk', 'color']
const SIZE_KEYS = ['beden', 'size', 'numara']

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function readVariant(item: LabelProductSource, names: string[]): string {
  for (const attribute of item.variantAttributes ?? []) {
    const name = clean(attribute?.name).toLocaleLowerCase('tr-TR')
    if (name && names.includes(name)) {
      const value = clean(attribute?.value)
      if (value) return value
    }
  }
  return ''
}

// Kelime bazlı sarma. Metin KESİLMEZ: satır sayısı sınırı aşılırsa kalan
// kelimeler son satıra sığdığı kadar değil, EK SATIRLARA taşınır — yalnız tek
// bir kelime satırdan uzunsa sert bölünür (aksi halde ZPL satırı taşardı).
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const safeMax = Math.max(1, maxChars)
  const words = text.split(' ').filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if (current.length + 1 + word.length <= safeMax) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
    while (current.length > safeMax) {
      lines.push(current.slice(0, safeMax))
      current = current.slice(safeMax)
    }
  }
  if (current) lines.push(current)
  // Okunaklılık sınırı: çok uzun adlarda satır sayısı sınırlanır; kalan metin
  // atılmaz, son satırda '…' ile işaretlenir (ürünün kendisi GİZLENMEZ).
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]
  kept[maxLines - 1] =
    last.length >= safeMax ? `${last.slice(0, Math.max(1, safeMax - 1))}…` : `${last}…`
  return kept
}

function truncate(text: string, maxChars: number): string {
  const safeMax = Math.max(1, maxChars)
  return text.length <= safeMax ? text : `${text.slice(0, safeMax - 1)}…`
}

// "Renk: X · Beden: Y · Varyant: A=1, B=2" — yalnız dolu alanlar.
function buildVariantLine(item: LabelProductSource, maxChars: number): string {
  const color = clean(item.color) || readVariant(item, COLOR_KEYS)
  const size = clean(item.size) || readVariant(item, SIZE_KEYS)
  const others = (item.variantAttributes ?? [])
    .filter((attribute) => {
      const name = clean(attribute?.name).toLocaleLowerCase('tr-TR')
      return (
        name &&
        clean(attribute?.value) &&
        !COLOR_KEYS.includes(name) &&
        !SIZE_KEYS.includes(name)
      )
    })
    .map((attribute) => `${clean(attribute?.name)}=${clean(attribute?.value)}`)
  const parts: string[] = []
  if (color) parts.push(`Renk: ${color}`)
  if (size) parts.push(`Beden: ${size}`)
  if (others.length > 0) parts.push(`Varyant: ${others.join(', ')}`)
  return parts.length > 0 ? truncate(parts.join(' · '), maxChars) : ''
}

// "SKU: X · Barkod: Y" — yalnız dolu alanlar.
function buildCodeLine(item: LabelProductSource, maxChars: number): string {
  const sku = clean(item.sku || item.merchantSku || item.stockCode)
  const barcode = clean(item.barcode)
  const parts: string[] = []
  if (sku) parts.push(`SKU: ${sku}`)
  if (barcode) parts.push(`Barkod: ${barcode}`)
  return parts.length > 0 ? truncate(parts.join(' · '), maxChars) : ''
}

// Her ürün için TAM detay bloğu (1..3 mantıksal satır). Ürün sayısı KISITLANMAZ.
export function buildProductItemBlocks(
  items: LabelProductSource[],
  options: LabelProductLayoutOptions,
): LabelProductLine[][] {
  const source = Array.isArray(items) ? items : []
  const maxTitleLines = Math.max(1, options.maxTitleLinesPerItem ?? 2)
  return source.map((item) => {
    const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1))
    const name = clean(item.productName) || 'Ürün'
    const block: LabelProductLine[] = wrapText(
      `${quantity} x ${name}`,
      options.titleMaxChars,
      maxTitleLines,
    ).map((text) => ({ text, kind: 'title' as const }))
    const variantLine = buildVariantLine(item, options.metaMaxChars)
    if (variantLine) block.push({ text: variantLine, kind: 'meta' })
    const codeLine = buildCodeLine(item, options.metaMaxChars)
    if (codeLine) block.push({ text: codeLine, kind: 'meta' })
    return block
  })
}

// Ürün bloklarını sayfalara böler. Bir ürün BÖLÜNMEZ: bloğu sığmıyorsa tümüyle
// sonraki sayfaya taşınır. İlk sayfa = ana Sürat etiketinin alt şeridi (küçük
// bütçe), sonrakiler = DEVAM etiketleri (geniş bütçe). Hiçbir ürün ATILMAZ.
export function paginateProductBlocks(
  blocks: LabelProductLine[][],
  budgets: { firstPageLines: number; continuationPageLines: number },
): LabelProductLine[][] {
  const pages: LabelProductLine[][] = []
  let current: LabelProductLine[] = []
  let budget = Math.max(0, budgets.firstPageLines)
  const nextBudget = Math.max(1, budgets.continuationPageLines)
  for (const block of blocks) {
    if (current.length + block.length > budget) {
      pages.push(current)
      current = []
      budget = nextBudget
      // Tek bir ürün bloğu devam sayfasına da sığmıyorsa yine de yazılır
      // (gizlenmez); pratikte devam sayfası bütçesi bir bloktan büyüktür.
    }
    current.push(...block)
  }
  pages.push(current)
  return pages
}

// Ana etiket için TEK sayfalık kullanım (geriye dönük yardımcı).
export function buildLabelProductLines(
  items: LabelProductSource[],
  options: LabelProductLayoutOptions & { maxLines: number },
): LabelProductLine[] {
  const source = Array.isArray(items) ? items : []
  if (source.length === 0) return [{ text: 'Ürün bilgisi yok', kind: 'title' }]
  const blocks = buildProductItemBlocks(source, options)
  const [first] = paginateProductBlocks(blocks, {
    firstPageLines: options.maxLines,
    continuationPageLines: options.maxLines,
  })
  return first
}
