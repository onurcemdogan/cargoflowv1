// Kanonik Sürat Web API servis modu — TEK sabit kaynak.
//
// Ayrı `.mjs` modül olmasının sebebi: index.mjs `.ts` modülleri yalnız
// dinamik import ile yükler (mevcut repo deseni), fakat `normalizeSuratConfig`
// senkrondur. Sabit burada durur; hem index.mjs hem kanonik `.ts` adaptör
// aynı değeri okur, string hiçbir yerde tekrar yazılmaz.
export const SURAT_CANONICAL_SERVICE_MODE = 'SURAT_CANONICAL_API'
export const SURAT_CANONICAL_SERVICE_TYPE = 'SuratCanonicalWebApi'
export const SURAT_CANONICAL_OPERATION_NAME = 'OrtakBarkodOlustur'
