// ÜRÜN DETAYI EK ETİKETİ — carrier etiketinden AYRI sayfalar.
//
// NEDEN VAR:
// 3 veya daha fazla FARKLI ürün satırı olan siparişlerde ürün listesini
// taşıyıcı etiketinin alt alanına sıkıştırmak hem okunmaz hem risklidir.
// Taşıyıcı etiketi yalnız taşıyıcı işini yapar (T.No, Code128, alıcı,
// DataMatrix, rota, aktarma, QR); ürün ayrıntısı bu ek sayfalara taşınır.
//
// ═══ BU BİR İKİNCİ KARGO ETİKETİ DEĞİLDİR ════════════════════════════════
// Ek sayfada Sürat T.No, Sürat Code128, taşıyıcı DataMatrix veya 727 QR
// TEKRAR BASILMAZ. Depo eşleştirmesi için YALNIZ dahili paket referansı
// (packageId) barkodu kullanılır ve yanında açıkça "PAKET" yazar.
//
// ═══ KARAR TOPLANMIŞ SATIRLAR ÜZERİNDEN ══════════════════════════════════
// Ham adet veya ham satır sayısı KULLANILMAZ. Önce mevcut katı toplama
// (ad + renk + beden + SKU aynı → tek satır, adet toplanır) uygulanır ve
// karar `aggregateProductLineItems(...).length` üzerinden verilir:
//   8 adet AYNI varyant  → 1 görüntü satırı → ek etiket YOK
//   8 FARKLI varyant     → 8 görüntü satırı → ek etiket VAR
//
// ═══ SAYFALAMA GEOMETRİ TABANLIDIR ═══════════════════════════════════════
// "8 ürün bir sayfaya sığar" VARSAYILMAZ. Her ürün atomik bir görsel blok
// olarak ölçülür; güvenli alt sınır aşılırsa yeni sayfa açılır. Hiçbir ürün
// kırpılmaz, kısaltılmaz veya sessizce düşürülmez.

import {
  aggregateProductLineItems,
  buildProductLineMeta,
  buildProductLineTitle,
  type SuratProductLineItem,
} from './suratZplProductLine.ts'
import { estimateA0Width } from './suratDurusoftComposer.ts'

/** Ek etiket EŞİĞİ: bu sayıdan FAZLA görüntü satırı ek sayfa gerektirir. */
export const PRODUCT_DETAIL_THRESHOLD = 2

/** Sayfa fiziksel sözleşmesi — taşıyıcı etiketiyle AYNI (100×100 mm). */
export const PAGE_WIDTH = 799
export const PAGE_LENGTH = 799

// ── Yerleşim ızgarası ────────────────────────────────────────────────────
const MARGIN_LEFT = 24
const MARGIN_RIGHT = 24
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT
/** Son ürün bloğunun geçemeyeceği taban (alt kenar payı dahil). */
const SAFE_BOTTOM = PAGE_LENGTH - 28

const TITLE_HEIGHT = 40
const HEADER_LINE_HEIGHT = 22
const HEADER_LINE_GAP = 4
const BARCODE_MODULE = 3
const BARCODE_BAR_HEIGHT = 70
const BARCODE_CAPTION_HEIGHT = 20
const RULE_GAP = 10

const BLOCK_TITLE_HEIGHT = 26
const BLOCK_META_HEIGHT = 20
const BLOCK_LINE_GAP = 3
const BLOCK_GAP = 12

export interface ProductDetailContext {
  readonly orderNumber: string
  readonly packageId: string
  readonly recipient: string
}

export interface ProductDetailBlock {
  readonly item: SuratProductLineItem
  /** "3 x Ürün Adı" */
  readonly title: string
  /** "(Renk: …, Beden: …) [SKU]" */
  readonly meta: string
  readonly titleLines: readonly string[]
  readonly metaLines: readonly string[]
  /** Bloğun toplam yüksekliği (dot). */
  readonly height: number
}

export interface ProductDetailPage {
  readonly page: number
  readonly totalPages: number
  readonly blocks: readonly ProductDetailBlock[]
}

