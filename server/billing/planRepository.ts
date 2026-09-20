// PLAN ATAMASI + KULLANIM ÖLÇÜMÜ — MEVCUT KALICILIĞI KULLANIR.
//
// ═══ MIGRATION KARARI: YOK ═══════════════════════════════════════════════
//
// Denetlendi: şemada `plan`/`subscription`/`entitlement`/`quota` alanı YOK.
// Ama `organization_settings.settings_json` ZATEN organizasyon başına esnek
// yapılandırmanın kanonik yeridir ve birden çok modül tarafından kullanılır
// (etiket belgesi deposu, index.mjs ayar uçları). Plan ataması ORAYA yazılır.
//
// Spekülatif tablo (invoices/payments/cards) AÇILMAZ; bu bilette ödeme YOK.
//
// ═══ GERİYE UYUMLULUK — EN KRİTİK KURAL ══════════════════════════════════
//
// Üretimde ŞU AN çalışan organizasyonların plan kaydı YOKTUR. Kayıt yokluğu
// "Free" SAYILMAZ: öyle sayılsaydı, bu kod üretime çıktığı an mevcut
// Trendyol + Sürat kullanıcıları yetenek KAYBEDERDİ.
//
// Kayıt yoksa → `legacy_unmetered` (her şey sınırsız, açıkça geçiş durumu).
// Bu bir satış planı DEĞİLDİR ve `assignable: false`tır.
import { and, count, eq, isNotNull } from 'drizzle-orm'
import { marketplaceAccounts, orders, organizationSettings, shipments } from '../db/schema.ts'
import { PLAN_IDS, type PlanId } from './planCatalog.ts'
import { NOT_YET_METERED, type UsageReading } from './featureAccess.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** `settings_json` içindeki plan bloğunun anahtarı. */
export const PLAN_SETTINGS_KEY = 'planAssignment'

export class TenantScopeMissingError extends Error {}

export interface PlanAssignment {
  planId: PlanId
  /** Geçiş durumunda mı (kayıt yoktu). */
  legacy: boolean
  assignedAt: string | null
  /** Kim/ne atadı — denetlenebilirlik için. Sır TAŞIMAZ. */
  assignedBy: string | null
}

const LEGACY_ASSIGNMENT: PlanAssignment = {
  planId: 'legacy_unmetered',
  legacy: true,
  assignedAt: null,
  assignedBy: null,
}

function readAssignment(settings: unknown): PlanAssignment {
  const block = (settings as Record<string, unknown> | null)?.[PLAN_SETTINGS_KEY]
  if (!block || typeof block !== 'object') return LEGACY_ASSIGNMENT
  const raw = block as Record<string, unknown>
  const planId = String(raw.planId ?? '')
  if (!(PLAN_IDS as readonly string[]).includes(planId)) {
    // TANINMAYAN plan kimliği UYDURULMAZ; geçiş durumuna düşülür ki mevcut
    // kullanıcı yetenek kaybetmesin.
    return LEGACY_ASSIGNMENT
  }
  return {
    planId: planId as PlanId,
    legacy: planId === 'legacy_unmetered',
    assignedAt: raw.assignedAt ? String(raw.assignedAt) : null,
    assignedBy: raw.assignedBy ? String(raw.assignedBy) : null,
  }
}

