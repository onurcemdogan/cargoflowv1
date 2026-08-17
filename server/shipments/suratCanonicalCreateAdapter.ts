// KANONİK SÜRAT CREATE ADAPTÖRÜ — index.mjs ile 3A-1 servisi arasındaki
// TEK köprü. Tüm DTO/marketplace/credential eşlemesi BURADA kalır;
// index.mjs yalnız serviceMode dallanması yapar.
//
// PRODUCTION-FIRST: env credential yok, api01 yok, SOAP yok, test/prova yok.
import {
  resolveSuratMarketplaceContext,
  CANONICAL_GONDERI_FIELDS,
  SURAT_SERVICE_DEFAULTS,
  type CanonicalShipmentInput,
} from './suratCanonicalGonderiModel.ts'
import {
  credentialRoleToAccountKey,
  describeOdemeTipi,
  evaluateSuratCreatePreflight,
  expectedSuratWhoPays,
  resolveBillingPartyV2,
  resolveCodContext,
  resolveCodCredentialPolicy,
  resolveSuratCredentialContext,
} from './suratRoutingModel.ts'
import {
  buildTraceId,
  buildUserFacingError,
  describeWireWhoPays,
} from './suratCreateTrace.ts'
import {
  resolveSuratPrintableArtifact,
  buildSuratArtifactLogContext,
} from './suratPrintableArtifact.ts'
import {
  createCanonicalSuratShipment,
  buildCanonicalIdempotencyKey,
  type CanonicalIdempotencyPort,
  type CanonicalShipmentResult,
} from './suratCanonicalShipmentService.ts'

// Servis modu sabitleri TEK kaynaktan gelir (index.mjs ile paylaşılır).
import {
  SURAT_CANONICAL_SERVICE_MODE,
  SURAT_CANONICAL_SERVICE_TYPE,
  SURAT_CANONICAL_OPERATION_NAME,
} from './suratCanonicalServiceMode.mjs'

export {
  SURAT_CANONICAL_SERVICE_MODE,
  SURAT_CANONICAL_SERVICE_TYPE,
  SURAT_CANONICAL_OPERATION_NAME,
}

/** Faturalamayı KİM ÖDÜYOR — credential seçimini belirleyen tek sinyal. */
export type SuratBillingParty = 'PRIMARY' | 'SELLER_PAYS' | 'CASH_ON_DELIVERY'

export interface CanonicalAccountSelection {
  kullaniciAdi: string
  sifre: string
  billingParty: SuratBillingParty
  /** Sır değil: hangi hesabın seçildiğini gösteren maskeli iz. */
  accountFingerprint: string
}

/** `****1234` — düz cari kodu ASLA taşımaz. */
function fingerprintAccount(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return `****${trimmed.slice(-4)}`
}

/**
 * Ödeyen tarafı belirler. Gönderici-öder yalnız siparişte AÇIK bir sinyal
 * varsa seçilir; aksi hâlde NORMAL gönderidir.
 */
export function resolveSuratBillingParty(params: {
  order?: Record<string, unknown>
  cashOnDelivery?: boolean
}): SuratBillingParty {
  if (params.cashOnDelivery === true) return 'CASH_ON_DELIVERY'
  const order = params.order ?? {}
  const explicitSellerPays =
    order.sellerPays === true ||
    String(order.payer ?? order.shippingPayer ?? '')
      .trim()
      .toUpperCase() === 'SELLER'
  return explicitSellerPays ? 'SELLER_PAYS' : 'PRIMARY'
}

/**
 * KANONİK TENANT HESABI — ENV OKUNMAZ, SESSİZ DÜŞÜŞ YOK.
 *
 * `normalizeSuratConfig` taban `kullaniciAdi`/`sifre` alanlarını
 * `SURAT_LIVE_*` / `SURAT_TEST_*` ile EZER; `liveKullaniciAdi`/`liveSifre`
 * ise ham tenant değeridir. Kanonik birincil hesap bu yüzden canlı
 * tenant alanından okunur.
 *
 * Öncelik AÇIKTIR ve karışmaz:
 *   NORMAL      → yalnız birincil canlı tenant hesabı
 *   SELLER_PAYS → yalnız açık sellerPays hesabı
 *   COD         → yalnız açık COD hesabı
 * İstenen küme boşsa `null` döner; başka bir kümeye DÜŞÜLMEZ.
 */
