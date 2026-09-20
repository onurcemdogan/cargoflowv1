// CANLI YAZMA KAPISI — AŞAMA SÜRÜR, SAĞLAYICI ADI DEĞİL.
//
// ═══ NEDEN `if (provider === 'woocommerce')` YASAK ════════════════════════
//
// Sağlayıcı adına dallanan kapı, her yeni bağlayıcıda UNUTULUR ve bir gün
// biri sessizce canlı yazmaya başlar. Karar TEK YERDE ve YAYIN AŞAMASINDAN
// türetilir; yeni bağlayıcı eklemek kapıyı DEĞİŞTİRMEZ.
//
// ═══ NE DEĞİŞİR, NE DEĞİŞMEZ ═════════════════════════════════════════════
//
//   off / internal_test / shadow
//     → çekilebilir, doğrulanabilir, normalleştirilebilir, KARŞILAŞTIRILABİLİR
//     → canlı karşılama davranışını DEĞİŞTİREMEZ
//
//   pilot / ga
//     → kanonik yazım GELECEK bir bilette yetkilendirilebilir
//
// `stageAffectsLiveBehavior` çekirdek kararıdır ve burada YENİDEN YAZILMAZ.
import {
  stageAffectsLiveBehavior,
  type CapabilityStage,
} from './connectorKernel.ts'
import { resolveRolloutStage } from './providerCatalog.ts'

export const LIVE_WRITE_DECISIONS = ['ALLOWED', 'BLOCKED_BY_ROLLOUT'] as const
export type LiveWriteDecision = (typeof LIVE_WRITE_DECISIONS)[number]

export interface LiveWriteGateResult {
  decision: LiveWriteDecision
  stage: CapabilityStage
  reasonCode: string
}

/**
 * Bu sağlayıcı KANONİK sipariş yazabilir mi.
 *
 * Varsayılan çalışma zamanı politikası: HAYIR — aşama canlı davranışı
 * etkilemiyorsa yazım engellenir. Bağlayıcının VAR OLMASI tek başına yazma
 * yetkisi vermez.
 */
export function canPersistCanonicalOrders(providerKey: string): LiveWriteGateResult {
  const stage = resolveRolloutStage(providerKey)
  if (!stageAffectsLiveBehavior(stage)) {
    return {
      decision: 'BLOCKED_BY_ROLLOUT',
      stage,
      reasonCode: 'ROLLOUT_STAGE_NOT_LIVE',
    }
  }
  return { decision: 'ALLOWED', stage, reasonCode: 'ROLLOUT_STAGE_LIVE' }
}

/**
 * Karşılama (fulfillment) yan etkileri kapısı.
 *
 * Etiket işçisi, taşıyıcı create, baskı durumu ve ödeyen çıkarımı CANLI
 * davranıştır. `internal_test`/`shadow` bunların HİÇBİRİNİ tetikleyemez.
 */
export function canTriggerFulfillmentSideEffects(
  providerKey: string,
): LiveWriteGateResult {
  const stage = resolveRolloutStage(providerKey)
  if (!stageAffectsLiveBehavior(stage)) {
    return {
      decision: 'BLOCKED_BY_ROLLOUT',
      stage,
      reasonCode: 'ROLLOUT_STAGE_NOT_LIVE',
    }
  }
  return { decision: 'ALLOWED', stage, reasonCode: 'ROLLOUT_STAGE_LIVE' }
}
