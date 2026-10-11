// HESAP KAPSAMLI KARGO ÖDEYEN YAPILANDIRMASI.
//
// ═══ NEDEN HESAP KAPSAMLI, ORG KAPSAMLI DEĞİL ════════════════════════════
//
// Bir organizasyonun AYNI pazaryerinde iki hesabı olabilir ve bu hesapların
// TİCARİ SÖZLEŞMELERİ FARKLI olabilir (biri pazaryeri ödüyor, diğeri satıcı).
// Org geneli tek bir ayar, bu gerçeği EZERDİ — entegrasyon sağlığı modelinde
// yaşanan "sağlayıcı çökmesi" kusurunun aynısı olurdu.
//
// ═══ MIGRATION KARARI: YOK ═══════════════════════════════════════════════
//
// `organization_settings.settings_json` zaten organizasyon başına esnek
// yapılandırmanın kanonik yeridir. Ödeyen ayarı ORADA, ama HESAP KİMLİĞİYLE
// ANAHTARLANMIŞ bir harita olarak tutulur:
//
//   settings_json.marketplacePayer = { "<marketplaceAccountId>": "SELLER_PAYS" }
//
// Böylece hesap-özel gerçek org geneli bir alanın İÇİNE GİZLENMEZ; her hesap
// kendi değerini taşır ve biri diğerini ezemez.
import { and, eq } from 'drizzle-orm'
import { marketplaceAccounts, organizationSettings } from '../db/schema.ts'
import {
  payerEvidenceClass,
  SHIPPING_PAYERS,
  type PayerEvidenceClass,
  type ShippingPayer,
} from './shippingBillingParty.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const PAYER_SETTINGS_KEY = 'marketplacePayer'

export class TenantScopeMissingError extends Error {}
export class AccountNotInTenantError extends Error {}
export class InvalidPayerValueError extends Error {}
export class PayerNotConfigurableError extends Error {}

function requireTenant(organizationId: unknown): string {
  const scoped = String(organizationId ?? '').trim()
  if (scoped === '') {
    throw new TenantScopeMissingError('organizationId zorunludur; kapsamsız erişim yapılmaz.')
  }
  return scoped
}

function normalize(value: unknown): ShippingPayer | null {
  const text = String(value ?? '').trim().toUpperCase()
  return (SHIPPING_PAYERS as readonly string[]).includes(text)
    ? (text as ShippingPayer)
    : null
}

/** Kiracının TÜM hesap ödeyen ayarları: `{ accountId: payer }`. */
export async function loadAccountPayerConfigs(
  db: Db,
  organizationId: string,
): Promise<Record<string, ShippingPayer>> {
  const scoped = requireTenant(organizationId)
  const rows = await db
    .select({ settingsJson: organizationSettings.settingsJson })
    .from(organizationSettings)
    // KİRACI SINIRI — istisnasız.
    .where(eq(organizationSettings.organizationId, scoped))
  const block = (rows[0]?.settingsJson as Record<string, unknown> | null)?.[PAYER_SETTINGS_KEY]
  if (!block || typeof block !== 'object') return {}
  const out: Record<string, ShippingPayer> = {}
  for (const [accountId, value] of Object.entries(block as Record<string, unknown>)) {
    const payer = normalize(value)
    // TANINMAYAN değer SESSİZCE bir ödeyene çevrilmez; atlanır → UNKNOWN.
    if (payer && payer !== 'UNKNOWN') out[accountId] = payer
  }
  return out
}

/**
 * Tek hesabın ödeyen ayarını yazar.
 *
 * HESAP KİRACIYA AİT OLMALIDIR: başka bir organizasyonun hesabına yazmak
 * FAIL-CLOSED reddedilir.
 */
