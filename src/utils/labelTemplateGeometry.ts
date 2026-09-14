// ETİKET ŞABLON GEOMETRİSİ — TEK SOURCE OF TRUTH (saf; IO/DOM/ağ YOK).
//
// ═══ ÖLÇÜLEN KUSUR ═══════════════════════════════════════════════════════
//
// QR boyutu, içerik bütçesiyle AYNI nesnede taşınıyordu: `LABEL_LAYOUT_PROFILES`
// hem ürün/adres/teslimat yüksekliklerini hem de `largeQrMm`/`smallQrMm`
// değerlerini tutuyordu. Profil seçimi ÜRÜN FOOTER'ININ SIĞMASINA göre
// yapıldığı için, opsiyonel ürün metni büyüdüğünde QR küçülüyordu:
//
//   1–2 kalem → standard      → büyük QR 21.0 mm · küçük QR 12.5 mm
//   3+  kalem → compact-multi → büyük QR 18.0 mm · küçük QR 11.0 mm   (−3 mm)
//
// Bu, çakışma önceliğinin TAM TERSİDİR: 1. öncelik (barkod/QR okunabilirliği)
// 4. öncelik (eklenen CargoFlow ürün footer'ı) için feda ediliyordu.
//
// DAHASI: küçülme HİÇBİR ŞEY KAZANDIRMIYORDU. Rota metninin yatay bütçesi
// (`ROUTE_WIDTH_MM = 52`) profilden BAĞIMSIZ bir sabittir; QR daraldığında o
// sabit genişlemiyordu. Kaybedilen 3 mm karşılığında kazanılan yatay alan
// SIFIRDI. Kazanç yalnız DİKEYDİ (teslimat satırı kısalınca ürün alanı
// büyüyordu) ve bedeli doğrudan okunabilirlikti.
//
// ═══ KURAL ════════════════════════════════════════════════════════════════
//
// QR fiziksel hedefi ŞABLONA aittir; içerikten TÜREMEZ. Şu girdilerin
// HİÇBİRİ QR boyutunu değiştiremez:
//   aktarma metni uzunluğu · rota adı uzunluğu · ürün metni uzunluğu
//   · kalem sayısı · footer yüksekliği · font kademesi · adres uzunluğu
//
// QR yalnız ŞU sebeplerle değişebilir:
//   sağlayıcı şablon sözleşmesi · QR kodlama/sürüm gereksinimi
//   · yazıcı DPI'ı · AÇIK şablon geometri sürümü
//
// ═══ "TEK BOYUTLANDIRMA" NE DEĞİLDİR ═════════════════════════════════════
//
// Tüm taşıyıcıları 100×100'e ZORLAMAK değildir. Her şablon KENDİ fiziksel
// sayfa geometrisini taşır; ortak olan, o geometrinin TEK yerden çözülmesidir.

/** Zebra 203 dpi = 8 dot/mm. Şablon başına DPI taşınır; global varsayım YOK. */
export const DOTS_PER_MM_203 = 8

export const LABEL_TEMPLATE_KEYS = [
  'cargoflow_html',
  'surat_official_zpl',
  'trendyol_common_label',
  'hepsiburada_mutual_barcode',
  'aras_native',
] as const

export type LabelTemplateKey = (typeof LABEL_TEMPLATE_KEYS)[number]

/**
 * Barkod/QR SAHİPLİĞİ.
 *
 * `carrier` veya `marketplace` sahipliğinde artefakt SAĞLAYICININDIR ve
 * geometrisi CargoFlow tarafından YENİDEN YAZILMAZ.
 */
export type LabelArtifactOwnership = 'cargoflow' | 'carrier' | 'marketplace'

export interface LabelQrTarget {
  /** Kanonik kenar uzunluğu (mm). İçerikten TÜREMEZ. */
  sideMm: number
  /**
   * Kabul edilebilir en küçük kenar (mm). Bu değer bir HEDEF DEĞİL, bir
   * TABANDIR: ölçülen render bunun altına düşerse kabul BAŞARISIZDIR.
   */
  minimumSideMm: number
}

