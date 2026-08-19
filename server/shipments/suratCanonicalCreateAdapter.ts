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
  describeOdemeTipi,
  evaluateSuratCreatePreflight,
  expectedSuratWhoPays,
  resolveBillingPartyV2,
  resolveCodContext,
  resolveCodCredentialPolicy,
  credentialRoleToAccountKey,
  resolveSuratCredentialContext,
} from './suratRoutingModel.ts'
import { accountFingerprint } from './suratRoutingModel.ts'
import {
  assertSuratWireCredentialParity,
  type SuratCredentialSnapshot,
} from './suratCredentialSnapshot.ts'
import {
  appendTraceStage,
  buildTraceId,
  buildUserFacingError,
  createTraceAttempt,
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
    // TEK BİÇİM: canary, denetçi ve create yolu AYNI fonksiyonu kullanır.
    // Önceden üç ayrı maske vardı ve aynı hesap farklı, farklı hesaplar aynı
    // görünebiliyordu — kıyas anlamsızdı.
    accountFingerprint: accountFingerprint(kullaniciAdi),
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
  /**
   * OTORİTER KİMLİK — ZORUNLU, DONDURULMUŞ.
   * Kimlik ARTIK `config`ten (istek gövdesi) OKUNMAZ.
   */
  credentialSnapshot: SuratCredentialSnapshot
  /** TAŞIMA SEÇENEKLERİ — KİMLİK DEĞİL. */
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
  // ROL SEÇİMİ politika kararıdır (sipariş + COD); KİMLİK DEĞERİ DEĞİLDİR.
  // Bu çağrıdan YALNIZ `role`/`reason`/`maskedAccount` kullanılır.
  const roleContext = resolveSuratCredentialContext({
    config: params.config,
    billingParty: billing.billingParty,
    cod,
    codPolicy: resolveCodCredentialPolicy(params.config.codCredentialPolicy),
  })
  const snapshot = params.credentialSnapshot
  const snapshotUsable = Boolean(
    snapshot && typeof snapshot.accountFingerprint === 'string',
  )
  // KİMLİK ALANLARI YALNIZ ANLIK GÖRÜNTÜDEN.
  const credential = {
    role: roleContext.role,
    reason: roleContext.reason,
    maskedAccount: roleContext.maskedAccount,
    source: snapshotUsable ? snapshot.source : 'MISSING_SNAPSHOT',
    resolved: snapshotUsable ? snapshot.resolved : false,
    accountFingerprint: snapshotUsable ? snapshot.accountFingerprint : '',
    // GRANÜLER SEBEP ROLDEN türetilir — config'ten DEĞİL. Böylece hangi rolün
    // kimliği eksik olduğu görünür kalır ve etiket istemci girdisine bağlı olmaz.
    errorCode: snapshotUsable && snapshot.resolved
      ? null
      : roleContext.role === 'SELLER_PAYS'
        ? 'SELLER_PAYS_CREDENTIAL_NOT_CONFIGURED'
        : roleContext.role === 'COD'
          ? 'COD_CREDENTIAL_NOT_CONFIGURED'
          : 'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
  }
  const preflight = evaluateSuratCreatePreflight({
    marketplace: params.order.marketplace,
    pazaryerimi: input.context.pazaryerimi,
    entegrasyonFirmasi: input.context.entegrasyonFirmasi,
    ozelKargoTakipNo: input.context.ozelKargoTakipNo,
    orderCargoTrackingNumber: params.order.cargoTrackingNumber,
    trackingSource: input.context.trackingSource,
    billingParty: billing.billingParty,
    credential,
  })

  const traceId = buildTraceId(
    `${params.organizationId}:${params.order.packageId ?? params.reference}`,
  )
  const wire = describeWireWhoPays({ contractFields: CANONICAL_GONDERI_FIELDS })
  const stamp = () => new Date().toISOString()
  // TEK correlation kimliği. Her aşama AYNI traceId altında ve KARAR ANINDAKİ
  // değerlerle kaydedilir; config sonradan değişse bile geçmiş deneme kendini
  // yeniden yorumlamaz.
  let traceAttempt = createTraceAttempt({ traceId, createdAt: stamp() })

  // FAIL-CLOSED: otoriter anlık görüntü yoksa AĞA ÇIKILMAZ.
  if (!snapshotUsable) {
    return {
      ok: false,
      source: 'real',
      errorSource: 'Frontend',
      errorCode: 'SURAT_CREDENTIAL_SNAPSHOT_MISSING',
      message: buildUserFacingError({ traceId }),
      canonicalCreate: {
        adapter: 'SURAT_WEB_API',
        carrierCreateStatus: 'NOT_STARTED',
        carrierCreateAttempts: 0,
        networkCallCount: 0,
      },
      traceAttempt: appendTraceStage(traceAttempt, {
        stage: 'FINAL', section: 'FINAL_RESULT', at: stamp(),
        data: {
          outcome: 'SURAT_CREDENTIAL_SNAPSHOT_MISSING',
          carrierCreateStatus: 'NOT_STARTED',
          carrierCalled: false,
          networkCallCount: 0,
        },
      }),
    }
  }
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

  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'PRE_FLIGHT', section: 'BILLING', at: stamp(),
    data: {
      billingParty: billing.billingParty,
      expectedSuratWhoPays: attemptContext.expectedSuratWhoPays,
      odemeTipi: attemptContext.odemeTipi,
      codEnabled: cod.codEnabled,
      pazaryerimi: input.context.pazaryerimi,
      entegrasyonFirmasi: input.context.entegrasyonFirmasi,
      ozelKargoTakipNoSource: input.context.trackingSource,
      preflightValid: preflight.valid,
      preflightFailures: preflight.failures,
    },
  })
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'ROUTING', section: 'CREDENTIAL_ROUTING', at: stamp(),
    data: {
      credentialRole: credential.role,
      credentialSource: credential.source,
      maskedAccount: credential.maskedAccount,
      credentialResolved: credential.resolved,
      serviceMode: SURAT_CANONICAL_SERVICE_MODE,
      serviceType: SURAT_CANONICAL_SERVICE_TYPE,
      operation: SURAT_CANONICAL_OPERATION_NAME,
    },
  })

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
        accountFingerprint: credential.accountFingerprint,
      },
      suratCreateTrace: attemptContext,
      // Bloklanan deneme de TUTARLI bir iz üretir: PRE_FLIGHT → FINAL,
      // arada CARRIER_CALL YOKTUR — çünkü taşıyıcıya hiç gidilmedi.
      traceAttempt: appendTraceStage(traceAttempt, {
        stage: 'FINAL', section: 'FINAL_RESULT', at: stamp(),
        data: {
          outcome: 'BLOCKED_BY_PREFLIGHT',
          carrierCreateStatus: 'NOT_STARTED',
          carrierCalled: false,
          failures: preflight.failures,
        },
      }),
    }
  }

  // İKİNCİ ÇÖZÜMLEME KALDIRILDI: eskiden burada
  // `resolveCanonicalTenantSuratAccount(params.config, ...)` vardı ve
  // `params.config` İSTEK GÖVDESİYDİ.
  const account = {
    kullaniciAdi: snapshot.kullaniciAdi,
    sifre: snapshot.sifre,
    accountFingerprint: snapshot.accountFingerprint,
    billingParty: credentialRoleToAccountKey(
      credential.role,
    ) as SuratBillingParty,
  }

  // ═══ AĞ ÖNCESİ KİMLİK PARİTE KAPISI ═════════════════════════════════
  // Kimliği SEÇEN `resolveSuratCredentialContext`, telde GİDEN hesabı ise
  // `resolveCanonicalTenantSuratAccount` çözüyor. İki bağımsız çözümleme
  // ayrışabilir ve gönderi YANLIŞ CARİYE yazılabilir — geri alınamaz.
  // Bu kapı YENİ bir yönlendirici DEĞİLDİR; yalnız telin hâlâ çözücünün
  // seçtiği hesabı taşıdığını doğrular.
  const wireAccountFingerprint = accountFingerprint(account?.kullaniciAdi)
  const credentialFingerprintMatch = assertSuratWireCredentialParity({
    snapshot, wireKullaniciAdi: account?.kullaniciAdi,
  }).ok
  const parity = {
    credentialRole: credential.role,
    credentialSource: credential.source,
    resolverAccountFingerprint: credential.accountFingerprint,
    wireAccountFingerprint,
    credentialFingerprintMatch,
  }
  if (!credentialFingerprintMatch) {
    return {
      ok: false,
      source: 'real',
      errorSource: 'Frontend',
      // İKİ AYRI DURUM: tele hiç hesap çıkmıyorsa bu "kimlik yapılandırılmamış"
      // hâlidir ve DIŞ SÖZLEŞME korunur. `SURAT_CREDENTIAL_WIRE_MISMATCH`
      // yalnız iki hesap da VAR ama FARKLI olduğunda kullanılır — sessizce
      // başka cariye yazma riski tam olarak budur.
      errorCode: account
        ? 'SURAT_CREDENTIAL_WIRE_MISMATCH'
        : 'SURAT_ACCOUNT_NOT_CONFIGURED',
      message: buildUserFacingError({ traceId }),
      canonicalCreate: {
        adapter: 'SURAT_WEB_API',
        carrierCreateStatus: 'NOT_STARTED',
        carrierCreateAttempts: 0,
        billingParty: credential.role,
        accountFingerprint: credential.accountFingerprint,
      },
      suratCreateTrace: { ...attemptContext, ...parity },
      // CARRIER_CALL aşaması YOK: taşıyıcıya hiç gidilmedi.
      traceAttempt: appendTraceStage(traceAttempt, {
        stage: 'FINAL', section: 'FINAL_RESULT', at: stamp(),
        data: {
          outcome: account
            ? 'SURAT_CREDENTIAL_WIRE_MISMATCH'
            : 'SURAT_ACCOUNT_NOT_CONFIGURED',
          carrierCreateStatus: 'NOT_STARTED',
          carrierCalled: false,
          ...parity,
        },
      }),
    }
  }
  // ═══ TAŞIYICI ÇAĞRISI — FIRLATSA BİLE İZ KAYBOLMAZ ════════════════════
  //
  // ÖLÇÜLEN KUSUR (üretim, 2 kez): Sürat kanonik ucu HTTP 200 döndürüp
  // gövdede .NET istisnası veriyor
  // (`OrtakBarkodOlusturSonuc` içinde String → KargoBarkod cast'i).
  // İstemci bunu ayrıştırırken FIRLATIYOR; `traceAttempt` bu fonksiyonun
  // YEREL değişkeniydi ve yığınla birlikte KAYBOLUYORDU. Route'un `catch`
  // dalı izsiz bir gövde döndürdüğü için hiçbir şey kaydedilmiyor, Canlı
  // Debug gerçek denemeden sonra bile "kayıt yok" diyordu.
  //
  // Bu yüzden çağrı BURADA yakalanır: iz zaten burada, aşamaları eksiksiz.
  // Fırlatma bir SONUÇ olarak döner ve iz KAYDEDİLİR.
  let result
  try {
    result = await createCanonicalSuratShipment({
      organizationId: params.organizationId,
      packageId: String(
        params.order.packageId ?? params.order.shipmentPackageId ?? params.reference,
      ),
      account: account
        ? { kullaniciAdi: account.kullaniciAdi, sifre: account.sifre, isActive: true }
        : null,
      credentialSnapshot: snapshot,
      context: input.context,
      shipment: input,
      idempotency: createHeldIdempotencyPort(),
      fetchImpl: params.fetchImpl,
    })
  } catch (carrierError) {
    const summary =
      carrierError instanceof Error ? carrierError.message : String(carrierError)
    return {
      ok: false,
      source: 'real',
      errorSource: 'Surat',
      errorCode: 'SURAT_CANONICAL_RESULT_UNPARSEABLE',
      message: buildUserFacingError({ traceId }),
      canonicalCreate: {
        adapter: 'SURAT_WEB_API',
        // KRİTİK: taşıyıcıya GİDİLDİ. Gönderinin oluşup oluşmadığı
        // BİLİNMİYOR — `NOT_STARTED` demek yanlış olur ve ikinci bir
        // fiziksel create'e zemin hazırlardı.
        carrierCreateStatus: 'UNKNOWN',
        carrierCreateAttempts: 1,
        billingParty: credential.role,
        accountFingerprint: credential.accountFingerprint,
      },
      suratCreateTrace: {
        ...attemptContext,
        ...parity,
        carrierCreateStatus: 'UNKNOWN',
        carrierCreateAttempts: 1,
        carrierExceptionSummary: summary,
      },
      traceAttempt: appendTraceStage(traceAttempt, {
        stage: 'FINAL', section: 'FINAL_RESULT', at: stamp(),
        data: {
          outcome: 'SURAT_CANONICAL_RESULT_UNPARSEABLE',
          carrierCreateStatus: 'UNKNOWN',
          carrierCalled: true,
          carrierExceptionSummary: summary,
          ...parity,
        },
      }),
    }
  }
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'REQUEST_READY', section: 'REQUEST', at: stamp(),
    data: {
      ...wire,
      contractHasWhoPaysField: wire.wireWhoPaysPresent,
      // Telin HÂLÂ çözücünün seçtiği hesabı taşıdığının kanıtı.
      ...parity,
    },
  })
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'CARRIER_CALL', section: 'SERVICE_ROUTING', at: stamp(),
    data: {
      serviceMode: SURAT_CANONICAL_SERVICE_MODE,
      operation: SURAT_CANONICAL_OPERATION_NAME,
      attempts: result.carrierCreateAttempts,
    },
  })
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'CARRIER_RESPONSE', section: 'RESPONSE', at: stamp(),
    data: {
      carrierCreateStatus: result.carrierCreateStatus,
      outcome: result.outcome,
      businessCode: result.errorCode ?? null,
      businessMessage: result.vendorMessage,
    },
  })
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'VERIFICATION', section: 'VERIFICATION', at: stamp(),
    data: {
      trackingPresent: Boolean(result.trackingNo),
      barcodePresent: result.barcode.length > 0,
      printArtifactStatus: result.printArtifactStatus,
    },
  })
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'FINAL', section: 'FINAL_RESULT', at: stamp(),
    data: {
      carrierCreateStatus: result.carrierCreateStatus,
      carrierCalled: true,
    },
  })
  const response = mapCanonicalResultToCreateResponse({ result, input, account })
  // AYNI traceId tüm aşamalarda taşınır: PRE_FLIGHT → ROUTING →
  // REQUEST_READY → CARRIER_CALL → CARRIER_RESPONSE → FINAL.
  return {
    ...response,
    suratCreateTrace: {
      ...attemptContext,
      ...parity,
      carrierCreateStatus: result.carrierCreateStatus,
      carrierCreateAttempts: result.carrierCreateAttempts,
      trackingPresent: Boolean(result.trackingNo),
      barcodePresent: result.barcode.length > 0,
    },
    traceAttempt,
  }
}

export { buildCanonicalIdempotencyKey }
