// SÜRAT CANONICAL GÖNDERİ ORKESTRASYONU (CANLI ÜRETİM KARAR MANTIĞI).
//
// Akış:
//   idempotency.acquire
//   → validateSuratBillingContext        (Ünite 1)
//   → resolveTenantSuratProductionCredentials (Ünite 2)
//   → buildSuratCanonicalGonderiModel    (Ünite 1)
//   → createOrtakBarkodShipment          (Ünite 2 · canlı api02)
//   → kanonik sonuç
//
// BU MODÜL LEGACY'DEN HABERSİZDİR: SOAP/ASMX/api01/PRE_REGISTRATION_REST
// veya test/prova kavramı YOKTUR. Host kararını vermez — Ünite 2 istemcisi
// canlı hedefi kilitler.
//
// EN KRİTİK DEĞİŞMEZ: taşıyıcı gönderisi oluştuysa, etiket artifact'i
// çözülemese bile İKİNCİ create çağrısı YAPILMAZ.
import {
  buildSuratCanonicalGonderiModel,
  validateSuratBillingContext,
  type CanonicalShipmentInput,
  type SuratMarketplaceContext,
} from './suratCanonicalGonderiModel.ts'
import {
  createOrtakBarkodShipment,
  resolveTenantSuratProductionCredentials,
  SuratCanonicalError,
  type SuratCanonicalCreateResult,
} from './suratWebApiClient.ts'

/** Taşıyıcı gönderi oluşturma sonucu — etiket durumundan AYRIDIR. */
export type CarrierCreateStatus = 'SUCCESS' | 'REJECTED' | 'UNKNOWN' | 'BLOCKED'

/**
 * Yazdırılabilir etiket durumu.
 * `UNRESOLVED`: gönderi oluştu fakat `Barcode[]`/`BarcodeNo[]` içinden hangi
 * öğenin yazdırılabilir etiket olduğu vendor örneğiyle DOĞRULANMADI. Tahmin
 * edilmez; gönderi başarısız SAYILMAZ.
 */
export type PrintArtifactStatus = 'UNRESOLVED' | 'MISSING' | 'NOT_APPLICABLE'

export interface CanonicalShipmentResult {
  carrierCreateStatus: CarrierCreateStatus
  /** Ağ belirsizliği: 'not_sent' | 'unknown' | 'rejected' | 'delivered'. */
  outcome: 'not_sent' | 'unknown' | 'rejected' | 'delivered'
  trackingNo: string
  barcode: unknown[]
  barcodeNo: string[]
  printArtifactStatus: PrintArtifactStatus
  vendorMessage: string
  errorCode?: string
  /** Aynı çalıştırmada yapılan taşıyıcı create çağrısı sayısı (denetim). */
  carrierCreateAttempts: number
}

/** Mevcut idempotency mekanizmasına 3A-2'de bağlanacak sözleşme. */
export interface CanonicalIdempotencyPort {
  /** `false` → başka bir çalıştırma sürüyor/bitti; create YAPILMAZ. */
  acquire(key: string): Promise<boolean> | boolean
  complete(key: string, result: CanonicalShipmentResult): Promise<void> | void
  /** Sonuç bilinmiyorsa (timeout): kör retry'a AÇILMAZ. */
  markUnknown(key: string, reason: string): Promise<void> | void
  release?(key: string): Promise<void> | void
}

/** Mevcut shipment persistence'a 3A-2'de bağlanacak sözleşme. */
export interface CanonicalPersistencePort {
  persist(input: {
    idempotencyKey: string
    organizationId: string
    marketplace: string
    packageId: string
    result: CanonicalShipmentResult
  }): Promise<void> | void
}

export interface CanonicalShipmentParams {
  organizationId: string
  packageId: string
  /** Tenant'ın KENDİ Sürat hesabı — global/env hesap KABUL EDİLMEZ. */
  account: { kullaniciAdi?: unknown; sifre?: unknown; isActive?: boolean } | null
  context: SuratMarketplaceContext
  shipment: CanonicalShipmentInput
  idempotency: CanonicalIdempotencyPort
  persistence?: CanonicalPersistencePort
  /** Ünite 2 istemcisine geçirilir (üretimde global fetch). */
  fetchImpl?: Parameters<typeof createOrtakBarkodShipment>[0]['fetchImpl']
  timeoutMs?: number
}

/** Kanonik idempotency kimliği: tenant + pazaryeri + paket. */
export function buildCanonicalIdempotencyKey(params: {
  organizationId: string
  marketplace: string
  packageId: string
}): string {
  return [
    'surat-canonical',
    params.organizationId,
    params.marketplace,
    params.packageId,
  ].join('::')
}

function blocked(
  errorCode: string,
  vendorMessage: string,
): CanonicalShipmentResult {
  return {
    carrierCreateStatus: 'BLOCKED',
    outcome: 'not_sent',
    trackingNo: '',
    barcode: [],
    barcodeNo: [],
    printArtifactStatus: 'NOT_APPLICABLE',
    vendorMessage,
    errorCode,
    carrierCreateAttempts: 0,
  }
}

