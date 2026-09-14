// Etiket görsel yerleşim profilleri — SAF (IO/DOM YOK).
//
// KÖK NEDEN (canlı): ürün footer'ı SABİT ~9.4mm idi. İki kalemli gerçek bir
// siparişte (uzun ürün adı + renk/beden/SKU satırı ×2) metin bu alana
// sığmıyor ve sipariş "Ürün bilgileri tek etikete sığmıyor." ile atlanıyordu.
// Oysa rota/teslimat bölümü tek satırlık kısa rotalarda boş alan bırakıyordu.
//
// ÇÖZÜM: tek sabit alan yerine SINIRLI sayıda güvenli profil. Profil YALNIZ
// görsel ölçüleri değiştirir; toplam etiket 100×100mm, barkodun yatay
// geometrisi ve 10X sessiz alan DEĞİŞMEZ. İlk sığan profil seçilir ve seçim
// DETERMINISTIKTIR (aynı girdi -> aynı profil, reprint aynı sonucu verir).
//
// Sessiz kırpma YOKTUR: hiçbir profil sığdıramazsa çağıran katman AÇIK hata
// verir (PRODUCT_OVERFLOW_MESSAGE).

import { LABEL_TEMPLATE_GEOMETRY } from './labelTemplateGeometry'

export interface LabelLayoutProfile {
  key: 'standard' | 'compact-multi' | 'dense-multi'
  /** Teslimat/rota satırı yüksekliği (mm). */
  deliveryRowMm: number
  /** Adres satırı yüksekliği (mm). */
  addressRowMm: number
  /** Ürün footer'ının dikey iç boşluğu (mm, tek taraf). */
  productPaddingMm: number
  /** Rota bloğunun dikey bütçesi (mm). */
  routeBudgetMm: number
}

// ═══ QR BOYUTU PROFİLDEN ÇIKARILDI — İÇERİKTEN TÜREMEZ ═══════════════
//
// Önceden `largeQrMm`/`smallQrMm` bu profillerin ALANIYDI ve profil seçimi
// ÜRÜN FOOTER'ININ SIĞMASINA göre yapılıyordu. Sonuç ölçüldü: 3+ kalemli
// siparişte büyük QR 21.0 → 18.0 mm, küçük QR 12.5 → 11.0 mm küçülüyordu.
// Yani 1. öncelik (QR okunabilirliği) 4. öncelik (opsiyonel ürün footer'ı)
// için feda ediliyordu.
//
// QR artık ŞABLON geometrisinden gelir (`labelTemplateGeometry.ts`).
// Profiller YALNIZ adres/teslimat/footer düşey bütçesini yeniden dağıtır.
//
// TESLİMAT SATIRI QR'I TAŞIR: `deliveryRowMm` büyük QR'ın kenarından KÜÇÜK
// OLAMAZ. Eskiden compact/dense kademelerinde 20.0 ve 17.5 mm'ye düşüyordu —
// QR'ın 18.0 ve 15.5'e inmesinin GERÇEK sebebi buydu. Satır artık SABİT
// kalır; kazanılacak alan adres satırından ve iç boşluktan alınır.
const LARGE_QR_SIDE_MM = LABEL_TEMPLATE_GEOMETRY.cargoflow_html.largeQr!.sideMm
const SMALL_QR_SIDE_MM = LABEL_TEMPLATE_GEOMETRY.cargoflow_html.smallQr!.sideMm
/** QR ile teslimat satırı kenarı arasındaki asgari pay (mm). */
const QR_ROW_CLEARANCE_MM = 2
/** Her profilde geçerli teslimat satırı yüksekliği (mm). */
const DELIVERY_ROW_MM = LARGE_QR_SIDE_MM + QR_ROW_CLEARANCE_MM

/** Şablondan gelen kanonik QR kenarları — profil DEĞİŞTİREMEZ. */
export const LABEL_QR_SIDES_MM = {
  largeQrMm: LARGE_QR_SIDE_MM,
  smallQrMm: SMALL_QR_SIDE_MM,
} as const

