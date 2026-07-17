import type {
  CargoOrder,
  Shipment,
  SuratErrorCategory,
  SuratServiceMode,
  SuratVerificationStage,
  SuratZplAnalysis,
} from '../types/cargoflow'
import { resolveSuratBarcodeRawZpl, type ZplSource } from './zpl'
import { analyzeSuratZpl, isNumericOperationalCode } from './suratZplAnalysis'

export interface TrackingUrlExtraction {
  value: string
  source: string
}

export interface SuratVerificationResult {
  verifiedShipment: boolean
  hasSuratShipment: boolean
  hasTrackingQuery: boolean
  hasSuratTrackingNumber: boolean
  matchReason: string
  trendyolCargoTrackingNumber: string
  suratKargoTakipNo: string
  extractedKargoTakipNo: string
  suratTakipUrl: string
  takipUrlSource: string
  takipUrlTrackingSource: string
  shipmentReference: string
  orderNumber: string
  packageId: string
  WebSiparisKodu: string
  SatisKodu: string
  OzelKargoTakipNo: string
  Satiskodu: string
  trackingNumber: string
  trackingNumberSource: string
  tNo: string
  tNoSource: string
  gonderiNo: string
  waybillNo: string
  irsaliyeNo: string
  cargoKey: string
  officialBarcodeValue: string
  officialBarcodeSource: string
  serviceMode?: SuratServiceMode
  operationName: string
  kargoTakipNo: string
  barcode: string
  barcodeRaw: string
  barcodeSource: string
  zplSource: ZplSource
  isLiveBarcodeReady: boolean
  technicalZplReceived: boolean
  operationalBarcodeVerified: boolean
  serdendipVerified: boolean
  operationalPrintAllowed: boolean
  technicalPrintAllowed: boolean
  verificationStage: SuratVerificationStage
  errorCategory?: SuratErrorCategory
  finalSuratBarcode: string
  internalWebBarcode: string
  zplAnalysis: SuratZplAnalysis
  gonderilerLength: number
}

export function extractTrackingNumberFromTakipUrl(
  url = '',
): TrackingUrlExtraction {
  const text = String(url ?? '').trim()
  if (!text) return { value: '', source: '' }

  try {
    const parsedUrl = new URL(text)
    for (const key of ['kargotakipno', 'takipno', 'tno', 'barkodno']) {
      const value = parsedUrl.searchParams.get(key)
      if (value) {
        return {
          value: value.trim(),
          source: `surat.track.TakipUrl.query.${key}`,
        }
      }
    }
  } catch {
    // Sürat bazen tam URL yerine parça metin döndürebiliyor.
  }

  const match = text.match(/\b\d{8,}\b/)
  return match
    ? {
        value: match[0],
        source: 'surat.track.TakipUrl.longNumericSequence',
      }
    : { value: '', source: '' }
}

