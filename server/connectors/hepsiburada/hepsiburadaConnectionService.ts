// HEPSIBURADA HESAPLARI — bağla / yükle / ayır / listele (hesap kapsamlı).
//
// ═══ KİMLİK + KAPSAM ═════════════════════════════════════════════════════
//
//   · Hesap kimliği: (kiracı, 'hepsiburada', merchantId) → marketplace_accounts.
//   · Kimlik: connector_credentials (şifreli; anahtar sürümlü), hesap kapsamlı.
//   · Sahiplik her işlemde MUTASYONDAN ÖNCE kanıtlanır; yabancı kiracı veya
//     başka sağlayıcının hesabı → NOT_FOUND, hiçbir mutasyon.
//   · Parola hiçbir görünümde/yanıtta YOKTUR; boş gönderilirse kayıtlı
//     parola korunur (arayüz parolayı geri göstermez).
//
// Bağlama AĞ ÇAĞRISI YAPMAZ: uç nokta yolları resmî olarak kanıtlanmadığı için
// yapılandırma önce kaydedilebilir; okuma "Test Et" ile ayrıca denenir.
import { and, eq } from 'drizzle-orm'
import { marketplaceAccounts } from '../../db/schema.ts'
import {
  ensureAccount,
  listAccounts,
  type MarketplaceAccount,
} from '../../integrations/marketplaceAccountRepository.ts'
import { getSyncState } from '../../onboarding/onboardingRepository.ts'
import {
  deleteConnectorCredential,
  getConnectorCredential,
  saveConnectorCredential,
} from '../connectorCredentialStore.ts'
import {
  configFromStoredPayload,
  configToStoredPayload,
  HEPSIBURADA_ACCOUNT_MARKETPLACE,
  HEPSIBURADA_PROVIDER_KEY,
  resolveReadFamily,
  toConfigView,
  validateHepsiburadaConfig,
  type HepsiburadaConfigError,
  type HepsiburadaConfigInput,
  type HepsiburadaConfigView,
  type HepsiburadaConnectorConfig,
} from './hepsiburadaConfig.ts'
import { resolveHepsiburadaHealth, type HepsiburadaHealth } from './hepsiburadaHealth.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function requireOrg(value: unknown): string {
  const organizationId = String(value ?? '').trim()
  if (organizationId === '') throw new Error('organizationId zorunludur.')
  return organizationId
}

/** Sağlayıcı + kiracı SAHİPLİĞİ kanıtlanmış Hepsiburada hesabı (yoksa null). */
export async function findOwnedHepsiburadaAccount(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<MarketplaceAccount | null> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') return null
  const rows = await db
    .select()
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, marketplaceAccountId),
        eq(marketplaceAccounts.marketplace, HEPSIBURADA_ACCOUNT_MARKETPLACE),
      ),
    )
    .limit(1)
  return (rows[0] as MarketplaceAccount | undefined) ?? null
}

export interface HepsiburadaConnectResult {
  ok: boolean
  errors: HepsiburadaConfigError[]
  marketplaceAccountId: string | null
}

/**
 * Yapılandırmayı doğrular ve hesabı + şifreli kimliği kaydeder (idempotent).
 * Aynı merchantId için ikinci çağrı AYNI hesabı günceller.
 */
