// ORTAK GÖNDERİ ÖN KONTROLÜ (PHASE2-D) — TAŞIYICIDAN BAĞIMSIZ.
//
// Taşıyıcıya gönderi oluşturma çağrısı yapılmadan ÖNCE şu sorular kesin
// cevaplanmalıdır; biri bile belirsizse çağrı YAPILMAZ ve sipariş "Kontrol
// Gerekli" durumuna düşer. SESSİZ VARSAYILAN YOKTUR.
//
//   kiracı            → oturumdan
//   satış hesabı      → siparişin kendi hesabı; yoksa tek aktif hesap; yoksa
//                       (hiç hesap yoksa) eski hesapsız kapsam; birden çok
//                       aktif hesap varsa BELİRSİZ
//   kargo hesabı      → açık eşleme / tek hesap (carriers/carrierResolution)
//   kargo doğrulaması → hesabın KALICI doğrulama kaydı
//   ödeyen            → kanıtlı sipariş sözleşmesi / hesap ayarı; UNKNOWN → YOK
//   ödeyen tutarlılığı→ pazaryerinin söylediği ödeyen = taşıyıcıya giden anlam
//   anlaşma / fiyat   → kullanıcının kendi kargo hesabı; fiyat UYDURULMAZ
//   zorunlu alanlar   → paket/sipariş no, alıcı, adres, il
//   işlem kimliği     → deterministik idempotency anahtarı
//
// Bu dosyanın değerlendiricisi SAFTIR (DB/ağ YOK); yükleyici yalnız okur.
// Mevcut Sürat finansal kapısı (`suratFinancialGate`) YERİNDE KALIR — bu
// katman onun YERİNE geçmez, ÜSTÜNE eklenir ve her taşıyıcıya uygulanır.
import { and, eq } from 'drizzle-orm'
import { marketplaceAccounts, orders } from '../db/schema.ts'
import {
  resolveCarrierAccountFromRecords,
  type CarrierAccountRecord,
  type CarrierMappingRecord,
} from '../carriers/carrierResolution.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type CanonicalPayer = 'MARKETPLACE_PAYS' | 'SELLER_PAYS' | 'UNKNOWN'
export type PayerSource = 'ORDER_CONTRACT' | 'ACCOUNT_CONFIG' | 'TENANT_CONFIG' | 'UNKNOWN'

export const PREFLIGHT_BLOCKERS = {
  TENANT_SCOPE_MISSING: 'Çalışma alanı belirlenemedi.',
  MARKETPLACE_ACCOUNT_AMBIGUOUS: 'Siparişin hangi satış hesabına ait olduğu belirlenemedi.',
  MARKETPLACE_ACCOUNT_NOT_FOUND: 'Siparişin satış hesabı bu çalışma alanında bulunamadı.',
  CARRIER_ACCOUNT_NOT_CONFIGURED: 'Bu sipariş için bağlı bir kargo hesabı yok.',
  CARRIER_ACCOUNT_DISABLED: 'Eşlenen kargo hesabı kapalı.',
  CARRIER_MAPPING_PROVIDER_MISMATCH: 'Satış hesabı başka bir kargo firmasının hesabına eşlenmiş.',
  CARRIER_ACCOUNT_AMBIGUOUS: 'Birden çok kargo hesabı var; satış hesabı için hangisinin kullanılacağı seçilmeli.',
  CARRIER_NOT_VERIFIED: 'Kargo hesabı doğrulanmamış; Entegrasyonlar ekranında bağlantıyı test edin.',
  PAYER_UNKNOWN: 'Kargo ücretini kimin ödediği kesin değil.',
  PAYER_MISMATCH: 'Pazaryerinin bildirdiği ödeyen ile kargoya gidecek ödeyen uyuşmuyor.',
  REQUIRED_FIELDS_MISSING: 'Gönderi için zorunlu sipariş bilgileri eksik.',
  OPERATION_KEY_MISSING: 'Gönderi işlem kimliği üretilemedi.',
} as const
export type PreflightBlocker = keyof typeof PREFLIGHT_BLOCKERS

export const PREFLIGHT_ERROR_CODE = 'SHIPMENT_PREFLIGHT_BLOCKED'

export interface PreflightMarketplaceAccount {
  id: string
  marketplace: string
  isActive: boolean
}

export interface PreflightOrder {
  marketplace: string
  packageId?: string | null
  orderNumber?: string | null
  /** SUNUCUDA çözülen hesap (DB'deki sipariş satırı) — istemciden ALINMAZ. */
  marketplaceAccountId?: string | null
  recipientName?: string | null
  address?: string | null
  city?: string | null
}