export function resolveCanonicalTenantSuratAccount(
  config: Record<string, unknown> = {},
  billingParty: SuratBillingParty = 'PRIMARY',
): CanonicalAccountSelection | null {
  const pick = (...values: unknown[]): string => {
    for (const value of values) {
      const text = String(value ?? '').trim()
      if (text) return text
    }
    return ''
  }
  const kullaniciAdi =
    billingParty === 'CASH_ON_DELIVERY'
      ? pick(config.codKullaniciAdi)
      : billingParty === 'SELLER_PAYS'
        ? pick(config.sellerPaysKullaniciAdi)
        : // Birincil: normalizeSuratConfig'in ENV'den bağımsız türettiği
          // tenant hesabı. `kullaniciAdi` (env ile ezilebilir) OKUNMAZ.
          pick(config.canonicalPrimaryKullaniciAdi, config.liveKullaniciAdi)
  const sifre =
    billingParty === 'CASH_ON_DELIVERY'
      ? pick(config.codSifre)
      : billingParty === 'SELLER_PAYS'
        ? pick(config.sellerPaysSifre)
        : pick(config.canonicalPrimarySifre, config.liveSifre)
  if (!kullaniciAdi || !sifre) return null
  return {
    kullaniciAdi,
    sifre,
    billingParty,
    accountFingerprint: fingerprintAccount(kullaniciAdi),
  }
}

/**
 * DIŞARIDAKİ KİLİDİ TEMSİL EDEN PORT.
 *
 * Gerçek idempotency `executeIdempotentSuratCreate` içindeki mevcut
 * rezervasyondur; bu çağrı zaten onu KAZANMIŞ durumdadır. İkinci paralel
 * idempotency sistemi kurulmaz — bu port yalnız sahipliği taşır.
 */
export function createHeldIdempotencyPort(): CanonicalIdempotencyPort {
  return {
    acquire: () => true,
    complete: () => undefined,
    markUnknown: () => undefined,
  }
}

const positive = (value: unknown): number | null => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Kanonik `GonderiModel` girdisi. Adet/desi/kg/içerik türetimi mevcut
 * üretim sözleşmesiyle AYNIDIR (Adet = koli sayısı, BirimKg yoksa desi).
 */
