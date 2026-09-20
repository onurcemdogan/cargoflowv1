// KANONİK ERİŞİM KARARI (BILLING-MODEL-UI-001) — SAF.
//
// ═══ NEDEN TEK BİR KARAR KATMANI ═════════════════════════════════════════
//
// `if (plan === 'pro')` benzeri karşılaştırmaların uygulamaya dağılması
// YASAKTIR (testle kilitli). Her karar BURADAN geçer ve KARARLI sebep kodu
// üretir; böylece UI "neden kapalı" sorusunu DOĞRU yanıtlayabilir.
//
// ═══ ÖNCELİK SIRASI VE GEREKÇESİ ═════════════════════════════════════════
//
//   1) UNSUPPORTED        → Müşteri, sağlayıcının SUNMADIĞI bir yeteneğe
//                           PARA ÖDEYEREK kavuşamaz. Bu yüzden EN ÜSTTE.
//   2) ROLLOUT_DISABLED   → Özellik henüz yayında değilse "plan yükseltin"
//                           demek YANLIŞ TAHSİLATTIR: müşteri öder ve yine
//                           alamaz. Bu yüzden plandan ÖNCE.
//   3) PLAN_REQUIRED      → Yetenek planda hiç yoksa "limit doldu" demek
//                           yanıltıcıdır; önce hak gelir.
//   4) LIMIT_REACHED      → Hak var ama ölçülen kullanım sınırı doldurmuş.
//   5) CONNECTION_REQUIRED→ Ticari olarak serbest; teknik olarak bağlantı
//                           onarılmalı.
//   6) ALLOWED
//
// ═══ SAĞLIK BURAYA KARIŞMAZ ══════════════════════════════════════════════
//
// Entegrasyon sağlığı AYRI bir modeldir ve bu dosya onu YENİDEN HESAPLAMAZ;
// yalnızca "bu bağlantı çalışıyor mu" sorusunun ÇIKTISINI girdi olarak alır.
// Ticari hak ile bağlantı sağlığı BİRLEŞTİRİLMEZ.
import {
  entitlementOf,
  isUnlimited,
  limitMax,
  smallestPlanWith,
  type BillableCapability,
  type LimitValue,
  type PlanId,
} from './planCatalog.ts'

export const ACCESS_DECISIONS = [
  'ALLOWED',
  'PLAN_REQUIRED',
  'LIMIT_REACHED',
  'CONNECTION_REQUIRED',
  'ROLLOUT_DISABLED',
  'UNSUPPORTED',
] as const
export type AccessDecision = (typeof ACCESS_DECISIONS)[number]

/** Karar sırası — testle kilitlenir, kod bu diziye uyar. */
export const ACCESS_PRECEDENCE: readonly AccessDecision[] = [
  'UNSUPPORTED',
  'ROLLOUT_DISABLED',
  'PLAN_REQUIRED',
  'LIMIT_REACHED',
  'CONNECTION_REQUIRED',
  'ALLOWED',
]

/**
 * ÖLÇÜLEN KULLANIM.
 *
 * `metered: false` → GÜVENİLİR KAYNAK YOK. Bu durumda `LIMIT_REACHED`
 * ÜRETİLMEZ: uydurma bir sayıyla müşteriyi kilitlemek, ölçmediğimiz bir şeyi
 * ölçmüş gibi davranmaktır. Sahte sıfır da RAPOR EDİLMEZ.
 */
export interface UsageReading {
  metered: boolean
  value: number | null
  /** Ölçülemiyorsa NEDEN — "bilmiyoruz" sessiz kalmaz. */
  reason?: string
}

export const NOT_YET_METERED: UsageReading = {
  metered: false,
  value: null,
  reason: 'NOT_YET_METERED',
}

export interface FeatureAccessInput {
  capability: BillableCapability
  planId: PlanId
  /**
   * Ürün/sağlayıcı bu yeteneği teknik olarak sunuyor mu. Sağlayıcıya bağlı
   * olmayan yetenekler için `true`. `false` ise HİÇBİR plan açamaz.
   */
  productSupported?: boolean
  /** Yayın aşaması canlı davranışa izin veriyor mu (kernel kararı). */
  rolloutLive?: boolean
  /** Bağlantı çalışır durumda mı (integrationHealth ÇIKTISI). */
  connectionOperational?: boolean
  usage?: UsageReading
  /** Kaç birim talep ediliyor (ör. 1 yeni hesap eklemek). */
  requested?: number
}

export interface FeatureAccessResult {
  capability: BillableCapability
  decision: AccessDecision
  reasonCode: string
  /** Yükseltme hedefi DETERMİNİSTİK olarak bilinemiyorsa null. */
  requiredPlanId: PlanId | null
  limit: LimitValue | null
  usage: UsageReading
  /** Limit bilinse de kullanım ölçülemiyorsa UI bunu bilmelidir. */
  usageMetered: boolean
}

/**
 * TEK KARAR NOKTASI.
 *
 * Aynı girdi → aynı çıktı (deterministik). Zaman, rastgelelik ve I/O YOK.
 */
export function resolveFeatureAccess(input: FeatureAccessInput): FeatureAccessResult {
  const usage = input.usage ?? NOT_YET_METERED
  const limit = entitlementOf(input.planId, input.capability)
  const requested = Number.isFinite(input.requested) ? Number(input.requested) : 1

  const base = {
    capability: input.capability,
    limit,
    usage,
    usageMetered: usage.metered,
  }

  // 1) TEKNİK İMKÂNSIZLIK — para bunu açamaz.
  if (input.productSupported === false) {
    return {
      ...base,
      decision: 'UNSUPPORTED',
      reasonCode: 'CAPABILITY_NOT_SUPPORTED',
      requiredPlanId: null,
    }
  }

  // 2) YAYINDA DEĞİL — "yükseltin" demek yanlış tahsilat olurdu.
  if (input.rolloutLive === false) {
    return {
      ...base,
      decision: 'ROLLOUT_DISABLED',
      reasonCode: 'ROLLOUT_NOT_ENABLED',
      requiredPlanId: null,
    }
  }

  // 3) PLAN HAKKI
  const entitled =
    limit !== null &&
    (limit.kind === 'BOOLEAN' ? limit.allowed : isUnlimited(limit) || (limitMax(limit) ?? 0) > 0)
  if (!entitled) {
    return {
      ...base,
      decision: 'PLAN_REQUIRED',
      reasonCode: 'CAPABILITY_NOT_IN_PLAN',
      requiredPlanId: smallestPlanWith(input.capability, requested),
    }
  }

  // 4) LİMİT — YALNIZ GÜVENİLİR ÖLÇÜM VARSA.
  if (!isUnlimited(limit) && limit.kind !== 'BOOLEAN') {
    const max = limitMax(limit)
    if (max !== null && usage.metered && usage.value !== null) {
      if (usage.value + requested > max) {
        return {
          ...base,
          decision: 'LIMIT_REACHED',
          reasonCode: 'PLAN_LIMIT_REACHED',
          requiredPlanId: smallestPlanWith(input.capability, usage.value + requested),
        }
      }
    }
    // Ölçüm YOKSA kilitlemeyiz: uydurma sayıyla müşteri engellenmez.
  }

  // 5) BAĞLANTI — ticari olarak serbest, teknik olarak onarım gerekli.
  if (input.connectionOperational === false) {
    return {
      ...base,
      decision: 'CONNECTION_REQUIRED',
      reasonCode: 'CONNECTION_NOT_OPERATIONAL',
      requiredPlanId: null,
    }
  }

  return { ...base, decision: 'ALLOWED', reasonCode: 'ALLOWED', requiredPlanId: null }
}
