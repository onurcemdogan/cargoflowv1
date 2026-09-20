// HESAP KAPSAMLI BAĞLAYICI KİMLİKLERİ — SAĞLAYICI-NÖTR DEPO.
//
// ═══ NEDEN ESKİ TABLOYA ZORLANMADI ═══════════════════════════════════════
//
// `integration_credentials` UNIQUE(organization_id, provider)'dır: bir
// organizasyonun İKİ Woo mağazası için AYRI sır ÇİFTİNİ temsil edemez.
// Ölçüldü (migration öncesi): hem provider allowlist'i hem tekil indeks
// ihlal edildi. Eski tablo Trendyol/Sürat için OLDUĞU GİBİ bırakıldı.
//
// ═══ İKİNCİ KRİPTOGRAFİ YOK ══════════════════════════════════════════════
//
// Şifreleme `credentialService`in AES-256-GCM zarfını AYNEN kullanır. Burada
// yeni bir şifreleme YAZILMAZ — zayıf ikinci uygulama, en olası sır sızıntısı
// kaynağıdır.
//
// ═══ KİRACI + HESAP SAHİPLİĞİ ZORUNLU ════════════════════════════════════
//
// Her sorgu HEM `organization_id` HEM `marketplace_account_id` taşır. Yalnız
// hesap kimliğiyle okuma YAPILMAZ: hesap id'si bilinen bir saldırgan başka
// kiracının sırrını okuyamaz.
import { and, eq } from 'drizzle-orm'
import { connectorCredentials, marketplaceAccounts } from '../db/schema.ts'
import {
  decryptCredentialPayload,
  encryptCredentialPayload,
} from '../integrations/credentialService.ts'
import { normalizeProviderKey } from './connectorKernel.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export class ConnectorCredentialScopeError extends Error {}
export class ConnectorAccountOwnershipError extends Error {}

export interface ConnectorCredentialRecord {
  organizationId: string
  marketplaceAccountId: string
  providerKey: string
  payload: Record<string, unknown>
  keyVersion: number
  updatedAt: Date | null
}

function requireScope(organizationId: unknown, marketplaceAccountId: unknown): {
  organizationId: string
  marketplaceAccountId: string
} {
  const org = String(organizationId ?? '').trim()
  const account = String(marketplaceAccountId ?? '').trim()
  // FAIL-CLOSED: kapsamsız okuma/yazma YOK.
  if (org === '') throw new ConnectorCredentialScopeError('organizationId zorunludur.')
  if (account === '') {
    throw new ConnectorCredentialScopeError('marketplaceAccountId zorunludur.')
  }
  return { organizationId: org, marketplaceAccountId: account }
}

/**
 * Hesap GERÇEKTEN bu kiracıya mı ait.
 *
 * Yazmadan önce sorulur: başka kiracının hesap id'si verilse bile yabancı
 * hesaba sır BAĞLANAMAZ.
 */
export async function assertAccountOwnedByOrganization(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string,
): Promise<void> {
  const scope = requireScope(organizationId, marketplaceAccountId)
  const rows = await db
    .select({ id: marketplaceAccounts.id })
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.organizationId, scope.organizationId),
        eq(marketplaceAccounts.id, scope.marketplaceAccountId),
      ),
    )
    .limit(1)
  if (!rows[0]) {
    throw new ConnectorAccountOwnershipError(
      'Hesap bu kiracıya ait değil; kimlik bağlanmaz.',
    )
  }
}

/** Hesap kapsamlı kimliği yazar/günceller (idempotent). */
export async function saveConnectorCredential(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    providerKey: string
    payload: Record<string, unknown>
  },
): Promise<void> {
  const scope = requireScope(params.organizationId, params.marketplaceAccountId)
  const providerKey = normalizeProviderKey(params.providerKey)
  await assertAccountOwnedByOrganization(
    db,
    scope.organizationId,
    scope.marketplaceAccountId,
  )
  const { encryptedPayload, keyVersion } = encryptCredentialPayload(params.payload)
  const now = new Date()
  await db
    .insert(connectorCredentials)
    .values({
      organizationId: scope.organizationId,
      marketplaceAccountId: scope.marketplaceAccountId,
      providerKey,
      encryptedPayload,
      keyVersion,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        connectorCredentials.organizationId,
        connectorCredentials.marketplaceAccountId,
        connectorCredentials.providerKey,
      ],
      set: { encryptedPayload, keyVersion, updatedAt: now },
    })
}

