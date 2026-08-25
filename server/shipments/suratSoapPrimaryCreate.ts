// SÜRAT SOAP BİRİNCİL CREATE — OTORİTE KATMANI.
//
// ═══ NEDEN AYRI KATMAN ═══════════════════════════════════════════════════
//
// SOAP uygulaması TARİHSEL ve DOĞRULANMIŞTIR; zarf DEĞİŞTİRİLMEZ. Ama
// "legacy adaptör" olması, legacy kimlik davranışının geri gelmesi anlamına
// GELMEZ: kanonik yolda ölçülen kusur, kimliğin istek gövdesinden
// çözülmesiydi — yani İSTEMCİ hangi cariye yazılacağını seçebiliyordu.
//
// Bu katman SOAP çağrısını sarar ve kanonik yolun kazandığı güvenceleri
// aynen uygular:
//
//   dondurulmuş kiracı kimlik anlık görüntüsü
//   ağ sınırı parmak izi paritesi (ağa çıkmadan)
//   Trace V2 yaşam döngüsü (GERÇEK tel yakalaması dahil)
//   iş kodu sınıflandırması (HTTP 200 ≠ başarı)
//
// Ağ çağrısı ENJEKTE EDİLİR (`executeCreate`). Bu modül fetch YAPMAZ:
// testler gerçek taşıyıcıya çıkmadan tüm kapıları çalıştırabilir.

import {
  appendTraceStage,
  createTraceAttempt,
  type SuratTraceAttempt,
} from './suratCreateTrace.ts'
import { assertSuratWireCredentialParity } from './suratCredentialSnapshot.ts'
import type { SuratCredentialSnapshot } from './suratCredentialSnapshot.ts'
import {
  classifySuratCreateResponse, isSuratAlreadyExistsMessage,
} from './suratResponseClassification.ts'
import type { SuratResponseClassification } from './suratResponseClassification.ts'
import {
  captureSoapActualWire,
  readEnvelopeKullaniciAdi,
} from './suratSoapWireCapture.ts'
import type { SoapWireCapture } from './suratSoapWireCapture.ts'
import {
  SOAP_PRIMARY_OPERATION,
  SOAP_PRIMARY_SERVICE_MODE,
  SOAP_PRIMARY_SERVICE_TYPE,
} from './suratPrimaryCreateRoute.ts'

/** Taşıyıcı çağrısının SONUCU — bu modül onu yorumlar, üretmez. */
export interface SoapCreateExecutionResult {
  httpSuccess?: unknown
  /** BU denemede ağ sınırının geçildiğine dair kanıt (gerçek HTTP durumu). */
  networkCrossed?: unknown
  businessCode?: unknown
  businessMessage?: unknown
  codeCategory?: unknown
  trackingNumber?: unknown
  barcode?: unknown
  zpl?: unknown
  /** Doğrulanmış kayıt kanıtı — read teyidi buradan gelir. */
  verifiedShipment?: unknown
  /** Ağ çağrısı GERÇEKTEN yapıldı mı? */
  carrierCalled?: unknown
  /** Çağıranın kendi yanıt gövdesi — olduğu gibi geri verilir. */
  response?: Record<string, unknown>
}

export interface SoapPrimaryCreateParams {
  traceId: string
  stamp: () => string
  /** OTORİTER KİMLİK — ZORUNLU, DONDURULMUŞ. */
  credentialSnapshot: SuratCredentialSnapshot
  /** Finansal kapının ÜRETTİĞİ bağlam. Bu katman onu YENİDEN HESAPLAMAZ. */
  financialContext: Record<string, unknown>
  marketplace?: unknown
  /**
   * Yürütücünün KULLANACAĞI hesap — ÖN parite için.
   *
   * Doğrulanmış zincirin İLK ağ çağrısı SOAP değildir (önce kayıt tescili
   * gelir). Pariteyi yalnız SOAP zarfında ölçmek, ayrışma hâlinde tescilin
   * ZATEN yapılmış olması demekti — "ağ çağrısı 0" iddiası doğru olmazdı.
   * Bu yüzden kapı, hiçbir çağrı başlamadan ÖNCE de çalışır.
   */
  wireAccountPreview?: unknown
  /** Okunan kaydın kimliği — maskeli, sır DEĞİL. */
  credentialRecordIdentity?: {
    organizationIdMasked?: unknown
    integrationIdMasked?: unknown
  } | null
  /**
   * Taşıyıcı çağrısı. `onWireReady` NİHAİ zarfla, fetch'ten HEMEN ÖNCE
   * çağrılmalıdır — sonradan yeniden kurgulanan zarf GERÇEK tel değildir.
   */
  executeCreate: (args: {
    onWireReady: (envelope: string) => void
  }) => Promise<SoapCreateExecutionResult>
}