export function verifySuratShipment(
  order?: CargoOrder,
  shipment?: Shipment,
): SuratVerificationResult {
  const effectiveShipment = shipment ?? order?.shipment
  const createLog = effectiveShipment?.suratCreateLog
  const trackingLog = effectiveShipment?.suratTrackingLog
  const operationalBarcodeLog = effectiveShipment?.suratOperationalBarcodeLog
  const createParsed = firstObject(
    createLog?.parsedResponse,
    readUnknown(effectiveShipment?.rawResponse, ['parsedResponse']),
    readUnknown(effectiveShipment?.rawResponse, ['suratCreateLog', 'parsedResponse']),
  )
  const operationalParsed = firstObject(
    operationalBarcodeLog?.parsedResponse,
    operationalBarcodeLog,
  )
  const trackingParsed = firstObject(
    trackingLog?.parsedResponse,
    readUnknown(effectiveShipment?.rawResponse, ['tracking']),
  )
  const trackingLogFields = trackingLog
    ? {
        KargoTakipNo: trackingLog.KargoTakipNo,
        TakipNo: trackingLog.TakipNo,
        TNo: trackingLog.TNo,
        BarkodNo: trackingLog.BarkodNo,
        Barkod: trackingLog.Barkod,
        TakipUrl: trackingLog.TakipUrl,
        TakipUrlTrackingNo: trackingLog.TakipUrlTrackingNo,
        extractedKargoTakipNo: trackingLog.extractedKargoTakipNo,
        Satiskodu: trackingLog.Satiskodu,
        SatisKodu: trackingLog.SatisKodu,
        WebSiparisKodu: trackingLog.WebSiparisKodu,
        OzelKargoTakipNo: trackingLog.OzelKargoTakipNo,
        KargoObjId: trackingLog.KargoObjId,
        SeriNo: trackingLog.SeriNo,
        SiraNo: trackingLog.SiraNo,
      }
    : undefined
  const allSources = [
    operationalParsed,
    trackingLogFields,
    trackingParsed,
    createParsed,
  ]
  const operationalSources = [operationalParsed]
  const trackingSources = [trackingLogFields, trackingParsed]
  const createSources = [createParsed]
  const serviceMode =
    effectiveShipment?.serviceMode ??
    createLog?.serviceMode ??
    serviceModeFromType(createLog?.serviceType)
  const operationName =
    effectiveShipment?.operationName ??
    createLog?.operationName ??
    (serviceMode === 'ORTAK_BARKOD_SOAP' ? 'OrtakBarkodOlustur' : '')
  const createKargoTakipNo = firstNonEmpty(
    firstField(createSources, [
      'KargoTakipNo',
      'KargoTakipNumarasi',
      'KargoTakipNumarası',
    ]),
    createLog?.KargoTakipNo,
    effectiveShipment?.kargoTakipNo,
  )
  const createBarcode = firstNonEmpty(
    firstField(createSources, ['Barcode', 'Barkod', 'BarkodNo']),
    createLog?.Barcode,
    effectiveShipment?.barcode,
  )
  const operationalKargoTakipNo = firstNonEmpty(
    firstField(operationalSources, [
      'KargoTakipNo',
      'KargoTakipNumarasi',
      'KargoTakipNumarası',
    ]),
    effectiveShipment?.trackingSource === 'surat.KargoBarkodu.KargoTakipNo'
      ? effectiveShipment?.kargoTakipNo
      : '',
  )
  const operationalBarkodNo = firstNonEmpty(
    firstField(operationalSources, ['BarkodNo', 'Barcode', 'Barkod']),
    effectiveShipment?.barcodeSource === 'surat.KargoBarkodu.BarkodNo'
      ? effectiveShipment?.barcode
      : '',
    effectiveShipment?.barcodeSource === 'surat.KargoBarkodu.BarkodNo'
      ? effectiveShipment?.finalSuratBarcode
      : '',
  )
  const barcodeRaw = resolveSuratBarcodeRawZpl(
    effectiveShipment?.barcodeRaw,
    createLog?.BarcodeRaw,
    readUnknown(createParsed, ['BarcodeRaw']),
  )
  const zplAnalysis =
    effectiveShipment?.zplAnalysis ??
    createLog?.zplAnalysis ??
    analyzeSuratZpl(barcodeRaw)
  const packageId = String(order?.packageId || order?.shipmentPackageId || '').trim()
  const orderNumber = String(order?.orderNumber ?? '').trim()
  const trendyolCargoTrackingNumber = String(order?.cargoTrackingNumber ?? '').trim()
  const suratTakipUrl = firstNonEmpty(
    firstField(trackingSources, ['TakipUrl', 'TakipURL']),
    firstField(createSources, ['TakipUrl', 'TakipURL']),
    effectiveShipment?.trackingUrl,
  )
  const takipUrlSource = firstField(trackingSources, ['TakipUrl', 'TakipURL'])
    ? 'surat.track.TakipUrl'
    : firstField(createSources, ['TakipUrl', 'TakipURL'])
      ? 'surat.create.TakipUrl'
      : effectiveShipment?.trackingUrl
        ? 'shipment.trackingUrl'
        : ''
  const extracted = extractTrackingNumberFromTakipUrl(suratTakipUrl)
  const trackingKargoTakipNo = firstField(trackingSources, [
    'KargoTakipNo',
    'KargoTakipNumarasi',
    'KargoTakipNumarası',
  ])
  const suratKargoTakipNo =
    operationalKargoTakipNo ||
    (serviceMode === 'ORTAK_BARKOD_SOAP'
      ? firstNonEmpty(createKargoTakipNo, trackingKargoTakipNo)
      : firstNonEmpty(trackingKargoTakipNo, createKargoTakipNo))
  const suratBarkodNo = firstNonEmpty(
    operationalBarkodNo,
    firstField(trackingSources, ['BarkodNo']),
  )
  const suratBarkod = firstField(trackingSources, ['Barkod'])
  const suratTakipNo = firstField(trackingSources, ['TakipNo'])
  const suratTNo = firstField(trackingSources, ['TNo', 'T.No', 'TNO'])
  const WebSiparisKodu = firstNonEmpty(
    firstField(allSources, ['WebSiparisKodu', 'webSiparisKodu']),
    effectiveShipment?.webSiparisKodu,
    effectiveShipment?.shipmentCode,
  )
  const SatisKodu = firstNonEmpty(
    firstField(allSources, ['SatisKodu', 'Satiskodu', 'SatışKodu']),
    effectiveShipment?.satisKodu,
  )
  const OzelKargoTakipNo = firstNonEmpty(
    firstField(allSources, ['OzelKargoTakipNo', 'ÖzelKargoTakipNo']),
    effectiveShipment?.ozelKargoTakipNo,
  )
  const shipmentReference = firstNonEmpty(
    WebSiparisKodu,
    SatisKodu,
    OzelKargoTakipNo,
    firstField(allSources, ['ReferansNo']),
    effectiveShipment?.shipmentCode,
    packageId,
    orderNumber,
  )
  const match = resolveMatchReason({
    WebSiparisKodu,
    SatisKodu,
    OzelKargoTakipNo,
    packageId,
    cargoTrackingNumber: trendyolCargoTrackingNumber,
  })
  const legacyConfirmedOfficialShipment = Boolean(
    effectiveShipment &&
      effectiveShipment.dispatchRegistrationConfirmed === true &&
      serviceMode === 'ORTAK_BARKOD_SOAP' &&
      isOperationalTNo(createKargoTakipNo) &&
      isNumericOperationalCode(createBarcode) &&
      !isMarketplaceIntegrationBarcode(
        createBarcode,
        trendyolCargoTrackingNumber,
        OzelKargoTakipNo,
      ),
  )
  const explicitCreateFailure = Boolean(
    effectiveShipment?.lifecycleStatus === 'SURAT_BARCODE_FAILED' ||
      effectiveShipment?.lifecycleStatus === 'FAILED' ||
      effectiveShipment?.errorCategory ||
      createLog?.hardError === true ||
      createLog?.failedBarcodeValidation === true,
  )
  const hasSuratShipment = Boolean(
    effectiveShipment &&
      !explicitCreateFailure &&
      (legacyConfirmedOfficialShipment ||
        (createLog &&
          [
            'SHIPMENT_CREATED',
            'SURAT_CREATED_NO_TRACKING',
            'SURAT_TRANSFERRED_BUT_NO_BARCODE',
            'SURAT_DISPATCH_REJECTED',
            'SURAT_BARCODE_FAILED',
            'SURAT_TRACKING_MISSING',
            'TECHNICAL_ZPL_RECEIVED',
            'ZPL_NOT_OPERATIONALLY_VERIFIED',
            'TRACKING_CONFIRMED',
            'LABEL_READY',
            'LABEL_READY_AWAITING_ACCEPTANCE',
          ].includes(String(effectiveShipment.lifecycleStatus ?? '')))),
  )
  const hasTrackingQuery = Boolean(trackingLog)
  const gonderilerLength = Number(trackingLog?.gonderilerLength ?? 0)
  const rawOfficialBarcodeSelection = selectOfficialBarcode({
    serviceMode,
    operationalBarkodNo,
    createBarcode,
    zplBarcode: zplAnalysis.acceptedFinalBarcode,
    suratKargoTakipNo,
    suratBarkodNo,
    suratBarkod,
    extractedKargoTakipNo: extracted.value,
    takipUrlTrackingSource: extracted.source,
  })
  const officialBarcodeSelection = isMarketplaceIntegrationBarcode(
    rawOfficialBarcodeSelection.value,
    trendyolCargoTrackingNumber,
    OzelKargoTakipNo,
  )
    ? {
        value: '',
        source: rawOfficialBarcodeSelection.source
          ? `${rawOfficialBarcodeSelection.source}.blockedMarketplaceIntegrationCode`
          : '',
      }
    : rawOfficialBarcodeSelection
  const marketplaceRegistrationBarcode = firstNonEmpty(
    effectiveShipment?.barcodeSource === 'trendyol.cargoTrackingNumber'
      ? effectiveShipment?.barcodeValue
      : '',
    effectiveShipment?.barcodeSource === 'trendyol.cargoTrackingNumber'
      ? effectiveShipment?.barcode
      : '',
    effectiveShipment?.barcodeSource === 'trendyol.cargoTrackingNumber'
      ? effectiveShipment?.finalSuratBarcode
      : '',
    OzelKargoTakipNo,
    trendyolCargoTrackingNumber,
  )
  const registeredMarketplaceBarcodeReady = false
  void marketplaceRegistrationBarcode
  const effectiveOfficialBarcodeSelection = registeredMarketplaceBarcodeReady
    ? {
        value: marketplaceRegistrationBarcode,
        source: 'trendyol.cargoTrackingNumber',
      }
    : officialBarcodeSelection
  const hasSuratTrackingNumber = Boolean(effectiveOfficialBarcodeSelection.value)
  const hasTrackingRows =
    !trackingLog ||
    trackingLog.gonderilerLength == null ||
    gonderilerLength > 0
  const serdendipVerified = Boolean(
    hasTrackingQuery &&
      gonderilerLength > 0 &&
      hasSuratTrackingNumber &&
      (effectiveShipment?.serdendipVerified === true ||
        effectiveShipment?.verificationStage === 'serdendip_verified' ||
        effectiveShipment?.lifecycleStage === 'VERIFIED'),
  )
  const legacyIsLiveBarcodeReady = Boolean(
    serviceMode === 'ORTAK_BARKOD_SOAP' &&
      createKargoTakipNo &&
      createBarcode,
  )
  const legacyMatchReason = !hasSuratShipment
    ? 'Sürat gönderisi oluşturulmadı'
    : !match.matched
      ? match.reason
      : legacyIsLiveBarcodeReady
        ? 'OrtakBarkodOlustur KargoTakipNo + Barcode doğrulandı'
        : serviceMode === 'ORTAK_BARKOD_SOAP' && !createKargoTakipNo
          ? 'OrtakBarkodOlustur KargoTakipNo alanı boş'
          : serviceMode === 'ORTAK_BARKOD_SOAP' && !createBarcode
            ? 'OrtakBarkodOlustur Barcode alanı boş'
            : !hasTrackingQuery
              ? 'Sürat takip sorgusu yapılmadı'
              : !hasTrackingRows
                ? 'Sürat veriyi aldı ancak Gonderiler=[] ve ortak barkod/takip no dönmedi'
                : !hasSuratTrackingNumber
                  ? 'KargoTakipNo, BarkodNo veya TakipUrl takip no bulunamadı'
                  : match.reason
  const rawTrackingNumberSelection = selectTrackingNumber({
    serviceMode,
    operationalKargoTakipNo,
    createKargoTakipNo,
    suratKargoTakipNo,
    extractedKargoTakipNo: extracted.value,
    takipUrlTrackingSource: extracted.source,
    suratTakipNo,
    suratTNo,
    shipmentTrackingNumber: effectiveShipment?.trackingNumber,
    shipmentTrackingSource: effectiveShipment?.trackingSource,
  })
  const trackingNumberSelection = isMarketplaceIntegrationBarcode(
    rawTrackingNumberSelection.value,
    trendyolCargoTrackingNumber,
    OzelKargoTakipNo,
  )
    ? {
        value: '',
        source: rawTrackingNumberSelection.source
          ? `${rawTrackingNumberSelection.source}.blockedMarketplaceIntegrationCode`
          : '',
      }
    : rawTrackingNumberSelection
  const rawTNoSelection = selectTNo({
    operationalTNo: operationalKargoTakipNo,
    createTNo: firstNonEmpty(
      zplAnalysis.acceptedTNo,
      createLog?.codeMapping?.tNoValue,
      firstField(createSources, ['TNo', 'T.No', 'TNO']),
      effectiveShipment?.tNo,
      createKargoTakipNo,
    ),
    trackingTNo: suratTNo,
  })
  const tNoSelection = isMarketplaceIntegrationBarcode(
    rawTNoSelection.value,
    trendyolCargoTrackingNumber,
    OzelKargoTakipNo,
  )
    ? {
        value: '',
        source: rawTNoSelection.source
          ? `${rawTNoSelection.source}.blockedMarketplaceIntegrationCode`
          : '',
      }
    : rawTNoSelection
  const technicalZplReceived = Boolean(
    effectiveShipment?.technicalZplReceived ||
      effectiveShipment?.operationalBarcodeVerified ||
      effectiveShipment?.verifiedShipment ||
      createLog?.zplAnalysis?.hasBarcodeRaw ||
      barcodeRaw,
  )
  const operationalBarcodeVerified = Boolean(
    hasSuratShipment &&
      serdendipVerified &&
      hasTrackingQuery &&
      gonderilerLength > 0 &&
      !['SURAT_BARCODE_FAILED', 'FAILED'].includes(
        String(effectiveShipment?.lifecycleStatus ?? ''),
      ) &&
      effectiveShipment?.dispatchRegistrationConfirmed === true &&
      match.matched &&
      technicalZplReceived &&
      isAcceptedOperationalBarcode(effectiveOfficialBarcodeSelection.value) &&
      isNumericOperationalCode(effectiveOfficialBarcodeSelection.value) &&
      !isMarketplaceIntegrationBarcode(
        effectiveOfficialBarcodeSelection.value,
        trendyolCargoTrackingNumber,
        OzelKargoTakipNo,
      ) &&
      isOperationalTNo(tNoSelection.value) &&
      (effectiveShipment?.operationalBarcodeVerified === true ||
        effectiveShipment?.verifiedShipment === true),
  )
  const isLiveBarcodeReady = operationalBarcodeVerified
  const verifiedShipment = operationalBarcodeVerified
  const dispatchRejected = Boolean(
    effectiveShipment?.lifecycleStatus === 'SURAT_DISPATCH_REJECTED' ||
      effectiveShipment?.errorCategory ===
        'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS' ||
      createLog?.errorCategory === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  )
  const labelCreatedNotRegistered = Boolean(
    effectiveShipment?.lifecycleStatus === 'LABEL_CREATED_NOT_REGISTERED' ||
      effectiveShipment?.candidateVerificationStatus ===
        'LABEL_CREATED_NOT_REGISTERED' ||
      effectiveShipment?.errorCategory ===
        'SURAT_LABEL_CREATED_NOT_REGISTERED',
  )
  // Kanıt (17.07.2026): ön-atanmış T.No/barkod fiziksel tesellümde birebir
  // korunuyor; bu durum bir hata değil, kabul öncesi hazır etiket durumudur.
  const preassignedAwaitingAcceptance = Boolean(
    effectiveShipment?.printEnabled === true &&
      (effectiveShipment?.lifecycleStatus ===
        'LABEL_READY_AWAITING_ACCEPTANCE' ||
        effectiveShipment?.candidateVerificationStatus ===
          'PREASSIGNED_AWAITING_ACCEPTANCE'),
  )
  const preassignedTNo = preassignedAwaitingAcceptance
    ? firstNonEmpty(
        effectiveShipment?.tNo,
        effectiveShipment?.kargoTakipNo,
        effectiveShipment?.trackingNumber,
        effectiveShipment?.candidateTNo,
      )
    : ''
  const preassignedBarcode = preassignedAwaitingAcceptance
    ? firstNonEmpty(
        effectiveShipment?.barkodNo,
        effectiveShipment?.barcode,
        effectiveShipment?.barcodeValue,
        effectiveShipment?.candidateBarkodNo,
      )
    : ''
  const verificationStage: SuratVerificationStage =
    operationalBarcodeVerified
      ? 'serdendip_verified'
      : preassignedAwaitingAcceptance
        ? 'preassigned_awaiting_acceptance'
      : labelCreatedNotRegistered
        ? 'label_created_not_registered'
      : dispatchRejected
      ? 'dispatch_rejected'
      : technicalZplReceived
        ? 'zpl_received_but_not_operationally_verified'
        : hasSuratShipment
          ? 'dispatch_registered'
          : 'failed'
  const matchReason = operationalBarcodeVerified
    ? registeredMarketplaceBarcodeReady
      ? 'GonderiyiKargoyaGonder kaydı başarılı; Trendyol/Sürat cargoTrackingNumber barkodu doğrulandı'
      : 'Sürat numeric ana barkodu ve T.No operasyonel olarak doğrulandı'
    : preassignedAwaitingAcceptance
      ? 'Etiket hazır — fiziksel Sürat kabulü bekleniyor'
    : labelCreatedNotRegistered
      ? 'Etiket oluşturuldu ancak doğru WebSiparisKodu ile Serendip gönderi kaydı açılmadı.'
    : dispatchRejected
      ? 'Trendyol/Sürat bu paketin mevcut statüsünde gönderi oluşturulmasına izin vermiyor. Mapping doğru, fakat kargo uygun statüde değil.'
    : technicalZplReceived
      ? zplAnalysis.rejectionReason ||
        'Teknik ZPL alındı ancak operasyonel barkod doğrulanamadı'
      : legacyMatchReason

  return {
    verifiedShipment,
    hasSuratShipment,
    hasTrackingQuery,
    hasSuratTrackingNumber,
    matchReason,
    trendyolCargoTrackingNumber,
    suratKargoTakipNo,
    extractedKargoTakipNo: extracted.value,
    suratTakipUrl,
    takipUrlSource,
    takipUrlTrackingSource: extracted.source,
    shipmentReference,
    orderNumber,
    packageId,
    WebSiparisKodu,
    SatisKodu,
    OzelKargoTakipNo,
    Satiskodu: SatisKodu,
    trackingNumber: serdendipVerified
      ? trackingNumberSelection.value
      : preassignedTNo,
    trackingNumberSource: serdendipVerified
      ? trackingNumberSelection.source
      : preassignedTNo
        ? 'surat.create.preassignedTNo'
        : '',
    tNo: serdendipVerified ? tNoSelection.value : preassignedTNo,
    tNoSource: serdendipVerified
      ? tNoSelection.source
      : preassignedTNo
        ? 'surat.create.preassignedTNo'
        : '',
    gonderiNo: firstNonEmpty(
      firstField(allSources, ['GonderiNo', 'GönderiNo', 'GonderiKodu']),
      effectiveShipment?.gonderiNo,
    ),
    waybillNo: firstNonEmpty(
      firstField(allSources, ['waybillNo', 'WaybillNo', 'awb', 'awbNo']),
      effectiveShipment?.waybillNo,
    ),
    irsaliyeNo: firstNonEmpty(
      firstField(allSources, ['irsaliyeNo', 'IrsaliyeNo', 'IrsaliyeSiraNo']),
      effectiveShipment?.irsaliyeNo,
    ),
    cargoKey: firstNonEmpty(
      firstField(allSources, ['cargoKey', 'CargoKey', 'kargoKey', 'KargoKey']),
      effectiveShipment?.cargoKey,
    ),
    officialBarcodeValue: operationalBarcodeVerified
      ? effectiveOfficialBarcodeSelection.value
      : preassignedBarcode,
    officialBarcodeSource: operationalBarcodeVerified
      ? effectiveOfficialBarcodeSelection.source
      : preassignedBarcode
        ? 'surat.create.preassignedBarkod'
        : '',
    serviceMode,
    operationName,
    kargoTakipNo: serdendipVerified
      ? trackingNumberSelection.value
      : preassignedTNo,
    barcode: operationalBarcodeVerified
      ? effectiveOfficialBarcodeSelection.value
      : preassignedBarcode,
    barcodeRaw,
    barcodeSource: operationalBarcodeVerified
      ? effectiveOfficialBarcodeSelection.source
      : preassignedBarcode
        ? 'surat.create.preassignedBarkod'
        : '',
    zplSource: barcodeRaw
      ? 'surat.ortakBarkod.BarcodeRaw'
      : 'generated',
    isLiveBarcodeReady,
    technicalZplReceived,
    operationalBarcodeVerified,
    serdendipVerified,
    operationalPrintAllowed: operationalBarcodeVerified,
    technicalPrintAllowed: operationalBarcodeVerified,
    verificationStage,
    errorCategory:
      effectiveShipment?.errorCategory ??
      createLog?.errorCategory,
    finalSuratBarcode: operationalBarcodeVerified
      ? effectiveOfficialBarcodeSelection.value
      : '',
    internalWebBarcode:
      effectiveShipment?.internalWebBarcode ??
      zplAnalysis.internalWebBarcode,
    zplAnalysis,
    gonderilerLength,
  }
}

