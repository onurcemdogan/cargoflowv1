import { listAccounts } from '../../integrations/marketplaceAccountRepository.ts'
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
  const accounts = await listAccounts(params.db, params.organizationId, ARAS_PROVIDER_KEY)
  return {
    httpStatus: 200,
    body: {
      ok: true,
      rolloutStage: 'internal_test',
      stores: accounts.map((a) => ({
        marketplaceAccountId: a.id,
        displayName: a.displayName,
        isActive: a.isActive,
        configured: true,
      })),
    },
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
