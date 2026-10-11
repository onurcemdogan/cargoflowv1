// RESEND ADAPTÖRÜ — resmî REST sözleşmesi:
//   POST https://api.resend.com/emails
//   Authorization: Bearer <RESEND_API_KEY>
//   gövde: from, to, subject, html, text
//   isteğe bağlı başlık: Idempotency-Key (24 saat geçerli, en fazla 256 karakter)
// Kaynak: https://resend.com/docs/api-reference/emails/send-email
//
// API anahtarı yalnız bu modülün kapanışında yaşar; loglanmaz ve hata
// sonucuna taşınmaz. Sağlayıcının ham hata metni de dışarı verilmez.
import type { EmailProvider, EmailSendResult, TransactionalEmail } from './emailProvider.ts'

export const RESEND_SEND_URL = 'https://api.resend.com/emails'

export interface ResendOptions {
  apiKey: string
  from: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function createResendEmailProvider(options: ResendOptions): EmailProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const configured = Boolean(options.apiKey && options.from)
  return {
    name: 'resend',
    isConfigured: () => configured,
    async send(email: TransactionalEmail): Promise<EmailSendResult> {
      if (!configured) return { ok: false, errorCode: 'EMAIL_NOT_CONFIGURED' }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      }
      if (email.idempotencyKey) headers['Idempotency-Key'] = email.idempotencyKey.slice(0, 256)
      let response: Response
      try {
        response = await fetchImpl(RESEND_SEND_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from: options.from,
            to: [email.to],
            subject: email.subject,
            html: email.html,
            text: email.text,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
      } catch {
        return { ok: false, errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' }
      }
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { id?: unknown } | null
        return { ok: true, providerMessageId: typeof body?.id === 'string' ? body.id : null }
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, errorCode: 'EMAIL_AUTH_FAILED' }
      }
      if (response.status === 429) return { ok: false, errorCode: 'EMAIL_RATE_LIMITED' }
      if (response.status >= 500) return { ok: false, errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' }
      return { ok: false, errorCode: 'EMAIL_REJECTED' }
    },
  }
}