export interface SoapPrimaryCreateOutcome {
  ok: boolean
  /** Ağa GERÇEKTEN çıkıldı mı? Bloklandıysa 0 çağrı. */
  carrierCalled: boolean
  carrierCreateAttempts: number
  errorCode: string | null
  classification: SuratResponseClassification | null
  wire: SoapWireCapture | null
  suratCreateTrace: Record<string, unknown>
  traceAttempt: SuratTraceAttempt
  response: Record<string, unknown> | null
}

const zplLengthOf = (value: unknown): number =>
  typeof value === 'string' ? value.length : 0

/**
 * Tek giriş noktası: kapılar → tel yakalama → çağrı → sınıflandırma.
 *
 * Kimlik ÇÖZÜLMEMİŞSE ya da parite tutmuyorsa AĞA ÇIKILMAZ. Yanlış cariye
 * açılan gönderi geri alınamaz; bu yüzden şüphede DURULUR.
 */
export async function createSuratSoapPrimaryShipment(
  params: SoapPrimaryCreateParams,
): Promise<SoapPrimaryCreateOutcome> {
  const { stamp, credentialSnapshot: snapshot } = params
  let traceAttempt = createTraceAttempt({
    traceId: params.traceId, createdAt: stamp(),
  })

  const recordIdentity = {
    tenantOrganizationIdMasked:
      String(params.credentialRecordIdentity?.organizationIdMasked ?? '')
      || 'UNKNOWN',
    tenantIntegrationIdMasked:
      String(params.credentialRecordIdentity?.integrationIdMasked ?? '')
      || 'UNKNOWN',
  }

  const routingContext = {
    serviceMode: SOAP_PRIMARY_SERVICE_MODE,
    serviceType: SOAP_PRIMARY_SERVICE_TYPE,
    operation: SOAP_PRIMARY_OPERATION,
    marketplace: String(params.marketplace ?? ''),
    credentialRole: snapshot?.role ?? null,
    // Kaynak etiketi YALNIZ gerçekten çözüldüyse rol adını taşır: boş parmak
    // izini "kiracının birincil hesabı" diye etiketlemek çözülmüş kimlik
    // izlenimi verir.
    credentialSource: snapshot?.resolved ? snapshot.source : 'UNRESOLVED_SNAPSHOT',
    credentialResolved: Boolean(snapshot?.resolved),
    snapshotAccountFingerprint: snapshot?.accountFingerprint ?? '',
    ...recordIdentity,
  }

  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'PRE_FLIGHT', section: 'BILLING', at: stamp(),
    data: { ...params.financialContext },
  })
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'ROUTING', section: 'CREDENTIAL_ROUTING', at: stamp(),
    data: routingContext,
  })

  const baseTrace = {
    ...params.financialContext,
    ...routingContext,
  }

  // ═══ KAPI 1 — KİMLİK ÇÖZÜLDÜ MÜ? ═══════════════════════════════════════
  if (!snapshot?.resolved) {
    traceAttempt = appendTraceStage(traceAttempt, {
      stage: 'WIRE_BLOCKED', section: 'CREDENTIAL_ROUTING', at: stamp(),
      data: {
        errorCode: 'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
        carrierCalled: false,
        networkCallCount: 0,
      },
    })
    return {
      ok: false,
      carrierCalled: false,
      carrierCreateAttempts: 0,
      errorCode: 'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
      classification: null,
      wire: null,
      suratCreateTrace: {
        ...baseTrace, carrierCreateStatus: 'BLOCKED', carrierCalled: false,
      },
      traceAttempt,
      response: null,
    }
  }

  // ═══ KAPI 2A — ZİNCİRİN İLK ÇAĞRISINDAN ÖNCE ═══════════════════════════
  const preflightParity = assertSuratWireCredentialParity({
    snapshot, wireKullaniciAdi: params.wireAccountPreview,
  })
  if (!preflightParity.ok) {
    traceAttempt = appendTraceStage(traceAttempt, {
      stage: 'WIRE_BLOCKED', section: 'CREDENTIAL_ROUTING', at: stamp(),
      data: {
        errorCode: preflightParity.errorCode,
        boundary: 'PRE_CHAIN',
        carrierCalled: false,
        networkCallCount: 0,
      },
    })
    return {
      ok: false,
      carrierCalled: false,
      carrierCreateAttempts: 0,
      errorCode: preflightParity.errorCode
        ?? 'SURAT_CREDENTIAL_WIRE_MISMATCH',
      classification: null,
      wire: null,
      suratCreateTrace: {
        ...baseTrace, carrierCreateStatus: 'BLOCKED', carrierCalled: false,
      },
      traceAttempt,
      response: null,
    }
  }

  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'REQUEST_READY', section: 'REQUEST', at: stamp(),
    data: {
      operation: SOAP_PRIMARY_OPERATION,
      serviceType: SOAP_PRIMARY_SERVICE_TYPE,
      // SOAP `Gonderi` sözleşmesinde bu alanlar YOKTUR; uydurulmaz.
      whoPaysInSoapContract: false,
      kimOderInSoapContract: false,
    },
  })

  // ═══ TEL YAKALAMA — fetch'ten HEMEN ÖNCE ══════════════════════════════
  let wire: SoapWireCapture | null = null
  // `edge` ayrimi: parite SOAP zarfi icin tasarlandi (anlik goruntu ile
  // serilesen zarfi kiyaslar). Zincirin REST kayit adimi FARKLI bir kimlik
  // alani tasir; oraya ayni kapiyi uygulamak calisan create'leri BLOKLARDI.
  // Bu yuzden REST kenari YAKALANIR (gorunurluk) ama SOAP paritesine
  // SOKULMAZ; parmak izi yine de ize yazilir ve fark GORUNUR kalir.
  const onWireReady = (envelope: string, edge: string = 'SOAP'): void => {
    wire = captureSoapActualWire({
      envelope,
      operation: SOAP_PRIMARY_OPERATION,
      serviceMode: SOAP_PRIMARY_SERVICE_MODE,
    })
    // KANIT AGDAN ONCE YAZILIR. Eskiden bu asama `executeCreate` DONDUKTEN
    // sonra ekleniyordu; cagri patlarsa ya da yakalama sonrasi bir sey
    // atarsa `carrierCalled=true` olurken telde NE gittigi KAYBOLUYORDU.
    // Uretim izi CF-4102465808 tam olarak bu haldeydi: ACTUAL_WIRE eksik,
    // carrierCalled dogru.
    traceAttempt = appendActualWireStage(traceAttempt, wire, snapshot, stamp, edge)
    // HER KENAR icin cagri baslangici yazilir: `carrierCalled=true` olan bir
    // deneme CARRIER_CALL_STARTED tasimak ZORUNDA. Uretim izi CF-4103110390'da
    // REST kenari tel kanitini yaziyor ama cagri asamasini YAZMIYORDU.
    const markCallStarted = (): void => {
      traceAttempt = appendTraceStage(traceAttempt, {
        stage: 'CARRIER_CALL_STARTED', section: 'SERVICE_ROUTING', at: stamp(),
        data: { operation: SOAP_PRIMARY_OPERATION, attempt: 1, step: edge },
      })
    }
    if (edge !== 'SOAP') {
      // REST kenari: yakalama + cagri asamasi EVET, SOAP paritesi HAYIR
      // (farkli kimlik alani; ayni kapiya sokmak calisan create'i bloklardi).
      markCallStarted()
      return
    }
    // ═══ KAPI 2 — AĞ SINIRI PARİTESİ ════════════════════════════════════
    // Karşılaştırma OTORİTER anlık görüntü ile GERÇEKTEN serileşen zarf
    // arasındadır. Bundan sonra hiçbir kimlik dönüşümü YOKTUR.
    const parity = assertSuratWireCredentialParity({
      snapshot,
      // Parite NIHAI zarftaki kullanici adiyla olculur; zarf disindan
      // yeniden cozulen bir deger AYNI SEY DEGILDIR.
      wireKullaniciAdi: readEnvelopeKullaniciAdi(envelope),
    })
    if (!parity.ok) {
      // Çağıran zarfı göndermeden ÖNCE durmalıdır.
      throw new SuratSoapWireBlockedError(
        parity.errorCode ?? 'SURAT_CREDENTIAL_WIRE_MISMATCH',
        parity.reason ?? 'Kimlik paritesi başarısız.',
      )
    }
    // SIRA: ACTUAL_WIRE_READY → parite → CARRIER_CALL_STARTED → ag.
    // Cagri baslangici ancak tel kaniti YAZILDIKTAN ve parite GECTIKTEN
    // sonra isaretlenir; boylece `carrierCalled=true` olup telin bilinmedigi
    // bir iz URETILEMEZ.
    markCallStarted()
  }

  let execution: SoapCreateExecutionResult
  try {
    execution = await params.executeCreate({ onWireReady })
  } catch (error) {
    const blocked = error instanceof SuratSoapWireBlockedError
    // TASIYICI "zaten var" DEDIYSE istek ULASMISTIR: bu bir tasima hatasi
    // DEGILDIR. Istemci is hatasini istisnaya cevirse bile mesaj KANITTIR.
    const alreadyExists = !blocked
      && isSuratAlreadyExistsMessage((error as Error)?.message)
    // Istisna da olsa: aga cikildigi KANITLANMALIDIR. Tel yakalanmadiysa
    // zarf hic kurulmamis demektir ve sinir GECILMEMISTIR.
    const crossedNetwork = !blocked && wire !== null
    traceAttempt = appendTraceStage(traceAttempt, {
      stage: blocked ? 'WIRE_BLOCKED' : 'CARRIER_RESPONSE',
      section: blocked ? 'CREDENTIAL_ROUTING' : 'RESPONSE',
      at: stamp(),
      data: blocked
        ? {
            errorCode: (error as SuratSoapWireBlockedError).errorCode,
            carrierCalled: false,
            networkCallCount: 0,
          }
        : {
            // Ağ/istisna durumunda gönderinin OLUŞMADIĞI KANITLANMAMIŞTIR.
            carrierCalled: crossedNetwork,
            evidenceSource: crossedNetwork
              ? 'CURRENT_CARRIER_RESPONSE'
              : 'PRIOR_OR_LOCAL_EVIDENCE',
            carrierCreateStatus: 'UNKNOWN',
            carrierExceptionSummary: summarizeError(error),
          },
    })
    traceAttempt = appendTraceStage(traceAttempt, {
      stage: 'FINAL', section: 'FINAL_RESULT', at: stamp(),
      data: {
        carrierCreateStatus: blocked
          ? 'BLOCKED'
          : alreadyExists ? 'ALREADY_EXISTS' : 'UNKNOWN',
        carrierCalled: crossedNetwork,
      },
    })
    return {
      ok: false,
      carrierCalled: crossedNetwork,
      carrierCreateAttempts: crossedNetwork ? 1 : 0,
      errorCode: blocked
        ? (error as SuratSoapWireBlockedError).errorCode
        : alreadyExists
          ? 'SURAT_SHIPMENT_ALREADY_EXISTS'
          : 'SURAT_SOAP_TRANSPORT_FAILED',
      classification: alreadyExists
        ? classifySuratCreateResponse({
            httpSuccess: true,
            businessMessage: (error as Error)?.message,
            codeCategory: 'DUPLICATE_EXISTS',
          })
        : null,
      wire,
      suratCreateTrace: {
        ...baseTrace,
        carrierCreateStatus: blocked ? 'BLOCKED' : 'UNKNOWN',
        carrierCalled: !blocked,
      },
      traceAttempt,
      response: null,
    }
  }

  const classification = classifySuratCreateResponse({
    httpSuccess: execution.httpSuccess === true,
    businessCode: execution.businessCode,
    businessMessage: execution.businessMessage,
    codeCategory: execution.codeCategory,
    trackingNumber: execution.trackingNumber,
    barcode: execution.barcode,
    zpl: execution.zpl,
  })

  // ═══ DENEME KAPSAMLI GERÇEK ═══════════════════════════════════════════
  // `carrierCalled` ARTIK varsayılan olarak true DEĞİLDİR. Bu denemede ağa
  // gerçekten çıkıldığının kanıtı: tel yakalandı (enstrümante sınır) ya da
  // yürütme gerçek bir HTTP durumu bildirdi. Önceki sürüm
  // `execution.carrierCalled !== false` diyerek YOKLUĞU onay sayıyordu ve
  // üretim izi CF-4102563548'de çağrı yapılmamış gibi görünen aşamalarla
  // `carrierCalled=true` yan yana çıkmıştı.
  const crossedNetwork = wire !== null || execution.networkCrossed === true
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: crossedNetwork ? 'CARRIER_RESPONSE' : 'VERIFICATION',
    section: 'RESPONSE', at: stamp(),
    data: {
      carrierCalled: crossedNetwork,
      // Ağ geçilmediyse sonuç YEREL/ÖNCEKİ kanıttandır; uydurma yanıt YOK.
      evidenceSource: crossedNetwork
        ? 'CURRENT_CARRIER_RESPONSE'
        : 'PRIOR_OR_LOCAL_EVIDENCE',
      createCallCount: crossedNetwork ? 1 : 0,
      businessResult: classification.finalClassification,
      carrierCode: classification.businessCode,
      carrierMessage: classification.businessMessage,
      trackingPresent: classification.trackingPresent,
      barcodePresent: classification.barcodePresent,
      zplPresent: classification.zplPresent,
      // İçerik DEĞİL, yalnız uzunluk: etiket verisi PII taşıyabilir.
      zplLength: zplLengthOf(execution.zpl),
      verificationStage: classification.verificationStage,
    },
  })

  // ═══ DOĞRULAMA — 200 ve hatta 013 TEK BAŞINA yeterli değildir ═════════
  // Depo sözleşmesi: kayıt kanıtı read teyidinden gelir. `verifiedShipment`
  // yoksa etiket "oluşturuldu" diye gösterilemez.
  const verifiedShipment = execution.verifiedShipment === true
  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'VERIFICATION', section: 'VERIFICATION', at: stamp(),
    data: {
      finalClassification: classification.finalClassification,
      carrierRegistrationConfirmed: classification.carrierRegistrationConfirmed,
      verifiedShipment,
      trackingPresent: classification.trackingPresent,
      barcodePresent: classification.barcodePresent,
      zplPresent: classification.zplPresent,
    },
  })

  const ok = classification.finalClassification === 'CREATED_CONFIRMED'
    && verifiedShipment
  const carrierCreateStatus = ok
    ? 'SUCCESS'
    : classification.finalClassification === 'SAVED_BARCODE_FAILED'
      ? 'SAVED_BARCODE_FAILED'
      : classification.finalClassification === 'REJECTED_BUSINESS_RULE'
        ? 'REJECTED'
        : classification.finalClassification === 'CREATED_CONFIRMED'
          ? 'TRACKING_CONFIRMATION_MISSING'
          : classification.finalClassification

  traceAttempt = appendTraceStage(traceAttempt, {
    stage: 'FINAL', section: 'FINAL_RESULT', at: stamp(),
    data: { carrierCreateStatus, carrierCalled: crossedNetwork },
  })

  return {
    ok,
    carrierCalled: crossedNetwork,
    carrierCreateAttempts: crossedNetwork ? 1 : 0,
    errorCode: ok ? null : carrierCreateStatus,
    classification,
    wire,
    suratCreateTrace: {
      ...baseTrace,
      carrierCreateStatus,
      carrierCreateAttempts: crossedNetwork ? 1 : 0,
      businessResult: classification.finalClassification,
      carrierCode: classification.businessCode,
      trackingPresent: classification.trackingPresent,
      barcodePresent: classification.barcodePresent,
      zplPresent: classification.zplPresent,
      verifiedShipment,
    },
    traceAttempt,
    response: execution.response ?? null,
  }
}

