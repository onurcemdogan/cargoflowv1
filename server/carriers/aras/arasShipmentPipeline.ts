// ARAS create → verify → label → persist (deterministik; enjekte edilebilir taşıma).
//
// PHASE2-D SERTLEŞTİRME — taşıyıcıya gidilmeden ÖNCE:
//   1) yayın kapısı (internal_test canlı yan etki açamaz)
//   2) ORTAK gönderi ön kontrolü ONAYLANMIŞ olmalı (satış/kargo hesabı, kargo
//      doğrulaması, ödeyen, zorunlu alanlar) — onaysız create YOK
//   3) ödeyen: Aras `PayorTypeCode` için resmî değer tablosu DOĞRULANMADI.
//      Değer yalnız çağıranın DOĞRULANMIŞ eşlemesinden gelir; alan doğrudan
//      verilirse veya eşleme yoksa create YAPILMAZ (taşıyıcı varsayılanına
//      sessizce düşmek yanlış tarafa fatura demektir)
//   4) ORTAK işlem kaydı (`shipment_operations`): aynı sipariş için ikinci
//      SetOrder çağrısı yapılamaz; ağ sınırı ağdan ÖNCE kalıcı yazılır.

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
import type { ArasLabelArtifactStore } from './arasLabelArtifactStore.ts'
import { buildArasIntegrationCode, buildArasSetOrder, buildArasSetOrderEnvelope } from './arasSetOrder.ts'
import {
  applyArasVerificationLookup,
  resolveArasVerificationTransport,
  startArasVerification,
} from './arasVerification.ts'
import { canArasCarrierAffectLiveFulfillment } from './arasRollout.ts'
import { arasIdempotencyKey, type ArasOperationIdentity, type ArasOperationStore } from './arasOperationStore.ts'
import type { PreflightResult } from '../../shipments/shipmentPreflight.ts'
import { normalizeArasError, type ArasProviderError } from './arasProviderErrors.ts'

export interface ArasPipelineParams {
  organizationId: string
  orderId: string
  /** Gönderi satırı kimliği (varsayılan: sipariş kimliği). */
  marketplace?: string
  packageId?: string
  credentials: { userName: string; password: string }
  shipmentFields: Record<string, unknown>
  fetchImpl: ArasFetchLike
  /** Etiket artefaktının KALICI depoya yazıldığı/okunduğu yer — bellek takma
   *  adı DEĞİL, gerçek bir yazma + ayrı bir okuma çağrısı gerektirir. */
  artifactStore: ArasLabelArtifactStore
  /** Ortak işlem kaydı (idempotency) — ZORUNLU. */
  operationStore: ArasOperationStore
  /** Ortak gönderi ön kontrolünün sonucu — `ok:true` olmadan create YOK. */
  preflight: PreflightResult
  /**
   * DOĞRULANMIŞ `PayorTypeCode` değeri (ödeyen eşlemesi). Resmî değer tablosu
   * elde olmadan null'dır ve create YAPILMAZ. Tahmin EDİLMEZ.
   */
  verifiedPayorTypeCode: string | null
  cod?: {
    isCod?: boolean
    codAmount?: unknown
    verifiedCollectionType?: number | null
    verifiedBillingType?: number | null
  }
}

export type ArasPipelineErrorCode =
  | 'ARAS_LIVE_WRITE_BLOCKED'
  | 'ARAS_PREFLIGHT_BLOCKED'
  | 'ARAS_PAYER_FIELD_NOT_ALLOWED'
  | 'ARAS_PAYER_MAPPING_UNVERIFIED'
  | 'ARAS_CREATE_IN_FLIGHT'
  | 'ARAS_CREATE_OUTCOME_UNKNOWN'
  | 'ARAS_REPLAY_ARTIFACT_MISSING'
  | string

