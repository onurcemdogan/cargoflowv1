// SÜRAT FİNANSAL KAPI — TÜM SERVİS MODLARININ ÜSTÜNDE, TEK OTORİTE.
//
// MİMARİ KURAL: kapı `serviceMode` dallarının ALTINDA değil, HEPSİNİN
// ÜSTÜNDEDİR. Böylece hangi mod seçilirse seçilsin taşıyıcıya giden her
// yol önce buradan geçer ve "legacy mod = guard bypass" durumu OLUŞAMAZ.
//
//   request/order
//        ↓
//   FİNANSAL KAPI  ← burası
//        ↓ PASS
//   serviceMode switch (canonical | legacy SOAP | REST | …)
//        ↓
//   taşıyıcı ağ çağrısı
//
// SEMANTİK ORTAK, WIRE EŞLEMESİ ADAPTÖRE ÖZEL: `billingParty` ve
// `expectedSuratWhoPays` burada üretilir; hangi alanın telde gideceğine
// her adaptör KENDİ sözleşmesine göre karar verir. Kapı hiçbir isteğe alan
// EKLEMEZ.
import { resolveSuratMarketplaceContext } from './suratCanonicalGonderiModel.ts'
import {
  describeOdemeTipi,
  evaluateSuratCreatePreflight,
  expectedSuratWhoPays,
  resolveBillingPartyV2,
  resolveCodContext,
  resolveCodCredentialPolicy,
  resolveSuratCredentialContext,
} from './suratRoutingModel.ts'
import { buildTraceId, buildUserFacingError } from './suratCreateTrace.ts'

/** Kapının uygulandığı servis modları — HEPSİ guarded. */
export const GUARDED_SURAT_SERVICE_MODES = [
  'SURAT_CANONICAL_API',
  'KARGO_BARKODU_SIPARIS_SOAP',
  'ORTAK_BARKOD_SOAP',
  'PRE_REGISTRATION_REST',
  'GONDERI_YENI_SOAP',
  'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
] as const

export interface SuratFinancialGateResult {
  ok: boolean
  errorCode: string | null
  message: string | null
  /** Değişmez deneme bağlamı — create sonrası da aynı kalır. */
  trace: Record<string, unknown>
  /** Fingerprint'e girecek finansal semantik (SIR İÇERMEZ). */
  financialFingerprint: Record<string, unknown>
}

/**
 * TEK OTORİTER KAPI.
 *
 * Ağ çağrısı YAPMAZ, DB'ye yazmaz. Yalnız "bu istek taşıyıcıya gidebilir mi"
 * sorusunu yanıtlar. `ok === false` ise çağıran DERHAL dönmelidir.
 */
export function evaluateSuratFinancialGate(params: {
  config?: Record<string, unknown>
  order?: Record<string, unknown>
  cashOnDelivery?: boolean
  serviceMode?: unknown
}): SuratFinancialGateResult {
  const config = params.config ?? {}
  const order = params.order ?? {}
  const rawOrder = (order.rawOrder ?? {}) as Record<string, unknown>

  const billing = resolveBillingPartyV2(rawOrder)
  const cod = resolveCodContext({
    enabled: params.cashOnDelivery === true,
    collectionType: config.kapidanOdemeTahsilatTipi,
    amount: order.cashOnDeliveryAmount,
  })
  const credential = resolveSuratCredentialContext({
    config,
    billingParty: billing.billingParty,
    cod,
    codPolicy: resolveCodCredentialPolicy(config.codCredentialPolicy),
    serviceMode: params.serviceMode,
  })
  const context = resolveSuratMarketplaceContext(order)
  const preflight = evaluateSuratCreatePreflight({
    marketplace: order.marketplace,
    pazaryerimi: context.pazaryerimi,
    entegrasyonFirmasi: context.entegrasyonFirmasi,
    ozelKargoTakipNo: context.ozelKargoTakipNo,
    orderCargoTrackingNumber: order.cargoTrackingNumber,
    trackingSource: context.trackingSource,
    billingParty: billing.billingParty,
    credential,
  })
  const payment = describeOdemeTipi(config.odemeTipi ?? 1)
  const traceId = buildTraceId(
    `${String(order.packageId ?? order.orderNumber ?? '')}`,
  )

  const financialFingerprint = {
    billingParty: billing.billingParty,
    expectedSuratWhoPays: expectedSuratWhoPays(billing.billingParty),
    credentialRole: credential.role,
    odemeTipi: payment.odemeTipi,
    codEnabled: cod.codEnabled,
    codCollectionType: cod.codCollectionType,
    pazaryerimi: context.pazaryerimi,
    entegrasyonFirmasi: context.entegrasyonFirmasi,
    // Pazaryeri kimliğinin KAYNAĞI — ikame edilirse fingerprint değişir.
    marketplaceIdentitySource: context.trackingSource,
    marketplaceIdentityPresent: Boolean(context.ozelKargoTakipNo),
  }

  return {
    ok: preflight.valid,
    // Mevcut dış sözleşme korunur: kimlik eksikliği hâlâ aynı kodla çıkar.
    errorCode: preflight.valid
      ? null
      : credential.resolved
        ? preflight.errorCode
        : 'SURAT_ACCOUNT_NOT_CONFIGURED',
    message: preflight.valid ? null : buildUserFacingError({ traceId }),
    trace: {
      traceId,
      serviceMode: String(params.serviceMode ?? ''),
      ...financialFingerprint,
      billingEvidence: billing.billingEvidence,
      rawWhoPaysPresent: billing.rawWhoPaysPresent,
      odemeTipiMeaning: payment.odemeTipiMeaning,
      credentialSource: credential.source,
      maskedAccount: credential.maskedAccount,
      credentialReason: credential.reason,
      credentialResolved: credential.resolved,
      credentialErrorCode: credential.errorCode,
      parcelIdentityFormatValid: preflight.parcelIdentityFormatValid,
      preflightValid: preflight.valid,
      preflightFailures: preflight.failures,
    },
    financialFingerprint,
  }
}

/**
 * YALNIZ PARMAK İZİ — kapı kararı UYGULAMAZ.
 *
 * Idempotency replay'i, kayıtlı gönderinin BUGÜNKÜ istekle aynı finansal
 * semantiği taşıyıp taşımadığını sormak zorundadır; bunun için karara değil
 * yalnız parmak izine ihtiyaç vardır. Ayrı isim BİLEREK verilmiştir: otoriter
 * kapı `evaluateSuratFinancialGate` olarak TEK yerde çağrılır ve mimari
 * değişmez ("kapı tüm serviceMode dallarının üstünde") bu çağrıyla ölçülür.
 * Buradan enforcement YAPILMAZ.
 */
export function resolveSuratFinancialFingerprint(
  params: Parameters<typeof evaluateSuratFinancialGate>[0],
): Record<string, unknown> {
  return evaluateSuratFinancialGate(params).financialFingerprint
}
