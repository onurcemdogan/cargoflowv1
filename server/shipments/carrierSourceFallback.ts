// SUNUCU YETKİLİ TAŞIYICI KAYNAK DOĞRULAMASI — fail-open'ın TEK kapısı.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
//
// Ürün politikası: "Yanlış carrier etiketi basma riski varsa BLOCK; yardımcı
// (supplemental) özellik başarısızsa GEÇERLİ carrier etiketi bas."
//
// Ek ürün detay sayfası üretilemediğinde ana kargo etiketini rehin almak,
// 4.000 sipariş/gün çalışan bir depoyu durdurur. Ancak taşıyıcı KAYNAK ZPL'e
// düşmek YALNIZ o baytların GERÇEKTEN BU gönderiye ait olduğu KANITLANDIĞINDA
// güvenlidir: yanlış siparişin etiketini basmak, ürün detayını kaybetmekten
// KAT KAT pahalı bir hatadır (paket yanlış adrese gider).
//
// Bu modül o kanıtı üretir. Kanıt yoksa fallback YOKTUR.
//
// ═══ SÖZLEŞME ════════════════════════════════════════════════════════════
//
//  1) YENİ FUZZY EŞLEŞTİRME YOK. Karşılaştırma TAM eşitliktir. Tek normalize
//     adımı `>:` ZPL subset-C önekinin ayrılmasıdır — bu bir tahmin değil,
//     ZPL sözdiziminin çözülmesidir (composer da AYNI kuralı uygular).
//  2) Kimlik doğrulanamıyorsa (canonical değer yok, slot okunamıyor)
//     sonuç MISMATCH ile AYNI: baskı YOK. "Bilinmiyor" ≠ "uyuyor".
//  3) Görsel parite, composer sonucu ve ek sayfa tamlığı BURADA ölçülmez.
//     Bunlar taşıyıcı etiketin basılabilirliği için ENGEL DEĞİLDİR.
//  4) Sebepler tiplidir; ham ZPL, takip numarası veya müşteri verisi
//     İÇERMEZ ve loglanmaz.
import { extractSuratSemanticFields } from '../../src/utils/suratSemanticParser.ts'

export type CarrierFallbackReason =
  | 'carrier_source_missing'
  | 'carrier_structure_invalid'
  | 'carrier_identity_unverifiable'
  | 'carrier_identity_mismatch'

/** Gönderinin CANONICAL kimliği — `shipments` satırının açık kolonları. */
export interface CarrierIdentity {
  trackingNumber?: string | null
  barcode?: string | null
}

export type CarrierValidation =
  | { ok: true }
  | { ok: false; reason: CarrierFallbackReason }

/**
 * Karşılaştırma için canonical biçim.
 *
 * `>:` ZPL Code128 subset-C anahtarıdır ve VERİNİN PARÇASI DEĞİLDİR; alan
 * gövdesinden ayrılır (bkz. suratDurusoftComposer, aynı kural). Bunun dışında
 * yalnız kenar boşluğu kırpılır: hane atma, biçim tahmini, kısmi eşleşme YOK.
 */
export function normalizeCarrierCode(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return (text.startsWith('>:') ? text.slice(2) : text).trim()
}

/**
 * Kaynak ZPL'in TEK bir fiziksel etiket olduğunu doğrular.
 *
 * Toplu/çok sayfalı bir yükü "taşıyıcı etiket" diye basmak, yazıcıya
 * beklenmedik sayıda etiket çıkartır. Yeni bir paralel ZPL ayrıştırıcı
 * İCAT EDİLMEZ: tek etiket olma koşulu ^XA/^XZ çerçeve sayımıdır.
 */
function verifySingleLabelStructure(zpl: string): CarrierValidation {
  const opens = (zpl.match(/\^XA/g) ?? []).length
  const closes = (zpl.match(/\^XZ/g) ?? []).length
  if (opens !== 1 || closes !== 1) {
    return { ok: false, reason: 'carrier_structure_invalid' }
  }
  if (zpl.indexOf('^XA') > zpl.indexOf('^XZ')) {
    return { ok: false, reason: 'carrier_structure_invalid' }
  }
  return { ok: true }
}

/**
 * Taşıyıcı kaynak ZPL'i fallback baskısı için doğrular.
 *
 * BAŞARILI dönüş şu anlama gelir: bu baytlar tek bir geçerli Sürat etiketidir
 * VE taşıdığı T.No / Code128 kimliği gönderinin canonical kimliğiyle BİREBİR
 * aynıdır. Yani "yanlış siparişin etiketi" olma ihtimali kapatılmıştır.
 *
 * Canonical değerlerden HANGİSİ mevcutsa O doğrulanır ve UYUŞMALIDIR;
 * ikisi birden yoksa doğrulama YAPILAMAZ ve fallback REDDEDİLİR.
 */
export function validateCarrierSourceZpl(
  sourceZpl: string,
  identity: CarrierIdentity,
): CarrierValidation {
  const zpl = typeof sourceZpl === 'string' ? sourceZpl : ''
  if (!zpl.trim()) return { ok: false, reason: 'carrier_source_missing' }

  const structure = verifySingleLabelStructure(zpl)
  if (!structure.ok) return structure

  const expectedTracking = normalizeCarrierCode(identity.trackingNumber)
  const expectedBarcode = normalizeCarrierCode(identity.barcode)
  // "Bilinmiyor" ASLA "uyuyor" sayılmaz.
  if (!expectedTracking && !expectedBarcode) {
    return { ok: false, reason: 'carrier_identity_unverifiable' }
  }

  // Semantic slotlar: kimlik, koordinat+font imzasıyla SABİTLENMİŞ alanlardan
  // okunur. Tanınmayan bir şablonda slot çözülemez → doğrulanamaz → baskı yok.
  const { fields } = extractSuratSemanticFields(zpl)
  const actualTracking = normalizeCarrierCode(fields.tNo?.text)
  const actualBarcode = normalizeCarrierCode(fields.code128Payload?.text)

  if (expectedTracking) {
    if (!actualTracking) {
      return { ok: false, reason: 'carrier_identity_unverifiable' }
    }
    if (actualTracking !== expectedTracking) {
      return { ok: false, reason: 'carrier_identity_mismatch' }
    }
  }
  if (expectedBarcode) {
    if (!actualBarcode) {
      return { ok: false, reason: 'carrier_identity_unverifiable' }
    }
    if (actualBarcode !== expectedBarcode) {
      return { ok: false, reason: 'carrier_identity_mismatch' }
    }
  }
  return { ok: true }
}