export interface ArasPipelineResult {
  ok: boolean
  integrationCode: string
  verificationState: string
  labelArtifact: ArasLabelArtifact | null
  persistedArtifact: ArasLabelArtifact | null
  errorCode: ArasPipelineErrorCode | null
  /** Taşıyıcıya SetOrder çağrısı bu çağrıda yapıldı mı? */
  carrierCreateCalled: boolean
  /** Önceki başarılı işlem kayıttan döndürüldü (yeni gönderi YOK). */
  replayed: boolean
  preflightBlockers?: string[]
  /** Ön yüze gidebilecek TEK hata görünümü — ham SOAP/ResultMessage YOK. */
  providerError: ArasProviderError | null
}

function blocked(
  errorCode: ArasPipelineErrorCode,
  integrationCode = '',
  extra: Partial<ArasPipelineResult> = {},
): ArasPipelineResult {
  return {
    ok: false,
    integrationCode,
    verificationState: 'BLOCKED',
    labelArtifact: null,
    persistedArtifact: null,
    errorCode,
    carrierCreateCalled: false,
    replayed: false,
    providerError: normalizeArasError(errorCode),
    ...extra,
  }
}

export async function runArasInternalTestPipeline(
  params: ArasPipelineParams,
): Promise<ArasPipelineResult> {
  if (canArasCarrierAffectLiveFulfillment()) return blocked('ARAS_LIVE_WRITE_BLOCKED')
  if (!params.preflight?.ok) {
    return blocked('ARAS_PREFLIGHT_BLOCKED', '', {
      preflightBlockers: params.preflight && !params.preflight.ok ? params.preflight.blockers : ['PREFLIGHT_MISSING'],
    })
  }
  if (Object.prototype.hasOwnProperty.call(params.shipmentFields ?? {}, 'PayorTypeCode')) {
    return blocked('ARAS_PAYER_FIELD_NOT_ALLOWED')
  }
  const payorTypeCode = String(params.verifiedPayorTypeCode ?? '').trim()
  if (!payorTypeCode) return blocked('ARAS_PAYER_MAPPING_UNVERIFIED')

  const integrationCode = buildArasIntegrationCode({
    organizationId: params.organizationId,
    orderId: params.orderId,
  })
  const identity: ArasOperationIdentity = {
    organizationId: params.organizationId,
    idempotencyKey: arasIdempotencyKey(params.organizationId, params.orderId),
    marketplace: params.marketplace ?? 'Trendyol',
    packageId: params.packageId ?? params.orderId,
    integrationCode,
    provenance: params.preflight.provenance,
  }

  // ═══ IDEMPOTENCY — ikinci SetOrder YOK ═══════════════════════════════
  const existing = await params.operationStore.read(params.organizationId, identity.idempotencyKey)
  if (existing?.status === 'succeeded') {
    const stored = await params.artifactStore.load(params.organizationId, integrationCode)
    const reprint = resolveArasReprintArtifact(stored)
    return {
      ok: reprint.ok,
      integrationCode,
      verificationState: reprint.ok ? 'REPLAYED' : 'REPLAY_ARTIFACT_MISSING',
      labelArtifact: null,
      persistedArtifact: reprint.ok ? reprint.artifact : null,
      errorCode: reprint.ok ? null : 'ARAS_REPLAY_ARTIFACT_MISSING',
      carrierCreateCalled: false,
      replayed: true,
      providerError: reprint.ok ? null : normalizeArasError('ARAS_REPLAY_ARTIFACT_MISSING'),
    }
  }
  if (existing?.status === 'pending' && existing.carrierCreateCalled) {
    // Ağ sınırı geçildi ama sonuç kesinleşmedi: ikinci create MÜKERRER olur.
    return blocked('ARAS_CREATE_OUTCOME_UNKNOWN', integrationCode)
  }
  if (existing) {
    // Ağdan önce kalmış rezervasyon veya açıkça REDDEDİLMİŞ create (Aras'ta
    // gönderi yok): aynı mantıksal işlem yeniden açılır, yeni anahtar YOK.
    await params.operationStore.release(identity)
  }
  const reservation = await params.operationStore.reserve(identity)
  if (!reservation.won) return blocked('ARAS_CREATE_IN_FLIGHT', integrationCode)

  const built = buildArasSetOrder({
    credentials: params.credentials,
    integrationCode,
    fields: { ...params.shipmentFields, PayorTypeCode: payorTypeCode },
    cod: params.cod,
  })
  if (!built.ok) {
    await params.operationStore.release(identity)
    return {
      ...blocked(built.errorCode ?? 'ARAS_CREATE_BUILD_FAILED', integrationCode),
      verificationState: 'CREATE_REJECTED',
    }
  }

  const envelope = buildArasSetOrderEnvelope(built.order)
  await params.operationStore.markCarrierBoundary(identity)
  let setOrderTransport: Awaited<ReturnType<typeof callArasSetOrder>>
  try {
    setOrderTransport = await callArasSetOrder({ envelope, fetchImpl: params.fetchImpl })
  } catch {
    await params.operationStore.complete(identity, {
      status: 'pending',
      errorCode: 'ARAS_CREATE_OUTCOME_UNKNOWN',
      shipmentRegistered: false,
      verificationState: 'TRANSPORT_UNKNOWN',
    })
    return { ...blocked('ARAS_CREATE_OUTCOME_UNKNOWN', integrationCode), carrierCreateCalled: true }
  }
  if (!setOrderTransport.ok && setOrderTransport.networkCalled === false) {
    // Ağa HİÇ çıkılmadı (ör. uç nokta çözülemedi): gönderi oluşmuş olamaz.
    await params.operationStore.release(identity)
    return blocked(setOrderTransport.errorCode ?? 'ARAS_TRANSPORT_NOT_SENT', integrationCode)
  }
  if (!setOrderTransport.ok) {
    // Taşıma belirsiz (zaman aşımı/5xx): Aras'ta kayıt OLUŞMUŞ olabilir.
    await params.operationStore.complete(identity, {
      status: 'pending',
      errorCode: 'ARAS_CREATE_OUTCOME_UNKNOWN',
      shipmentRegistered: false,
      verificationState: 'TRANSPORT_UNKNOWN',
    })
    return { ...blocked('ARAS_CREATE_OUTCOME_UNKNOWN', integrationCode), carrierCreateCalled: true }
  }
  const setOrder = classifyArasSetOrderResult(setOrderTransport.raw)

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
      // KALICI YAZIM: GetBarcode'dan gelen artefakt hemen depoya yazılır.
      // Kayıt zaten varsa `persist` DOKUNMAZ (immutable, ilk yazım kazanır).
      await params.artifactStore.persist(
        params.organizationId,
        integrationCode,
        labelArtifact,
      )
    }
  }

  // STORAGE-BACKED REPRINT: yukarıdaki `labelArtifact` DEĞİL, depodan TAZE bir
  // okuma kullanılır. Böylece reprint gerçekten kalıcı kayda bağlıdır — aynı
  // JS nesnesinin bellek takma adı DEĞİL.
  const stored = await params.artifactStore.load(
    params.organizationId,
    integrationCode,
  )
  const reprint = resolveArasReprintArtifact(stored)

  // Aras açıkça KABUL ettiyse işlem başarılıdır (yeniden create YOK); açıkça
  // REDDETTİYSE başarısızdır (Aras'ta gönderi yok, düzeltip yeniden açılabilir).
  await params.operationStore.complete(identity, {
    status: setOrder.ok ? 'succeeded' : 'failed',
    errorCode: setOrder.ok ? null : setOrder.errorCode,
    shipmentRegistered: setOrder.ok && verification.registered,
    verificationState: verification.state,
  })

  return {
    ok: setOrder.ok && verification.registered && reprint.ok,
    integrationCode,
    verificationState: verification.state,
    labelArtifact,
    persistedArtifact: reprint.ok ? reprint.artifact : null,
    errorCode: setOrder.ok ? null : setOrder.errorCode,
    carrierCreateCalled: true,
    replayed: false,
    providerError: setOrder.ok ? null : normalizeArasError(setOrder.errorCode),
  }
}