export interface LabelTemplateGeometry {
  key: LabelTemplateKey
  /** İnsan tarafından okunan ad — UI metni DEĞİL, denetim etiketi. */
  label: string
  /** Fiziksel sayfa. `null` = sağlayıcı tanımlı, CargoFlow BİLMİYOR. */
  pageWidthMm: number | null
  pageHeightMm: number | null
  /** Yazıcı çözünürlüğü (dot/mm). `null` = sağlayıcı tanımlı. */
  dotsPerMm: number | null
  qrOwnership: LabelArtifactOwnership
  /** Kanonik QR hedefleri. Sağlayıcı sahipliğinde `null`. */
  largeQr: LabelQrTarget | null
  smallQr: LabelQrTarget | null
  /**
   * CargoFlow bu artefaktın GEOMETRİSİNİ değiştirebilir mi?
   *
   * Sağlayıcıya ait ZPL'de `false`: baskı yolu byte'ı KORUR. Yalnız AÇIK ve
   * sözleşmeyle KANITLANMIŞ dönüşümlere izin verilir.
   */
  mayMutateGeometry: boolean
  /** Ürün footer'ı bu şablonda EKLENEBİLİR mi? */
  productFooterEligible: boolean
  /**
   * Geometri sözleşmesi sürümü. QR/sayfa hedefi DEĞİŞİRSE bu artar ve
   * `printZplVersion` ile birlikte YALNIZ YENİ artefaktlara uygulanır;
   * kayıtlı artefaktlar GERİYE DÖNÜK DEĞİŞTİRİLMEZ.
   */
  geometryVersion: number
  /** Kanıt/gerekçe — hangi kaynaktan geldiği denetlenebilsin diye. */
  source: string
}

/**
 * CargoFlow'un KENDİ ürettiği 100×100 HTML etiketi.
 *
 * QR hedefleri eski `standard` profilinin değerleridir: küçülme kaldırıldı,
 * BÜYÜTME YAPILMADI. Bugün 21/12.5 mm basan bir etiket AYNI boyutta basmaya
 * devam eder; değişen tek şey, 3+ kalemde 18/11'e DÜŞMEMESİDİR.
 *
 * Taban değerler (15.5 / 9.5) eski `dense-multi` kademesidir: o kademe
 * "okunabilir minimum" olarak KABUL EDİLMİŞTİ. Hedef artık taban DEĞİL,
 * `standard`tır; taban yalnız kabul testinin alt sınırıdır.
 */
const CARGOFLOW_HTML: LabelTemplateGeometry = {
  key: 'cargoflow_html',
  label: 'CargoFlow 100×100 HTML',
  pageWidthMm: 100,
  pageHeightMm: 100,
  dotsPerMm: DOTS_PER_MM_203,
  qrOwnership: 'cargoflow',
  largeQr: { sideMm: 21, minimumSideMm: 15.5 },
  smallQr: { sideMm: 12.5, minimumSideMm: 9.5 },
  mayMutateGeometry: true,
  productFooterEligible: true,
  geometryVersion: 2,
  source: 'CargoFlow şablonu; ölçülen standard profil değerleri',
}

/**
 * Resmî Sürat ZPL'i — GÖVDE TAŞIYICININDIR.
 *
 * QR taşıyıcının `^BQ` komutudur. CargoFlow yalnız KANITLI ve dar bir
 * dönüşüm uygular (büyütme token'ı normalize edilir); sayfa geometrisi ve
 * komut yapısı DEĞİŞMEZ. Ölçüm: büyütme 5 → 21 modül × 5 = 105 dot = 13.13 mm.
 */
const SURAT_OFFICIAL_ZPL: LabelTemplateGeometry = {
  key: 'surat_official_zpl',
  label: 'Resmî Sürat ZPL 100×100',
  pageWidthMm: 100,
  pageHeightMm: 100,
  dotsPerMm: DOTS_PER_MM_203,
  qrOwnership: 'carrier',
  // 105 dot / 8 dpmm = 13.125 mm — gerçek render ölçümü.
  largeQr: { sideMm: 13.125, minimumSideMm: 13.125 },
  smallQr: null,
  // Dar ve kanıtlı dönüşüm (yalnız `^BQ` büyütme normalizasyonu) AÇIKÇA
  // izinlidir; bu yüzden true. Sayfa/komut yeniden yazımı DEĞİL.
  mayMutateGeometry: true,
  productFooterEligible: true,
  geometryVersion: 1,
  source: 'zebrash render ölçümü (105×105 dot, mag 5)',
}

