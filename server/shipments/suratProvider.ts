// SÜRAT KARGO — KANONİK PERSISTENCE ANAHTARI (TEK KAYNAK).
//
// `shipments.provider` kolonunda saklanan ve TÜM org-kapsamlı sorguların
// (create persistence, findShipment/attachShipment, printZplRepository)
// eşleştiği DEĞER budur. Kolon sorguları EXACT `eq(...)` kullanır; bu yüzden
// anahtar tek bir kanonik dize olmak ZORUNDADIR.
//
// KÖK NEDEN (canlı): sipariş GÖRÜNÜMÜNDEKİ `shipment.provider` alanı UI için
// 'surat-kargo' olarak üretiliyor, `order.cargoProviderName` ise pazaryerinden
// 'Sürat Kargo Marketplace' gibi serbest metin gelebiliyordu. Bu GÖRÜNÜM
// değerleri repository anahtarı olarak geçirilince `provider = 'surat'` satırı
// BULUNAMIYOR ve kayıtlı etiket varken "kayıtlı resmî kargo etiketi (ZPL)
// bulunamadı" hatası dönüyordu.
//
// KURAL: görünen ad YALNIZ doğrulama içindir; DB anahtarı DAİMA bu sabittir.
export const SURAT_PERSISTENCE_PROVIDER = 'surat'

/**
 * Görünen sağlayıcı adı Sürat'ı mı işaret ediyor?
 * ('surat', 'Sürat', 'Sürat Kargo', 'Sürat Kargo Marketplace', 'surat-kargo')
 *
 * Bu YALNIZ bir doğrulama yardımcısıdır; dönüş değeri DB sorgusunda
 * KULLANILMAZ.
 */
export function isSuratProviderName(provider: unknown): boolean {
  return /surat|sürat/i.test(String(provider ?? ''))
}
