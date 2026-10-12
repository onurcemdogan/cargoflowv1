import { listAccounts } from '../../integrations/marketplaceAccountRepository.ts'
import { arasCredentialRef, listCarrierAccounts } from '../../carriers/carrierAccounts.ts'
import { getConnectorCredential } from '../connectorCredentialStore.ts'
import {
  connectArasCarrierAccount,
  disconnectArasCarrierAccount,
} from './arasConnectionService.ts'
import { ARAS_PROVIDER_KEY } from './arasIdentity.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export async function handleArasListStores(params: {
  db: Db
  organizationId: string
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const [accounts, carrierAccounts] = await Promise.all([
    listAccounts(params.db, params.organizationId, ARAS_PROVIDER_KEY),
    listCarrierAccounts(params.db, params.organizationId),
  ])
  // TAŞIYICI HESABI HİZASI (PHASE2-F): doğrulama durumu `carrier_accounts`
  // kaydından gelir — bu uç "kayıtlı = doğrulandı" demez. Sır DÖNMEZ.
  const stores = []
  for (const account of accounts) {
    const carrier = carrierAccounts.find(
      (row) => row.provider === ARAS_PROVIDER_KEY && row.credentialRef === arasCredentialRef(account.id),
    )
    const credential = await getConnectorCredential(params.db, {
      organizationId: params.organizationId,
      marketplaceAccountId: account.id,
      providerKey: ARAS_PROVIDER_KEY,
    })
    stores.push({
      marketplaceAccountId: account.id,
      displayName: account.displayName,
      isActive: account.isActive,
      configured: Boolean(credential),
      carrierAccountId: carrier?.id ?? null,
      verificationStatus: carrier?.verificationStatus ?? 'unverified',
      lastVerifiedAt: carrier?.lastVerifiedAt ?? null,
      enabled: carrier?.enabled ?? false,
    })
  }
  return {
    httpStatus: 200,
    body: { ok: true, rolloutStage: 'internal_test', stores },
  }
}

export async function handleArasConnect(params: {
  db: Db
  organizationId: string
  body: Record<string, unknown>
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const result = await connectArasCarrierAccount(params.db, {
    organizationId: params.organizationId,
    userName: String(params.body.userName ?? ''),
    password: String(params.body.password ?? ''),
    displayName: params.body.displayName ? String(params.body.displayName) : null,
    marketplaceAccountId: params.body.marketplaceAccountId
      ? String(params.body.marketplaceAccountId)
      : null,
  })
  return {
    httpStatus: result.ok ? 200 : 400,
    body: {
      ok: result.ok,
      message: result.message,
      marketplaceAccountId: result.marketplaceAccountId,
      rolloutStage: 'internal_test',
    },
  }
}

export async function handleArasDisconnect(params: {
  db: Db
  organizationId: string
  marketplaceAccountId: string
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const result = await disconnectArasCarrierAccount(params.db, {
    organizationId: params.organizationId,
    marketplaceAccountId: params.marketplaceAccountId,
  })
  return {
    httpStatus: result.ok ? 200 : 400,
    body: { ok: result.ok },
  }
}
