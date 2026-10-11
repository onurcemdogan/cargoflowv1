// YEREL GELİŞTİRME ADAPTÖRÜ — e-postayı EMAIL_OUTBOX_DIR altına .eml benzeri
// metin dosyası olarak yazar; gerçek e-posta GÖNDERMEZ. Yerel uçtan uca
// denemede doğrulama/sıfırlama bağlantısı bu dosyadan okunur. Dosyalar
// bağlantıyı (tek kullanımlık token) içerdiği için dizin yerel ve geçici
// olmalıdır; production'da `resolveEmailProvider` bu adaptörü SEÇMEZ.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EmailProvider } from './emailProvider.ts'

export function createOutboxEmailProvider(options: { dir: string }): EmailProvider {
  const configured = Boolean(options.dir)
  let counter = 0
  return {
    name: 'outbox',
    isConfigured: () => configured,
    async send(email) {
      if (!configured) return { ok: false, errorCode: 'EMAIL_NOT_CONFIGURED' }
      try {
        mkdirSync(options.dir, { recursive: true })
        counter += 1
        const file = join(options.dir, `${Date.now()}-${counter}-${email.kind}.txt`)
        writeFileSync(
          file,
          [`To: ${email.to}`, `Subject: ${email.subject}`, `Kind: ${email.kind}`, '', email.text].join('\n'),
          'utf8',
        )
        return { ok: true, providerMessageId: file }
      } catch {
        return { ok: false, errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' }
      }
    },
  }
}