function resolveMatchReason({
  WebSiparisKodu,
  SatisKodu,
  OzelKargoTakipNo,
  packageId,
  cargoTrackingNumber,
}: {
  WebSiparisKodu: string
  SatisKodu: string
  OzelKargoTakipNo: string
  packageId: string
  cargoTrackingNumber: string
}): { matched: boolean; reason: string } {
  if (
    WebSiparisKodu &&
    cargoTrackingNumber &&
    WebSiparisKodu === cargoTrackingNumber
  ) {
    return {
      matched: true,
      reason: 'WebSiparisKodu == Trendyol cargoTrackingNumber',
    }
  }
  if (
    OzelKargoTakipNo &&
    cargoTrackingNumber &&
    OzelKargoTakipNo === cargoTrackingNumber
  ) {
    return {
      matched: true,
      reason: 'OzelKargoTakipNo == Trendyol cargoTrackingNumber',
    }
  }
  if (WebSiparisKodu && SatisKodu && WebSiparisKodu === SatisKodu) {
    return { matched: true, reason: 'WebSiparisKodu == SatisKodu' }
  }
  if (WebSiparisKodu && packageId && WebSiparisKodu === packageId) {
    return { matched: true, reason: 'WebSiparisKodu == packageId' }
  }
  if (OzelKargoTakipNo && packageId && OzelKargoTakipNo === packageId) {
    return { matched: true, reason: 'OzelKargoTakipNo == packageId' }
  }
  return { matched: false, reason: 'Sürat referansı eşleşmedi' }
}