export async function connectHepsiburadaAccount(
  db: Db,
  input: HepsiburadaConfigInput & { organizationId: string },
): Promise<HepsiburadaConnectResult> {
  const organizationId = requireOrg(input.organizationId)
  const merchantId = String(input.merchantId ?? '').trim()
  // Parola/kullanıcı adı boşsa ve bu merchant zaten kayıtlıysa kayıtlı değer
  // KORUNUR (arayüz bunları geri göstermez). Yalnız AYNI kiracı + AYNI merchant.
  let storedPassword: string | null = null
  let storedUsername: string | null = null
  if (merchantId !== '' && (String(input.password ?? '') === '' || String(input.username ?? '').trim() === '')) {
    const existing = (await listAccounts(db, organizationId, HEPSIBURADA_ACCOUNT_MARKETPLACE))
      .find((account) => account.providerAccountId === merchantId)
    if (existing) {
      const stored = await getConnectorCredential(db, {
        organizationId, marketplaceAccountId: existing.id, providerKey: HEPSIBURADA_PROVIDER_KEY,
      })
      storedPassword = stored ? String(stored.payload.password ?? '') : null
      storedUsername = stored ? String(stored.payload.username ?? '') : null
    }
  }
  const validation = validateHepsiburadaConfig(input, { storedPassword, storedUsername })
  if (!validation.ok) return { ok: false, errors: validation.errors, marketplaceAccountId: null }
  const config = validation.config

  const account = await ensureAccount(db, organizationId, HEPSIBURADA_ACCOUNT_MARKETPLACE, config.merchantId)
  await db
    .update(marketplaceAccounts)
    .set({
      isActive: true,
      displayName: `Hepsiburada • ${config.merchantId}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
        eq(marketplaceAccounts.marketplace, HEPSIBURADA_ACCOUNT_MARKETPLACE),
      ),
    )
  await saveConnectorCredential(db, {
    organizationId,
    marketplaceAccountId: account.id,
    providerKey: HEPSIBURADA_PROVIDER_KEY,
    payload: configToStoredPayload(config),
  })
  return { ok: true, errors: [], marketplaceAccountId: account.id }
}

/** Sahipliği kanıtlanmış hesabın yapılandırması (kimlik yoksa/bozuksa config null). */
export async function loadHepsiburadaAccount(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ account: MarketplaceAccount; config: HepsiburadaConnectorConfig | null } | null> {
  const account = await findOwnedHepsiburadaAccount(db, params)
  if (!account) return null
  const stored = await getConnectorCredential(db, {
    organizationId: String(params.organizationId).trim(),
    marketplaceAccountId: account.id,
    providerKey: HEPSIBURADA_PROVIDER_KEY,
  })
  return { account, config: configFromStoredPayload(stored?.payload) }
}

/**
 * Tek hesabı ayırır — FAIL-CLOSED. Kimlik silinir, hesap pasifleşir; geçmiş
 * siparişler ve kardeş hesaplar DOKUNULMAZ.
 */
export async function disconnectHepsiburadaAccount(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ outcome: 'DISCONNECTED' | 'NOT_FOUND' }> {
  const account = await findOwnedHepsiburadaAccount(db, params)
  if (!account) return { outcome: 'NOT_FOUND' }
  const organizationId = String(params.organizationId).trim()
  await deleteConnectorCredential(db, {
    organizationId, marketplaceAccountId: account.id, providerKey: HEPSIBURADA_PROVIDER_KEY,
  })
  await db
    .update(marketplaceAccounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
        eq(marketplaceAccounts.marketplace, HEPSIBURADA_ACCOUNT_MARKETPLACE),
      ),
    )
  return { outcome: 'DISCONNECTED' }
}

export interface HepsiburadaAccountView {
  marketplaceAccountId: string
  merchantId: string
  displayName: string | null
  isActive: boolean
  config: HepsiburadaConfigView | null
  health: HepsiburadaHealth
}

/** Kiracının Hepsiburada hesapları — SIR ASLA dönmez. */
export async function listHepsiburadaAccounts(db: Db, organizationId: string): Promise<HepsiburadaAccountView[]> {
  const org = requireOrg(organizationId)
  const accounts = await listAccounts(db, org, HEPSIBURADA_ACCOUNT_MARKETPLACE)
  const views: HepsiburadaAccountView[] = []
  for (const account of accounts) {
    const stored = await getConnectorCredential(db, {
      organizationId: org, marketplaceAccountId: account.id, providerKey: HEPSIBURADA_PROVIDER_KEY,
    })
    const config = configFromStoredPayload(stored?.payload)
    const syncState = await getSyncState(db, org, 'orders', account.id)
    views.push({
      marketplaceAccountId: account.id,
      merchantId: account.providerAccountId,
      displayName: account.displayName ?? null,
      isActive: account.isActive,
      config: config ? toConfigView(config) : null,
      health: resolveHepsiburadaHealth({
        hasEndpointPath: Boolean(config && resolveReadFamily(config)),
        credentialsComplete: config !== null,
        syncState,
      }),
    })
  }
  return views
}
