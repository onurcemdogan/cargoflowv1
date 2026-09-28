// ARAS hesap kimliği — UserName/Password SIR; yerel hesap kaydı kimliktir.

import { randomUUID } from 'node:crypto'

export const ARAS_PROVIDER_KEY = 'aras'

export class ArasIdentityError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Yeni Aras hesabı için yerel, gizli olmayan providerAccountId üretir.
 * CargoFlow `marketplace_accounts.id` kapsamı API'de birincil anahtardır;
 * bu değer yalnız benzersiz providerAccountId sütununu doldurur.
 */
export function newArasLocalProviderAccountId(): string {
  return `local-${randomUUID()}`
}

export function assertArasCredentialNeverIdentity(params: {
  candidateField?: string | null
  candidateValue?: unknown
  userName?: unknown
  password?: unknown
}): void {
  const field = String(params.candidateField ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, '')
  if (
    field === 'username' ||
    field === 'password' ||
    field.includes('username') ||
    field.includes('password')
  ) {
    throw new ArasIdentityError(
      'ARAS_CREDENTIAL_NOT_IDENTITY',
      'UserName/Password kimlik OLAMAZ.',
    )
  }
  const userName = String(params.userName ?? '').trim()
  const password = String(params.password ?? '').trim()
  const candidate = String(params.candidateValue ?? '').trim()
  if (candidate !== '' && (candidate === userName || candidate === password)) {
    throw new ArasIdentityError(
      'ARAS_CREDENTIAL_NOT_IDENTITY',
      'Kimlik bilgisi değeri providerAccountId OLAMAZ.',
    )
  }
}
