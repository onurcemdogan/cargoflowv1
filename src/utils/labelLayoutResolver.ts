// Etiket yerleşiminin TEK KAYNAĞI — SAF (IO/DOM YOK).
//
// KÖK NEDEN (canlı, sipariş 7270035237446594):
// Ön kontrol (App.tsx resolveFitBlock) `resolveProductFit`'i SABİT
// `availableHeightMm: 9.4` ile çağırıyordu — yani YALNIZ 'standard' profilin
// ürün alanı. Adaptif profiller (compact-multi / dense-multi) YALNIZ
// renderer'da (browserLabelPrint) deneniyordu. İki kalemli sipariş standard'a
// sığmadığı için ön kontrol siparişi ATLIYOR, renderer HİÇ ÇALIŞMIYOR ve
// dense profil DENENMEDEN "Ürün bilgileri tek etikete sığmıyor." dönüyordu.
// Önizleme de (LabelHtmlPreview) aynı sabit 9.4'ü kullanıyordu.
//
// ÇÖZÜM: profil seçimi TEK yerde. Ön kontrol, önizleme ve baskı renderer'ı
// AYNI fonksiyonu çağırır; aynı sipariş için "ön kontrol sığmaz / renderer
// sığar" çelişkisi ARTIK MÜMKÜN DEĞİLDİR.
import {
  LABEL_LAYOUT_PROFILES,
  resolveProductAreaHeightMm,
  type LabelLayoutProfile,
} from './labelLayoutProfile'
import {
  PRODUCT_OVERFLOW_MESSAGE,
  resolveProductFit,
  type ProductFitResult,
} from './labelProductFit'
import {
  ROUTE_OVERFLOW_MESSAGE,
  resolveRouteFit,
  type RouteFitResult,
} from './labelRouteFit'

/** Ürün satırı — metadata çözümlemesi ÇAĞIRAN katmanda yapılır. */
export interface LabelLayoutItem {
  productName: string
  quantity: number
  color?: string
  size?: string
  sku?: string
}

export interface LabelLayoutInput {
  items: LabelLayoutItem[]
  destination: string
  transfer: string
}

export interface LabelLayoutMetrics {
  productAreaMm: number
  routeBudgetMm: number
  addressRowMm: number
  deliveryRowMm: number
  largeQrMm: number
  smallQrMm: number
}

export type LabelLayoutResult =
  | {
      ok: true
      profile: LabelLayoutProfile
      productFit: ProductFitResult
      routeFit: RouteFitResult
      metrics: LabelLayoutMetrics
    }
  | { ok: false; reason: string }

/** Ürün satırı genişliği (mm) — gövde 93.9 eksi yatay padding. */
const PRODUCT_WIDTH_MM = 89
/** Rota metin sütunu (mm) — QR'lar arasında kalan alan. */
const ROUTE_WIDTH_MM = 52

// Profiller SIRALI denenir; İLK sığan seçilir. Saf fonksiyonlar kullanıldığı
// için seçim DETERMINISTIKTIR: aynı girdi -> aynı profil (reprint dahil).
export function resolveLabelLayout(input: LabelLayoutInput): LabelLayoutResult {
  const items = (input.items ?? []).map((line) => ({
    productName: String(line.productName ?? ''),
    quantity: Number(line.quantity) || 1,
    color: line.color,
    size: line.size,
    sku: line.sku,
  }))
  let anyRouteFits = false

  for (const profile of LABEL_LAYOUT_PROFILES) {
    const routeFit = resolveRouteFit({
      destination: input.destination,
      transfer: input.transfer,
      availableWidthMm: ROUTE_WIDTH_MM,
      availableHeightMm: profile.routeBudgetMm,
    })
    if (routeFit.fits) anyRouteFits = true
    if (!routeFit.fits) continue

    const productAreaMm = resolveProductAreaHeightMm(profile)
    const productFit = resolveProductFit({
      items,
      availableWidthMm: PRODUCT_WIDTH_MM,
      availableHeightMm: productAreaMm,
    })
    if (!productFit.fits) continue

    return {
      ok: true,
      profile,
      productFit,
      routeFit,
      metrics: {
        productAreaMm,
        routeBudgetMm: profile.routeBudgetMm,
        addressRowMm: profile.addressRowMm,
        deliveryRowMm: profile.deliveryRowMm,
        largeQrMm: profile.largeQrMm,
        smallQrMm: profile.smallQrMm,
      },
    }
  }

  // Hiçbir güvenli profil sığdıramadı. Sessiz kırpma YOK: açık sebep.
  return {
    ok: false,
    reason: anyRouteFits ? PRODUCT_OVERFLOW_MESSAGE : ROUTE_OVERFLOW_MESSAGE,
  }
}

/** Ön kontrol yardımcısı: sığıyorsa null, sığmıyorsa güvenli sebep. */
export function resolveLabelLayoutBlockReason(
  input: LabelLayoutInput,
): string | null {
  const layout = resolveLabelLayout(input)
  return layout.ok ? null : layout.reason
}
