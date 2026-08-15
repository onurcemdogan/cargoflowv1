// index.mjs senkron olarak okuyabilsin diye sabitler `.mjs` dosyasındadır;
// tip bilgisi buradan gelir.
export declare const SURAT_CANONICAL_SERVICE_MODE: 'SURAT_CANONICAL_API'
export declare const SURAT_CANONICAL_SERVICE_TYPE: 'SuratCanonicalWebApi'
export declare const SURAT_CANONICAL_OPERATION_NAME: 'OrtakBarkodOlustur'
export declare function deriveCanonicalPrimaryAccount(
  surat?: Record<string, unknown>,
): { canonicalPrimaryKullaniciAdi: string; canonicalPrimarySifre: string }