export function buildCanonicalShipmentInput(params: {
  order: Record<string, unknown>
  reference: string
  resolveAddress?: (order: Record<string, unknown>) => string
}): CanonicalShipmentInput {
  const { order, reference } = params
  const context = resolveSuratMarketplaceContext(order)
  const desi = positive(order.desi)
  if (desi == null) {
    throw new Error(
      'Desi bilgisi eksik. Sürat gönderisi oluşturmadan önce desi girilmelidir.',
    )
  }
  const items = Array.isArray(order.items) ? order.items : []
  const content = items
    .map((item: Record<string, unknown>) => {
      const variants = [
        item.color ? `Renk: ${item.color}` : '',
        item.size ? `Beden: ${item.size}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      return `${Number(item.quantity ?? 1)}x ${item.productName || 'Ürün'}${
        variants ? ` (${variants})` : ''
      }`
    })
    .join(' | ')
    .slice(0, 250)
  const address = params.resolveAddress
    ? params.resolveAddress(order)
    : String(order.address ?? '')
  return {
    order: { ...order, address },
    context,
    referansNo: String(
      order.packageId ?? order.shipmentPackageId ?? reference,
    ).trim() || reference,
    adet: Math.max(1, Math.round(positive(order.packageCount) ?? 1)),
    birimDesi: desi,
    birimKg: positive(order.weightKg ?? order.kg) ?? desi,
    kargoIcerigi: content || 'CargoFlow gönderisi',
  }
}

/**
 * Kanonik sonucu MEVCUT create response sözleşmesine taşır.
 *
 * §22/§23: `carrier created` ile `print ready` AYRIDIR. Etiket çözülemediği
 * için `printEnabled` ASLA true olmaz ve etiket alanları DOLDURULMAZ —
 * `Barcode[]` / `BarcodeNo[]` içinden hangisinin yazdırılabilir olduğu
 * doğrulanmamıştır (3B).
 */
export function mapCanonicalResultToCreateResponse(params: {
  result: CanonicalShipmentResult
  input: CanonicalShipmentInput
  account?: CanonicalAccountSelection | null
}): Record<string, unknown> {
  const { result, input } = params
  const created = result.carrierCreateStatus === 'SUCCESS'
  const artifact = resolveSuratPrintableArtifact(result)
  const base = {
    source: 'real',
    serviceType: SURAT_CANONICAL_SERVICE_TYPE,
    operationName: SURAT_CANONICAL_OPERATION_NAME,
    // index.mjs sınıflandırması bu işaretçiyi okur; Serendip doğrulaması
    // yapılmadığı için legacy "verified" alanları KULLANILMAZ.
    canonicalCreate: {
      adapter: 'SURAT_WEB_API',
      host: 'api02.suratkargo.com.tr',
      operation: SURAT_CANONICAL_OPERATION_NAME,
      carrierCreateStatus: result.carrierCreateStatus,
      // Etiket durumu artık yapısal sınıflandırmadan gelir.
      printArtifactStatus:
        result.carrierCreateStatus === 'SUCCESS'
          ? artifact.status === 'RESOLVED'
            ? 'RESOLVED'
            : artifact.status
          : 'NOT_APPLICABLE',
      outcome: result.outcome,
      billingParty: params.account?.billingParty ?? null,
      accountFingerprint: params.account?.accountFingerprint ?? '',
      ...buildSuratArtifactLogContext(artifact),
      carrierCreateAttempts: result.carrierCreateAttempts,
    },
    suratCreateLog: {
      operationName: SURAT_CANONICAL_OPERATION_NAME,
      responseStatus: result.carrierCreateAttempts > 0 ? 200 : 0,
      rawRequest: {
        // Pazaryeri faturalama bağlamı (denetim için); credential YOK.
        OzelKargoTakipNo: input.context.ozelKargoTakipNo,
        ReferansNo: input.referansNo ?? '',
        Pazaryerimi: input.context.pazaryerimi,
        EntegrasyonFirmasi: input.context.entegrasyonFirmasi,
        skipped: result.carrierCreateAttempts === 0,
      },
    },
  }
  if (!created) {
    return {
      ...base,
      ok: false,
      errorSource: 'Sürat',
      errorCode: result.errorCode,
      message: result.vendorMessage,
    }
  }
  return {
    ...base,
    ok: true,
    message:
      'Sürat kanonik gönderisi oluşturuldu. Yazdırılabilir etiket kaynağı henüz çözülmedi.',
    shipment: {
      // KargoTakipNo = Sürat'ın verdiği taşıyıcı kimliği.
      trackingNumber: result.trackingNo,
      kargoTakipNo: result.trackingNo,
      tNo: result.trackingNo,
      // OzelKargoTakipNo = pazaryerinin verdiği dış numara (727...).
      ozelKargoTakipNo: input.context.ozelKargoTakipNo,
      dispatchRegistrationConfirmed: true,
      lifecycleStatus:
        artifact.status === 'RESOLVED'
          ? 'LABEL_CREATED_UNVERIFIED'
          : 'SHIPMENT_REGISTERED_LABEL_REQUIRED',
      labelStatus: artifact.status === 'RESOLVED' ? 'READY' : artifact.status,
      // print-ready YALNIZ yapısal olarak doğrulanmış etiket varsa.
      printEnabled: artifact.status === 'RESOLVED',
      printReady: artifact.status === 'RESOLVED',
      printableFormat: artifact.format,
      printableArtifact: artifact.artifact,
      // Ham vendor verisi: seçim yapılsa da AYNEN korunur (immutable kaynak).
      canonicalVendorBarcode: result.barcode,
      canonicalVendorBarcodeNo: result.barcodeNo,
    },
  }
}

export interface CanonicalCreateRequestParams {
  organizationId: string
  config: Record<string, unknown>
  order: Record<string, unknown>
  reference: string
  cashOnDelivery?: boolean
  resolveAddress?: (order: Record<string, unknown>) => string
  fetchImpl?: typeof fetch
}

/**
 * index.mjs'in çağırdığı TEK giriş noktası. Dış idempotency rezervasyonu
 * ZATEN alınmış durumdayken çağrılır; ağ çağrısı kilidin içinde kalır.
 */
export async function createCanonicalSuratShipmentForRequest(
  params: CanonicalCreateRequestParams,
): Promise<Record<string, unknown>> {
  const input = buildCanonicalShipmentInput({
    order: params.order,
    reference: params.reference,
    resolveAddress: params.resolveAddress,
  })

  // ═══ OTORİTER YÖNLENDİRME (Faz 5C) ═══════════════════════════════════
  // Kredensiyal seçimi ARTIK dağınık sipariş alanlarından (sellerPays /
  // payer / shippingPayer) YAPILMAZ. Tek sınır: `resolveSuratCredentialContext`.
  const rawOrder = (params.order.rawOrder ?? {}) as Record<string, unknown>
  const billing = resolveBillingPartyV2(rawOrder)
  const cod = resolveCodContext({
    enabled: params.cashOnDelivery === true,
    collectionType: params.config.kapidanOdemeTahsilatTipi,
    amount: params.order.cashOnDeliveryAmount,
  })
  const credential = resolveSuratCredentialContext({
    config: params.config,
    billingParty: billing.billingParty,
    cod,
    codPolicy: resolveCodCredentialPolicy(params.config.codCredentialPolicy),
  })
  const preflight = evaluateSuratCreatePreflight({
    marketplace: params.order.marketplace,
    pazaryerimi: input.context.pazaryerimi,
    entegrasyonFirmasi: input.context.entegrasyonFirmasi,
    ozelKargoTakipNo: input.context.ozelKargoTakipNo,
    orderCargoTrackingNumber: params.order.cargoTrackingNumber,
    billingParty: billing.billingParty,
    credential,
  })

  const traceId = buildTraceId(
    `${params.organizationId}:${params.order.packageId ?? params.reference}`,
  )
  const wire = describeWireWhoPays({ contractFields: CANONICAL_GONDERI_FIELDS })
  const attemptContext = {
    traceId,
    billingParty: billing.billingParty,
    billingEvidence: billing.billingEvidence,
    expectedSuratWhoPays: expectedSuratWhoPays(billing.billingParty),
    ...describeOdemeTipi(SURAT_SERVICE_DEFAULTS.OdemeTipi),
    codEnabled: cod.codEnabled,
    codCollectionType: cod.codCollectionType,
    codAmountPresent: cod.codAmountPresent,
    credentialRole: credential.role,
    credentialSource: credential.source,
    maskedAccount: credential.maskedAccount,
    credentialReason: credential.reason,
    credentialResolved: credential.resolved,
    credentialErrorCode: credential.errorCode,
    pazaryerimi: input.context.pazaryerimi,
    entegrasyonFirmasi: input.context.entegrasyonFirmasi,
    ozelKargoTakipNoPresent: Boolean(input.context.ozelKargoTakipNo),
    serviceMode: SURAT_CANONICAL_SERVICE_MODE,
    serviceType: SURAT_CANONICAL_SERVICE_TYPE,
    operation: SURAT_CANONICAL_OPERATION_NAME,
    ...wire,
    preflightValid: preflight.valid,
    preflightFailures: preflight.failures,
  }

  // FAIL-CLOSED: bağlam bozuksa TAŞIYICIYA GİDİLMEZ. Yanlış bağlamda
  // oluşan gönderi yanlış cariye yazılır ve geri alınamaz.
  if (!preflight.valid) {
    return {
      ok: false,
      source: 'real',
      errorSource: 'Frontend',
      // MEVCUT YANIT SÖZLEŞMESİ KORUNUR: kimlik eksikliği dışarıya hâlâ
      // `SURAT_ACCOUNT_NOT_CONFIGURED` olarak çıkar; ince sebep izdedir.
      errorCode: credential.resolved
        ? preflight.errorCode
        : 'SURAT_ACCOUNT_NOT_CONFIGURED',
      message: buildUserFacingError({ traceId }),
      canonicalCreate: {
        adapter: 'SURAT_WEB_API',
        carrierCreateStatus: 'NOT_STARTED',
        carrierCreateAttempts: 0,
        billingParty: credential.role,
        accountFingerprint: credential.maskedAccount,
      },
      suratCreateTrace: attemptContext,
    }
  }

  const billingParty = credentialRoleToAccountKey(
    credential.role,
  ) as SuratBillingParty
  const account = resolveCanonicalTenantSuratAccount(params.config, billingParty)
  const result = await createCanonicalSuratShipment({
    organizationId: params.organizationId,
    packageId: String(
      params.order.packageId ?? params.order.shipmentPackageId ?? params.reference,
    ),
    account: account
      ? { kullaniciAdi: account.kullaniciAdi, sifre: account.sifre, isActive: true }
      : null,
    context: input.context,
    shipment: input,
    idempotency: createHeldIdempotencyPort(),
    fetchImpl: params.fetchImpl,
  })
  const response = mapCanonicalResultToCreateResponse({ result, input, account })
  // AYNI traceId tüm aşamalarda taşınır: PRE_FLIGHT → ROUTING →
  // REQUEST_READY → CARRIER_CALL → CARRIER_RESPONSE → FINAL.
  return {
    ...response,
    suratCreateTrace: {
      ...attemptContext,
      carrierCreateStatus: result.carrierCreateStatus,
      carrierCreateAttempts: result.carrierCreateAttempts,
      trackingPresent: Boolean(result.trackingNo),
      barcodePresent: result.barcode.length > 0,
    },
  }
}

export { buildCanonicalIdempotencyKey }