export interface PreflightInput {
  organizationId: string | null
  provider: string
  order: PreflightOrder
  marketplaceAccounts: readonly PreflightMarketplaceAccount[]
  carrierAccounts: readonly CarrierAccountRecord[]
  carrierMappings: readonly CarrierMappingRecord[]
  /** Pazaryeri/sipariş tarafının ödeyeni ve kaynağı. */
  payer: { payer: CanonicalPayer; source: PayerSource }
  /**
   * Taşıyıcıya gidecek isteğin ödeyen anlamı (ör. Sürat kimlik rolü). null →
   * taşıyıcı ödeyeni ayrıca ifade etmiyor; tutarlılık kontrolü atlanır.
   */
  carrierPayer: CanonicalPayer | null
  idempotencyKey: string | null
  /** Sağlayıcıya özgü kanıt (ham alanlar) — kayda JSON olarak girer. */
  evidence?: Record<string, unknown>
}

export interface ShipmentProvenance {
  marketplaceAccountId: string | null
  marketplaceAccountSource: 'ORDER' | 'ONLY_ACTIVE_ACCOUNT' | 'LEGACY_UNSCOPED'
  carrierAccountId: string
  carrierAccountSource: string
  payerType: 'MARKETPLACE_PAYS' | 'SELLER_PAYS'
  payerSource: 'ORDER_CONTRACT' | 'ACCOUNT_CONFIG' | 'TENANT_CONFIG'
  expectedPayer: CanonicalPayer
  resolvedPayer: CanonicalPayer
  contractSource: 'CARRIER_ACCOUNT'
  rateSource: 'NOT_QUOTED'
  carrierVerifiedAt: string | null
  preflightReference: string
  preflightEvidence: Record<string, unknown>
}

export type PreflightResult =
  | { ok: true; provenance: ShipmentProvenance }
  | { ok: false; blockers: PreflightBlocker[]; errorCode: typeof PREFLIGHT_ERROR_CODE; message: string }

function filled(value: unknown): boolean {
  return String(value ?? '').trim().length > 0
}

function resolveMarketplaceAccount(
  order: PreflightOrder,
  accounts: readonly PreflightMarketplaceAccount[],
):
  | { ok: true; id: string | null; source: ShipmentProvenance['marketplaceAccountSource'] }
  | { ok: false; code: 'MARKETPLACE_ACCOUNT_AMBIGUOUS' | 'MARKETPLACE_ACCOUNT_NOT_FOUND' } {
  const marketplace = order.marketplace.toLowerCase()
  if (order.marketplaceAccountId) {
    const own = accounts.find((account) => account.id === order.marketplaceAccountId)
    return own ? { ok: true, id: own.id, source: 'ORDER' } : { ok: false, code: 'MARKETPLACE_ACCOUNT_NOT_FOUND' }
  }
  const same = accounts.filter((account) => account.marketplace.toLowerCase() === marketplace)
  if (same.length === 0) return { ok: true, id: null, source: 'LEGACY_UNSCOPED' }
  const active = same.filter((account) => account.isActive)
  if (active.length === 1) return { ok: true, id: active[0].id, source: 'ONLY_ACTIVE_ACCOUNT' }
  return { ok: false, code: 'MARKETPLACE_ACCOUNT_AMBIGUOUS' }
}

/** SAF karar — hiçbir yan etki yok. */
export function evaluateShipmentPreflight(input: PreflightInput): PreflightResult {
  const blockers: PreflightBlocker[] = []
  if (!filled(input.organizationId)) blockers.push('TENANT_SCOPE_MISSING')

  const marketplaceAccount = resolveMarketplaceAccount(input.order, input.marketplaceAccounts)
  if (!marketplaceAccount.ok) blockers.push(marketplaceAccount.code)

  const carrier = resolveCarrierAccountFromRecords(input.carrierAccounts, input.carrierMappings, {
    provider: input.provider,
    marketplaceAccountId: marketplaceAccount.ok ? marketplaceAccount.id : null,
  })
  if (!carrier.ok) blockers.push(carrier.code)
  else if (carrier.account.verificationStatus !== 'verified') blockers.push('CARRIER_NOT_VERIFIED')

  const expected = input.payer.payer
  if (expected === 'UNKNOWN' || input.payer.source === 'UNKNOWN') blockers.push('PAYER_UNKNOWN')
  else if (input.carrierPayer != null && input.carrierPayer !== expected) blockers.push('PAYER_MISMATCH')

  if (
    !(filled(input.order.packageId) || filled(input.order.orderNumber)) ||
    !filled(input.order.recipientName) ||
    !filled(input.order.address) ||
    !filled(input.order.city)
  ) {
    blockers.push('REQUIRED_FIELDS_MISSING')
  }
  if (!filled(input.idempotencyKey)) blockers.push('OPERATION_KEY_MISSING')

  if (blockers.length > 0 || !marketplaceAccount.ok || !carrier.ok || expected === 'UNKNOWN' || input.payer.source === 'UNKNOWN') {
    return {
      ok: false,
      blockers,
      errorCode: PREFLIGHT_ERROR_CODE,
      message: `Kontrol gerekli — gönderi oluşturulmadı. ${blockers.map((code) => PREFLIGHT_BLOCKERS[code]).join(' ')}`,
    }
  }
  return {
    ok: true,
    provenance: {
      marketplaceAccountId: marketplaceAccount.id,
      marketplaceAccountSource: marketplaceAccount.source,
      carrierAccountId: carrier.account.id,
      carrierAccountSource: carrier.source,
      payerType: expected,
      payerSource: input.payer.source,
      expectedPayer: expected,
      resolvedPayer: input.carrierPayer ?? expected,
      contractSource: 'CARRIER_ACCOUNT',
      rateSource: 'NOT_QUOTED',
      carrierVerifiedAt: carrier.account.lastVerifiedAt,
      preflightReference: String(input.idempotencyKey),
      preflightEvidence: { provider: input.provider, ...(input.evidence ?? {}) },
    },
  }
}

