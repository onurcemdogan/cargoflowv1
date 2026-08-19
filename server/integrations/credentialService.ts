// Organization bazlı entegrasyon credential servisi (faz: tenant izolasyonu).
// Payload DB'de ASLA düz metin tutulmaz: AES-256-GCM, kayıt başına random IV,
// auth tag + keyVersion saklanır. Secret değerler loglanmaz. db örneği
// dependency-injection ile gelir (hermetik testlerde pglite).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { integrationCredentials } from '../db/schema.ts'

// P4: Hepsiburada ve n11 sozlesmeleri dogrulandi (2026-08-19) → saglayici
// kumesi genisledi. `getOrganizationIntegrationConfig` gibi Trendyol/Surat'a
// OZEL yardimcilar DEGISMEDI: yeni saglayicilar kendi adaptorlerinden okunur
// ve normallestirilmis siparis alanina SIZMAZ.
export type IntegrationProvider = 'trendyol' | 'surat' | 'hepsiburada' | 'n11'
export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  'trendyol', 'surat', 'hepsiburada', 'n11',
]

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

/**
 * Birden çok kayıt bulunduğunda atılır — SESSİZ SEÇİM YERİNE.
 *
 * `(organization_id, provider)` üzerinde tekil indeks VARDIR; yine de bu
 * hata gerçektir: indeks düşerse, geri yükleme çift satır bırakırsa ya da
 * başka bir yol satır eklerse, `rows[0]` HANGİ cariye yazılacağını sessizce
 * seçerdi. Yanlış cariye açılan gönderi geri alınamaz.
 */
export class IntegrationCredentialAmbiguityError extends Error {
  readonly code = 'INTEGRATION_CREDENTIAL_AMBIGUOUS'
  readonly provider: IntegrationProvider
  readonly recordCount: number
  constructor(provider: IntegrationProvider, recordCount: number) {
    super(
      `${provider} entegrasyonu için ${recordCount} kayıt bulundu; `
      + 'tek etkin kayıt zorunludur. Seçim YAPILMADI.',
    )
    this.name = 'IntegrationCredentialAmbiguityError'
    this.provider = provider
    this.recordCount = recordCount
  }
}

export interface IntegrationCredentialRecord {
  /** Kaydın kimliği — hangi satırın okunduğu karşılaştırılabilir olmalı. */
  id: string
  updatedAt: unknown
  payload: Record<string, unknown>
}

/**
 * TEK kaydı kimliğiyle döner. Sıfır kayıt → `null`; birden çok → FAIL CLOSED.
 *
 * Kimlik alanı Part 2 içindir: kanarya ile canlı POST'un AYNI satırı okuyup
 * okumadığı ancak satır kimliği görünürse ampirik olarak karşılaştırılabilir.
 */
export async function getIntegrationCredentialRecord(
  db: CredentialDb,
  organizationId: string,
  provider: IntegrationProvider,
): Promise<IntegrationCredentialRecord | null> {
  const rows = await db
    .select({
      id: integrationCredentials.id,
      updatedAt: integrationCredentials.updatedAt,
      encryptedPayload: integrationCredentials.encryptedPayload,
    })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.organizationId, organizationId),
        eq(integrationCredentials.provider, provider),
      ),
    )
  if (rows.length > 1) {
    throw new IntegrationCredentialAmbiguityError(provider, rows.length)
  }
  const row = rows[0]
  if (!row) return null
  return {
    id: String(row.id ?? ''),
    updatedAt: row.updatedAt ?? null,
    payload: decryptCredentialPayload(String(row.encryptedPayload)),
  }
}

export async function getIntegrationCredential(
  db: CredentialDb,
  organizationId: string,
  provider: IntegrationProvider,
): Promise<Record<string, unknown> | null> {
  const record = await getIntegrationCredentialRecord(db, organizationId, provider)
  return record ? record.payload : null
}

// Frontend'in secret alanlarda gösterdiği maskeli placeholder (yalnız
// bullet/yıldız + "(kayıtlı)" gibi). Bu değer ASLA gerçek credential olarak
// kaydedilmemeli; geldiğinde eski secret korunur.
export function isMaskedPlaceholder(value: unknown): boolean {
  const text = String(value ?? '').trim()
  if (!text) return false
  // Sistemin ürettiği maskeler bullet (•) ile başlar: "••••<tail>" (maskTail)
  // veya "•••••••• (kayıtlı)" (SAVED_SECRET_PLACEHOLDER). Ayrıca tamamı
  // yıldız/nokta olan jenerik maskeler. Gerçek secret'lar bullet ile başlamaz.
  if (/^•{3,}/.test(text)) return true
  if (/^[*·●]{3,}$/.test(text)) return true
  return false
}

