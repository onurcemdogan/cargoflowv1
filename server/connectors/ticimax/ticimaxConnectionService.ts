// TICIMAX BAĞLANTI SERVİSİ — TEL DOĞRULANMADAN KALICILAŞTIRMA YOK.
//
// Sıra:
//   1) mağaza URL politikası (SSRF / kullanıcı kontrollü yol yok)
//   2) SelectSiparis tel kapısı — doğrulanmamışsa WIRE_CONTRACT_UNVERIFIED
//   3) (gelecek) probe + hesap/sır kalıcılaştırma — bu iskelette ULAŞILMAZ
//
// UyeKodu list/disconnect yanıtlarında ASLA plaintext dönmez.
import { and, eq } from 'drizzle-orm'
import { marketplaceAccounts } from '../../db/schema.ts'
import {
  listAccounts,
  type MarketplaceAccount,
} from '../../integrations/marketplaceAccountRepository.ts'
import {
  deleteConnectorCredential,
  getConnectorCredential,
} from '../connectorCredentialStore.ts'
import {
  assertTicimaxStoreOriginAllowed,
  TICIMAX_PROVIDER_KEY,
} from './ticimaxEndpoint.ts'
import { ticimaxProviderAccountId, assertUyeKoduNeverIdentity } from './ticimaxIdentity.ts'
import { isSelectSiparisWireVerified } from './ticimaxWireGate.ts'
import { ticimaxSafeMessage, type TicimaxErrorClass } from './ticimaxClient.ts'
import type { DnsResolver } from '../storeUrlPolicy.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export { TICIMAX_PROVIDER_KEY }

export const TICIMAX_CONNECT_OUTCOMES = [
  'CONNECTED',
  'STORE_URL_REJECTED',
  'WIRE_CONTRACT_UNVERIFIED',
  'CONNECTION_FAILED',
] as const
export type TicimaxConnectOutcome = (typeof TICIMAX_CONNECT_OUTCOMES)[number]

export interface TicimaxConnectResult {
  outcome: TicimaxConnectOutcome
  errorClass: TicimaxErrorClass | null
  message: string
  account: MarketplaceAccount | null
  providerAccountId: string | null
  /** true ise hesap veya kimlik yazıldı — tel kapalıyken daima false. */
  persisted: boolean
}

export interface TicimaxConnectInput {
  organizationId: string
  storeUrl: string
  uyeKodu: string
  displayName?: string
}

/**
 * Bağlantıyı doğrula / kaydet.
 *
 * Tel sözleşmesi doğrulanmadan HİÇBİR hesap veya sır kalıcılaşmaz.
 */
export async function connectTicimaxStore(
  _db: Db,
  input: TicimaxConnectInput,
  options: { resolver?: DnsResolver } = {},
): Promise<TicimaxConnectResult> {
  const organizationId = String(input.organizationId ?? '').trim()
  if (organizationId === '') {
    throw new Error('organizationId zorunludur.')
  }

  const decision = await assertTicimaxStoreOriginAllowed(input.storeUrl, {
    ...(options.resolver ? { resolver: options.resolver } : {}),
  })
  if (!decision.ok) {
    return {
      outcome: 'STORE_URL_REJECTED',
      errorClass: 'STORE_URL_REJECTED',
      message: `Mağaza adresi kabul edilmedi (${decision.rejection}).`,
      account: null,
      providerAccountId: null,
      persisted: false,
    }
  }

  const providerAccountId = ticimaxProviderAccountId(decision.storeOrigin)
  // UyeKodu değeri hesap kimliği olamaz (sır ≠ identity).
  assertUyeKoduNeverIdentity({
    candidateValue: providerAccountId,
    uyeKodu: input.uyeKodu,
  })

  if (!isSelectSiparisWireVerified()) {
    // FAIL-CLOSED: probe yok, kalıcılaştırma yok.
    return {
      outcome: 'WIRE_CONTRACT_UNVERIFIED',
      errorClass: 'WIRE_CONTRACT_UNVERIFIED',
      message: ticimaxSafeMessage('WIRE_CONTRACT_UNVERIFIED'),
      account: null,
      providerAccountId,
      persisted: false,
    }
  }

  // Tel doğrulandıktan sonra gerçek probe + persist buraya gelir.
  // Bu iskelette selectSiparisVerified=false sabit → buraya düşülmez.
  return {
    outcome: 'CONNECTION_FAILED',
    errorClass: 'WIRE_CONTRACT_UNVERIFIED',
    message: ticimaxSafeMessage('WIRE_CONTRACT_UNVERIFIED'),
    account: null,
    providerAccountId,
    persisted: false,
  }
}

export const TICIMAX_DISCONNECT_OUTCOMES = ['DISCONNECTED', 'NOT_FOUND'] as const
export type TicimaxDisconnectOutcome = (typeof TICIMAX_DISCONNECT_OUTCOMES)[number]

export async function findOwnedTicimaxAccount(
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
        eq(marketplaceAccounts.marketplace, TICIMAX_PROVIDER_KEY),
      ),
    )
    .limit(1)
  return (rows[0] as MarketplaceAccount | undefined) ?? null
}

/**
 * Tek mağazayı ayırır — FAIL-CLOSED sahiplik (kiracı + ticimax).
 * Plaintext UyeKodu dönülmez.
 */
export async function disconnectTicimaxStore(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ outcome: TicimaxDisconnectOutcome }> {
  const account = await findOwnedTicimaxAccount(db, params)
  if (!account) return { outcome: 'NOT_FOUND' }
  const organizationId = String(params.organizationId).trim()
  await deleteConnectorCredential(db, {
    organizationId,
    marketplaceAccountId: account.id,
    providerKey: TICIMAX_PROVIDER_KEY,
  })
  await db
    .update(marketplaceAccounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, account.id),
        eq(marketplaceAccounts.marketplace, TICIMAX_PROVIDER_KEY),
      ),
    )
  return { outcome: 'DISCONNECTED' }
}

export interface TicimaxStoreView {
  marketplaceAccountId: string
  providerAccountId: string
  displayName: string | null
  isActive: boolean
  storeUrl: string | null
  /** UyeKodu var mı — plaintext DEĞİL. */
  hasUyeKodu: boolean
}

/**
 * Kiracının Ticimax mağazaları — UyeKodu ASLA plaintext dönmez.
 *
 * Not: connect henüz kalıcılaştırmadığı için bu liste yalnız manuel /
 * gelecekteki kalıcı hesaplar içindir. ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS
 * listesine ticimax EKLENMEDİ.
 */
export async function listTicimaxStores(
  db: Db,
  organizationId: string,
): Promise<TicimaxStoreView[]> {
  const org = String(organizationId ?? '').trim()
  if (org === '') throw new Error('organizationId zorunludur.')
  const accounts = await listAccounts(db, org, TICIMAX_PROVIDER_KEY)
  const views: TicimaxStoreView[] = []
  for (const account of accounts) {
    const credential = await getConnectorCredential(db, {
      organizationId: org,
      marketplaceAccountId: account.id,
      providerKey: TICIMAX_PROVIDER_KEY,
    })
    views.push({
      marketplaceAccountId: account.id,
      providerAccountId: account.providerAccountId,
      displayName: account.displayName ?? null,
      isActive: account.isActive,
      storeUrl: credential ? String(credential.payload.storeUrl ?? '') || null : null,
      hasUyeKodu: String(credential?.payload.uyeKodu ?? '') !== '',
    })
  }
  return views
}
