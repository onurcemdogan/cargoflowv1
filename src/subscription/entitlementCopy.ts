// PLAN / HAK DURUMU — SUNUM KATMANI (SAF).
//
// ═══ DÖRT NEDEN, DÖRT FARKLI MESAJ ═══════════════════════════════════════
//
// "Kapalı" tek bir gri kutu DEĞİLDİR. Kullanıcının yapabileceği şey her
// durumda FARKLIDIR ve mesaj bunu söylemek zorundadır:
//
//   PLAN_REQUIRED        → planını yükseltebilir
//   LIMIT_REACHED        → limitini büyütebilir
//   CONNECTION_REQUIRED  → bağlantısını onarabilir
//   ROLLOUT_DISABLED     → BEKLEMEKTEN başka şey yapamaz
//   UNSUPPORTED          → HİÇBİR ŞEY yapamaz; para da çözmez
//
// Bu beşini aynı "kullanılamıyor" mesajına çökertmek, kullanıcıyı boş yere
// uğraştırır (ya da yanlış tahsilata yol açar).

export type EntitlementTone = 'ok' | 'upgrade' | 'fix' | 'wait' | 'unavailable' | 'legacy'

export interface AccessViewModel {
  capability: string
  decision: string
  reasonCode: string
  requiredPlanId?: string | null
  usageMetered?: boolean
}

export interface PresentedEntitlement {
  capability: string
  text: string
  tone: EntitlementTone
  /** Yükseltme hedefi DETERMİNİSTİK değilse UI "Yükselt" DEMEZ. */
  upgradeTarget: string | null
  actionable: boolean
}

const DECISION_COPY: Record<string, { text: string; tone: EntitlementTone; actionable: boolean }> = {
  ALLOWED: { text: 'Kullanılabilir', tone: 'ok', actionable: false },
  PLAN_REQUIRED: {
    text: 'Bu özellik mevcut planınıza dahil değil.',
    tone: 'upgrade',
    actionable: true,
  },
  LIMIT_REACHED: { text: 'Plan limitine ulaşıldı.', tone: 'upgrade', actionable: true },
  CONNECTION_REQUIRED: {
    text: 'Bağlantının yeniden doğrulanması gerekiyor.',
    tone: 'fix',
    actionable: true,
  },
  ROLLOUT_DISABLED: {
    text: 'Bu özellik henüz kullanıma açılmadı.',
    tone: 'wait',
    actionable: false,
  },
  UNSUPPORTED: {
    text: 'Bu özellik bu entegrasyonda desteklenmiyor.',
    tone: 'unavailable',
    actionable: false,
  },
}

export function presentEntitlement(model: AccessViewModel): PresentedEntitlement {
  const copy = DECISION_COPY[model.decision] ?? {
    text: 'Durum bilinmiyor',
    tone: 'unavailable' as EntitlementTone,
    actionable: false,
  }
  // "Yükselt" YALNIZ gerçek bir hedef varsa gösterilir.
  const upgradeTarget =
    (model.decision === 'PLAN_REQUIRED' || model.decision === 'LIMIT_REACHED') &&
    model.requiredPlanId
      ? model.requiredPlanId
      : null
  return {
    capability: model.capability,
    text: copy.text,
    tone: copy.tone,
    upgradeTarget,
    actionable: copy.actionable && (copy.tone !== 'upgrade' || upgradeTarget !== null),
  }
}

/** Geçiş (legacy) organizasyonu için dürüst açıklama. */
export function presentPlanHeadline(plan: {
  displayName: string
  legacy: boolean
}): { title: string; note: string | null } {
  if (plan.legacy) {
    return {
      title: plan.displayName,
      note: 'Mevcut kullanımınız korunuyor.',
    }
  }
  return { title: plan.displayName, note: null }
}

/**
 * Ölçülemeyen kullanım SIFIR GİBİ GÖSTERİLMEZ.
 *
 * "0 / 3" yazmak, ölçmediğimiz bir şeyi ölçmüş gibi göstermektir.
 */
export function presentUsage(reading: {
  metered: boolean
  value: number | null
}): string {
  if (!reading.metered || reading.value === null) return 'Henüz ölçülmüyor'
  return String(reading.value)
}
