// CARGOFLOW AUTHENTICATED API SÖZLEŞMESİ — TEK KAYNAK.
//
// Depodaki gerçek sözleşme (koddan çıkarıldı, varsayım DEĞİL):
//   - İstek AYNI ORIGIN'e, KÖK-GÖRELİ yol ile gider (mutlak URL / base URL YOK).
//   - Oturum `cargoflow_session` HTTP-only cookie'siyle taşınır; bu yüzden her
//     çağrıda `credentials: 'include'` bulunur.
//   - Authorization header YOKTUR (depoda hiçbir CargoFlow API çağrısı
//     kullanmaz), CSRF token YOKTUR.
//   - Gövde JSON ise `Content-Type: application/json`.
//   - organizationId / marketplaceAccountId İSTEMCİDEN GÖNDERİLMEZ; sunucu
//     bunları YALNIZ session'dan (`request.auth`) çözer.
//
// Aynı sözleşme çalışan uçlarda da geçerlidir: GET /api/orders,
// POST /api/orders/:id/label-ready, POST /api/orders/:id/label-printed.
// Bu modül sözleşmeyi tek yerde tanımlar; yeni bir auth mekanizması KURMAZ.

/** Oturumun taşındığı yol — sözleşmenin tek anahtarı. */
export const AUTH_CREDENTIALS_MODE: RequestCredentials = 'include'

/** Oturum doğrulanamadığında kullanıcıya gösterilen GÜVENLİ mesaj. */
export const AUTH_REQUIRED_MESSAGE =
  'Oturum doğrulanamadı. Sayfayı yenileyip tekrar giriş yapın.'

/** Sunucunun oturum reddi olarak döndürdüğü HTTP durumları. */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403
}

export interface AuthenticatedRequestOptions {
  method?: string
  /** JSON gövdesi (varsa). Ham ZPL veya PII TAŞIMAMALIDIR. */
  json?: unknown
  signal?: AbortSignal
}

/**
 * CargoFlow API'sine oturum bağlamıyla istek atar.
 *
 * `path` KÖK-GÖRELİ olmalıdır (`/api/...`); mutlak URL kabul edilmez, böylece
 * oturum cookie'si her zaman aynı origin'de kalır ve üçüncü bir origin'e
 * sızmaz.
 */
export function authenticatedApiRequest(
  path: string,
  options: AuthenticatedRequestOptions = {},
): Promise<Response> {
  if (!path.startsWith('/')) {
    throw new Error('CargoFlow API yolu kök-göreli olmalıdır.')
  }
  const hasJson = options.json !== undefined
  return fetch(path, {
    ...(options.method ? { method: options.method } : {}),
    ...(hasJson ? { headers: { 'Content-Type': 'application/json' } } : {}),
    // Oturum cookie'si: sözleşmenin taşıyıcısı.
    credentials: AUTH_CREDENTIALS_MODE,
    ...(hasJson ? { body: JSON.stringify(options.json) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}