/** Parite tutmadığında zarf GÖNDERİLMEDEN atılır. */
export class SuratSoapWireBlockedError extends Error {
  readonly errorCode: string
  constructor(errorCode: string, reason: string) {
    super(reason)
    this.name = 'SuratSoapWireBlockedError'
    this.errorCode = errorCode
  }
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  // Mesaj kimlik/PII taşımamalı: yalnız ilk satır ve sınırlı uzunluk.
  return message.split('\n')[0].slice(0, 200)
}

function appendActualWireStage(
  attempt: SuratTraceAttempt,
  wire: SoapWireCapture,
  snapshot: SuratCredentialSnapshot,
  stamp: () => string,
  // Zincirde IKI tasima var; izde birbirine KARISMAMALI.
  step: string = 'SOAP',
): SuratTraceAttempt {
  return appendTraceStage(attempt, {
    stage: 'ACTUAL_WIRE_READY', section: 'REQUEST', at: stamp(),
    data: {
      step: step === 'SOAP' ? 'BARCODE_SOAP' : 'REGISTRATION_REST',
      envelopePresent: wire.envelopePresent,
      gonderiPresent: wire.gonderiPresent,
      operation: wire.operation,
      serviceMode: wire.serviceMode,
      gonderiFieldNames: wire.gonderiFieldNames,
      gonderiFieldTypes: wire.gonderiFieldTypes,
      safeValues: wire.safeValues,
      contractAbsentFields: wire.contractAbsentFields,
      credential: wire.credential,
      snapshotAccountFingerprint: snapshot.accountFingerprint,
      networkBoundaryAccountFingerprint:
        wire.credential.networkBoundaryAccountFingerprint,
      credentialFingerprintMatch:
        wire.credential.networkBoundaryAccountFingerprint
          === snapshot.accountFingerprint,
      envelopeLength: wire.envelopeLength,
    },
  })
}
