// TAŞIYICI HESAPLARI + PAZARYERİ↔TAŞIYICI EŞLEMESİ (PHASE2-C).
//
// Kullanıcının KENDİ kargo hesapları burada tanımlanır; sır burada DURMAZ
// (`credential_ref` şifreli kaydı gösterir). Gönderi hangi hesapla açılacak
// sorusunun TEK cevabı `resolveCarrierAccount`tır:
//
//   1) Pazaryeri hesabının AÇIK eşlemesi varsa o hesap — sağlayıcısı istenen
//      taşıyıcı değilse veya hesap kapalıysa gönderi YOK.
//   2) Eşleme yoksa organizasyonda istenen taşıyıcının TEK etkin hesabı varsa
//      o hesap (bugünkü tek Sürat hesabı akışı kesintisiz sürer).
//   3) Aday yoksa veya birden çoksa gönderi YOK — tahmin edilmez.
//
// Doğrulama durumu yalnız taşıyıcıya yapılan gerçek, gönderi OLUŞTURMAYAN bir
// kimlik kontrolünden gelir. Kimlik değişince (anahtarlı parmak izi) doğrulama
// `unverified`a döner: eski doğrulama YENİ kimliği kanıtlamaz.
import { and, asc, eq } from 'drizzle-orm'
import { carrierAccounts, marketplaceAccounts, marketplaceCarrierMappings } from '../db/schema.ts'
import {
  credentialFingerprint,
  getIntegrationCredential,
} from '../integrations/credentialService.ts'
import {
  resolveCarrierAccountFromRecords,
  type CarrierAccountRecord,
  type CarrierMappingRecord,
  type CarrierResolution,
  type VerificationStatus,
} from './carrierResolution.ts'

export * from './carrierResolution.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const SURAT_CREDENTIAL_REF = 'integration_credentials:surat'
export const arasCredentialRef = (marketplaceAccountId: string) => `connector_credentials:${marketplaceAccountId}`