/* ─── Yükleyici (yalnız okur) ────────────────────────────────────────── */

/** Siparişin SUNUCUDAKİ satış hesabı (istemcinin gönderdiği değere güvenilmez). */
export async function loadOrderMarketplaceAccountId(
  db: Db,
  params: { organizationId: string; marketplace: string; packageId: string | null },
): Promise<string | null> {
  if (!params.packageId) return null
  const rows = await db
    .select({ marketplaceAccountId: orders.marketplaceAccountId })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, params.organizationId),
        eq(orders.marketplace, params.marketplace),
        eq(orders.packageId, params.packageId),
      ),
    )
    .limit(2)
  const ids = [...new Set(rows.map((row: Record<string, unknown>) => row.marketplaceAccountId).filter(Boolean))]
  return ids.length === 1 ? String(ids[0]) : null
}

export async function loadPreflightMarketplaceAccounts(
  db: Db,
  organizationId: string,
): Promise<PreflightMarketplaceAccount[]> {
  const rows = await db
    .select({ id: marketplaceAccounts.id, marketplace: marketplaceAccounts.marketplace, isActive: marketplaceAccounts.isActive })
    .from(marketplaceAccounts)
    .where(eq(marketplaceAccounts.organizationId, organizationId))
  return rows
    .filter((row: Record<string, unknown>) => String(row.marketplace).toLowerCase() !== 'aras')
    .map((row: Record<string, unknown>) => ({
      id: String(row.id),
      marketplace: String(row.marketplace),
      isActive: row.isActive === true,
    }))
}

/** Kayda yazılacak normalize kolonlar (shipments + shipment_operations). */
export function provenanceColumns(provenance: ShipmentProvenance | null | undefined): Record<string, unknown> {
  if (!provenance) return {}
  return {
    marketplaceAccountId: provenance.marketplaceAccountId,
    carrierAccountId: provenance.carrierAccountId,
    payerType: provenance.payerType,
    payerSource: provenance.payerSource,
    expectedPayer: provenance.expectedPayer,
    resolvedPayer: provenance.resolvedPayer,
    contractSource: provenance.contractSource,
    rateSource: provenance.rateSource,
    carrierVerifiedAt: provenance.carrierVerifiedAt ? new Date(provenance.carrierVerifiedAt) : null,
    preflightReference: provenance.preflightReference,
    preflightEvidence: {
      ...provenance.preflightEvidence,
      marketplaceAccountSource: provenance.marketplaceAccountSource,
      carrierAccountSource: provenance.carrierAccountSource,
    },
  }
}

/** Sürat finansal kapı izinden kanonik ödeyen (sipariş sözleşmesi). */
export function suratExpectedPayer(billingParty: unknown): CanonicalPayer {
  if (billingParty === 'TRENDYOL_PAYS') return 'MARKETPLACE_PAYS'
  if (billingParty === 'SELLER_PAYS') return 'SELLER_PAYS'
  return 'UNKNOWN'
}

/**
 * Sürat kimlik rolünün ödeyen anlamı. COD rolü bir ödeyen beyanı DEĞİLDİR
 * (tahsilat yöntemidir) → null: tutarlılık kontrolü bu durumda atlanır.
 */
export function suratCarrierPayer(credentialRole: unknown): CanonicalPayer | null {
  if (credentialRole === 'PRIMARY_MARKETPLACE') return 'MARKETPLACE_PAYS'
  if (credentialRole === 'SELLER_PAYS') return 'SELLER_PAYS'
  return null
}
