import { stageAffectsLiveBehavior, type CapabilityStage } from '../../connectors/connectorKernel.ts'

export const ARAS_ROLLOUT_STAGE: CapabilityStage = 'internal_test'

export function canArasCarrierAffectLiveFulfillment(): boolean {
  return stageAffectsLiveBehavior(ARAS_ROLLOUT_STAGE)
}
