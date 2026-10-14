// Account-scoped canonical order ingestion only. Fulfillment keeps liveWriteGate.
import { and, eq } from 'drizzle-orm'
import { marketplaceAccounts } from '../db/schema.ts'
import { credentialFingerprint } from '../integrations/credentialService.ts'
import { getConnectorCredential } from './connectorCredentialStore.ts'
import { supportsAccountOrdersRead } from './connectorKernel.ts'
import { buildProviderCatalog, resolveRolloutStage } from './providerCatalog.ts'
import type { LiveWriteGateResult } from './liveWriteGate.ts'
const catalog = buildProviderCatalog()

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface AccountOrdersReadGateResult {
  decision: 'ALLOWED' | 'BLOCKED_BY_ACCOUNT'
  stage: LiveWriteGateResult['stage']
  reasonCode: string
  checkpointBlocker?: string
}
export type OrdersReadGateResult = LiveWriteGateResult | AccountOrdersReadGateResult

export { supportsAccountOrdersRead } from './connectorKernel.ts'

/** Only credential/config fields proven by this provider's read probe. */
export function accountOrdersReadPayload(providerKey: string, payload: Record<string, unknown>): Record<string, unknown> {
  const fields = catalog.get(providerKey)?.accountOrdersRead?.fingerprintFields ?? []
  return Object.fromEntries(fields.map((field) => [field, payload[field] ?? null]))
}

/** Evidence always comes from DB; request-body verification flags are never accepted. */
export async function getAccountOrdersReadGate(
  db: Db,
  scope: { organizationId: string; marketplaceAccountId: string; providerKey: string; expectedFingerprint?: string | null },
): Promise<AccountOrdersReadGateResult> {
  const providerKey = scope.providerKey.trim().toLowerCase()
  const stage = resolveRolloutStage(providerKey)
  const blocked = (reasonCode: string): AccountOrdersReadGateResult => ({ decision: 'BLOCKED_BY_ACCOUNT', stage, reasonCode })
  const descriptor = catalog.get(providerKey)
  if (!supportsAccountOrdersRead(descriptor)) return blocked('ORDERS_READ_NOT_AVAILABLE')
  if (!scope.organizationId.trim() || !scope.marketplaceAccountId.trim()) return blocked('ACCOUNT_NOT_VERIFIED')
  const [account] = await db.select().from(marketplaceAccounts).where(and(
    eq(marketplaceAccounts.organizationId, scope.organizationId),
    eq(marketplaceAccounts.id, scope.marketplaceAccountId),
    eq(marketplaceAccounts.marketplace, providerKey),
  )).limit(1)
  if (!account) return blocked('ACCOUNT_NOT_VERIFIED')
  if (!account.isActive) return blocked('ACCOUNT_NOT_ACTIVE')
  const credential = await getConnectorCredential(db, scope)
  if (!credential) return blocked('ACCOUNT_NOT_VERIFIED')
  if (descriptor?.accountOrdersRead?.requiredCredentialFields.some((field) => !String(credential.payload[field] ?? '').trim())) return blocked('ACCOUNT_NOT_VERIFIED')
  const endpointFields = descriptor?.accountOrdersRead?.requiredEndpointFields
  if (endpointFields && !endpointFields.some((field) => String(credential.payload[field] ?? '').trim())) return blocked('ORDERS_READ_NOT_AVAILABLE')
  const fingerprint = credentialFingerprint(accountOrdersReadPayload(providerKey, credential.payload))
  if (!fingerprint || fingerprint !== account.credentialFingerprint ||
      (scope.expectedFingerprint !== undefined && scope.expectedFingerprint !== fingerprint)) {
    return blocked('ACCOUNT_CREDENTIALS_CHANGED')
  }
  if (account.verificationStatus !== 'verified') return blocked('ACCOUNT_NOT_VERIFIED')
  return {
    decision: 'ALLOWED', stage, reasonCode: 'ACCOUNT_VERIFIED',
    ...(descriptor?.accountOrdersRead?.checkpointBlocker ? { checkpointBlocker: descriptor.accountOrdersRead.checkpointBlocker } : {}),
  }
}
