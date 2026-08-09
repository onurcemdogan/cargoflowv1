// BASKI İŞİ (PRINT JOB) — TEK MERKEZİ KURUCU.
//
// Tekil, toplu ve reprint yolları AYNI bu fonksiyonu kullanır; birleştirme
// mantığı App.tsx'in üç ayrı yerine KOPYALANMAZ.
//
// ═══ SÖZLEŞMELER ═════════════════════════════════════════════════════════
//
//  1) SAYFA SIRASI CANONICAL: taşıyıcı HER ZAMAN ilk, ardından ek sayfalar
//     1..N. Sıra dizi konumundan değil, doğrulanmış `page` alanından gelir.
//
//  2) TAM İŞ YA DA HİÇ: ek sayfalardan biri bozuksa (hash uyuşmuyor, sayfa
//     eksik, sıra bozuk) İŞ ÜRETİLMEZ. Taşıyıcı sayfayı TEK BAŞINA basmak,
//     depoda ürün bilgisini sessizce kaybettirir — Aşama 2'deki
//     "taşıyıcı-only başarı yok" kuralının baskı katmanındaki karşılığıdır.
//
//  3) KALICI BAYT: bu fonksiyon ZPL ÜRETMEZ, ürün toplamaz, sayfalamaz.
//     Yalnız kalıcı baytları sıralar ve birleştirir.
//
//  4) `printZpl` DOKUNULMAZ: birleşik yük TÜREVDİR ve yalnız bellekte yaşar;
//     kalıcı artefakta geri YAZILMAZ (repair CLI / render / immutable
//     sözleşmeleri bozulmasın).

export interface PrintablePage {
  readonly kind: 'carrier' | 'product_detail'
  readonly page: number
  readonly zpl: string
  readonly sha256?: string
}

export interface PrintableSupplementalInput {
  readonly kind?: string
  readonly page?: number
  readonly totalPages?: number
  readonly zpl?: string
  readonly sha256?: string
}

export interface PrintableJobInput {
  /** Taşıyıcı etiketi — kalıcı `printZpl`. */
  readonly carrierZpl: string
  /** Kalıcı ek sayfalar. Eski kayıtlarda yok/boş olabilir. */
  readonly supplementalLabels?: readonly PrintableSupplementalInput[]
  /**
   * Ek sayfaların içerik doğrulaması için hash fonksiyonu. Verilmezse hash
   * karşılaştırması ATLANIR (saf çağıranlar için); sunucu tarafı HER ZAMAN
   * verir.
   */
  readonly hash?: (value: string) => string
}

export type PrintableJobBlockReason =
  | 'carrier_missing'
  | 'supplemental_page_missing'
  | 'supplemental_order_invalid'
  | 'supplemental_hash_mismatch'
  | 'supplemental_total_mismatch'

export interface PrintableJob {
  readonly printReady: boolean
  readonly reason: PrintableJobBlockReason | null
  /** Sıralı fiziksel sayfalar; iş üretilemediyse BOŞ. */
  readonly pages: readonly PrintablePage[]
  readonly labelPageCount: number
  readonly productDetailPageCount: number
  /** Tek baskı işi için birleşik ZPL; iş üretilemediyse boş dize. */
  readonly combinedZpl: string
}

const blocked = (reason: PrintableJobBlockReason): PrintableJob => ({
  printReady: false,
  reason,
  pages: [],
  labelPageCount: 0,
  productDetailPageCount: 0,
  combinedZpl: '',
})

/**
 * Kalıcı baytlardan TEK baskı işi kurar.
 *
 * Eski kayıt (ek sayfa yok) → tek sayfalık geçerli iş.
 * Yeni kayıt (ek sayfa var) → taşıyıcı + 1..N, hepsi doğrulanmış.
 * Herhangi bir tutarsızlık → `printReady: false`, sayfa YOK, birleşik yük YOK.
 */
export function buildPrintableJob(input: PrintableJobInput): PrintableJob {
  const carrierZpl = String(input.carrierZpl ?? '')
  if (!carrierZpl.trim()) return blocked('carrier_missing')

  const raw = Array.isArray(input.supplementalLabels)
    ? input.supplementalLabels
    : []
  const supplemental: PrintablePage[] = []
  for (const [index, entry] of raw.entries()) {
    const zpl = String(entry?.zpl ?? '')
    if (!zpl.trim()) return blocked('supplemental_page_missing')
    // SIRA: dizi konumu ile `page` alanı BİRBİRİNİ doğrular.
    if (Number(entry?.page) !== index + 1) {
      return blocked('supplemental_order_invalid')
    }
    if (Number(entry?.totalPages) !== raw.length) {
      return blocked('supplemental_total_mismatch')
    }
    if (input.hash && entry?.sha256 && input.hash(zpl) !== entry.sha256) {
      return blocked('supplemental_hash_mismatch')
    }
    supplemental.push({
      kind: 'product_detail',
      page: index + 1,
      zpl,
      ...(entry?.sha256 ? { sha256: entry.sha256 } : {}),
    })
  }

  // TAŞIYICI HER ZAMAN İLK.
  const pages: PrintablePage[] = [
    { kind: 'carrier', page: 1, zpl: carrierZpl },
    ...supplemental,
  ]
  return {
    printReady: true,
    reason: null,
    pages,
    labelPageCount: pages.length,
    productDetailPageCount: supplemental.length,
    // Türev yük: kalıcı artefakta GERİ YAZILMAZ.
    combinedZpl: pages.map((page) => page.zpl).join('\n'),
  }
}

/**
 * Toplu baskıda birden çok gönderiyi TEK işe birleştirir.
 *
 * Sıra gönderi bazındadır: her gönderinin taşıyıcı sayfası KENDİ ek
 * sayfalarından hemen önce gelir. Ek sayfalar işin sonuna TOPLANMAZ.
 * Bir gönderi bile basılamaz durumdaysa iş üretilmez.
 */
export function buildBatchPrintableJob(
  inputs: readonly PrintableJobInput[],
): PrintableJob {
  const pages: PrintablePage[] = []
  let productDetailPageCount = 0
  for (const input of inputs) {
    const job = buildPrintableJob(input)
    if (!job.printReady) return blocked(job.reason ?? 'carrier_missing')
    pages.push(...job.pages)
    productDetailPageCount += job.productDetailPageCount
  }
  if (pages.length === 0) return blocked('carrier_missing')
  return {
    printReady: true,
    reason: null,
    pages,
    labelPageCount: pages.length,
    productDetailPageCount,
    combinedZpl: pages.map((page) => page.zpl).join('\n'),
  }
}