function selectTrackingNumber({
  serviceMode,
  operationalKargoTakipNo,
  createKargoTakipNo,
  suratKargoTakipNo,
  extractedKargoTakipNo,
  takipUrlTrackingSource,
  suratTakipNo,
  suratTNo,
  shipmentTrackingNumber,
  shipmentTrackingSource,
}: {
  serviceMode?: SuratServiceMode
  operationalKargoTakipNo: string
  createKargoTakipNo: string
  suratKargoTakipNo: string
  extractedKargoTakipNo: string
  takipUrlTrackingSource: string
  suratTakipNo: string
  suratTNo: string
  shipmentTrackingNumber?: string
  shipmentTrackingSource?: string
}): { value: string; source: string } {
  if (operationalKargoTakipNo) {
    return {
      value: operationalKargoTakipNo,
      source: 'surat.KargoBarkodu.KargoTakipNo',
    }
  }
  if (serviceMode === 'ORTAK_BARKOD_SOAP' && createKargoTakipNo) {
    return {
      value: createKargoTakipNo,
      source: 'surat.ortakBarkod.KargoTakipNo',
    }
  }
  if (suratKargoTakipNo) {
    return { value: suratKargoTakipNo, source: 'surat.track.KargoTakipNo' }
  }
  if (extractedKargoTakipNo) {
    return {
      value: extractedKargoTakipNo,
      source: takipUrlTrackingSource || 'surat.track.TakipUrl',
    }
  }
  if (suratTakipNo) {
    return { value: suratTakipNo, source: 'surat.track.TakipNo' }
  }
  if (suratTNo) {
    return { value: suratTNo, source: 'surat.track.TNo' }
  }
  const trackingNumber = String(shipmentTrackingNumber ?? '').trim()
  const source = String(shipmentTrackingSource ?? '').trim()
  if (
    trackingNumber &&
    source.startsWith('surat.response.')
  ) {
    return { value: trackingNumber, source }
  }
  return { value: '', source: '' }
}

