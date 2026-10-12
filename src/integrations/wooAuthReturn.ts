// WooCommerce resmî yetkilendirmesinden dönüş (`return_url`): WooCommerce
// adrese `success=1|0&user_id=…` ekler; `woo_auth` bizim bağlantı isteği
// kimliğimizdir. Sır taşımaz — geri çağrıyı sunucu belirteci yetkilendirir.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface WooAuthReturn {
  authorizationId: string
  denied: boolean
}

export function readWooAuthReturn(search: string = typeof window === 'undefined' ? '' : window.location.search): WooAuthReturn | null {
  const params = new URLSearchParams(search)
  const authorizationId = String(params.get('woo_auth') ?? '').trim()
  if (!UUID.test(authorizationId)) return null
  return { authorizationId, denied: params.get('success') === '0' }
}

/** Dönüş parametrelerini adres çubuğundan temizler (geçmişe kayıt eklemeden). */
export function clearWooAuthReturn(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  for (const key of ['woo_auth', 'success', 'user_id']) url.searchParams.delete(key)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

/** WooCommerce onay ekranına tam sayfa geçiş (testte taklit edilebilir tek nokta). */
export function redirectToStore(url: string): void {
  window.location.assign(url)
}