export async function setAccountPayerConfig(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string,
  payer: ShippingPayer,
): Promise<void> {
  const scoped = requireTenant(organizationId)
  const accountId = String(marketplaceAccountId ?? '').trim()
  if (accountId === '') {
    throw new AccountNotInTenantError('marketplaceAccountId zorunludur.')
  }
  const normalized = normalize(payer)
  if (!normalized) {
    throw new InvalidPayerValueError(`Geçersiz ödeyen değeri: ${String(payer)}`)
  }

  // SAHİPLİK DOĞRULAMASI — hesap bu kiracıya ait mi.
  const owned = await db
    .select({
      id: marketplaceAccounts.id,
      marketplace: marketplaceAccounts.marketplace,
    })
    .from(marketplaceAccounts)
    .where(
      and(
        eq(marketplaceAccounts.id, accountId),
        eq(marketplaceAccounts.organizationId, scoped),
      ),
    )
  if (owned.length === 0) {
    throw new AccountNotInTenantError('Hesap bu organizasyona ait değil.')
  }

  // YAPILANDIRILABİLİRLİK — SUNUM DEĞİL, YAZMA KAPISI.
  //
  // Trendyol'da ödeyen SİPARİŞ SÖZLEŞMESİNDEN okunur. UI alanı gizlemek
  // YETMEZ: API doğrudan çağrılabilir. Elle yazılmış bir Trendyol ayarı,
  // sözleşmeden gelen gerçeğin ÜSTÜNE oturmaya çalışırdı; bu yüzden yazma
  // yolunda da REDDEDİLİR.
  const marketplace = String((owned[0] as Record<string, unknown>).marketplace ?? '')
  if (payerEvidenceClass(marketplace) === 'CAN_DERIVE_FROM_ORDER') {
    throw new PayerNotConfigurableError(
      `Bu pazaryerinde ödeyen sipariş verisinden okunur; elle ayarlanamaz: ${marketplace}`,
    )
  }

  const rows = await db
    .select({ settingsJson: organizationSettings.settingsJson })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, scoped))
  const current = (rows[0]?.settingsJson as Record<string, unknown> | null) ?? {}
  const block = {
    ...((current[PAYER_SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}),
    // YALNIZ bu hesabın anahtarı değişir; kardeş hesaplar KORUNUR.
    [accountId]: normalized,
  }
  const next = { ...current, [PAYER_SETTINGS_KEY]: block }

  if (rows.length === 0) {
    await db.insert(organizationSettings).values({ organizationId: scoped, settingsJson: next })
    return
  }
  await db
    .update(organizationSettings)
    .set({ settingsJson: next, updatedAt: new Date() })
    .where(eq(organizationSettings.organizationId, scoped))
}

/** UI için hesap satırı — SIR TAŞIMAZ, görünen ad KİMLİK DEĞİLDİR. */
export interface AccountPayerRow {
  marketplaceAccountId: string
  marketplace: string
  displayName: string | null
  isActive: boolean
  evidenceClass: PayerEvidenceClass
  /** Sözleşmeden türetilebiliyorsa operatöre SORULMAZ. */
  configurable: boolean
  payer: ShippingPayer
}

/**
 * Kiracının TÜM pazaryeri hesapları + mevcut ödeyen ayarı.
 *
 * Tek okuma noktası burasıdır; rota katmanı DB'ye dokunmaz.
 */
export async function loadAccountPayerView(
  db: Db,
  organizationId: string,
): Promise<AccountPayerRow[]> {
  const scoped = requireTenant(organizationId)
  const [accounts, configured] = await Promise.all([
    db
      .select({
        id: marketplaceAccounts.id,
        marketplace: marketplaceAccounts.marketplace,
        displayName: marketplaceAccounts.displayName,
        isActive: marketplaceAccounts.isActive,
      })
      .from(marketplaceAccounts)
      // KİRACI SINIRI — istisnasız.
      .where(eq(marketplaceAccounts.organizationId, scoped)),
    loadAccountPayerConfigs(db, scoped),
  ])
  return (accounts as Record<string, unknown>[]).map((account) => {
    const marketplace = String(account.marketplace ?? '')
    const evidenceClass = payerEvidenceClass(marketplace)
    const id = String(account.id)
    return {
      marketplaceAccountId: id,
      marketplace,
      displayName: account.displayName ? String(account.displayName) : null,
      isActive: Boolean(account.isActive),
      evidenceClass,
      configurable: evidenceClass !== 'CAN_DERIVE_FROM_ORDER',
      payer: configured[id] ?? 'UNKNOWN',
    }
  })
}
