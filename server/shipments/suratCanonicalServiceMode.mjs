// Kanonik Sürat Web API servis modu — TEK sabit kaynak.
//
// Ayrı `.mjs` modül olmasının sebebi: index.mjs `.ts` modülleri yalnız
// dinamik import ile yükler (mevcut repo deseni), fakat `normalizeSuratConfig`
// senkrondur. Sabit burada durur; hem index.mjs hem kanonik `.ts` adaptör
// aynı değeri okur, string hiçbir yerde tekrar yazılmaz.
export const SURAT_CANONICAL_SERVICE_MODE = 'SURAT_CANONICAL_API'
export const SURAT_CANONICAL_SERVICE_TYPE = 'SuratCanonicalWebApi'
export const SURAT_CANONICAL_OPERATION_NAME = 'OrtakBarkodOlustur'

/**
 * KANONİK BİRİNCİL HESAP TÜREVİ — TEK KAYNAK, ENV OKUNMAZ.
 *
 * Aynı türev iki yerde kullanılır ve İKİSİ DE aynı sonucu vermek
 * zorundadır:
 *   1) normalizeSuratConfig (index.mjs) — ham tenant girdisi üzerinde,
 *   2) kanarya ön kontrolü — kayıtlı (şifresi çözülmüş) payload üzerinde.
 *
 * Entegrasyonlar ekranı cari kodunu `kullaniciAdi`, şifreyi `sifre`
 * alanına yazar; `liveKullaniciAdi`/`liveSifre` için ekranda alan YOKTUR.
 * Bu yüzden birincil hesap her iki adı da kabul eder. `process.env`
 * BURADA OKUNMAZ — çağıranın ham tenant değerini geçmesi esastır.
 */
export function deriveCanonicalPrimaryAccount(surat = {}) {
  const pick = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim()
      if (text) return text
    }
    return ''
  }
  return {
    canonicalPrimaryKullaniciAdi: pick(
      surat.canonicalPrimaryKullaniciAdi,
      surat.liveKullaniciAdi,
      surat.kullaniciAdi,
      surat.cariKodu,
    ),
    canonicalPrimarySifre: pick(
      surat.canonicalPrimarySifre,
      surat.liveSifre,
      surat.sifre,
      surat.password,
    ),
  }
}
