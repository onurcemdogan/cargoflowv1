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
  resolveContinuationProductAreaHeightMm,
  type LabelLayoutProfile,
  LABEL_QR_SIDES_MM,
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
        // QR ŞABLONDAN gelir, profilden DEĞİL. İçerik bu iki değeri
        // DEĞİŞTİREMEZ (bkz. labelTemplateGeometry).
        largeQrMm: LABEL_QR_SIDES_MM.largeQrMm,
        smallQrMm: LABEL_QR_SIDES_MM.smallQrMm,
      },
    }
  }

  // Hiçbir güvenli profil sığdıramadı. Sessiz kırpma YOK: açık sebep.
  return {
    ok: false,
    reason: anyRouteFits ? PRODUCT_OVERFLOW_MESSAGE : ROUTE_OVERFLOW_MESSAGE,
  }
}

/**
 * Ön kontrol yardımcısı: baskı ÜRETİLEBİLİYORSA null, üretilemiyorsa sebep.
 *
 * ═══ PRINT-GEOMETRY-003: ARTIK SAYFALAMA FARKINDA ════════════════════════
 *
 * Eskiden bu kontrol "her şey TEK sayfaya sığıyor mu?" diye soruyordu ve
 * 4+ kalemli siparişleri, sevkiyat etiketi pekâlâ üretilebilir olmasına
 * rağmen BLOKLUYORDU. Artık soru doğru sorulur: "yazdırılabilir bir belge
 * üretilebiliyor mu?" Ürün detayı sığmıyorsa sipariş engellenmez, detay
 * DEVAM SAYFASINA taşar. Blok YALNIZ sevkiyat sayfasının kendisi
 * üretilemediğinde (rota sığmadığında) döner.
 */
export function resolveLabelLayoutBlockReason(
  input: LabelLayoutInput,
): string | null {
  const plan = planLabelProductPages(input)
  return plan.ok ? null : plan.reason
}

// ═══ ÜRÜN SAYFALAMA (PRINT-GEOMETRY-003) ═════════════════════════════════
//
// ÖLÇÜLEN KAPASİTE KUSURU (9ddee46 tabanında YENİDEN ölçüldü):
//
//   kalem   1    2    3    4+
//   sonuç   OK   OK   OK   "Ürün bilgileri tek etikete sığmıyor."
//
// Sınır İÇERİKTEN BAĞIMSIZ olarak 3'tür: kısa ad, uzun ad, varyantsız,
// SKU'suz, adet 12 ve Türkçe karakterli içeriklerin HEPSİNDE aynı. Yani
// 4+ kalemli GEÇERLİ siparişler yalnız opsiyonel ürün detayı yüzünden
// BASILAMIYORDU.
//
// İKİ ÇÖZÜM DE REDDEDİLDİ: (A) QR'ı yeniden küçültmek — çakışma önceliğinin
// tersi; (B) siparişi engellemek — sevkiyat etiketi zaten üretilebilir
// durumda. DOĞRU çözüm: SAYFA 1 sevkiyat etiketi olarak KALIR, sığmayan ürün
// satırları DEVAM SAYFALARINA taşar.
//
// KARAR TARAYICIDAN ÖNCE VERİLİR: sayfalama saf hesapla yapılır, DOM ölçümü
// YOKTUR. Aynı girdi HER ZAMAN aynı sayfa sayısını, aynı dağılımı ve aynı
// tipografiyi üretir (reprint dahil).

/** Bir sayfanın ürün yerleşimi — sayfa 1 ve devam sayfaları için ORTAK. */
export interface LabelProductPage {
  kind: 'shipping' | 'product_continuation'
  items: LabelLayoutItem[]
  fit: ProductFitResult
}

export type LabelProductPagePlan =
  | {
      ok: true
      profile: LabelLayoutProfile
      routeFit: RouteFitResult
      metrics: LabelLayoutMetrics
      /** Sayfa 1 DAHİL tüm sayfalar, BASKI SIRASINDA. */
      pages: LabelProductPage[]
      totalPages: number
    }
  | { ok: false; reason: string }

/**
 * Verilen alana sığan EN UZUN ÖNEK (prefix) uzunluğu.
 *
 * SIRA ASLA DEĞİŞTİRİLMEZ: ürünler yeniden sıralanmaz, yalnız baştan itibaren
 * kaç tanesinin sığdığı bulunur. Böylece `order.items` sırası sayfalar
 * boyunca AYNEN korunur.
 */