function selectTNo({
  operationalTNo,
  createTNo,
  trackingTNo,
}: {
  operationalTNo: string
  createTNo: string
  trackingTNo: string
}): { value: string; source: string } {
  if (isOperationalTNo(operationalTNo)) {
    return {
      value: operationalTNo,
      source: 'surat.KargoBarkodu.KargoTakipNo',
    }
  }
  if (isOperationalTNo(createTNo)) {
    return { value: createTNo, source: 'surat.create.TNo' }
  }
  if (isOperationalTNo(trackingTNo)) {
    return { value: trackingTNo, source: 'surat.track.TNo' }
  }
  return { value: '', source: '' }
}

function isOperationalTNo(value: string): boolean {
  const text = String(value ?? '').trim()
  return (
    isNumericOperationalCode(text) ||
    /^TNO[-\s]?\d{8,20}$/i.test(text)
  )
}

function isAcceptedOperationalBarcode(value: string): boolean {
  const text = String(value ?? '').trim()
  return isNumericOperationalCode(text)
}

function isMarketplaceIntegrationBarcode(
  value: string,
  trendyolCargoTrackingNumber: string,
  ozelKargoTakipNo: string,
): boolean {
  const text = String(value ?? '').trim()
  if (!text) return false
  return Boolean(
    text === String(trendyolCargoTrackingNumber ?? '').trim() ||
      text === String(ozelKargoTakipNo ?? '').trim() ||
      /^727\d{10,}$/.test(text),
  )
}

