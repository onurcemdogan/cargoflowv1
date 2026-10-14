// N11 HESAPLARI — bağla / yükle / ayır / listele / satıcı bağla (hesap kapsamlı).
//
//   · Hesap kimliği: (kiracı, 'n11', appKey parmak izi) → marketplace_accounts.
//   · Kimlik: connector_credentials (şifreli), hesap kapsamlı; yük
//     { appKey, appSecret, boundSellerId }.
//   · Sahiplik her işlemde MUTASYONDAN ÖNCE kanıtlanır; yabancı kiracı veya
//     başka sağlayıcının hesabı → NOT_FOUND, hiçbir mutasyon, hiçbir ağ çağrısı.
//   · appSecret hiçbir görünümde/yanıtta YOKTUR; tam appKey de dönmez.
//   · Bu depo yalnız kaydeder; HTTP save/test akışı güvenli GET ile doğrular.
import { and, eq, ne } from 'drizzle-orm'
import { marketplaceAccounts, organizations } from '../../db/schema.ts'
import { credentialFingerprint } from '../../integrations/credentialService.ts'
import { recordMarketplaceVerification, syncMarketplaceAccountFingerprint } from '../../carriers/carrierAccounts.ts'
import { accountOrdersReadPayload, getAccountOrdersReadGate } from '../accountOrdersReadGate.ts'
import { ensureAccount, listAccounts, type MarketplaceAccount } from '../../integrations/marketplaceAccountRepository.ts'
import { getSyncState } from '../../onboarding/onboardingRepository.ts'
import { deleteConnectorCredential, getConnectorCredential, saveConnectorCredential } from '../connectorCredentialStore.ts'
import {
  configFromStoredPayload,
  configToStoredPayload,
  N11_ACCOUNT_MARKETPLACE,
  N11_PROVIDER_KEY,
  n11AccountFingerprint,
  toConfigView,
  validateN11Credentials,
  type N11ConfigError,
  type N11ConfigView,
  type N11ConnectorConfig,
} from './n11Config.ts'
import { resolveN11Health, type N11Health } from './n11Health.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function requireOrg(value: unknown): string {
  const organizationId = String(value ?? '').trim()
  if (organizationId === '') throw new Error('organizationId zorunludur.')
  return organizationId
}

/** Sağlayıcı + kiracı SAHİPLİĞİ kanıtlanmış n11 hesabı (yoksa null). */
export async function findOwnedN11Account(
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
        eq(marketplaceAccounts.marketplace, N11_ACCOUNT_MARKETPLACE),
      ),
    )
    .limit(1)
  return (rows[0] as MarketplaceAccount | undefined) ?? null
}

async function readStoredConfig(db: Db, organizationId: string, marketplaceAccountId: string): Promise<N11ConnectorConfig | null> {
  const stored = await getConnectorCredential(db, { organizationId, marketplaceAccountId, providerKey: N11_PROVIDER_KEY })
  return configFromStoredPayload(stored?.payload)
}

export interface N11ConnectResult {
  ok: boolean
  errors: Array<N11ConfigError | 'N11_APP_KEY_CHANGED' | 'N11_ACCOUNT_NOT_FOUND'>
  marketplaceAccountId: string | null
}

/**
 * Yeni bağlantı ya da düzenleme (`marketplaceAccountId` verilirse).
 *
 * Düzenlemede appKey boş bırakılırsa kayıtlıdır; girilirse AYNI parmak izini
 * vermelidir (farklı appKey = farklı API hesabı → yeni bağlantı). appSecret
 * boşsa kayıtlı değer korunur. Bağlı satıcı kimliği korunur.
 */
