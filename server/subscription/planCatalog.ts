// TİCARİ PLAN / HAK KATALOĞU (BILLING-MODEL-UI-001).
//
// ═══ AD ÇAKIŞMASI UYARISI ════════════════════════════════════════════════
//
// Bu depoda `billingParty` ZATEN VARDIR ve TAMAMEN FARKLI bir şeydir:
// GÖNDERİ ÜCRETİNİ KİM ÖDÜYOR (Platform Öder / Satıcı Öder — taşıyıcı
// WhoPays semantiği, 290+ kullanım). Bu dosya ONUNLA İLGİSİZDİR; burada
// konu CargoFlow'un KENDİ ABONELİK planıdır. İkisi ASLA karıştırılmamalıdır.
//
// ═══ FİYAT YOK ═══════════════════════════════════════════════════════════
//
// Depoda kabul edilmiş bir ticari fiyatlandırma YOKTUR (denetlendi: `pricing`
// 0 dosya, `entitlement` 0 dosya, `subscription` yok, şemada plan alanı yok).
// Bu yüzden TL fiyat UYDURULMAZ. Katman kimlikleri NÖTRDÜR ve görünen adlar
// yapılandırılabilir; para bu modele hiç girmez.
//
// ═══ DÖRT KAVRAM AYRIDIR ═════════════════════════════════════════════════
//
//   ÜRÜN YETENEĞİ   → CargoFlow bunu yapabiliyor mu      (connector kernel)
//   PLAN HAKKI      → müşterinin planı buna izin veriyor mu  (BU DOSYA)
//   BAĞLANTI SAĞLIĞI→ entegrasyon teknik olarak çalışıyor mu (integrationHealth)
//   YAYIN AŞAMASI   → özellik canlı davranışa girebilir mi   (rolloutStage)
//
// Bunlar tek bir boolean'a ÇÖKERTİLMEZ.

/**
 * TİCARİ OLARAK KISITLANABİLİR yetenekler.
 *
 * Bunlar ÖLÇEK/ÜRÜN yetenekleridir. Doğruluk ve güvenlik ASLA buraya girmez
 * (bkz. `NEVER_BILLABLE`).
 */
export const BILLABLE_CAPABILITIES = [
  /** Kaç pazaryeri/mağaza bağlantısı kurulabilir. */
  'connections.marketplace',
  /** Kaç taşıyıcı bağlantısı kurulabilir. */
  'connections.carrier',
  /** Toplu etiket yazdırma. */
  'labels.bulk_print',
  /** Kodsuz etiket şablonu düzenleyici. */
  'labels.custom_templates',
  /** Arka planda otomatik etiket hazırlama. */
  'automation.background_label',
  /** Analitik dışa aktarma. */
  'analytics.export',
] as const
export type BillableCapability = (typeof BILLABLE_CAPABILITIES)[number]

/**
 * ASLA PARALI YAPILAMAYACAK yetenekler — DOĞRULUK VE GÜVENLİK.
 *
 * Bir müşterinin siparişinin doğru saatte görünmesi, kiracı izolasyonu, sır
 * şifrelemesi, idempotency ve HATAYI ANLAMAK İÇİN GEREKEN sağlık görünürlüğü
 * ticari pazarlık konusu DEĞİLDİR. Bu liste testle zorunlu kılınır: bu
 * anahtarlardan biri plan hakkı olarak tanımlanırsa test DÜŞER.
 */
export const NEVER_BILLABLE = [
  'orders.sync',
  'labels.generate',
  'integrations.health',
  'security.tenant_isolation',
  'security.secret_encryption',
  'data.integrity',
  'data.retention',
] as const
export type NeverBillableCapability = (typeof NEVER_BILLABLE)[number]

/** Limit TİPİ açıktır; sihirli `-1` KULLANILMAZ. */
export const LIMIT_KINDS = [
  'BOOLEAN',
  /** Şu anki sayım (anlık durum) — ör. bağlı hesap sayısı. */
  'COUNT',
  /** Takvim ayı sayımı — faturalama döngüsü OLMADIĞI için ERTELENDİ. */
  'MONTHLY_COUNT',
  'CONCURRENT_COUNT',
  'RETENTION_DAYS',
] as const
export type LimitKind = (typeof LIMIT_KINDS)[number]

/** Sınırsızlık AÇIKÇA temsil edilir; sayı değildir. */
export type LimitValue =
  | { kind: 'BOOLEAN'; allowed: boolean }
  | { kind: 'COUNT'; max: number }
  | { kind: 'COUNT'; unlimited: true }
  | { kind: 'MONTHLY_COUNT'; max: number }
  | { kind: 'MONTHLY_COUNT'; unlimited: true }
  | { kind: 'CONCURRENT_COUNT'; max: number }
  | { kind: 'RETENTION_DAYS'; days: number }
  | { kind: 'RETENTION_DAYS'; unlimited: true }

export function isUnlimited(limit: LimitValue | null | undefined): boolean {
  return Boolean(limit && 'unlimited' in limit && limit.unlimited === true)
}

