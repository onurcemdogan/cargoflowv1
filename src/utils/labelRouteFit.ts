// Rota / aktarma satırlarının etiket alanına SIĞDIRILMASI — SAF (IO/DOM YOK).
//
// KÖK NEDEN (görsel inceleme): rota satırları sabit 15pt/13pt yazılıyordu.
// "KASTAMONU / ARAC" gibi 16+ karakterlik bir rota, QR'lar arasındaki ~52mm'lik
// dar sütunda 15pt ile İKİ satıra sarıyor; iki satırlık rota + aktarma satırı
// teslimat bölümünün yüksekliğini aşıyor ve metin ürün footer'ının üstüne,
// bölüm ayırıcı çizgisinin içinden geçerek taşıyordu.
//
// ÇÖZÜM: product-fit ile AYNI desen — kademeli punto. Sessiz kırpma
// (overflow:hidden / line-clamp) YOKTUR; hiçbir kademe sığmazsa AÇIK hata.
// Ürün footer yüksekliği, etiket toplam yüksekliği ve product-fit iş kuralı
// DEĞİŞMEZ; bu yalnız rota bloğunun kendi bütçesidir.

export interface RouteFitTier {
  /** Rota (il/ilçe) satırı punto. */
  destinationPt: number
  /** Aktarma satırı punto. */
  transferPt: number
  lineHeight: number
}

export interface RouteFitInput {
  destination: string
  transfer: string
  /** QR'lar arasındaki metin sütunu genişliği (mm). */
  availableWidthMm: number
  /** İki rota satırı için kalan dikey bütçe (mm). */
  availableHeightMm: number
}

export interface RouteFitResult {
  fits: boolean
  tier: RouteFitTier
  /** Seçilen kademede satır sayısı (tanı için). */
  destinationLines: number
  transferLines: number
  estimatedHeightMm: number
}

export const ROUTE_OVERFLOW_MESSAGE =
  'Rota/aktarma bilgisi etiket alanına sığmıyor.'

// Referanstaki güçlü görünüm ÖNCE font-weight ile sağlanır; punto yalnız
// gerektiği kadar düşer. En büyük kademe fiziksel alana ZORLA sıkıştırılmaz.
export const ROUTE_FIT_TIERS: RouteFitTier[] = [
  { destinationPt: 13, transferPt: 11.5, lineHeight: 1 },
  { destinationPt: 12, transferPt: 10.5, lineHeight: 0.98 },
  { destinationPt: 11, transferPt: 10, lineHeight: 0.96 },
  { destinationPt: 10, transferPt: 9, lineHeight: 0.95 },
  // Minimum sınır: bunun altına İNİLMEZ (okunaklılık).
  { destinationPt: 9, transferPt: 8, lineHeight: 0.95 },
]

const PT_TO_MM = 25.4 / 72
// Ağır grotesk (Arial Black) ortalama karakter genişliği ~0.78em. Kasıtlı
// olarak KÖTÜMSER: gerçek render bu tahminden dar çıkar, taşma olmaz.
const DISPLAY_CHAR_EM = 0.78

function lineCount(text: string, pt: number, widthMm: number): number {
  const value = String(text ?? '').trim()
  if (!value) return 0
  const charMm = pt * PT_TO_MM * DISPLAY_CHAR_EM
  if (charMm <= 0 || widthMm <= 0) return 1
  const perLine = Math.max(1, Math.floor(widthMm / charMm))
  return Math.max(1, Math.ceil(value.length / perLine))
}

export function resolveRouteFit(input: RouteFitInput): RouteFitResult {
  const width = Math.max(0, input.availableWidthMm)
  const height = Math.max(0, input.availableHeightMm)

  let last: RouteFitResult | null = null
  for (const tier of ROUTE_FIT_TIERS) {
    const destinationLines = lineCount(input.destination, tier.destinationPt, width)
    const transferLines = lineCount(input.transfer, tier.transferPt, width)
    const estimatedHeightMm =
      destinationLines * tier.destinationPt * tier.lineHeight * PT_TO_MM +
      transferLines * tier.transferPt * tier.lineHeight * PT_TO_MM
    const result: RouteFitResult = {
      fits: estimatedHeightMm <= height,
      tier,
      destinationLines,
      transferLines,
      estimatedHeightMm,
    }
    if (result.fits) return result
    last = result
  }
  // Hiçbir kademe sığmadı: SESSİZ KIRPMA YOK, açık hata çağıran katmanda.
  return last ?? {
    fits: false,
    tier: ROUTE_FIT_TIERS[ROUTE_FIT_TIERS.length - 1],
    destinationLines: 0,
    transferLines: 0,
    estimatedHeightMm: 0,
  }
}
