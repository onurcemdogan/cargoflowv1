// IKAS BAĞLANTI SERVİSİ — ÇOK MAĞAZA, HESAP KAPSAMLI, YALNIZ OKUMA.
//
// ═══ KİMLİK: merchant.id — SIR DEĞİL ═════════════════════════════════════
//
// `providerAccountId` = `getMerchant.id`. client_id / client_secret /
// access_token / mağaza URL'i kimlik OLAMAZ: kimlik bilgisi döndürülür ve
// sırdır. Özel uygulama yeniden oluşturulup kimlik döndürülse bile aynı
// merchant.id AYNI hesaba düşer (yeni hesap ÜRETİLMEZ).
//
// ═══ ÇOK MAĞAZA ══════════════════════════════════════════════════════════
//
// WooCommerce deseni: `ensureAccount` (aktifliğe DOKUNMAZ) + yalnız BU
// hesabı aktifleştirme. `resolveOrCreateActiveAccount` ÇAĞRILMAZ — o,
// Trendyol'un tek-aktif anlamı için kardeşleri pasifleştirir.
//
// ═══ KALICILAŞTIRMA SIRASI ═══════════════════════════════════════════════
//
//   1) mağaza adı sözleşmesi (host daima *.myikas.com)
//   2) OAuth belirteci
//   3) getMerchant → merchant.id (+ storeName)
//   4) asgari sipariş okuma yetkisi doğrulaması (limit 1)
//   5) YALNIZ hepsi başarılıysa: hesap + aktiflik + şifreli kimlik
//
// Başarısız doğrulama HİÇBİR ŞEY yazmaz; sahte "yapılandırıldı" YOK.
// access_token ASLA kalıcılaştırılmaz.
import { and, eq } from 'drizzle-orm'
import { marketplaceAccounts } from '../../db/schema.ts'
import {
  ensureAccount,
  listAccounts,
  type MarketplaceAccount,
} from '../../integrations/marketplaceAccountRepository.ts'
import {
  deleteConnectorCredential,
  getConnectorCredential,
  saveConnectorCredential,
} from '../connectorCredentialStore.ts'
import {
  fetchIkasMerchant,
  fetchIkasOrderPage,
  ikasSafeMessage,
  type IkasClientOptions,
  type IkasCredentials,
  type IkasErrorClass,
} from './ikasClient.ts'
import { normalizeIkasStoreName } from './ikasStoreName.ts'
import { IKAS_PROVIDER_KEY } from './ikasOrderSync.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const IKAS_CONNECT_OUTCOMES = ['CONNECTED', 'STORE_NAME_REJECTED', 'CONNECTION_FAILED'] as const
export type IkasConnectOutcome = (typeof IKAS_CONNECT_OUTCOMES)[number]

export interface IkasConnectResult {
  outcome: IkasConnectOutcome
  errorClass: IkasErrorClass | null
  message: string
  marketplaceAccountId: string | null
  providerAccountId: string | null
}

export interface IkasConnectInput {
  organizationId: string
  storeName: string
  clientId: string
  clientSecret: string
}

function requireOrg(value: unknown): string {
  const organizationId = String(value ?? '').trim()
  if (organizationId === '') throw new Error('organizationId zorunludur.')
  return organizationId
}

export async function connectIkasStore(
  db: Db,
  input: IkasConnectInput,
  options: IkasClientOptions,
): Promise<IkasConnectResult> {
  const organizationId = requireOrg(input.organizationId)
  const store = normalizeIkasStoreName(input.storeName)
  if (!store.ok) {
    return {
      outcome: 'STORE_NAME_REJECTED',
      errorClass: 'STORE_NAME_INVALID',
      message: ikasSafeMessage('STORE_NAME_INVALID'),
      marketplaceAccountId: null,
      providerAccountId: null,
    }
  }
  const clientId = String(input.clientId ?? '').trim()
  const clientSecret = String(input.clientSecret ?? '')
  const credentials: IkasCredentials = {
    storeName: store.storeName,
    tokenUrl: store.tokenUrl,
    clientId,
    clientSecret,
  }
  const fail = (errorClass: IkasErrorClass, providerAccountId: string | null = null): IkasConnectResult => ({
    outcome: 'CONNECTION_FAILED',
    errorClass,
    message: ikasSafeMessage(errorClass),
    marketplaceAccountId: null,
    providerAccountId,
  })
  if (clientId === '' || clientSecret === '') return fail('AUTH_FAILED')

  // 2–3) Belirteç + mağaza kimliği.
  const merchant = await fetchIkasMerchant(credentials, options)
  if (!merchant.ok) return fail(merchant.errorClass)

  // 4) Asgari sipariş okuma yetkisi — sipariş verisi SAKLANMAZ.
  const probe = await fetchIkasOrderPage(credentials, { page: 1, limit: 1 }, options)
  if (!probe.ok) return fail(probe.errorClass, merchant.data.id)

  // 5) Yalnız TAM doğrulamadan sonra kalıcılaştır — kardeşlere DOKUNMADAN.
  const account = await ensureAccount(db, organizationId, IKAS_PROVIDER_KEY, merchant.data.id)
  await db
    .update(marketplaceAccounts)
    .set({
      isActive: true,
      displayName: merchant.data.storeName ?? store.storeName,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
        eq(marketplaceAccounts.marketplace, IKAS_PROVIDER_KEY),
      ),
    )
  await saveConnectorCredential(db, {
    organizationId,
    marketplaceAccountId: account.id,
    providerKey: IKAS_PROVIDER_KEY,
    // access_token KALICILAŞTIRILMAZ.
    payload: { storeName: store.storeName, clientId, clientSecret },
  })
  return {
    outcome: 'CONNECTED',
    errorClass: null,
    message: 'ikas bağlantısı doğrulandı ve kaydedildi.',
    marketplaceAccountId: account.id,
    providerAccountId: merchant.data.id,
  }
}