/**
 * Trendyol Ortak Etiket — PAZARYERİ SAHİPLİĞİNDE.
 *
 * Sayfa ölçüsü `null`: resmî kaynakta 100 mm × 130 mm YALNIZ "AB Ürün Etiketi
 * ile birlikte" servisi için belirtilmiştir (2026-07-02). Düz `getCommonLabel`
 * için bu ölçü DOĞRULANMAMIŞTIR ve UYDURULMAZ — ilk gerçek artefakt ölçülene
 * kadar `null` kalır.
 */
const TRENDYOL_COMMON_LABEL: LabelTemplateGeometry = {
  key: 'trendyol_common_label',
  label: 'Trendyol Ortak Etiket (ZPL)',
  pageWidthMm: null,
  pageHeightMm: null,
  dotsPerMm: null,
  qrOwnership: 'marketplace',
  largeQr: null,
  smallQr: null,
  mayMutateGeometry: false,
  productFooterEligible: false,
  geometryVersion: 1,
  source: 'developers.trendyol.com getCommonLabel (2026-02-16); ölçü UNRESOLVED',
}

const HEPSIBURADA_MUTUAL_BARCODE: LabelTemplateGeometry = {
  key: 'hepsiburada_mutual_barcode',
  label: 'Hepsiburada Ortak Barkod',
  pageWidthMm: null,
  pageHeightMm: null,
  dotsPerMm: null,
  qrOwnership: 'marketplace',
  largeQr: null,
  smallQr: null,
  mayMutateGeometry: false,
  productFooterEligible: false,
  geometryVersion: 1,
  source: 'Hepsiburada ortak barkod servisi; ölçü sağlayıcı tanımlı',
}

const ARAS_NATIVE: LabelTemplateGeometry = {
  key: 'aras_native',
  label: 'Aras Kargo yerel etiketi',
  pageWidthMm: null,
  pageHeightMm: null,
  dotsPerMm: null,
  qrOwnership: 'carrier',
  largeQr: null,
  smallQr: null,
  mayMutateGeometry: false,
  productFooterEligible: false,
  geometryVersion: 1,
  source: 'Aras GetBarcode; ölçü sağlayıcı tanımlı',
}

export const LABEL_TEMPLATE_GEOMETRY: Readonly<
  Record<LabelTemplateKey, LabelTemplateGeometry>
> = {
  cargoflow_html: CARGOFLOW_HTML,
  surat_official_zpl: SURAT_OFFICIAL_ZPL,
  trendyol_common_label: TRENDYOL_COMMON_LABEL,
  hepsiburada_mutual_barcode: HEPSIBURADA_MUTUAL_BARCODE,
  aras_native: ARAS_NATIVE,
}

/**
 * Şablon geometrisi çözer.
 *
 * BİLİNMEYEN ŞABLON FAIL-SAFE: `null` döner. Çağıran taraf geometri yeniden
 * yazımı YAPMAZ — tanımadığı bir sağlayıcı etiketine "muhtemelen 100×100'dür"
 * diye davranmak, o etiketi BOZMAK demektir.
 */
export function resolveLabelTemplateGeometry(
  key: unknown,
): LabelTemplateGeometry | null {
  const token = String(key ?? '').trim()
  return (
    LABEL_TEMPLATE_GEOMETRY[token as LabelTemplateKey] ?? null
  )
}

/** Sağlayıcıya ait artefakt mı? (CargoFlow üretmedi.) */
export function isProviderOwnedTemplate(key: unknown): boolean {
  const geometry = resolveLabelTemplateGeometry(key)
  if (!geometry) return false
  return geometry.qrOwnership !== 'cargoflow'
}

/**
 * CargoFlow bu şablonun geometrisini değiştirebilir mi?
 *
 * BİLİNMEYEN ŞABLONDA `false`. Belirsizlikte "yapabilir" demek, sağlayıcı
 * etiketini sessizce bozma iznidir.
 */
export function mayMutateTemplateGeometry(key: unknown): boolean {
  return resolveLabelTemplateGeometry(key)?.mayMutateGeometry === true
}

/** mm → dot (şablonun KENDİ DPI'ı ile). DPI bilinmiyorsa `null`. */
export function templateMmToDots(
  geometry: LabelTemplateGeometry,
  mm: number,
): number | null {
  if (geometry.dotsPerMm === null) return null
  return Math.round(mm * geometry.dotsPerMm)
}
