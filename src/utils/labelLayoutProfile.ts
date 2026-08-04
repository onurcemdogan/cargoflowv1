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

export interface LabelLayoutProfile {
  key: 'standard' | 'compact-multi' | 'dense-multi'
  /** Teslimat/rota satırı yüksekliği (mm). */
  deliveryRowMm: number
  /** Adres satırı yüksekliği (mm). */
  addressRowMm: number
  /** Ürün footer'ının dikey iç boşluğu (mm, tek taraf). */
  productPaddingMm: number
  /** QR kenar uzunlukları (mm). */
  largeQrMm: number
  smallQrMm: number
  /** Rota bloğunun dikey bütçesi (mm). */
  routeBudgetMm: number
}

// SABİT satır toplamı 87mm KORUNUR (header 12 + barkod 20.5 + adres +
// ödeme 10 + teslimat). Profiller adres/teslimat arasında yeniden dağıtır;
// kazanılan alan ürün footer'ına geçer.
export const LABEL_LAYOUT_PROFILES: LabelLayoutProfile[] = [
  {
    key: 'standard',
    deliveryRowMm: 23,
    addressRowMm: 21.5,
    productPaddingMm: 1.2,
    largeQrMm: 21,
    smallQrMm: 12.5,
    routeBudgetMm: 13.4,
  },
  {
    // İki kalem: kısa rotada teslimat bölümünden 3mm, adresten 1.5mm alınır.
    key: 'compact-multi',
    deliveryRowMm: 20,
    addressRowMm: 20,
    productPaddingMm: 0.9,
    largeQrMm: 18,
    smallQrMm: 11,
    routeBudgetMm: 11,
  },
  {
    // Son güvenli kademe. QR'lar okunabilir minimumun (15mm/9mm) ALTINA
    // İNMEZ; barkod alanı ve header hiç küçülmez.
    key: 'dense-multi',
    deliveryRowMm: 17.5,
    addressRowMm: 19,
    productPaddingMm: 0.7,
    largeQrMm: 15.5,
    smallQrMm: 9.5,
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
