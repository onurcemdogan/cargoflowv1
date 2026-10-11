// TRANSACTIONAL E-POSTA SOYUTLAMASI.
//
// Uygulama e-postayı bir SAĞLAYICIYA değil bu arayüze gönderir. İlk gerçek
// adaptör Resend'dir; SMTP / Postmark / SES ileride aynı arayüzle eklenir.
//
// YALNIZ transactional: e-posta doğrulama, şifre sıfırlama, güvenlik
// bildirimi. Pazarlama e-postası YOKTUR ve bu katmandan gönderilmez.
//
// Sağlayıcı anahtarları YALNIZ sunucu ortam değişkenindedir; ön yüze, loga
// veya DB'ye yazılmaz. Geliştirme/test ortamı gerçek e-posta göndermek
// ZORUNDA DEĞİLDİR: `memory` (test) ve `outbox` (yerel dosya) adaptörleri
// vardır ve production'da REDDEDİLİR.
import { createMemoryEmailProvider } from './memoryEmailProvider.ts'
import { createOutboxEmailProvider } from './outboxEmailProvider.ts'
import { createResendEmailProvider } from './resendEmailProvider.ts'

export type TransactionalEmailKind =
  | 'email_verification'
  | 'password_reset'
  | 'security_notice'

export interface TransactionalEmail {
  to: string
  subject: string
  text: string
  html: string
  kind: TransactionalEmailKind
  /**
   * Yeniden denemede ikinci e-postayı engeller (sağlayıcı destekliyorsa).
   * Ham token İÇERMEZ.
   */
  idempotencyKey?: string
}

export type EmailSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; errorCode: EmailErrorCode }

/** Kararlı hata sınıfı — sağlayıcının ham metni dışarı taşınmaz. */
export type EmailErrorCode =
  | 'EMAIL_NOT_CONFIGURED'
  | 'EMAIL_AUTH_FAILED'
  | 'EMAIL_REJECTED'
  | 'EMAIL_RATE_LIMITED'
  | 'EMAIL_PROVIDER_UNAVAILABLE'

export interface EmailProvider {
  readonly name: string
  /** Gönderilebilir mi (anahtar/gönderen tanımlı mı)? Ağ çağrısı YAPMAZ. */
  isConfigured(): boolean
  send(email: TransactionalEmail): Promise<EmailSendResult>
}

const PRODUCTION_ALLOWED = new Set(['resend'])

/**
 * Ortamdan sağlayıcı seçer.
 *
 *   EMAIL_PROVIDER=resend  → RESEND_API_KEY + EMAIL_FROM
 *   EMAIL_PROVIDER=outbox  → EMAIL_OUTBOX_DIR (yalnız production DIŞI)
 *   EMAIL_PROVIDER=memory  → bellek (yalnız production DIŞI)
 *
 * Tanımsızsa: production'da yapılandırılmamış Resend (gönderim kapalı,
 * signup kapalı); geliştirmede bellek adaptörü.
 */
export function resolveEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const production = env.NODE_ENV === 'production'
  const requested = String(env.EMAIL_PROVIDER ?? '').trim().toLowerCase()
  const name = requested || (production ? 'resend' : 'memory')
  if (production && !PRODUCTION_ALLOWED.has(name)) {
    // Test adaptörü production'da sessizce "başarılı" demesin.
    return createResendEmailProvider({ apiKey: '', from: '' })
  }
  if (name === 'outbox') {
    return createOutboxEmailProvider({ dir: String(env.EMAIL_OUTBOX_DIR ?? '').trim() })
  }
  if (name === 'memory') return createMemoryEmailProvider()
  return createResendEmailProvider({
    apiKey: String(env.RESEND_API_KEY ?? '').trim(),
    from: String(env.EMAIL_FROM ?? '').trim(),
  })
}
