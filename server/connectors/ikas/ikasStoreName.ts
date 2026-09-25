// IKAS MAĞAZA ADI SÖZLEŞMESİ — SSRF KAPISI.
//
// Resmî sözleşme belirteç ucunu SABİT bir biçimde tanımlar:
//
//   https://<your_store_name>.myikas.com/api/admin/oauth/token
//
// Bu yüzden kullanıcıdan KİMLİK DOĞRULAMA ADRESİ ALINMAZ. Kullanıcı yalnız
// mağaza ADINI verir; host bu addan KURULUR ve her zaman `*.myikas.com`
// altında kalır. Şema, port, yol, sorgu, parça, URL içi kimlik veya başka bir
// host KABUL EDİLMEZ — genel amaçlı bir URL girişi (ve onun SSRF yüzeyi)
// hiç açılmaz.
//
// Kolaylık için kabul edilen yazımlar (hepsi aynı ada indirgenir):
//   magazam · MAGAZAM · magazam.myikas.com · https://magazam.myikas.com/

export const IKAS_STORE_HOST_SUFFIX = '.myikas.com'
export const IKAS_GRAPHQL_URL = 'https://api.myikas.com/api/v1/admin/graphql'

/** DNS etiketi: küçük harf/rakam/tire, tireyle başlamaz/bitmez, 1–63. */
const STORE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export type IkasStoreNameResult =
  | { ok: true; storeName: string; tokenUrl: string }
  | { ok: false; error: 'STORE_NAME_INVALID' }

export function normalizeIkasStoreName(input: unknown): IkasStoreNameResult {
  let value = String(input ?? '').trim().toLowerCase()
  if (value === '') return { ok: false, error: 'STORE_NAME_INVALID' }
  // Yalnız TAM `https://` öneki ve tek bir sondaki `/` tolere edilir.
  if (value.startsWith('https://')) value = value.slice('https://'.length)
  if (value.endsWith('/')) value = value.slice(0, -1)
  if (value.endsWith(IKAS_STORE_HOST_SUFFIX)) {
    value = value.slice(0, -IKAS_STORE_HOST_SUFFIX.length)
  }
  // Kalan değer TEK bir DNS etiketi olmalı: nokta, iki nokta (şema/port),
  // eğik çizgi (yol), ?, #, @ (URL içi kimlik) — hiçbiri geçemez.
  if (!STORE_LABEL.test(value)) return { ok: false, error: 'STORE_NAME_INVALID' }
  // `api.myikas.com` GraphQL hostudur; mağaza adı olarak KABUL EDİLMEZ.
  if (value === 'api') return { ok: false, error: 'STORE_NAME_INVALID' }
  return {
    ok: true,
    storeName: value,
    tokenUrl: `https://${value}${IKAS_STORE_HOST_SUFFIX}/api/admin/oauth/token`,
  }
}

/**
 * Giden isteğin hedefi İZİN VERİLEN iki biçimden biri mi?
 *   · belirteç: https://<etiket>.myikas.com/api/admin/oauth/token
 *   · GraphQL : https://api.myikas.com/api/v1/admin/graphql (tam eşleşme)
 * Taşıma katmanı HER istekten önce bunu doğrular (savunma derinliği).
 */
export function isAllowedIkasRequestUrl(raw: string): boolean {
  if (raw === IKAS_GRAPHQL_URL) return true
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.port !== '' || url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '') return false
  if (url.pathname !== '/api/admin/oauth/token') return false
  if (!url.hostname.endsWith(IKAS_STORE_HOST_SUFFIX)) return false
  const label = url.hostname.slice(0, -IKAS_STORE_HOST_SUFFIX.length)
  return STORE_LABEL.test(label) && label !== 'api'
}
