// Etiket ALT bölümü için ürün özeti satırları (SAF, deterministik).
// Sürat etiketinin fiziksel yüksekliği DEĞİŞMEZ; bu yüzden ürün bölümü sabit
// bir satır bütçesiyle çalışır: sığmayan ürünler "+X ürün daha" ile özetlenir.
// Barkod/QR alanına TAŞMAZ (çağıran sabit y aralığı verir).
//
// Kurallar:
// - quantity doğru gösterilir (satır adedi; duplicate satır BASILMAZ).
// - eksik alanlar "undefined/null" yazılmaz, sessizce atlanır.
// - renk/beden variantAttributes içindeyse güvenli çözülür.
// - uzun ürün adları kelime bazlı sarılır; son çare '…' ile kısaltılır.
// - font okunamayacak kadar küçültülmez (boyutlar çağıranda sabittir).

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

export type LabelProductLineKind = 'title' | 'meta' | 'more'

export interface LabelProductLine {
  text: string
  kind: LabelProductLineKind
}

export interface LabelProductLayoutOptions {
  // Toplam satır bütçesi (etiket yüksekliği sabit).
  maxLines: number
  // Başlık satırı için maksimum karakter (font genişliğine göre çağıran verir).
  titleMaxChars: number
  // Meta satırı için maksimum karakter.
  metaMaxChars: number
  // Bir ürün başlığının kaplayabileceği en fazla satır.
  maxTitleLinesPerItem?: number
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

// variantAttributes'tan ada göre değer (Renk/Beden gibi) — güvenli.
function readVariant(item: LabelProductSource, names: string[]): string {
  const wanted = names.map((name) => name.toLocaleLowerCase('tr-TR'))
  for (const attribute of item.variantAttributes ?? []) {
    const name = clean(attribute?.name).toLocaleLowerCase('tr-TR')
    if (name && wanted.includes(name)) {
      const value = clean(attribute?.value)
      if (value) return value
    }
  }
  return ''
}

// Kelime bazlı sarma; maxLines'a sığmazsa son satır '…' ile kısaltılır
// (kelime ortasından rastgele kesme yok, içerik kaybı açıkça işaretlenir).
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
    // Çok uzun tek kelime: sert böl (aksi halde satır taşar).
    while (current.length > safeMax) {
      lines.push(current.slice(0, safeMax))
      current = current.slice(safeMax)
    }
  }
  if (current) lines.push(current)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]
  kept[maxLines - 1] =
    last.length >= safeMax ? `${last.slice(0, Math.max(1, safeMax - 1))}…` : `${last}…`
  return kept
}

function truncate(text: string, maxChars: number): string {
  const safeMax = Math.max(1, maxChars)
  if (text.length <= safeMax) return text
  return `${text.slice(0, safeMax - 1)}…`
}

// Bir ürünün meta satırı — GERÇEK Sürat etiketindeki biçim:
//   "(Renk: Lacivert, Beden: 40) [ttzeyna44]"
// Boş alanlar tamamen atlanır (asla "Renk: undefined" yazılmaz); hiçbir alan
// yoksa meta satırı hiç üretilmez.
function buildMeta(item: LabelProductSource, maxChars: number): string {
  const color = clean(item.color) || readVariant(item, ['Renk', 'Color'])
  const size =
    clean(item.size) || readVariant(item, ['Beden', 'Size', 'Numara'])
  const attrs: string[] = []
  if (color) attrs.push(`Renk: ${color}`)
  if (size) attrs.push(`Beden: ${size}`)
  // Renk/Beden dışındaki anlamlı varyant (ör. Model) — en fazla 1 tane.
  const extra = (item.variantAttributes ?? []).find((attribute) => {
    const name = clean(attribute?.name)
    const normalized = name.toLocaleLowerCase('tr-TR')
    return (
      name &&
      clean(attribute?.value) &&
      !['renk', 'color', 'beden', 'size', 'numara'].includes(normalized)
    )
  })
  if (extra) attrs.push(`${clean(extra.name)}: ${clean(extra.value)}`)

  const code = clean(item.sku || item.merchantSku || item.stockCode || item.barcode)
  const parts: string[] = []
  if (attrs.length > 0) parts.push(`(${attrs.join(', ')})`)
  if (code) parts.push(`[${code}]`)
  return parts.length > 0 ? truncate(parts.join(' '), maxChars) : ''
}

// Deterministik ürün bölümü satırları. Sığmayan ürünler "+X ürün daha".
export function buildLabelProductLines(
  items: LabelProductSource[],
  options: LabelProductLayoutOptions,
): LabelProductLine[] {
  const maxLines = Math.max(0, Math.trunc(options.maxLines))
  if (maxLines === 0) return []
  const source = Array.isArray(items) ? items : []
  if (source.length === 0) {
    return [{ text: 'Ürün bilgisi yok', kind: 'title' }]
  }
  const maxTitleLines = Math.max(1, options.maxTitleLinesPerItem ?? 2)

  // Her ürün için satır bloğu üret (başlık satırları + tek meta satırı).
  const blocks = source.map((item) => {
    const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1))
    const name = clean(item.productName) || 'Ürün'
    const titleLines = wrapText(
      `${quantity} x ${name}`,
      options.titleMaxChars,
      maxTitleLines,
    ).map((text) => ({ text, kind: 'title' as const }))
    const meta = buildMeta(item, options.metaMaxChars)
    return meta
      ? [...titleLines, { text: meta, kind: 'meta' as const }]
      : titleLines
  })

  const lines: LabelProductLine[] = []
  let rendered = 0
  for (const block of blocks) {
    const remainingItems = source.length - rendered
    // Sığmayan ürün kalacaksa son satırı "+X ürün daha" için ayır.
    const reserve = remainingItems > 1 ? 1 : 0
    if (lines.length + block.length > maxLines - reserve) break
    lines.push(...block)
    rendered += 1
  }

  const leftover = source.length - rendered
  if (leftover > 0) {
    // En az bir ürün gösterilemediyse bile özet satırı yazılır.
    if (lines.length >= maxLines) lines.length = maxLines - 1
    lines.push({ text: `+${leftover} ürün daha`, kind: 'more' })
  }
  return lines.slice(0, maxLines)
}
