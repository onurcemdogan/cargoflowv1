// ARAS create → verify → label → persist (deterministik; enjekte edilebilir taşıma).

import { classifyArasSetOrderResult } from './arasContract.ts'
import {
  callArasGetBarcode,
  callArasSetOrder,
  callArasVerification,
  type ArasFetchLike,
} from './arasClient.ts'
import {
  resolveArasLabelArtifacts,
  resolveArasReprintArtifact,
  type ArasLabelArtifact,
} from './arasLabelArtifact.ts'
import { buildArasIntegrationCode, buildArasSetOrder, buildArasSetOrderEnvelope } from './arasSetOrder.ts'
import {
  applyArasVerificationLookup,
  resolveArasVerificationTransport,
  startArasVerification,
} from './arasVerification.ts'
import { canArasCarrierAffectLiveFulfillment } from './arasRollout.ts'

export interface ArasPipelineParams {
  organizationId: string
  orderId: string
  credentials: { userName: string; password: string }
  shipmentFields: Record<string, unknown>
  fetchImpl: ArasFetchLike
  cod?: {
    isCod?: boolean
    codAmount?: unknown
    verifiedCollectionType?: number | null
    verifiedBillingType?: number | null
  }
}

export interface ArasPipelineResult {
  ok: boolean
  integrationCode: string
  verificationState: string
  labelArtifact: ArasLabelArtifact | null
  persistedArtifact: ArasLabelArtifact | null
  errorCode: string | null
}

export async function runArasInternalTestPipeline(
  params: ArasPipelineParams,
): Promise<ArasPipelineResult> {
  if (canArasCarrierAffectLiveFulfillment()) {
    return {
      ok: false,
      integrationCode: '',
      verificationState: 'BLOCKED',
      labelArtifact: null,
      persistedArtifact: null,
      errorCode: 'ARAS_LIVE_WRITE_BLOCKED',
    }
  }

  const integrationCode = buildArasIntegrationCode({
    organizationId: params.organizationId,
    orderId: params.orderId,
  })
  const built = buildArasSetOrder({
    credentials: params.credentials,
    integrationCode,
    fields: params.shipmentFields,
    cod: params.cod,
  })
  if (!built.ok) {
    return {
      ok: false,
      integrationCode,
      verificationState: 'CREATE_REJECTED',
      labelArtifact: null,
      persistedArtifact: null,
      errorCode: built.errorCode ?? 'ARAS_CREATE_BUILD_FAILED',
    }
  }

  const envelope = buildArasSetOrderEnvelope(built.order)
  const setOrderTransport = await callArasSetOrder({ envelope, fetchImpl: params.fetchImpl })
  const setOrder = classifyArasSetOrderResult(setOrderTransport.ok ? setOrderTransport.raw : null)

  let verification = startArasVerification({
    integrationCode,
    setOrderOk: setOrder.ok,
    resultCode: setOrder.resultCode,
    resultMessage: setOrder.resultMessage,
  })

  if (setOrder.ok) {
    const lookupTransport = await callArasVerification({
      credentials: params.credentials,
      integrationCode,
      fetchImpl: params.fetchImpl,
    })
    const resolved = resolveArasVerificationTransport({
      transportOk: lookupTransport.ok,
      requestedIntegrationCode: integrationCode,
      raw: lookupTransport.raw,
    })
    verification = applyArasVerificationLookup({
      current: verification,
      lookupOk: resolved.lookupOk,
      found: resolved.found ?? undefined,
    })
  }

  let labelArtifact: ArasLabelArtifact | null = null
  if (verification.registered) {
    const barcodeTransport = await callArasGetBarcode({
      credentials: params.credentials,
      integrationCode,
      registered: true,
      fetchImpl: params.fetchImpl,
    })
    const labelResolution = resolveArasLabelArtifacts(
      barcodeTransport.ok ? barcodeTransport.raw : null,
    )
    if (labelResolution.ok && labelResolution.preferred) {
      labelArtifact = labelResolution.preferred
    }
  }

  const store = labelArtifact
  const reprint = resolveArasReprintArtifact(store)

  return {
    ok: setOrder.ok && verification.registered && reprint.ok,
    integrationCode,
    verificationState: verification.state,
    labelArtifact,
    persistedArtifact: reprint.ok ? reprint.artifact : null,
    errorCode: setOrder.ok ? null : setOrder.errorCode,
  }
}