function selectOfficialBarcode({
  serviceMode,
  operationalBarkodNo,
  createBarcode,
  zplBarcode,
  suratKargoTakipNo,
  suratBarkodNo,
  suratBarkod,
  extractedKargoTakipNo,
  takipUrlTrackingSource,
}: {
  serviceMode?: SuratServiceMode
  operationalBarkodNo: string
  createBarcode: string
  zplBarcode: string
  suratKargoTakipNo: string
  suratBarkodNo: string
  suratBarkod: string
  extractedKargoTakipNo: string
  takipUrlTrackingSource: string
}): { value: string; source: string } {
  if (isNumericOperationalCode(operationalBarkodNo)) {
    return {
      value: operationalBarkodNo,
      source: 'surat.KargoBarkodu.BarkodNo',
    }
  }
  if (isAcceptedOperationalBarcode(zplBarcode)) {
    return {
      value: zplBarcode,
      source: 'surat.ortakBarkod.BarcodeRaw.mainCode128',
    }
  }
  if (
    serviceMode === 'ORTAK_BARKOD_SOAP' &&
    isNumericOperationalCode(createBarcode)
  ) {
    return {
      value: createBarcode,
      source: 'surat.ortakBarkod.Barcode',
    }
  }
  if (isNumericOperationalCode(suratBarkodNo)) {
    return { value: suratBarkodNo, source: 'surat.track.BarkodNo' }
  }
  if (isNumericOperationalCode(suratBarkod)) {
    return { value: suratBarkod, source: 'surat.track.Barkod' }
  }
  void suratKargoTakipNo
  void extractedKargoTakipNo
  void takipUrlTrackingSource
  return { value: '', source: '' }
}

