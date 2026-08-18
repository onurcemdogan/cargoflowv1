// Tek-buton akışının AŞAMA BAZLI güvenli sebepleri.
//
// KÖK NEDEN (canlı): create başarılı olduğu hâlde baskı aşamasındaki HER
// farklı hata tek bir "Baskı doğrulanmadı; durum değiştirilmedi." mesajına
// düşüyordu. Kullanıcı ne olduğunu (etiket yok mu, ürün sığmadı mı, baskı mı
// doğrulanmadı) ayırt edemiyordu.
//
// Bu sabitler YALNIZ güvenli metin taşır: PII (ad/adres/telefon), ham ZPL,
// provider payload veya credential İÇERMEZ.

/** Baskı belgesi hiç oluşturulamadı (tarayıcı arayüzü yok / host yazılamadı). */
export const PRINT_HOST_UNAVAILABLE_MESSAGE =
  'Yazdırma penceresi açılamadı. Bu site için açılır pencerelere izin verin.'

/**
 * Create çağrısı HATA ATMADI ama kayıtlı etiket doğrulanamadı.
 *
 * DİKKAT: bu durumda etiketin OLUŞTUĞU BİLİNMEZ. Eski metin "etiket
 * oluşturuldu" diyordu; 2026-08-18 canlı denemesinde (paket 4085791254)
 * taşıyıcı HTTP 200 döndürüp hiç barkod/takip/ZPL üretmediği hâlde operatöre
 * etiket oluşmuş gibi görünüyordu. Metin artık OLUŞTUĞUNU İDDİA ETMEZ.
 */
export const LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE =
  'Sürat etiketi doğrulanamadı; etiketin oluştuğu teyit edilemedi.'

/** Etiket henüz hazır değil (kayıtlı etiket uçtan da çözülemedi). */
export const LABEL_NOT_READY_MESSAGE =
  'Sürat etiketi henüz hazır değil; baskı yapılmadı.'

/** Baskı sonucu hiç dönmedi (servis printResult üretmedi). */
export const PRINT_RESULT_MISSING_MESSAGE =
  'Baskı sonucu alınamadı; durum değiştirilmedi.'

/** Sipariş belgeye hiç girmedi (render aşamasında atlandı). */
export const NOT_IN_PRINT_DOCUMENT_MESSAGE =
  'Sipariş baskı belgesine girmedi; durum değiştirilmedi.'