/** Sağlayıcı + kiracı SAHİPLİĞİ kanıtlanmış ikas hesabı (yoksa null). */
export async function findOwnedIkasAccount(
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
        eq(marketplaceAccounts.marketplace, IKAS_PROVIDER_KEY),
      ),
    )
    .limit(1)
  return (rows[0] as MarketplaceAccount | undefined) ?? null
}

/** Sahipliği kanıtlanmış hesabın şifreli kimliği (yoksa null). */
export async function loadIkasCredentials(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ account: MarketplaceAccount; credentials: IkasCredentials } | null> {
  const account = await findOwnedIkasAccount(db, params)
  if (!account) return null
  const stored = await getConnectorCredential(db, {
    organizationId: String(params.organizationId).trim(),
    marketplaceAccountId: account.id,
    providerKey: IKAS_PROVIDER_KEY,
  })
  if (!stored) return null
  const store = normalizeIkasStoreName(stored.payload.storeName)
  if (!store.ok) return null
  return {
    account,
    credentials: {
      storeName: store.storeName,
      tokenUrl: store.tokenUrl,
      clientId: String(stored.payload.clientId ?? ''),
      clientSecret: String(stored.payload.clientSecret ?? ''),
    },
  }
}

export const IKAS_DISCONNECT_OUTCOMES = ['DISCONNECTED', 'NOT_FOUND'] as const
export type IkasDisconnectOutcome = (typeof IKAS_DISCONNECT_OUTCOMES)[number]

/**
 * Tek mağazayı ayırır — FAIL-CLOSED.
 *
 * Sahiplik (kiracı + hesap + `marketplace = 'ikas'`) MUTASYONDAN ÖNCE
 * kanıtlanır. Yabancı sağlayıcı/kiracı hesabı → NOT_FOUND, HİÇBİR mutasyon.
 * Kardeş mağazalar ve geçmiş iş verisi DOKUNULMAZ.
 */
export async function disconnectIkasStore(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ outcome: IkasDisconnectOutcome }> {
  const account = await findOwnedIkasAccount(db, params)
  if (!account) return { outcome: 'NOT_FOUND' }
  const organizationId = String(params.organizationId).trim()
  await deleteConnectorCredential(db, {
    organizationId,
    marketplaceAccountId: account.id,
    providerKey: IKAS_PROVIDER_KEY,
  })
  await db
    .update(marketplaceAccounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
        eq(marketplaceAccounts.marketplace, IKAS_PROVIDER_KEY),
      ),
    )
  return { outcome: 'DISCONNECTED' }
}

export interface IkasStoreView {
  marketplaceAccountId: string
  providerAccountId: string
  displayName: string | null
  isActive: boolean
  storeName: string | null
  clientIdMasked: string | null
  hasClientSecret: boolean
}

/** Kiracının ikas mağazaları — SIR ve BELİRTEÇ ASLA dönmez. */
export async function listIkasStores(db: Db, organizationId: string): Promise<IkasStoreView[]> {
  const org = requireOrg(organizationId)
  const accounts = await listAccounts(db, org, IKAS_PROVIDER_KEY)
  const views: IkasStoreView[] = []
  for (const account of accounts) {
    const credential = await getConnectorCredential(db, {
      organizationId: org,
      marketplaceAccountId: account.id,
      providerKey: IKAS_PROVIDER_KEY,
    })
    const clientId = String(credential?.payload.clientId ?? '')
    views.push({
      marketplaceAccountId: account.id,
      providerAccountId: account.providerAccountId,
      displayName: account.displayName ?? null,
      isActive: account.isActive,
      storeName: credential ? String(credential.payload.storeName ?? '') || null : null,
      clientIdMasked: clientId === '' ? null : `••••${clientId.slice(-4)}`,
      hasClientSecret: String(credential?.payload.clientSecret ?? '') !== '',
    })
  }
  return views
}
