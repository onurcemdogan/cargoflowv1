import type { CargoOrder, OrderItem } from '../types/cargoflow'

// ═══ BEDEN ÇÖZÜMLEYİCİ — YALNIZ SUNUM ═════════════════════════════════════
//
// ÜRETİM HATASI (kanıtlandı): Toplanacak Ürünler'de tüm beden chip'leri
// "Bedensiz" görünüyordu. Sebep, ürün ailesi mantığı DEĞİL, bedenin okunduğu
// alanın kalıcı okuma yolunda KAYBOLMASIYDI:
//
//   · sync yolu  : normalizeTrendyolOrderLines `line.productSize` → item.size
//   · kalıcı yol : rowToOrder (server/orders/orderMapper.ts) satırı DB'den
//                  kurarken `size`/`color` ALANLARINI HİÇ ÜRETMİYORDU ve
//                  `variantAttributes` çoğu Trendyol satırında [] olduğu için
//                  beden hiçbir yerden gelmiyordu.
//
// KAPSAM: bu modül YALNIZ beden GÖSTERİMİ içindir.
// ÜRÜN AİLESİ ANAHTARINA BEDEN GİRMEZ — aile hâlâ kanonik kimlik + renktir
// (bkz. orderProductFamily.resolveProductFamilyIdentity). 36/40/42 TEK ailedir.

/** Beden bilgisi taşıyabilecek yapılandırılmış nitelik adları. */
const SIZE_ATTRIBUTE_NAMES = ['beden', 'size', 'numara', 'olcu', 'ölçü']

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
}

function fromVariantAttributes(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const name = normalizeName(
      record.attributeName ?? record.name ?? record.key ?? record.label,
    )
    if (!SIZE_ATTRIBUTE_NAMES.includes(name)) continue
    const attributeValue = text(
      record.attributeValue ?? record.value ?? record.val,
    )
    if (attributeValue) return attributeValue
  }
  return ''
}

/** Ham (provider) satırından yapılandırılmış beden. İSİM PARSE EDİLMEZ. */
function fromRawLine(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const record = raw as Record<string, unknown>
  return (
    text(record.productSize) ||
    text(record.size) ||
    fromVariantAttributes(record.variantAttributes)
  )
}

/**
 * TEK GÜVENİLİR BEDEN ÇÖZÜMLEYİCİ.
 *
 * Öncelik:
 *   1. normalize edilmiş kalemdeki açık alanlar  (size, productSize)
 *   2. kalemin variantAttributes'ındaki Beden/Size/Numara niteliği
 *   3. kaleme İLİŞTİRİLMİŞ ham satır (item.rawLine)
 *   4. sipariş düzeyindeki ham satırlardan KARARLI KİMLİKLE eşleşen satır
 *
 * ÜRÜN ADI ASLA PARSE EDİLMEZ: "... SCUBA-SEC01, 42" gibi adlardaki sayı
 * beden sanılmaz (ad içinde başka sayılar olabilir). Yapılandırılmış hiçbir
 * kaynak yoksa boş döner → çağıran "Bedensiz" gösterir.
 */
export function resolveOrderItemSize(
  item: OrderItem,
  rawLine?: unknown,
): string {
  const record = item as unknown as Record<string, unknown>
  return (
    text(record.size) ||
    text(record.productSize) ||
    fromVariantAttributes(record.variantAttributes) ||
    fromRawLine(record.rawLine) ||
    fromRawLine(rawLine)
  )
}

/**
 * Sipariş düzeyindeki ham satırları KARARLI KİMLİKLE indeksler.
 *
 * ÇOK ÜRÜNLÜ SİPARİŞ GÜVENLİĞİ: "siparişin ilk bedenini tüm kalemlere ver"
 * gibi bir geri düşüş YOKTUR. Yalnız TEKİL eşleşen kimlikler kullanılır;
 * bir anahtar birden çok ham satıra denk geliyorsa (ör. aynı contentId'nin
 * iki bedeni) o anahtar KULLANILMAZ — yanlış bedeni başka ürüne vermektense
 * "Bedensiz" göstermek doğrudur.
 */
export function buildRawLineIndex(order: CargoOrder): Map<string, unknown> {
  const rawOrder = (order as unknown as Record<string, unknown>).rawOrder
  const lines = (rawOrder as Record<string, unknown> | undefined)?.lines
  const index = new Map<string, unknown>()
  if (!Array.isArray(lines)) return index
  const ambiguous = new Set<string>()
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const record = line as Record<string, unknown>
    for (const key of rawLineKeys(record)) {
      if (ambiguous.has(key)) continue
      if (index.has(key)) {
        // Aynı anahtar birden çok satırda → GÜVENSİZ, tamamen düşür.
        index.delete(key)
        ambiguous.add(key)
        continue
      }
      index.set(key, line)
    }
  }
  return index
}

function rawLineKeys(record: Record<string, unknown>): string[] {
  const keys: string[] = []
  const push = (prefix: string, value: unknown) => {
    const token = text(value)
    if (token) keys.push(`${prefix}:${token}`)
  }
  push('line', record.id)
  push('line', record.orderLineId)
  push('barcode', record.barcode)
  push('sku', record.merchantSku)
  push('sku', record.sku)
  push('sku', record.stockCode)
  push('content', record.productContentId ?? record.contentId)
  push('code', record.productCode)
  return keys
}

/** Kalem için indeksten KARARLI eşleşen ham satırı bulur (yoksa undefined). */
export function findRawLineForItem(
  item: OrderItem,
  index: Map<string, unknown>,
): unknown {
  if (index.size === 0) return undefined
  const record = item as unknown as Record<string, unknown>
  // `ty_line_` ön eki sync tarafında eklenir; ham satır kimliği ÖN EKSİZDİR.
  const rawId = text(record.id).replace(/^ty_line_/, '')
  const candidates = [
    `line:${rawId}`,
    `barcode:${text(record.barcode)}`,
    `sku:${text(record.merchantSku)}`,
    `sku:${text(record.sku)}`,
    `sku:${text(record.stockCode)}`,
    `content:${text(record.productContentId)}`,
    `code:${text(record.productCode)}`,
  ]
  for (const candidate of candidates) {
    if (candidate.endsWith(':')) continue
    const found = index.get(candidate)
    if (found) return found
  }
  return undefined
}
