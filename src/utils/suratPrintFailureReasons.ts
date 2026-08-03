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

/** Create çağrısı hata atmadı ama kayıtlı etiket doğrulanamadı. */
export const LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE =
  'Sürat etiketi oluşturuldu fakat kayıtlı etiket doğrulanamadı.'

/** Etiket henüz hazır değil (kayıtlı etiket uçtan da çözülemedi). */
export const LABEL_NOT_READY_MESSAGE =
  'Sürat etiketi henüz hazır değil; baskı yapılmadı.'

/** Baskı sonucu hiç dönmedi (servis printResult üretmedi). */
export const PRINT_RESULT_MISSING_MESSAGE =
  'Baskı sonucu alınamadı; durum değiştirilmedi.'

/** Kullanıcı baskı onayında "Hayır"/İptal dedi. */
export const PRINT_NOT_CONFIRMED_MESSAGE =
  'Kullanıcı baskıyı doğrulamadı; durum değiştirilmedi.'

/** Baskı onay sorusu (browser-print yolunda dialog kapandıktan sonra). */
export const PRINT_CONFIRMATION_QUESTION =
  'Etiketler yazıcıdan doğru şekilde çıktı mı?'

/** Sipariş belgeye hiç girmedi (render aşamasında atlandı). */
export const NOT_IN_PRINT_DOCUMENT_MESSAGE =
  'Sipariş baskı belgesine girmedi; durum değiştirilmedi.'