// SABİT satır toplamı 87mm KORUNUR (header 12 + barkod 20.5 + adres +
// ödeme 10 + teslimat). Profiller adres/teslimat arasında yeniden dağıtır;
// kazanılan alan ürün footer'ına geçer.
export const LABEL_LAYOUT_PROFILES: LabelLayoutProfile[] = [
  {
    key: 'standard',
    deliveryRowMm: DELIVERY_ROW_MM,
    addressRowMm: 21.5,
    productPaddingMm: 1.2,
    routeBudgetMm: 13.4,
  },
  {
    // İki kalem: adres satırından 1.5 mm ve iç boşluktan pay alınır.
    // TESLİMAT SATIRI ALINMAZ — QR'ı taşıyan satır odur.
    key: 'compact-multi',
    deliveryRowMm: DELIVERY_ROW_MM,
    addressRowMm: 20,
    productPaddingMm: 0.9,
    routeBudgetMm: 11,
  },
  {
    // Son güvenli kademe. Barındırdığı tek esneklik adres satırı ve iç
    // boşluktur; QR, barkod alanı ve header HIÇ küçülmez.
    key: 'dense-multi',
    deliveryRowMm: DELIVERY_ROW_MM,
    addressRowMm: 19,
    productPaddingMm: 0.7,
    routeBudgetMm: 9.4,
  },
]

/** Etiket yüksekliği (mm) eksi kenarlık; sabit satırların oturduğu alan. */
const BODY_HEIGHT_MM = 99.3
const HEADER_ROW_MM = 12
const BARCODE_ROW_MM = 20.5
const CARGO_ROW_MM = 10

// Bir profilde ürün footer'ına kalan KULLANILABILIR yükseklik (mm).
export function resolveProductAreaHeightMm(profile: LabelLayoutProfile): number {
  const fixed =
    HEADER_ROW_MM +
    BARCODE_ROW_MM +
    profile.addressRowMm +
    CARGO_ROW_MM +
    profile.deliveryRowMm
  return Math.max(0, BODY_HEIGHT_MM - fixed - profile.productPaddingMm * 2)
}

// ═══ ÜRÜN DETAY DEVAM SAYFASI (PRINT-GEOMETRY-003) ═══════════════════════
//
// PRINT-GEOMETRY-001 QR'ı içerikten kurtardı; bedeli ÖLÇÜLDÜ: tek sayfaya
// sığan kalem sayısı 3'e düştü (bu turda YENİDEN ölçüldü — kısa ad, uzun ad,
// varyantsız, SKU'suz, adet 12 ve Türkçe karakterli içeriklerin HEPSİNDE
// sınır AYNI: 3 kalem).
//
// Kapasiteyi geri kazanmanın QR'a dokunmayan yolu, ZPL yolunda ZATEN var olan
// ürün detay sayfasına taşmadır (`PRODUCT_DETAIL_THRESHOLD`). Bu sabitler o
// mekanizmanın HTML karşılığını tanımlar.
//
// DEVAM SAYFASI SEVKIYAT ETİKETİ DEĞİLDİR: barkod, adres, rota ve QR YOKTUR;
// yalnız ürün detayı ve sayfayı siparişe bağlayan kimlik taşır. Bu yüzden
// dikey bütçesi sayfanın TAMAMIDIR (eksi başlık ve iç boşluk).
/** Devam sayfası başlığı: "Ürün Detayı" + sipariş kimliği + "Sayfa X / Y". */
const CONTINUATION_HEADER_MM = 12
/** Devam sayfasının dikey iç boşluğu (mm, tek taraf). */
const CONTINUATION_PADDING_MM = 1.5

/**
 * Bir DEVAM sayfasında ürün satırlarına kalan yükseklik (mm).
 *
 * Sayfa 1'in ürün alanından ~6 kat büyüktür; taşma bu yüzden birkaç sayfada
 * değil, tipik olarak TEK devam sayfasında biter.
 */
export function resolveContinuationProductAreaHeightMm(): number {
  return Math.max(
    0,
    BODY_HEIGHT_MM - CONTINUATION_HEADER_MM - CONTINUATION_PADDING_MM * 2,
  )
}

export const CONTINUATION_PAGE_METRICS = {
  headerMm: CONTINUATION_HEADER_MM,
  paddingMm: CONTINUATION_PADDING_MM,
} as const