function firstField(sources: unknown[], keys: string[]): string {
  for (const source of sources) {
    const found = readString(source, keys)
    if (found) return found
  }
  return ''
}

function readString(value: unknown, keys: string[]): string {
  const found = readUnknown(value, keys)
  if (found == null) return ''
  if (typeof found === 'object') return JSON.stringify(found)
  return String(found).trim()
}

function readUnknown(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readUnknown(item, keys)
      if (found != null && found !== '') return found
    }
    return undefined
  }

  const normalizedKeys = keys.map((key) => key.toLocaleLowerCase('tr-TR'))
  for (const [key, item] of Object.entries(value)) {
    if (
      normalizedKeys.includes(key.toLocaleLowerCase('tr-TR')) &&
      item != null
    ) {
      return item
    }
    const nested = readUnknown(item, keys)
    if (nested != null && nested !== '') return nested
  }

  return undefined
}

function firstObject(...values: unknown[]): unknown {
  return values.find(
    (value) => value && typeof value === 'object' && !Array.isArray(value),
  )
}

function firstNonEmpty(...values: unknown[]): string {
  return values
    .map((value) => String(value ?? '').trim())
    .find(Boolean) ?? ''
}

function serviceModeFromType(
  serviceType?: string,
): SuratServiceMode | undefined {
  if (serviceType === 'KargoBarkoduSiparisSoap') {
    return 'KARGO_BARKODU_SIPARIS_SOAP'
  }
  if (
    serviceType === 'OrtakBarkodOlusturSoap' ||
    serviceType ===
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap'
  ) {
    return 'ORTAK_BARKOD_SOAP'
  }
  if (serviceType === 'GonderiyiKargoyaGonderRestJson') {
    return 'PRE_REGISTRATION_REST'
  }
  if (serviceType === 'GonderiyiKargoyaGonderYeniSoap') {
    return 'GONDERI_YENI_SOAP'
  }
  if (serviceType === 'GonderiOlusturV2') {
    return 'GONDERI_OLUSTUR_V2_EXPERIMENTAL'
  }
  return undefined
}