/** Kiracıya ait plan ataması. Kayıt yoksa GERİYE UYUMLU geçiş durumu. */
export async function loadPlanAssignment(
  db: Db,
  organizationId: string,
): Promise<PlanAssignment> {
  const scoped = String(organizationId ?? '').trim()
  if (scoped === '') {
    throw new TenantScopeMissingError('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  }
  const rows = await db
    .select({ settingsJson: organizationSettings.settingsJson })
    .from(organizationSettings)
    // KİRACI SINIRI — istisnasız.
    .where(eq(organizationSettings.organizationId, scoped))
  if (rows.length === 0) return LEGACY_ASSIGNMENT
  return readAssignment(rows[0]?.settingsJson)
}

/** Ölçülen metrikler — her biri OTORİTER bir kaynağa bağlıdır. */
export const USAGE_METRICS = [
  'connections.marketplace',
  'connections.carrier',
  'orders.ingested.total',
  'labels.created.total',
  'team.members',
  'orders.ingested.monthly',
] as const
export type UsageMetric = (typeof USAGE_METRICS)[number]

export interface UsageSnapshot {
  metrics: Record<UsageMetric, UsageReading>
  measuredAt: string
}

/**
 * KULLANIM ÖLÇÜMÜ — HER DEĞER GERÇEK BİR TABLODAN GELİR.
 *
 * Ölçülemeyenler AÇIKÇA `NOT_YET_METERED` döner; sahte sıfır ÜRETİLMEZ.
 *
 * `team.members`  : şemada `users` tablosunda UNIQUE(organization_id) vardır
 *                   → organizasyon başına TEK kullanıcı. Üyelik tablosu
 *                   OLMADIĞI için "ekip üyesi" ticari metriği ÖLÇÜLEMEZ.
 * `orders.ingested.monthly`
 *                 : faturalama DÖNGÜSÜ yoktur (ödeme sağlayıcı yok). Takvim
 *                   ayı mı, abonelik ayı mı, hangi saat dilimi — hiçbiri
 *                   kabul edilmemiştir. UYDURULMAZ, ERTELENİR.
 */
export async function loadUsageSnapshot(
  db: Db,
  organizationId: string,
  options: { nowMs: number },
): Promise<UsageSnapshot> {
  const scoped = String(organizationId ?? '').trim()
  if (scoped === '') {
    throw new TenantScopeMissingError('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  }

  const [marketplaceRows, carrierRows, orderRows, activatedRows] = await Promise.all([
    // OTORİTER: pazaryeri hesapları tablosu.
    db
      .select({ value: count() })
      .from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.organizationId, scoped)),
    // OTORİTER: CargoFlow'un OLUŞTURDUĞU gönderiler (taşıyıcı bağlantısı
    // kanıtı); dışarıdan gelen pazaryeri gönderisi SAYILMAZ.
    db
      .select({ value: count() })
      .from(shipments)
      .where(and(eq(shipments.organizationId, scoped), eq(shipments.source, 'local_create'))),
    db.select({ value: count() }).from(orders).where(eq(orders.organizationId, scoped)),
    // OTORİTER: kullanıcının etiketi İŞ AKIŞINA ALDIĞI siparişler.
    // `user_label_activated_at` YALNIZ açık kullanıcı aksiyonuyla yazılır
    // (arka plan hazırlığı bu alanı DOLDURMAZ), bu yüzden ticari "etiket
    // üretildi" metriği için doğru kaynaktır.
    db
      .select({ value: count() })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, scoped),
          isNotNull(orders.userLabelActivatedAt),
        ),
      ),
  ])

  const readCount = (rows: { value: number }[]): UsageReading => ({
    metered: true,
    value: Number(rows[0]?.value ?? 0),
  })

  return {
    measuredAt: new Date(options.nowMs).toISOString(),
    metrics: {
      'connections.marketplace': readCount(marketplaceRows),
      'connections.carrier': readCount(carrierRows),
      'orders.ingested.total': readCount(orderRows),
      'labels.created.total': readCount(activatedRows),
      // ÖLÇÜLEMEZ — üyelik tablosu yok (org başına tek kullanıcı).
      'team.members': {
        ...NOT_YET_METERED,
        reason: 'NO_MEMBERSHIP_TABLE',
      },
      // ERTELENDİ — faturalama döngüsü tanımlı değil.
      'orders.ingested.monthly': {
        ...NOT_YET_METERED,
        reason: 'NO_BILLING_CYCLE_DEFINED',
      },
    },
  }
}