function iso(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function toRecord(row: Record<string, unknown>): CarrierAccountRecord {
  return {
    id: String(row.id),
    provider: String(row.provider),
    displayName: String(row.displayName),
    externalAccountRef: row.externalAccountRef == null ? null : String(row.externalAccountRef),
    credentialRef: String(row.credentialRef),
    verificationStatus: String(row.verificationStatus) as VerificationStatus,
    lastVerifiedAt: iso(row.lastVerifiedAt),
    lastVerificationAttemptAt: iso(row.lastVerificationAttemptAt),
    enabled: row.enabled === true,
  }
}

const SAFE_COLUMNS = {
  id: carrierAccounts.id,
  provider: carrierAccounts.provider,
  displayName: carrierAccounts.displayName,
  externalAccountRef: carrierAccounts.externalAccountRef,
  credentialRef: carrierAccounts.credentialRef,
  verificationStatus: carrierAccounts.verificationStatus,
  lastVerifiedAt: carrierAccounts.lastVerifiedAt,
  lastVerificationAttemptAt: carrierAccounts.lastVerificationAttemptAt,
  enabled: carrierAccounts.enabled,
}

function requireOrg(value: unknown): string {
  const organizationId = String(value ?? '').trim()
  if (!organizationId) throw new Error('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  return organizationId
}

export async function listCarrierAccounts(db: Db, organizationId: string): Promise<CarrierAccountRecord[]> {
  const rows = await db
    .select(SAFE_COLUMNS)
    .from(carrierAccounts)
    .where(eq(carrierAccounts.organizationId, requireOrg(organizationId)))
    .orderBy(asc(carrierAccounts.createdAt))
  return rows.map(toRecord)
}

export async function listCarrierMappings(db: Db, organizationId: string): Promise<CarrierMappingRecord[]> {
  const rows = await db
    .select({
      marketplaceAccountId: marketplaceCarrierMappings.marketplaceAccountId,
      carrierAccountId: marketplaceCarrierMappings.carrierAccountId,
    })
    .from(marketplaceCarrierMappings)
    .where(eq(marketplaceCarrierMappings.organizationId, requireOrg(organizationId)))
  return rows.map((row: Record<string, unknown>) => ({
    marketplaceAccountId: String(row.marketplaceAccountId),
    carrierAccountId: String(row.carrierAccountId),
  }))
}

/**
 * Taşıyıcı hesabını oluşturur/günceller. Kimlik parmak izi değiştiyse
 * doğrulama SIFIRLANIR.
 */
export async function upsertCarrierAccount(
  db: Db,
  input: {
    organizationId: string
    provider: string
    credentialRef: string
    displayName: string
    externalAccountRef?: string | null
    fingerprint: string | null
    enabled?: boolean
  },
): Promise<CarrierAccountRecord> {
  const organizationId = requireOrg(input.organizationId)
  const now = new Date()
  const existing = await db
    .select({ id: carrierAccounts.id, credentialFingerprint: carrierAccounts.credentialFingerprint })
    .from(carrierAccounts)
    .where(
      and(
        eq(carrierAccounts.organizationId, organizationId),
        eq(carrierAccounts.provider, input.provider),
        eq(carrierAccounts.credentialRef, input.credentialRef),
      ),
    )
    .limit(1)
  const changed = !existing[0] || existing[0].credentialFingerprint !== input.fingerprint
  const base = {
    displayName: input.displayName,
    externalAccountRef: input.externalAccountRef ?? null,
    enabled: input.enabled ?? true,
    updatedAt: now,
    ...(changed
      ? {
          credentialFingerprint: input.fingerprint,
          verificationStatus: 'unverified',
          lastVerifiedAt: null,
        }
      : {}),
  }
  if (existing[0]) {
    await db.update(carrierAccounts).set(base).where(eq(carrierAccounts.id, existing[0].id))
  } else {
    await db
      .insert(carrierAccounts)
      .values({ organizationId, provider: input.provider, credentialRef: input.credentialRef, ...base })
      .onConflictDoNothing()
  }
  const rows = await db
    .select(SAFE_COLUMNS)
    .from(carrierAccounts)
    .where(
      and(
        eq(carrierAccounts.organizationId, organizationId),
        eq(carrierAccounts.provider, input.provider),
        eq(carrierAccounts.credentialRef, input.credentialRef),
      ),
    )
    .limit(1)
  return toRecord(rows[0])
}

/** Kayıtlı Sürat kimliğinden taşıyıcı hesabını eşitler (kimlik yoksa kapatır). */
export async function syncSuratCarrierAccount(db: Db, organizationId: string): Promise<CarrierAccountRecord | null> {
  const payload = await getIntegrationCredential(db, requireOrg(organizationId), 'surat')
  const customerCode = String(payload?.kullaniciAdi ?? '').trim()
  if (!payload || !customerCode) {
    await db
      .update(carrierAccounts)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(carrierAccounts.organizationId, organizationId),
          eq(carrierAccounts.provider, 'surat'),
          eq(carrierAccounts.credentialRef, SURAT_CREDENTIAL_REF),
        ),
      )
    return null
  }
  return upsertCarrierAccount(db, {
    organizationId,
    provider: 'surat',
    credentialRef: SURAT_CREDENTIAL_REF,
    displayName: 'Sürat Kargo',
    externalAccountRef: customerCode,
    fingerprint: credentialFingerprint(payload),
  })
}

export async function findCarrierAccountByRef(
  db: Db,
  organizationId: string,
  provider: string,
  credentialRef: string,
): Promise<CarrierAccountRecord | null> {
  const rows = await db
    .select(SAFE_COLUMNS)
    .from(carrierAccounts)
    .where(
      and(
        eq(carrierAccounts.organizationId, requireOrg(organizationId)),
        eq(carrierAccounts.provider, provider),
        eq(carrierAccounts.credentialRef, credentialRef),
      ),
    )
    .limit(1)
  return rows[0] ? toRecord(rows[0]) : null
}