/** Hesap kapsamlı kimliği okur (yoksa null). */
export async function getConnectorCredential(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    providerKey: string
  },
): Promise<ConnectorCredentialRecord | null> {
  const scope = requireScope(params.organizationId, params.marketplaceAccountId)
  const providerKey = normalizeProviderKey(params.providerKey)
  const rows = await db
    .select()
    .from(connectorCredentials)
    .where(
      and(
        // KİRACI SINIRI — istisnasız.
        eq(connectorCredentials.organizationId, scope.organizationId),
        eq(connectorCredentials.marketplaceAccountId, scope.marketplaceAccountId),
        eq(connectorCredentials.providerKey, providerKey),
      ),
    )
    .limit(1)
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    organizationId: scope.organizationId,
    marketplaceAccountId: scope.marketplaceAccountId,
    providerKey,
    payload: decryptCredentialPayload(String(row.encryptedPayload)),
    keyVersion: Number(row.keyVersion ?? 1),
    updatedAt: (row.updatedAt as Date | null) ?? null,
  }
}

/** Kimliği siler (hesap/iş verisi SİLİNMEZ). */
export async function deleteConnectorCredential(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    providerKey: string
  },
): Promise<void> {
  const scope = requireScope(params.organizationId, params.marketplaceAccountId)
  const providerKey = normalizeProviderKey(params.providerKey)
  await db
    .delete(connectorCredentials)
    .where(
      and(
        eq(connectorCredentials.organizationId, scope.organizationId),
        eq(connectorCredentials.marketplaceAccountId, scope.marketplaceAccountId),
        eq(connectorCredentials.providerKey, providerKey),
      ),
    )
}

/**
 * Kiracının bir sağlayıcı için kimliği OLAN hesap id'leri.
 *
 * Sağlık katmanı bunu HESAP KAPSAMLI varlık için kullanır; sağlayıcı geneli
 * "Woo kimliği var mı" sorusu SORULMAZ — bir mağazanın kimliği silindiyse
 * kardeşi duruyor diye "bağlı" görünemez.
 */
export async function listAccountsWithCredential(
  db: Db,
  params: { organizationId: string; providerKey: string },
): Promise<string[]> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') {
    throw new ConnectorCredentialScopeError('organizationId zorunludur.')
  }
  const providerKey = normalizeProviderKey(params.providerKey)
  const rows = await db
    .select({ marketplaceAccountId: connectorCredentials.marketplaceAccountId })
    .from(connectorCredentials)
    .where(
      and(
        eq(connectorCredentials.organizationId, organizationId),
        eq(connectorCredentials.providerKey, providerKey),
      ),
    )
  return rows.map((row: Record<string, unknown>) => String(row.marketplaceAccountId))
}

/** UI'a dönen maskeli görünüm — SIR ASLA GERİ DÖNMEZ. */
export interface MaskedCredentialView {
  hasConsumerKey: boolean
  consumerKeyMasked: string | null
  hasConsumerSecret: boolean
  hasWebhookSecret: boolean
  updatedAt: Date | null
}

/**
 * Maskeleme.
 *
 * `consumer_key` GİZLİ DEĞİLDİR ama yine de tam gösterilmez (operatörün
 * doğru mağazayı tanıması için son 4 karakter yeter). `consumer_secret` ve
 * webhook secret HİÇBİR biçimde geri dönmez — yalnız VARLIĞI bildirilir.
 */
export function maskConnectorCredential(
  record: ConnectorCredentialRecord | null,
): MaskedCredentialView {
  if (!record) {
    return {
      hasConsumerKey: false,
      consumerKeyMasked: null,
      hasConsumerSecret: false,
      hasWebhookSecret: false,
      updatedAt: null,
    }
  }
  const consumerKey = String(record.payload.consumerKey ?? '')
  const consumerSecret = String(record.payload.consumerSecret ?? '')
  const webhookSecret = String(record.payload.webhookSecret ?? '')
  return {
    hasConsumerKey: consumerKey !== '',
    consumerKeyMasked:
      consumerKey === '' ? null : `••••${consumerKey.slice(-4)}`,
    hasConsumerSecret: consumerSecret !== '',
    hasWebhookSecret: webhookSecret !== '',
    updatedAt: record.updatedAt,
  }
}
