// Organization bazlı entegrasyon credential servisi (faz: tenant izolasyonu).
// Payload DB'de ASLA düz metin tutulmaz: AES-256-GCM, kayıt başına random IV,
// auth tag + keyVersion saklanır. Secret değerler loglanmaz. db örneği
// dependency-injection ile gelir (hermetik testlerde pglite).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { integrationCredentials } from '../db/schema.ts'

export type IntegrationProvider = 'trendyol' | 'surat'
export const INTEGRATION_PROVIDERS: IntegrationProvider[] = ['trendyol', 'surat']

const CURRENT_KEY_VERSION = 1

// Minimal yapısal db arayüzü (node-postgres veya pglite drizzle örneği).
export interface CredentialDb {
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => {
      onConflictDoUpdate: (config: unknown) => Promise<unknown>
    }
  }
  delete: (table: unknown) => { where: (condition: unknown) => Promise<unknown> }
  select: (fields?: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<Record<string, unknown>[]>
    }
  }
}

export function isCredentialEncryptionConfigured(): boolean {
  try {
    getEncryptionKey()
    return true
  } catch {
    return false
  }
}

// CREDENTIAL_ENCRYPTION_KEY: base64 veya hex kodlanmış 32-byte anahtar.
function getEncryptionKey(): Buffer {
  const raw = String(process.env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim()
  if (!raw) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY tanımlı değil.')
  }
  const candidates: Buffer[] = []
  if (/^[0-9a-fA-F]{64}$/.test(raw)) candidates.push(Buffer.from(raw, 'hex'))
  try {
    candidates.push(Buffer.from(raw, 'base64'))
  } catch {
    // yok say
  }
  const key = candidates.find((buffer) => buffer.length === 32)
  if (!key) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY 32 byte olmalı (base64 veya hex).',
    )
  }
  return key
}

interface EncryptedEnvelope {
  v: number
  iv: string
  tag: string
  data: string
}

export function encryptCredentialPayload(payload: Record<string, unknown>): {
  encryptedPayload: string
  keyVersion: number
} {
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: EncryptedEnvelope = {
    v: CURRENT_KEY_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  }
  return {
    encryptedPayload: JSON.stringify(envelope),
    keyVersion: CURRENT_KEY_VERSION,
  }
}

export function decryptCredentialPayload(
  encryptedPayload: string,
): Record<string, unknown> {
  const key = getEncryptionKey()
  const envelope = JSON.parse(encryptedPayload) as EncryptedEnvelope
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
}

export async function getIntegrationCredential(
  db: CredentialDb,
  organizationId: string,
  provider: IntegrationProvider,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ encryptedPayload: integrationCredentials.encryptedPayload })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.organizationId, organizationId),
        eq(integrationCredentials.provider, provider),
      ),
    )
  const row = rows[0]
  if (!row) return null
  return decryptCredentialPayload(String(row.encryptedPayload))
}

// Boş bırakılan secret alanlar eski değeri korur; sağlanan alanlar üzerine
// yazılır. Böylece frontend maskeli/boş secret gönderdiğinde eski secret
// kaybolmaz.
function mergePreservingSecrets(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined || value === null || value === '') continue
    merged[key] = value
  }
  return merged
}

export async function saveIntegrationCredential(
  db: CredentialDb,
  organizationId: string,
  provider: IntegrationProvider,
  payload: Record<string, unknown>,
): Promise<void> {
  const existing = await getIntegrationCredential(db, organizationId, provider)
  const merged = mergePreservingSecrets(existing, payload)
  const { encryptedPayload, keyVersion } = encryptCredentialPayload(merged)
  await db
    .insert(integrationCredentials)
    .values({ organizationId, provider, encryptedPayload, keyVersion })
    .onConflictDoUpdate({
      target: [
        integrationCredentials.organizationId,
        integrationCredentials.provider,
      ],
      set: { encryptedPayload, keyVersion, updatedAt: new Date() },
    })
}

export async function deleteIntegrationCredential(
  db: CredentialDb,
  organizationId: string,
  provider: IntegrationProvider,
): Promise<void> {
  await db
    .delete(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.organizationId, organizationId),
        eq(integrationCredentials.provider, provider),
      ),
    )
}

// Org'un TÜM credential'larını normalize config şeklinde döner (server
// tarafı kullanım için; secret İÇERİR, yalnız sunucu içi kullanılır).
export async function loadOrganizationIntegrationConfig(
  db: CredentialDb,
  organizationId: string,
): Promise<{ trendyol: Record<string, unknown>; surat: Record<string, unknown> }> {
  const [trendyol, surat] = await Promise.all([
    getIntegrationCredential(db, organizationId, 'trendyol'),
    getIntegrationCredential(db, organizationId, 'surat'),
  ])
  return { trendyol: trendyol ?? {}, surat: surat ?? {} }
}

function maskTail(value: unknown): string {
  const text = String(value ?? '')
  if (!text) return ''
  const tail = text.slice(-4)
  return `••••${tail}`
}

// Maskelenmiş durum: secret DÖNDÜRMEZ; yalnız configured + tanımlayıcı +
// maskeli kuyruk.
export async function getMaskedIntegrationStatus(
  db: CredentialDb,
  organizationId: string,
): Promise<{
  trendyol: {
    configured: boolean
    sellerId: string
    apiKeyMasked: string
  }
  surat: {
    configured: boolean
    customerCode: string
    usernameMasked: string
  }
}> {
  const { trendyol, surat } = await loadOrganizationIntegrationConfig(
    db,
    organizationId,
  )
  const trendyolConfigured = Boolean(
    trendyol.sellerId || trendyol.apiKey || trendyol.apiSecret,
  )
  const suratConfigured = Boolean(
    surat.kullaniciAdi || surat.sifre || surat.webPassword || surat.firmaId,
  )
  return {
    trendyol: {
      configured: trendyolConfigured,
      sellerId: String(trendyol.sellerId ?? ''),
      apiKeyMasked: maskTail(trendyol.apiKey),
    },
    surat: {
      configured: suratConfigured,
      customerCode: String(surat.firmaId ?? surat.kullaniciAdi ?? ''),
      usernameMasked: maskTail(surat.kullaniciAdi),
    },
  }
}