export function limitMax(limit: LimitValue | null | undefined): number | null {
  if (!limit) return null
  if (isUnlimited(limit)) return null
  if ('max' in limit) return limit.max
  return null
}

/**
 * PLAN KİMLİKLERİ — NÖTR, ticari ad DEĞİL.
 *
 * `legacy_unmetered` bir SATIŞ planı değildir: yeni ticari model ÖNCESİNDEN
 * var olan organizasyonların GERİYE UYUMLU durumudur (bkz. planRepository).
 */
export const PLAN_IDS = [
  'legacy_unmetered',
  'tier_basic',
  'tier_standard',
  'tier_advanced',
] as const
export type PlanId = (typeof PLAN_IDS)[number]

export interface PlanDefinition {
  planId: PlanId
  /** Görünen ad YAPILANDIRILABİLİR; burada yalnız varsayılan taşınır. */
  defaultDisplayName: string
  /** Bu plan SATILABİLİR mi (legacy geçiş durumu satılamaz). */
  assignable: boolean
  entitlements: Partial<Record<BillableCapability, LimitValue>>
}

const UNLIMITED_COUNT: LimitValue = { kind: 'COUNT', unlimited: true }

/**
 * KATALOG. Fiyat TAŞIMAZ.
 *
 * `legacy_unmetered` HER ŞEYİ SINIRSIZ verir: mevcut üretim organizasyonları
 * yeni modelin yürürlüğe girmesiyle YETENEK KAYBETMEZ.
 */
export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  legacy_unmetered: {
    planId: 'legacy_unmetered',
    defaultDisplayName: 'Mevcut Kullanım',
    assignable: false,
    entitlements: {
      'connections.marketplace': UNLIMITED_COUNT,
      'connections.carrier': UNLIMITED_COUNT,
      'labels.bulk_print': { kind: 'BOOLEAN', allowed: true },
      'labels.custom_templates': { kind: 'BOOLEAN', allowed: true },
      'automation.background_label': { kind: 'BOOLEAN', allowed: true },
      'analytics.export': { kind: 'BOOLEAN', allowed: true },
    },
  },
  tier_basic: {
    planId: 'tier_basic',
    defaultDisplayName: 'Başlangıç',
    assignable: true,
    entitlements: {
      'connections.marketplace': { kind: 'COUNT', max: 1 },
      'connections.carrier': { kind: 'COUNT', max: 1 },
      'labels.bulk_print': { kind: 'BOOLEAN', allowed: false },
      'labels.custom_templates': { kind: 'BOOLEAN', allowed: false },
      'automation.background_label': { kind: 'BOOLEAN', allowed: false },
      'analytics.export': { kind: 'BOOLEAN', allowed: false },
    },
  },
  tier_standard: {
    planId: 'tier_standard',
    defaultDisplayName: 'Standart',
    assignable: true,
    entitlements: {
      'connections.marketplace': { kind: 'COUNT', max: 3 },
      'connections.carrier': { kind: 'COUNT', max: 2 },
      'labels.bulk_print': { kind: 'BOOLEAN', allowed: true },
      'labels.custom_templates': { kind: 'BOOLEAN', allowed: true },
      'automation.background_label': { kind: 'BOOLEAN', allowed: true },
      'analytics.export': { kind: 'BOOLEAN', allowed: false },
    },
  },
  tier_advanced: {
    planId: 'tier_advanced',
    defaultDisplayName: 'Gelişmiş',
    assignable: true,
    entitlements: {
      'connections.marketplace': UNLIMITED_COUNT,
      'connections.carrier': UNLIMITED_COUNT,
      'labels.bulk_print': { kind: 'BOOLEAN', allowed: true },
      'labels.custom_templates': { kind: 'BOOLEAN', allowed: true },
      'automation.background_label': { kind: 'BOOLEAN', allowed: true },
      'analytics.export': { kind: 'BOOLEAN', allowed: true },
    },
  },
}

export function planDefinition(planId: PlanId): PlanDefinition {
  return PLAN_CATALOG[planId]
}

export function entitlementOf(
  planId: PlanId,
  capability: BillableCapability,
): LimitValue | null {
  return PLAN_CATALOG[planId].entitlements[capability] ?? null
}

/**
 * Bu yeteneği İÇEREN en düşük SATILABİLİR plan — "hangi yükseltme gerekli"
 * sorusunun DETERMİNİSTİK cevabı.
 *
 * Yükseltme hedefi YOKSA `null` döner ve UI "Yükselt" DEMEZ.
 */
export function smallestPlanWith(
  capability: BillableCapability,
  atLeast = 1,
): PlanId | null {
  const order: PlanId[] = ['tier_basic', 'tier_standard', 'tier_advanced']
  for (const planId of order) {
    if (!PLAN_CATALOG[planId].assignable) continue
    const limit = entitlementOf(planId, capability)
    if (!limit) continue
    if (limit.kind === 'BOOLEAN') {
      if (limit.allowed) return planId
      continue
    }
    if (isUnlimited(limit)) return planId
    const max = limitMax(limit)
    if (max !== null && max >= atLeast) return planId
  }
  return null
}
