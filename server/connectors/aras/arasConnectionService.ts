// ARAS bağlantı — hesap kapsamlı şifreli kimlik; internal_test (canlı SOAP probe YOK).

import { and, eq } from 'drizzle-orm'
import { marketplaceAccounts } from '../../db/schema.ts'
import { ensureAccount } from '../../integrations/marketplaceAccountRepository.ts'
import {
  deleteConnectorCredential,
  getConnectorCredential,
  saveConnectorCredential,
} from '../connectorCredentialStore.ts'
import {
  assertArasCredentialNeverIdentity,
  ARAS_PROVIDER_KEY,
  newArasLocalProviderAccountId,
} from './arasIdentity.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface ArasConnectInput {
  organizationId: string
  displayName?: string | null
  userName: string
  password: string
  marketplaceAccountId?: string | null
}

export interface ArasConnectResult {
  ok: boolean
  marketplaceAccountId: string | null
  message: string
}

function requireOrg(value: unknown): string {
  const organizationId = String(value ?? '').trim()
  if (organizationId === '') throw new Error('organizationId zorunludur.')
  return organizationId
}

export async function connectArasCarrierAccount(
  db: Db,
  input: ArasConnectInput,
): Promise<ArasConnectResult> {
  const organizationId = requireOrg(input.organizationId)
  const userName = String(input.userName ?? '').trim()
  const password = String(input.password ?? '')
  if (!userName || !password) {
    return { ok: false, marketplaceAccountId: null, message: 'Kullanıcı adı ve parola zorunludur.' }
  }

  let accountId = String(input.marketplaceAccountId ?? '').trim()
  if (accountId) {
    const rows = await db
      .select({ id: marketplaceAccounts.id })
      .from(marketplaceAccounts)
      .where(
        and(
          eq(marketplaceAccounts.organizationId, organizationId),
          eq(marketplaceAccounts.id, accountId),
          eq(marketplaceAccounts.marketplace, ARAS_PROVIDER_KEY),
        ),
      )
      .limit(1)
    if (!rows[0]) {
      return { ok: false, marketplaceAccountId: null, message: 'Aras hesabı bu kiracıya ait değil.' }
    }
  } else {
    const providerAccountId = newArasLocalProviderAccountId()
    assertArasCredentialNeverIdentity({ candidateValue: providerAccountId, userName, password })
    const account = await ensureAccount(db, organizationId, ARAS_PROVIDER_KEY, providerAccountId)
    accountId = account.id
    if (input.displayName) {
      await db
        .update(marketplaceAccounts)
        .set({ displayName: String(input.displayName).trim(), updatedAt: new Date() })
        .where(
          and(
            eq(marketplaceAccounts.organizationId, organizationId),
            eq(marketplaceAccounts.id, accountId),
          ),
        )
    }
  }

  await saveConnectorCredential(db, {
    organizationId,
    marketplaceAccountId: accountId,
    providerKey: ARAS_PROVIDER_KEY,
    payload: { userName, password, environment: 'TEST' },
  })

  await db
    .update(marketplaceAccounts)
    .set({ isActive: true, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, accountId),
      ),
    )

  return { ok: true, marketplaceAccountId: accountId, message: 'Aras hesabı kaydedildi (internal_test).' }
}

export async function disconnectArasCarrierAccount(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ ok: boolean }> {
  const organizationId = requireOrg(params.organizationId)
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (!marketplaceAccountId) return { ok: false }
  await deleteConnectorCredential(db, {
    organizationId,
    marketplaceAccountId,
    providerKey: ARAS_PROVIDER_KEY,
  })
  await db
    .update(marketplaceAccounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(marketplaceAccounts.organizationId, organizationId),
        eq(marketplaceAccounts.id, marketplaceAccountId),
        eq(marketplaceAccounts.marketplace, ARAS_PROVIDER_KEY),
      ),
    )
  return { ok: true }
}

export async function loadArasCredentialsForAccount(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string },
): Promise<{ userName: string; password: string } | null> {
  const record = await getConnectorCredential(db, {
    organizationId: params.organizationId,
    marketplaceAccountId: params.marketplaceAccountId,
    providerKey: ARAS_PROVIDER_KEY,
  })
  if (!record) return null
  const userName = String(record.payload.userName ?? '').trim()
  const password = String(record.payload.password ?? '')
  if (!userName || !password) return null
  return { userName, password }
}