/**
 * ETİKET DURUMU — TAHMİN YOK.
 *
 * Vendor'ın hangi alanı yazdırılabilir etiket olarak döndürdüğü henüz
 * kanıtlanmadığı için format ÇÖZÜLMEZ. Veri aynen taşınır; seçim 3B'de,
 * gerçek yanıt örneğiyle yapılacaktır.
 */
function resolvePrintArtifactStatus(
  result: SuratCanonicalCreateResult,
): PrintArtifactStatus {
  if (result.barcode.length === 0 && result.barcodeNo.length === 0) {
    return 'MISSING'
  }
  return 'UNRESOLVED'
}

/**
 * CANLI kanonik gönderi oluşturma orkestrasyonu.
 *
 * Fail-closed: faturalama bağlamı veya tenant hesabı eksikse AĞ İSTEĞİ
 * YAPILMAZ. Legacy/alternatif hedefe ASLA düşülmez.
 */
export async function createCanonicalSuratShipment(
  params: CanonicalShipmentParams,
): Promise<CanonicalShipmentResult> {
  const marketplace = params.context.marketplace
  const key = buildCanonicalIdempotencyKey({
    organizationId: params.organizationId,
    marketplace,
    packageId: params.packageId,
  })

  // 1) KİLİT — ağdan ÖNCE. İki eşzamanlı istek iki gönderi oluşturamaz.
  const acquired = await params.idempotency.acquire(key)
  if (!acquired) {
    return blocked(
      'SURAT_CANONICAL_CREATE_IN_PROGRESS',
      'Bu paket için kanonik gönderi oluşturma zaten sürüyor.',
    )
  }

  // 2) FATURALAMA BAĞLAMI — eksikse ağ isteği YOK.
  const billing = validateSuratBillingContext(params.context)
  if (!billing.valid) {
    const result = blocked(
      billing.errorCode ?? 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID',
      billing.reason ?? 'Pazaryeri faturalama bağlamı geçersiz.',
    )
    await params.idempotency.complete(key, result)
    return result
  }

  // 3) TENANT HESABI — global/env hesaba DÜŞÜLMEZ.
  let credentials
  try {
    credentials = resolveTenantSuratProductionCredentials(params.account)
  } catch (error) {
    const canonical = error as SuratCanonicalError
    const result = blocked(
      canonical.code ?? 'SURAT_ACCOUNT_NOT_CONFIGURED',
      canonical.message,
    )
    await params.idempotency.complete(key, result)
    return result
  }

  // 4) İSTEK GÖVDESİ — TEK kaynak Ünite 1 builder'ıdır.
  const gonderi = buildSuratCanonicalGonderiModel(params.shipment)

  // 5) TEK taşıyıcı çağrısı.
  try {
    const vendor = await createOrtakBarkodShipment({
      credentials,
      gonderi,
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs,
    })
    const result: CanonicalShipmentResult = {
      carrierCreateStatus: 'SUCCESS',
      outcome: 'delivered',
      trackingNo: vendor.trackingNo,
      barcode: vendor.barcode,
      barcodeNo: vendor.barcodeNo,
      printArtifactStatus: resolvePrintArtifactStatus(vendor),
      vendorMessage: vendor.vendorMessage,
      carrierCreateAttempts: 1,
    }
    // Etiket ÇÖZÜLEMESE BİLE gönderi oluştu → İKİNCİ create YOK.
    await params.persistence?.persist({
      idempotencyKey: key,
      organizationId: params.organizationId,
      marketplace,
      packageId: params.packageId,
      result,
    })
    await params.idempotency.complete(key, result)
    return result
  } catch (error) {
    const canonical = error as SuratCanonicalError
    const unknown = canonical.outcome === 'unknown'
    const result: CanonicalShipmentResult = {
      carrierCreateStatus: unknown ? 'UNKNOWN' : 'REJECTED',
      outcome: unknown ? 'unknown' : 'rejected',
      trackingNo: '',
      barcode: [],
      barcodeNo: [],
      printArtifactStatus: 'NOT_APPLICABLE',
      vendorMessage: canonical.message ?? 'Sürat çağrısı başarısız.',
      errorCode: canonical.code ?? 'SURAT_CANONICAL_CREATE_FAILED',
      carrierCreateAttempts: 1,
    }
    if (unknown) {
      // Gönderi Sürat tarafında OLUŞMUŞ OLABİLİR → kör retry'a AÇILMAZ.
      await params.idempotency.markUnknown(key, result.errorCode ?? 'unknown')
    } else {
      await params.idempotency.complete(key, result)
    }
    return result
  }
}

/** Sır içermeyen orkestrasyon log bağlamı. */
export function buildCanonicalShipmentLogContext(params: {
  organizationId: string
  marketplace: string
  result: CanonicalShipmentResult
}): Record<string, string | number> {
  return {
    tenantId: params.organizationId,
    adapter: 'SURAT_WEB_API',
    operation: 'OrtakBarkodOlustur',
    marketplace: params.marketplace,
    carrierCreateStatus: params.result.carrierCreateStatus,
    outcome: params.result.outcome,
    printArtifactStatus: params.result.printArtifactStatus,
    barcodeCount: params.result.barcode.length,
    barcodeNoCount: params.result.barcodeNo.length,
    carrierCreateAttempts: params.result.carrierCreateAttempts,
  }
}
