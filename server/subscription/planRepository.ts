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
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm'
import {
  integrationCredentials,
  marketplaceAccounts,
  orders,
  organizationSettings,
} from '../db/schema.ts'
import { PLAN_IDS, type PlanId } from './planCatalog.ts'
import { NOT_YET_METERED, type UsageReading } from './featureAccess.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * TAŞIYICI sağlayıcılar.
 *
 * `INTEGRATION_PROVIDERS` = trendyol · surat · hepsiburada · n11 — bunlardan
 * YALNIZ `surat` bir taşıyıcıdır. Yani mevcut şema BUGÜN en fazla BİR taşıyıcı
 * bağlantısı temsil edebilir; bu bir SINIRLILIKTIR ve uydurulmaz.
 */
export const CARRIER_PROVIDERS = ['surat'] as const

/** `settings_json` içindeki plan bloğunun anahtarı. */
export const PLAN_SETTINGS_KEY = 'planAssignment'

export class TenantScopeMissingError extends Error {}

/**
 * ATAMA ÇÖZÜMLEME SONUCU — "kayıt yok" ile "kayıt BOZUK" AYRI şeylerdir.
 *
 * ÖLÇÜLEN KUSUR: `tier_standrad` gibi bir YAZIM HATASI sessizce
 * `legacy_unmetered`e düşüyor ve SINIRSIZ hak veriyordu (yeniden üretildi).
 * Yanlış yazılmış bir plan, bedava sınırsız plan DEĞİLDİR.
 */
export const PLAN_RESOLUTIONS = [
  /** Hiç atama yok → mevcut üretim organizasyonu, geriye uyumlu. */
  'LEGACY_NO_ASSIGNMENT',
  /** Tanınan plan atanmış. */
  'ASSIGNED',
  /** AÇIKÇA atanmış ama TANINMAYAN/bozuk → FAIL-CLOSED. */
  'INVALID_ASSIGNMENT',
] as const
export type PlanResolution = (typeof PLAN_RESOLUTIONS)[number]

export interface PlanAssignment {
  /** Bozuk atamada `null` — uydurma plan ATANMAZ. */
  planId: PlanId | null
  resolution: PlanResolution
  /** Geçiş durumunda mı (kayıt yoktu). */
  legacy: boolean
  assignedAt: string | null
  /** Kim/ne atadı — denetlenebilirlik için. Sır TAŞIMAZ. */
  assignedBy: string | null
  /** Bozuk atamada operatöre gösterilecek KARARLI hata kodu. */
  errorCode: string | null
  /** Tanınmayan ham değer (PII değil, yapılandırma verisi). */
  invalidPlanId: string | null
}

const LEGACY_ASSIGNMENT: PlanAssignment = {
  planId: 'legacy_unmetered',
  resolution: 'LEGACY_NO_ASSIGNMENT',
  legacy: true,
  assignedAt: null,
  assignedBy: null,
  errorCode: null,
  invalidPlanId: null,
}

function readAssignment(settings: unknown): PlanAssignment {
  const block = (settings as Record<string, unknown> | null)?.[PLAN_SETTINGS_KEY]
  if (!block || typeof block !== 'object') return LEGACY_ASSIGNMENT
  const raw = block as Record<string, unknown>
  const planId = String(raw.planId ?? '')
  if (!(PLAN_IDS as readonly string[]).includes(planId)) {
    // FAIL-CLOSED: AÇIKÇA yazılmış ama tanınmayan plan, ne sınırsız geçiş
    // durumuna ne de kısıtlayıcı bir plana SESSİZCE çevrilir. Yapılandırma
    // hatası GÖRÜNÜR kılınır ve ticari hak VERİLMEZ.
    return {
      planId: null,
      resolution: 'INVALID_ASSIGNMENT',
      legacy: false,
      assignedAt: raw.assignedAt ? String(raw.assignedAt) : null,
      assignedBy: raw.assignedBy ? String(raw.assignedBy) : null,
      errorCode: 'PLAN_ASSIGNMENT_INVALID',
      invalidPlanId: planId || null,
    }
  }
  return {
    planId: planId as PlanId,
    resolution: 'ASSIGNED',
    legacy: planId === 'legacy_unmetered',
    assignedAt: raw.assignedAt ? String(raw.assignedAt) : null,
    assignedBy: raw.assignedBy ? String(raw.assignedBy) : null,
    errorCode: null,
    invalidPlanId: null,
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
    // OTORİTER: YAPILANDIRILMIŞ TAŞIYICI KİMLİKLERİ.
    //
    // ÖLÇÜLEN KUSUR: burada önce `shipments` sayılıyordu. O GÖNDERİ HACMİDİR,
    // BAĞLANTI DEĞİL: tek bir Sürat yapılandırmasıyla atılan 100 gönderi
    // "100 taşıyıcı bağlantısı" olarak raporlanıyordu (yeniden üretildi).
    //
    // Doğru kaynak `integration_credentials`tır: UNIQUE(org, provider) ile
    // sağlayıcı başına TEK satır tutar. Kimlik ÇÖZÜLMEZ (decrypt YOK);
    // yalnız SATIR VARLIĞI sayılır.
    db
      .select({ value: count() })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.organizationId, scoped),
          inArray(integrationCredentials.provider, [...CARRIER_PROVIDERS]),
        ),
      ),
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
