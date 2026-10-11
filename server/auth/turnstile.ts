// CLOUDFLARE TURNSTILE — sunucu tarafı doğrulama.
//
// Resmî sözleşme (developers.cloudflare.com/turnstile/get-started/server-side-validation):
//   POST https://challenges.cloudflare.com/turnstile/v0/siteverify
//   gövde: secret, response, remoteip (isteğe bağlı), idempotency_key (isteğe bağlı)
//   yanıt: success, error-codes, challenge_ts, hostname, action, cdata
// Token 300 sn geçerlidir ve TEK KULLANIMLIKTIR (tekrar → timeout-or-duplicate).
//
// KAPI KURALI: doğrulanamayan istek (eksik token, ağ hatası, Cloudflare
// hatası) GEÇMEZ — kullanıcı OLUŞTURULMAZ. Gizli anahtar loglanmaz.
//
// Geliştirme: `TURNSTILE_SECRET_KEY` yoksa ve production DEĞİLSE doğrulama
// atlanır (yerel geliştirme). Production'da anahtar yoksa doğrulayıcı
// "yapılandırılmamış" döner ve signup KAPALI kalır. Cloudflare'in resmî test
// anahtarları (ör. her zaman geçen `1x0000000000000000000000000000000AA`)
// gerçek siteverify ucuyla çalışır.
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export type TurnstileResult =
  | { ok: true; skipped: boolean }
  | { ok: false; reason: 'MISSING_TOKEN' | 'REJECTED' | 'UNAVAILABLE' | 'NOT_CONFIGURED' }

export interface TurnstileVerifier {
  /** Signup için zorunlu mu (production'da her zaman). */
  isConfigured(): boolean
  /** Ön yüze verilen herkese açık site anahtarı (gizli DEĞİL). */
  siteKey(): string | null
  verify(token: unknown, remoteIp?: string): Promise<TurnstileResult>
}

export interface TurnstileOptions {
  secret: string
  siteKey: string
  production: boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function createTurnstileVerifier(options: TurnstileOptions): TurnstileVerifier {
  const fetchImpl = options.fetchImpl ?? fetch
  const hasSecret = Boolean(options.secret)
  const bypass = !hasSecret && !options.production
  return {
    isConfigured: () => (hasSecret && Boolean(options.siteKey)) || bypass,
    siteKey: () => (hasSecret && options.siteKey ? options.siteKey : null),
    async verify(token, remoteIp) {
      if (bypass) return { ok: true, skipped: true }
      if (!hasSecret) return { ok: false, reason: 'NOT_CONFIGURED' }
      const response = String(token ?? '').trim()
      if (!response) return { ok: false, reason: 'MISSING_TOKEN' }
      try {
        const result = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret: options.secret,
            response,
            ...(remoteIp ? { remoteip: remoteIp } : {}),
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
        })
        if (!result.ok) return { ok: false, reason: 'UNAVAILABLE' }
        const body = (await result.json().catch(() => null)) as { success?: unknown } | null
        return body?.success === true ? { ok: true, skipped: false } : { ok: false, reason: 'REJECTED' }
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' }
      }
    },
  }
}

export function resolveTurnstileVerifier(env: NodeJS.ProcessEnv = process.env): TurnstileVerifier {
  return createTurnstileVerifier({
    secret: String(env.TURNSTILE_SECRET_KEY ?? '').trim(),
    siteKey: String(env.TURNSTILE_SITE_KEY ?? '').trim(),
    production: env.NODE_ENV === 'production',
  })
}