export async function connectN11Account(
  db: Db,
  input: { organizationId: string; marketplaceAccountId?: unknown; appKey?: unknown; appSecret?: unknown },
): Promise<N11ConnectResult> {
  const organizationId = requireOrg(input.organizationId)
  const editId = String(input.marketplaceAccountId ?? '').trim()
  let stored: N11ConnectorConfig | null = null
  let existing: MarketplaceAccount | null = null

  if (editId !== '') {
    existing = await findOwnedN11Account(db, { organizationId, marketplaceAccountId: editId })
    if (!existing) return { ok: false, errors: ['N11_ACCOUNT_NOT_FOUND'], marketplaceAccountId: null }
    stored = await readStoredConfig(db, organizationId, existing.id)
    const typedKey = String(input.appKey ?? '').trim()
    if (typedKey !== '' && n11AccountFingerprint(typedKey) !== existing.providerAccountId) {
      return { ok: false, errors: ['N11_APP_KEY_CHANGED'], marketplaceAccountId: null }
    }
  } else {
    const typedKey = String(input.appKey ?? '').trim()
    if (typedKey !== '') {
      existing = (await listAccounts(db, organizationId, N11_ACCOUNT_MARKETPLACE))
        .find((account) => account.providerAccountId === n11AccountFingerprint(typedKey)) ?? null
      if (existing) stored = await readStoredConfig(db, organizationId, existing.id)
    }
  }

  const validation = validateN11Credentials(
    { appKey: input.appKey, appSecret: input.appSecret },
    { appKey: stored?.appKey ?? null, appSecret: stored?.appSecret ?? null, boundSellerId: stored?.boundSellerId ?? null },
  )
  if (!validation.ok) return { ok: false, errors: validation.errors, marketplaceAccountId: null }
  const config = validation.config
  const fingerprint = n11AccountFingerprint(config.appKey)
  const account = existing ?? (await ensureAccount(db, organizationId, N11_ACCOUNT_MARKETPLACE, fingerprint))
  const view = toConfigView(config)
  await db
    .update(marketplaceAccounts)
    .set({
      isActive: true,
      displayName: config.boundSellerId ? `n11 • Satıcı ${config.boundSellerId}` : `n11 • ${view.appKeyMasked}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
        eq(marketplaceAccounts.marketplace, N11_ACCOUNT_MARKETPLACE),
      ),
    )
  await db.transaction(async (tx: Db) => {
    await tx.select({ id: marketplaceAccounts.id }).from(marketplaceAccounts)
      .where(and(eq(marketplaceAccounts.organizationId, organizationId), eq(marketplaceAccounts.id, account.id))).for('update')
    // Re-read after locking: blank secret edits preserve the current value and
    // cannot overwrite a seller binding learned by a concurrent read.
    const current = await readStoredConfig(tx, organizationId, account.id)
    const latest = validateN11Credentials(input, current ?? config)
    if (!latest.ok) throw new Error('N11_CONFIG_INVALID')
    const payload = configToStoredPayload(latest.config)
    await saveConnectorCredential(tx, { organizationId, marketplaceAccountId: account.id, providerKey: N11_PROVIDER_KEY, payload })
    await syncMarketplaceAccountFingerprint(tx, {
      organizationId, marketplaceAccountId: account.id, payload: accountOrdersReadPayload(N11_PROVIDER_KEY, payload),
    })
  })
  return { ok: true, errors: [], marketplaceAccountId: account.id }
}

/** Sahipliği kanıtlanmış hesabın yapılandırması (kimlik yoksa/bozuksa config null). */
export async function loadN11Account(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ account: MarketplaceAccount; config: N11ConnectorConfig | null } | null> {
  const account = await findOwnedN11Account(db, params)
  if (!account) return null
  return { account, config: await readStoredConfig(db, String(params.organizationId).trim(), account.id) }
}

/**
 * Aynı satıcı bu kiracıda BAŞKA etkin n11 hesabına bağlı mı? (İki API anahtarı
 * aynı satıcıyı okursa siparişler iki hesapta mükerrer kanonik kayıt olurdu.)
 */
export async function findN11SellerConflict(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string; sellerId: string },
): Promise<boolean> {
  const organizationId = requireOrg(params.organizationId)
  const others = await db
    .select()
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.marketplace, N11_ACCOUNT_MARKETPLACE),
        eq(marketplaceAccounts.isActive, true),
        ne(marketplaceAccounts.id, params.marketplaceAccountId),
      ),
    )
  for (const other of others as MarketplaceAccount[]) {
    const config = await readStoredConfig(db, organizationId, other.id)
    if (config?.boundSellerId && config.boundSellerId === params.sellerId) return true
  }
  return false
}

/** Okumadan öğrenilen satıcı kimliğini şifreli yüke bağlar (yalnız henüz bağlı değilse). */
export async function bindN11Seller(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string; sellerId: string; expectedFingerprint: string | null },
): Promise<{ ok: boolean; reasonCode: string | null }> {
  const organizationId = requireOrg(params.organizationId)
  return db.transaction(async (tx: Db) => {
    // Serialize seller claims across sibling accounts, not just one account row.
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).for('update')
    const [account] = await tx.select().from(marketplaceAccounts).where(and(
      eq(marketplaceAccounts.organizationId, organizationId), eq(marketplaceAccounts.id, params.marketplaceAccountId),
      eq(marketplaceAccounts.marketplace, N11_ACCOUNT_MARKETPLACE),
    )).for('update')
    const config = account ? await readStoredConfig(tx, organizationId, params.marketplaceAccountId) : null
    if (!account?.isActive || !config || !params.expectedFingerprint ||
        account.credentialFingerprint !== params.expectedFingerprint ||
        credentialFingerprint(accountOrdersReadPayload(N11_PROVIDER_KEY, configToStoredPayload(config))) !== params.expectedFingerprint) return { ok: false, reasonCode: 'ACCOUNT_CREDENTIALS_CHANGED' }
    if (await findN11SellerConflict(tx, { ...params, organizationId })) {
      await recordMarketplaceVerification(tx, { organizationId, marketplaceAccountId: params.marketplaceAccountId, status: 'unverified', expectedFingerprint: params.expectedFingerprint })
      return { ok: false, reasonCode: 'N11_SELLER_ALREADY_CONNECTED' }
    }
    if (config.boundSellerId) return { ok: config.boundSellerId === params.sellerId, reasonCode: config.boundSellerId === params.sellerId ? null : 'N11_SELLER_MISMATCH' }
    await saveConnectorCredential(tx, {
      organizationId,
      marketplaceAccountId: params.marketplaceAccountId,
      providerKey: N11_PROVIDER_KEY,
      payload: configToStoredPayload({ ...config, boundSellerId: params.sellerId }),
    })
    await tx
      .update(marketplaceAccounts)
      .set({ displayName: `n11 • Satıcı ${params.sellerId}`, updatedAt: new Date() })
      .where(
        and(
          eq(marketplaceAccounts.organizationId, organizationId),
          eq(marketplaceAccounts.id, params.marketplaceAccountId),
          eq(marketplaceAccounts.marketplace, N11_ACCOUNT_MARKETPLACE),
        ),
      )
    return { ok: true, reasonCode: null }
  })
}

/** Tek hesabı ayırır — FAIL-CLOSED. Kimlik silinir, hesap pasifleşir; geçmiş siparişler DOKUNULMAZ. */
export async function disconnectN11Account(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ outcome: 'DISCONNECTED' | 'NOT_FOUND' }> {
  const account = await findOwnedN11Account(db, params)
  if (!account) return { outcome: 'NOT_FOUND' }
  const organizationId = String(params.organizationId).trim()
  await deleteConnectorCredential(db, { organizationId, marketplaceAccountId: account.id, providerKey: N11_PROVIDER_KEY })
  await db
    .update(marketplaceAccounts)
    .set({ isActive: false, verificationStatus: 'unverified', credentialFingerprint: null, lastVerifiedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
        eq(marketplaceAccounts.marketplace, N11_ACCOUNT_MARKETPLACE),
      ),
    )
  return { outcome: 'DISCONNECTED' }
}

export interface N11AccountView {
  marketplaceAccountId: string
  displayName: string | null
  isActive: boolean
  config: N11ConfigView | null
  health: N11Health
  verificationStatus: string
  lastVerifiedAt: Date | null
  lastVerificationAttemptAt: Date | null
  ordersActive: boolean
  ordersReadReasonCode: string
  checkpointBlocker: string | null
}

/** Kiracının n11 hesapları — SIR ASLA dönmez. */
export async function listN11Accounts(db: Db, organizationId: string): Promise<N11AccountView[]> {
  const org = requireOrg(organizationId)
  const accounts = await listAccounts(db, org, N11_ACCOUNT_MARKETPLACE)
  const views: N11AccountView[] = []
  for (const account of accounts) {
    const config = await readStoredConfig(db, org, account.id)
    const syncState = await getSyncState(db, org, 'orders', account.id)
    const gate = await getAccountOrdersReadGate(db, { organizationId: org, marketplaceAccountId: account.id, providerKey: N11_PROVIDER_KEY })
    views.push({
      marketplaceAccountId: account.id,
      displayName: account.displayName ?? null,
      isActive: account.isActive,
      verificationStatus: gate.decision === 'ALLOWED' ? 'verified' : account.verificationStatus === 'verified' ? 'unverified' : account.verificationStatus ?? 'unverified',
      lastVerifiedAt: account.lastVerifiedAt ?? null,
      lastVerificationAttemptAt: account.lastVerificationAttemptAt ?? null,
      ordersActive: gate.decision === 'ALLOWED',
      ordersReadReasonCode: gate.reasonCode,
      checkpointBlocker: gate.checkpointBlocker ?? null,
      config: config ? toConfigView(config) : null,
      health: resolveN11Health({ credentialsComplete: config !== null, syncState }),
    })
  }
  return views
}
