// TEST ADAPTÖRÜ — e-postayı belleğe yazar, ağa çıkmaz. Production'da
// `resolveEmailProvider` bu adaptörü SEÇMEZ.
import type { EmailProvider, TransactionalEmail } from './emailProvider.ts'

export interface MemoryEmailProvider extends EmailProvider {
  readonly sent: TransactionalEmail[]
  /** Testler için: belirli bir türün başarısız olmasını sağlar. */
  failNext(errorCode?: 'EMAIL_PROVIDER_UNAVAILABLE' | 'EMAIL_REJECTED'): void
}

export function createMemoryEmailProvider(): MemoryEmailProvider {
  const sent: TransactionalEmail[] = []
  let pendingFailure: 'EMAIL_PROVIDER_UNAVAILABLE' | 'EMAIL_REJECTED' | null = null
  return {
    name: 'memory',
    sent,
    isConfigured: () => true,
    failNext(errorCode = 'EMAIL_PROVIDER_UNAVAILABLE') {
      pendingFailure = errorCode
    },
    async send(email) {
      if (pendingFailure) {
        const errorCode = pendingFailure
        pendingFailure = null
        return { ok: false, errorCode }
      }
      sent.push(email)
      return { ok: true, providerMessageId: `memory-${sent.length}` }
    },
  }
}