function longestFittingPrefix(
  items: readonly LabelLayoutItem[],
  availableHeightMm: number,
): { count: number; fit: ProductFitResult | null } {
  let best: { count: number; fit: ProductFitResult | null } = {
    count: 0,
    fit: null,
  }
  for (let count = 1; count <= items.length; count += 1) {
    const fit = resolveProductFit({
      items: items.slice(0, count) as LabelLayoutItem[],
      availableWidthMm: PRODUCT_WIDTH_MM,
      availableHeightMm,
    })
    // İLK SIĞMAYANDA DURULUR: ürün eklemek yüksekliği ASLA azaltmaz, bu
    // yüzden daha uzun bir önek de sığmaz.
    if (!fit.fits) break
    best = { count, fit }
  }
  return best
}

export function planLabelProductPages(
  input: LabelLayoutInput,
): LabelProductPagePlan {
  const items: LabelLayoutItem[] = (input.items ?? []).map((line) => ({
    productName: String(line.productName ?? ''),
    quantity: Number(line.quantity) || 1,
    color: line.color,
    size: line.size,
    sku: line.sku,
  }))

  // ── SAYFA 1: SEVKİYAT ETİKETİ ───────────────────────────────────────
  //
  // Profil seçimi bugünkü sözleşmeyle AYNI kalır, tek farkla: artık "tüm
  // kalemler sığıyor mu" değil, "KAÇ kalem sığıyor" sorulur. En çok kalem
  // sığdıran profil seçilir; eşitlikte İLK profil kazanır (adres satırı en
  // geniş olan). 0-3 kalemde sonuç bugünküyle BİREBİR aynıdır.
  let anyRouteFits = false
  let chosen: {
    profile: LabelLayoutProfile
    routeFit: RouteFitResult
    productAreaMm: number
    count: number
    fit: ProductFitResult | null
  } | null = null

  for (const profile of LABEL_LAYOUT_PROFILES) {
    const routeFit = resolveRouteFit({
      destination: input.destination,
      transfer: input.transfer,
      availableWidthMm: ROUTE_WIDTH_MM,
      availableHeightMm: profile.routeBudgetMm,
    })
    if (!routeFit.fits) continue
    anyRouteFits = true

    const productAreaMm = resolveProductAreaHeightMm(profile)
    const prefix = longestFittingPrefix(items, productAreaMm)
    if (!chosen || prefix.count > chosen.count) {
      chosen = { profile, routeFit, productAreaMm, ...prefix }
    }
  }

  // ROTA SIĞMIYORSA SEVKİYAT ETİKETİ ÜRETİLEMEZ — bu davranış DEĞİŞMEDİ.
  // Ürün detayı opsiyoneldir, rota DEĞİLDİR.
  if (!anyRouteFits || !chosen) {
    return { ok: false, reason: ROUTE_OVERFLOW_MESSAGE }
  }

  const pageOneItems = items.slice(0, chosen.count)
  const pageOneFit =
    chosen.fit ??
    resolveProductFit({
      items: [],
      availableWidthMm: PRODUCT_WIDTH_MM,
      availableHeightMm: chosen.productAreaMm,
    })

  const pages: LabelProductPage[] = [
    { kind: 'shipping', items: pageOneItems, fit: pageOneFit },
  ]

  // ── DEVAM SAYFALARI ─────────────────────────────────────────────────
  //
  // GÜVENLİK: her sayfa EN AZ bir kalem almalıdır. Alamıyorsa sayfalama
  // ilerlemez ve SONSUZ DÖNGÜ oluşurdu; bu durumda sessizce kalem düşürmek
  // yerine AÇIK hata verilir.
  const continuationAreaMm = resolveContinuationProductAreaHeightMm()
  let cursor = chosen.count
  while (cursor < items.length) {
    const remaining = items.slice(cursor)
    const prefix = longestFittingPrefix(remaining, continuationAreaMm)
    if (prefix.count === 0 || !prefix.fit) {
      // Tek bir kalem devam sayfasına BİLE sığmıyor. Sessiz kırpma YOK.
      return { ok: false, reason: PRODUCT_OVERFLOW_MESSAGE }
    }
    pages.push({
      kind: 'product_continuation',
      items: remaining.slice(0, prefix.count),
      fit: prefix.fit,
    })
    cursor += prefix.count
  }

  return {
    ok: true,
    profile: chosen.profile,
    routeFit: chosen.routeFit,
    metrics: {
      productAreaMm: chosen.productAreaMm,
      routeBudgetMm: chosen.profile.routeBudgetMm,
      addressRowMm: chosen.profile.addressRowMm,
      deliveryRowMm: chosen.profile.deliveryRowMm,
      // QR ŞABLONDAN gelir. Sayfalama onu DEĞİŞTİREMEZ — bu biletin
      // varlık sebebi tam olarak budur.
      largeQrMm: LABEL_QR_SIDES_MM.largeQrMm,
      smallQrMm: LABEL_QR_SIDES_MM.smallQrMm,
    },
    pages,
    totalPages: pages.length,
  }
}