export interface ProductDetailPlan {
  /** Ek etiket gerekiyor mu? */
  readonly required: boolean
  /** Toplanmış görüntü satırları — karar bunun uzunluğuna dayanır. */
  readonly aggregated: readonly SuratProductLineItem[]
  readonly pages: readonly ProductDetailPage[]
  /** Toplanmış satırlardaki toplam adet. */
  readonly quantityTotal: number
  /** Plan üretilemediyse güvenli teknik sebep. */
  readonly reason: string | null
}

const TITLE_FONT = { height: 26, width: 22 }
const META_FONT = { height: 20, width: 17 }
const HEADER_FONT = { height: 22, width: 19 }

/**
 * Metni verilen genişliğe göre KELİME sınırlarında böler.
 *
 * Kırpma veya kısaltma YOKTUR: tek bir kelime bile satıra sığmıyorsa o kelime
 * kendi satırına konur (taşma testte yakalanır, sessizce yutulmaz).
 */
export function wrapToWidth(
  text: string,
  fontWidth: number,
  maxWidth: number,
): string[] {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (current !== '' && estimateA0Width(candidate, fontWidth) > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

function buildBlock(item: SuratProductLineItem): ProductDetailBlock {
  const title = buildProductLineTitle(item)
  const meta = buildProductLineMeta(item)
  const titleLines = wrapToWidth(title, TITLE_FONT.width, CONTENT_WIDTH)
  const metaLines = wrapToWidth(meta, META_FONT.width, CONTENT_WIDTH)
  const height =
    titleLines.length * BLOCK_TITLE_HEIGHT +
    BLOCK_LINE_GAP +
    metaLines.length * BLOCK_META_HEIGHT
  return { item, title, meta, titleLines, metaLines, height }
}

/** Başlık bloğunun toplam yüksekliği (sayfanın üstünde her sayfada tekrarlar). */
function headerHeight(): number {
  const headerLines = 5 // Sipariş · Paket · Alıcı · Kalem/Adet · Sayfa
  return (
    TITLE_HEIGHT +
    headerLines * (HEADER_LINE_HEIGHT + HEADER_LINE_GAP) +
    BARCODE_BAR_HEIGHT +
    BARCODE_CAPTION_HEIGHT +
    RULE_GAP * 2
  )
}

/**
 * Ürün detay sayfalarını PLANLAR. ZPL ÜRETMEZ — yalnız karar ve yerleşim.
 *
 * Sözleşme: her toplanmış ürün satırı sayfalarda TAM OLARAK BİR KEZ bulunur.
 */
export function planProductDetailPages(
  items: readonly SuratProductLineItem[],
): ProductDetailPlan {
  const aggregated = aggregateProductLineItems(
    (Array.isArray(items) ? items : []).filter(
      (item) => String(item?.productName ?? '').trim() !== '',
    ),
  )
  const quantityTotal = aggregated.reduce(
    (total, item) => total + Math.max(1, Math.trunc(Number(item.quantity) || 1)),
    0,
  )
  if (aggregated.length <= PRODUCT_DETAIL_THRESHOLD) {
    // MEVCUT DAVRANIŞ: ürünler taşıyıcı etiketinin güvenli footer'ında kalır.
    return { required: false, aggregated, pages: [], quantityTotal, reason: null }
  }

  const blocks = aggregated.map(buildBlock)
  const available = SAFE_BOTTOM - headerHeight()
  const oversized = blocks.find((block) => block.height > available)
  if (oversized) {
    // Tek bir ürün bloğu BOŞ bir sayfaya bile sığmıyorsa plan üretilmez;
    // çağıran güvenli davranışa düşer (kırpma/kısaltma YOK).
    return {
      required: true,
      aggregated,
      pages: [],
      quantityTotal,
      reason: `ürün bloğu tek sayfaya sığmıyor (${oversized.height} > ${available})`,
    }
  }

  const pages: ProductDetailBlock[][] = []
  let current: ProductDetailBlock[] = []
  let used = 0
  for (const block of blocks) {
    const needed = current.length === 0 ? block.height : BLOCK_GAP + block.height
    if (used + needed > available && current.length > 0) {
      pages.push(current)
      current = [block]
      used = block.height
      continue
    }
    current.push(block)
    used += needed
  }
  if (current.length > 0) pages.push(current)

  return {
    required: true,
    aggregated,
    pages: pages.map((pageBlocks, index) => ({
      page: index + 1,
      totalPages: pages.length,
      blocks: pageBlocks,
    })),
    quantityTotal,
    reason: null,
  }
}

// ── ZPL üretimi ──────────────────────────────────────────────────────────

/** `^FD` gövdesine giremeyecek denetim karakterlerini temizler. */
function escapeFieldData(value: string): string {
  return String(value ?? '').replace(/[\^~]/g, ' ').trim()
}

function textField(
  x: number,
  y: number,
  height: number,
  width: number,
  value: string,
): string {
  return `^FO${x},${y}^A0N,${height},${width}^FD${escapeFieldData(value)}^FS`
}

/**
 * Bir ürün detay sayfasını ZPL'e çevirir.
 *
 * DAHİLİ barkod paket referansıdır (packageId), taşıyıcı barkodu DEĞİLDİR:
 * yanında açıkça "PAKET" yazar ve Sürat T.No / Code128 / DataMatrix / QR
 * BURADA TEKRAR EDİLMEZ.
 */
export function buildProductDetailPageZpl(
  page: ProductDetailPage,
  context: ProductDetailContext,
  plan: ProductDetailPlan,
): string {
  const parts: string[] = ['^XA', '^CI28', `^PW${PAGE_WIDTH}`, `^LL0${PAGE_LENGTH}`, '^LS0']
  let y = 24

  parts.push(textField(MARGIN_LEFT, y, 34, 30, 'ÜRÜN DETAYI'))
  y += TITLE_HEIGHT

  const headerLines = [
    `Sipariş: ${context.orderNumber}`,
    `Paket: ${context.packageId}`,
    `Alıcı: ${context.recipient}`,
    `Kalem: ${plan.aggregated.length}   Toplam Adet: ${plan.quantityTotal}`,
    `Sayfa: ${page.page} / ${page.totalPages}`,
  ]
  for (const line of headerLines) {
    parts.push(
      textField(MARGIN_LEFT, y, HEADER_FONT.height, HEADER_FONT.width, line),
    )
    y += HEADER_LINE_HEIGHT + HEADER_LINE_GAP
  }

  // DAHİLİ paket barkodu — taşıyıcı barkodu DEĞİL.
  y += RULE_GAP
  const barcodePayload = escapeFieldData(context.packageId).replace(/\s+/g, '')
  if (barcodePayload !== '') {
    parts.push(
      `^BY${BARCODE_MODULE},3,${BARCODE_BAR_HEIGHT}`,
      `^FO${MARGIN_LEFT},${y}^BCN,${BARCODE_BAR_HEIGHT},N,N^FD${barcodePayload}^FS`,
    )
    y += BARCODE_BAR_HEIGHT
    parts.push(
      textField(MARGIN_LEFT, y, 18, 15, `PAKET  ${barcodePayload}`),
    )
    y += BARCODE_CAPTION_HEIGHT
  }
  y += RULE_GAP
  parts.push(`^FO${MARGIN_LEFT},${y}^GB${CONTENT_WIDTH},0,2^FS`)
  y += RULE_GAP

  for (const [index, block] of page.blocks.entries()) {
    if (index > 0) y += BLOCK_GAP
    for (const line of block.titleLines) {
      parts.push(
        textField(MARGIN_LEFT, y, TITLE_FONT.height, TITLE_FONT.width, line),
      )
      y += BLOCK_TITLE_HEIGHT
    }
    y += BLOCK_LINE_GAP
    for (const line of block.metaLines) {
      parts.push(
        textField(MARGIN_LEFT + 12, y, META_FONT.height, META_FONT.width, line),
      )
      y += BLOCK_META_HEIGHT
    }
  }

  parts.push('^PQ1,0,1,Y', '^XZ')
  return parts.join('\n')
}

export interface ProductDetailLabel {
  readonly kind: 'product_detail'
  readonly page: number
  readonly totalPages: number
  readonly zpl: string
}

/** Plandan tüm ek sayfaların ZPL'ini üretir (sıra DETERMINISTIKTIR). */
export function buildProductDetailLabels(
  plan: ProductDetailPlan,
  context: ProductDetailContext,
): ProductDetailLabel[] {
  if (!plan.required || plan.reason !== null) return []
  return plan.pages.map((page) => ({
    kind: 'product_detail' as const,
    page: page.page,
    totalPages: page.totalPages,
    zpl: buildProductDetailPageZpl(page, context, plan),
  }))
}