// Boş bırakılan VEYA maskeli-placeholder olan secret alanlar eski değeri korur;
// yalnız gerçek yeni değer üzerine yazılır. Böylece frontend maskeli/boş secret
// gönderdiğinde eski secret kaybolmaz ve maske DB'ye gerçek şifre olarak yazılmaz.
function mergePreservingSecrets(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'string' && isMaskedPlaceholder(value)) continue
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

// Maskelenmiş durum: gerçek apiKey/apiSecret/şifre DÖNDÜRMEZ. Yalnız tanımlayıcı
// (sellerId, cariKod, firmaId), ortam, türetilmiş userAgent ve secret'ların
// VARLIK bayrakları (hasApiKey/hasApiSecret/hasPassword/hasWebPassword) döner.
// Frontend bu bilgiyle formu yeniden hydrate eder ve secret alanlarda maskeli
// placeholder gösterir; secret'ın kendisi hiçbir zaman istemciye gitmez.
export async function getMaskedIntegrationStatus(
  db: CredentialDb,
  organizationId: string,
): Promise<{
  trendyol: {
    configured: boolean
    connected: boolean
    sellerId: string
    environment: string
    userAgent: string
    hasApiKey: boolean
    hasApiSecret: boolean
    apiKeyMasked: string
  }
  surat: {
    configured: boolean
    connected: boolean
    customerCode: string
    cariKod: string
    firmaId: string
    environment: string
    serviceMode: string
    hasPassword: boolean
    hasWebPassword: boolean
    usernameMasked: string
  }
}> {
  const { trendyol, surat } = await loadOrganizationIntegrationConfig(
    db,
    organizationId,
  )
  const sellerId = String(trendyol.sellerId ?? '')
  const hasApiKey = Boolean(String(trendyol.apiKey ?? '').trim())
  const hasApiSecret = Boolean(String(trendyol.apiSecret ?? '').trim())
  const trendyolConfigured = Boolean(sellerId || hasApiKey || hasApiSecret)
  const userAgentName = String(trendyol.userAgentName ?? '').trim() || 'CargoFlow'

  const cariKod = String(surat.kullaniciAdi ?? surat.cariKodu ?? '')
  const hasSuratPassword = Boolean(String(surat.sifre ?? '').trim())
  const hasWebPassword = Boolean(String(surat.webPassword ?? '').trim())
  const suratConfigured = Boolean(
    cariKod || hasSuratPassword || hasWebPassword || surat.firmaId,
  )
  return {
    trendyol: {
      configured: trendyolConfigured,
      // "connected": zorunlu alanların tamamı kayıtlı (gerçek test durumu DEĞİL).
      connected: Boolean(sellerId && hasApiKey && hasApiSecret),
      sellerId,
      environment: String(trendyol.environment ?? ''),
      userAgent: sellerId ? `${sellerId} - ${userAgentName}` : '',
      hasApiKey,
      hasApiSecret,
      apiKeyMasked: maskTail(trendyol.apiKey),
    },
    surat: {
      configured: suratConfigured,
      connected: Boolean(cariKod && (hasSuratPassword || hasWebPassword)),
      // customerCode geriye dönük uyum; cariKod yeni standart ad. Canlı-doğrulanmış
      // davranış: kullaniciAdi yoksa firmaId'ye düşer (kullaniciAdi ?? firmaId).
      customerCode: cariKod || String(surat.firmaId ?? ''),
      cariKod,
      firmaId: String(surat.firmaId ?? ''),
      environment: String(surat.ortam ?? ''),
      // SERVİS MODU SIR DEĞİLDİR ve geri okunabilmelidir. Bu alan
      // dönmediğinde form her yüklemede varsayılana (ORTAK_BARKOD_SOAP)
      // düşüyor ve bir sonraki kaydetme, tenant'ın seçtiği modu SESSİZCE
      // eziyordu. Kalıcılık zincirinin kapanması için gereklidir.
      serviceMode: String(surat.serviceMode ?? ''),
      hasPassword: hasSuratPassword,
      hasWebPassword,
      usernameMasked: maskTail(surat.kullaniciAdi),
    },
  }
}
