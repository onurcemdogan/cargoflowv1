// TICIMAX KİMLİK — MAĞAZA KÖKÜ HESAP, SiparisID SİPARİŞ.
//
// UyeKodu SIRDIR: providerAccountId / hash / sipariş / üye kimliği OLAMAZ.
// Hesap kimliği = normalize edilmiş mağaza origin (Woo `storeFingerprint`
// deseni). Sipariş kimliği = yalnız `SiparisID` (SiparisNo görüntü ref'idir).
import { assertIdentityFieldIsStable, storeFingerprint } from '../canonicalIdentity.ts'
import { TICIMAX_PROVIDER_KEY } from './ticimaxEndpoint.ts'

export { TICIMAX_PROVIDER_KEY }

/**
 * Kanonik mağaza kimliği — `storeFingerprint` ile; ikinci normalleştirme YOK.
 *
 * `https://magaza.example.com` · `.../` · `HTTPS://Magaza.Example.COM`
 * → aynı `providerAccountId`. Anlamlı alt yol ayrı mağazadır.
 */
export function ticimaxProviderAccountId(storeOrigin: string): string {
  const fingerprint = storeFingerprint({
    providerKey: TICIMAX_PROVIDER_KEY,
    externalStoreId: storeOrigin,
  })
  return fingerprint.slice(`${TICIMAX_PROVIDER_KEY}::`.length)
}

export class TicimaxIdentityError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * UyeKodu'nun kimlik olarak kullanılmasını FAIL-CLOSED engeller.
 *
 * Karşılaştırma bilinçli olarak aday değeri "UyeKodu alanı mı?" diye
 * etiketler — sırın kendisini loglamaz / saklamaz.
 */
export function assertUyeKoduNeverIdentity(params: {
  candidateField?: string | null
  candidateValue?: unknown
  uyeKodu?: unknown
}): void {
  const field = String(params.candidateField ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, '')
  if (
    field === 'uyekodu' ||
    field === 'uyekod' ||
    field.endsWith('uyekodu') ||
    field.includes('uyekodu')
  ) {
    throw new TicimaxIdentityError(
      'UYE_KODU_NOT_IDENTITY',
      'UyeKodu kimlik OLAMAZ — yalnız mağaza origin providerAccountId olur.',
    )
  }

  const secret = String(params.uyeKodu ?? '').trim()
  if (secret === '') return
  const candidate = String(params.candidateValue ?? '').trim()
  if (candidate !== '' && candidate === secret) {
    throw new TicimaxIdentityError(
      'UYE_KODU_NOT_IDENTITY',
      'UyeKodu değeri providerAccountId / dış kimlik OLAMAZ.',
    )
  }
}

/** Sipariş dış kimliği — yalnız SiparisID (kararlı). */
export function ticimaxOrderExternalId(rawOrder: unknown): string | null {
  assertIdentityFieldIsStable('SiparisID')
  const record = (rawOrder ?? {}) as Record<string, unknown>
  const id = String(record.SiparisID ?? '').trim()
  if (id === '' || id === '0') return null
  return id
}

/** İnsan referansı — kimlik DEĞİL. */
export function ticimaxOrderHumanReference(rawOrder: unknown): string | null {
  const record = (rawOrder ?? {}) as Record<string, unknown>
  const no = String(record.SiparisNo ?? '').trim()
  return no === '' ? null : no
}