/** Gerçek kimlik kontrolünün sonucunu KALICI yazar. */
export async function recordCarrierVerification(
  db: Db,
  params: { organizationId: string; carrierAccountId: string; status: VerificationStatus; now?: Date },
): Promise<void> {
  const now = params.now ?? new Date()
  await db
    .update(carrierAccounts)
    .set({
      verificationStatus: params.status,
      lastVerificationAttemptAt: now,
      ...(params.status === 'verified' ? { lastVerifiedAt: now } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(carrierAccounts.organizationId, requireOrg(params.organizationId)),
        eq(carrierAccounts.id, params.carrierAccountId),
      ),
    )
}

/* ─── Pazaryeri hesabı doğrulaması ───────────────────────────────────── */

/** Kimlik kaydedildiğinde: parmak izi değiştiyse pazaryeri doğrulaması sıfırlanır. */
export async function syncMarketplaceAccountFingerprint(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string; payload: Record<string, unknown> },
): Promise<void> {
  const fingerprint = credentialFingerprint(params.payload)
  const rows = await db
    .select({ credentialFingerprint: marketplaceAccounts.credentialFingerprint })
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, requireOrg(params.organizationId)),
        eq(marketplaceAccounts.id, params.marketplaceAccountId),
      ),
    )
    .limit(1)
  if (!rows[0] || rows[0].credentialFingerprint === fingerprint) return
  await db
    .update(marketplaceAccounts)
    .set({ credentialFingerprint: fingerprint, verificationStatus: 'unverified', lastVerifiedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, params.organizationId),
        eq(marketplaceAccounts.id, params.marketplaceAccountId),
      ),
    )
}

export async function recordMarketplaceVerification(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string; status: VerificationStatus; now?: Date },
): Promise<void> {
  const now = params.now ?? new Date()
  await db
    .update(marketplaceAccounts)
    .set({
      verificationStatus: params.status,
      lastVerificationAttemptAt: now,
      ...(params.status === 'verified' ? { lastVerifiedAt: now } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, requireOrg(params.organizationId)),
        eq(marketplaceAccounts.id, params.marketplaceAccountId),
      ),
    )
}

/* ─── Eşleme ─────────────────────────────────────────────────────────── */

export class CarrierMappingError extends Error {
  readonly code: 'MARKETPLACE_ACCOUNT_NOT_FOUND' | 'CARRIER_ACCOUNT_NOT_FOUND' | 'CARRIER_ACCOUNT_DISABLED'
  constructor(code: CarrierMappingError['code']) {
    super(code)
    this.code = code
  }
}

/** Açık eşleme yazar (`carrierAccountId` null → eşleme kaldırılır). */
export async function setCarrierMapping(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string; carrierAccountId: string | null },
): Promise<void> {
  const organizationId = requireOrg(params.organizationId)
  const marketplace = await db
    .select({ id: marketplaceAccounts.id })
    .from(marketplaceAccounts)
    .where(and(eq(marketplaceAccounts.organizationId, organizationId), eq(marketplaceAccounts.id, params.marketplaceAccountId)))
    .limit(1)
  if (!marketplace[0]) throw new CarrierMappingError('MARKETPLACE_ACCOUNT_NOT_FOUND')
  if (params.carrierAccountId == null) {
    await db
      .delete(marketplaceCarrierMappings)
      .where(
        and(
          eq(marketplaceCarrierMappings.organizationId, organizationId),
          eq(marketplaceCarrierMappings.marketplaceAccountId, params.marketplaceAccountId),
        ),
      )
    return
  }
  const carrier = await db
    .select({ id: carrierAccounts.id, enabled: carrierAccounts.enabled })
    .from(carrierAccounts)
    .where(and(eq(carrierAccounts.organizationId, organizationId), eq(carrierAccounts.id, params.carrierAccountId)))
    .limit(1)
  if (!carrier[0]) throw new CarrierMappingError('CARRIER_ACCOUNT_NOT_FOUND')
  if (carrier[0].enabled !== true) throw new CarrierMappingError('CARRIER_ACCOUNT_DISABLED')
  await db
    .insert(marketplaceCarrierMappings)
    .values({ organizationId, marketplaceAccountId: params.marketplaceAccountId, carrierAccountId: params.carrierAccountId })
    .onConflictDoUpdate({
      target: [marketplaceCarrierMappings.organizationId, marketplaceCarrierMappings.marketplaceAccountId],
      set: { carrierAccountId: params.carrierAccountId, updatedAt: new Date() },
    })
}

export async function resolveCarrierAccount(
  db: Db,
  params: { organizationId: string; provider: string; marketplaceAccountId: string | null },
): Promise<CarrierResolution> {
  const [accounts, mappings] = await Promise.all([
    listCarrierAccounts(db, params.organizationId),
    listCarrierMappings(db, params.organizationId),
  ])
  return resolveCarrierAccountFromRecords(accounts, mappings, params)
}

