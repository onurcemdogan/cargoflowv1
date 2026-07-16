import type {
  CargoOrder,
  Label,
  LabelTemplate,
  Shipment,
} from '../../types/cargoflow'
import { apiDebugService } from '../../services/apiDebugService'
import { createId } from '../../utils/ids'
import { resolveSuratBarcodeRawZpl } from '../../utils/zpl'
import { ZebraZplLabelProvider } from '../labels/ZebraZplLabelProvider'
import type {
  CreateShipmentInput,
  ShippingProvider,
  TrackShipmentInput,
  TrackShipmentResponse,
  TrackingResult,
} from './ShippingProvider'

export class SuratKargoProvider implements ShippingProvider {
  private readonly labelProvider = new ZebraZplLabelProvider()

  async createShipment(input: CreateShipmentInput): Promise<Shipment> {
    const startedAt = performance.now()
    const reference = String(input.order.packageId || input.order.orderNumber)
    const marketplaceOrderNumber = String(input.order.orderNumber)
    const marketplaceIntegrationCode = String(
      input.order.cargoTrackingNumber ?? '',
    ).trim()
    const shipmentId = createId('shp')

    try {
      const response = await fetch('/api/shipments/surat/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: input.order,
          config: input.config,
        }),
      })
      const data = await response.json()
      const createLog = data.shipment?.suratCreateLog ?? data.suratCreateLog
      const operationalBarcodeLog =
        data.shipment?.suratOperationalBarcodeLog ??
        data.operationalBarcodeResolution
      const barcodeRaw = resolveSuratBarcodeRawZpl(
        data.shipment?.barcodeRaw,
        createLog?.BarcodeRaw,
        createLog?.parsedResponse?.BarcodeRaw,
      )
      const verifiedPrintReady = Boolean(
        data.shipment?.verifiedShipment &&
          data.shipment?.operationalBarcodeVerified &&
          data.shipment?.printEnabled,
      )
      const createResponseStatus = Number(
        createLog?.responseStatus ?? response.status,
      )
      const createLogFailed = Boolean(
        !response.ok ||
          data?.ok === false ||
          (createResponseStatus >= 400 && !verifiedPrintReady) ||
          data.shipment?.labelStatus === 'BLOCKED',
      )
      if (data.dispatchRegistration) {
        apiDebugService.append({
          provider: 'Sürat',
          operation: 'Gerçek Gönderi Kaydı',
          button: 'Sürat Gönderisi Oluştur',
          buttonName: 'Sürat Gönderisi Oluştur',
          providerMethod: 'GonderiyiKargoyaGonder',
          endpoint:
            data.dispatchRegistration.endpoint ??
            '/api/GonderiyiKargoyaGonder',
          requestUrl: '/api/shipments/surat/create',
          requestHeaders: { 'Content-Type': 'application/json' },
          requestBody: data.dispatchRegistration.rawRequest,
          responseStatus: Number(
            data.dispatchRegistration.responseStatus ?? response.status,
          ),
          responseBody: data.dispatchRegistration.rawResponse,
          rawResponse: data.dispatchRegistration.rawResponse,
          status: data.dispatchRegistration.ok ? 'SUCCESS' : 'ERROR',
          durationMs: Math.round(performance.now() - startedAt),
          orderNumber: input.order.orderNumber,
          shipmentId,
          fields: {
            serviceType: data.dispatchRegistration.serviceType,
            responseCode: data.dispatchRegistration.responseCode,
            responseMessage: data.dispatchRegistration.responseMessage,
            duplicateShipment:
              data.dispatchRegistration.duplicateShipment,
            providerRegistrationConfirmed:
              data.dispatchRegistration.ok,
          },
          errorMessage: data.dispatchRegistration.ok
            ? undefined
            : data.message,
          errorSource: data.dispatchRegistration.ok
            ? undefined
            : 'Sürat',
        })
      }
      apiDebugService.append({
        provider: 'Sürat',
        operation: 'Ortak Barkod Oluştur',
        button: 'Sürat Gönderisi Oluştur',
        buttonName: 'Sürat Gönderisi Oluştur',
        providerMethod:
          data.providerMethod ?? 'SuratKargoProvider.createShipment',
        endpoint:
          data.endpoint ??
          input.config.surat.createShipmentPath,
        requestUrl: '/api/shipments/surat/create',
        requestHeaders: { 'Content-Type': 'application/json' },
        requestBody: createLog?.rawRequest ?? {
          orderNumber: input.order.orderNumber,
          packageId: input.order.packageId,
          SatisKodu: marketplaceOrderNumber,
          WebSiparisKodu: marketplaceOrderNumber,
          OzelKargoTakipNo: marketplaceIntegrationCode,
          ReferansNo: marketplaceIntegrationCode || reference,
          MarketplaceIntegrationCode: marketplaceIntegrationCode,
        },
        responseStatus: createResponseStatus,
        responseBody: createLog?.rawResponse ?? data,
        rawResponse: createLog?.rawResponse ?? data,
        status: createLogFailed ? 'ERROR' : 'SUCCESS',
        durationMs: Math.round(performance.now() - startedAt),
        orderNumber: input.order.orderNumber,
        shipmentId,
        fields: {
          CariKod: input.config.surat.kullaniciAdi,
          FirmaId: input.config.surat.firmaId,
          SatisKodu:
            data.requestFieldMapping?.SatisKodu ??
            marketplaceOrderNumber,
          WebSiparisKodu:
            data.requestFieldMapping?.WebSiparisKodu ??
            marketplaceOrderNumber,
          OzelKargoTakipNo:
            data.requestFieldMapping?.OzelKargoTakipNo ??
            marketplaceIntegrationCode,
          MarketplaceIntegrationCode:
            data.requestFieldMapping?.MarketplaceIntegrationCode ??
            marketplaceIntegrationCode,
          requestFieldMapping: data.requestFieldMapping,
          serviceType:
            data.serviceType ?? input.config.surat.serviceType,
          serviceMode:
            data.serviceMode ?? createLog?.serviceMode,
          operationName:
            data.operationName ?? createLog?.operationName,
          payloadFormat: data.payloadFormat,
          responseCode:
            createLog?.responseCode ?? data.createDiagnostics?.code,
          barcodeResponseCodeDetected:
            createLog?.barcodeResponseCodeDetected ??
            data.createDiagnostics?.barcodeResponseCodeDetected,
          createResponseHasTrackingNumber:
            createLog?.hasTrackingNumber ??
            data.createDiagnostics?.hasTrackingNumber,
          preRegistrationOnly:
            createLog?.preRegistrationOnly ??
            data.createDiagnostics?.preRegistrationOnly,
          duplicateShipment:
            createLog?.duplicateShipment ??
            data.createDiagnostics?.duplicateShipment,
          noTrackingReason:
            createLog?.noTrackingReason ??
            data.createDiagnostics?.noTrackingReason,
          codeCandidates:
            createLog?.codeCandidates ??
            data.createDiagnostics?.codeCandidates,
          codeMapping:
            createLog?.codeMapping ??
            data.createDiagnostics?.codeMapping,
          requestValidation:
            createLog?.requestValidation ??
            data.shipment?.requestValidation,
          trendyolPreflight:
            createLog?.trendyolPreflight ??
            data.shipment?.trendyolPreflight,
          addressNormalization:
            createLog?.addressNormalization ??
            data.shipment?.addressNormalization,
          verificationStage:
            data.shipment?.verificationStage ??
            createLog?.verificationStage,
          technicalZplReceived:
            data.shipment?.technicalZplReceived,
          operationalBarcodeVerified:
            data.shipment?.operationalBarcodeVerified,
          zplAnalysis:
            data.shipment?.zplAnalysis ??
            createLog?.zplAnalysis,
          errorCategory:
            data.shipment?.errorCategory ??
            createLog?.errorCategory,
          Pazaryerimi: data.requestFieldMapping?.Pazaryerimi,
          EntegrasyonFirmasi:
            data.requestFieldMapping?.EntegrasyonFirmasi,
          ReferansNo: data.requestFieldMapping?.ReferansNo,
          TakipNo: data.shipment?.trackingNumber,
          KargoTakipNo: createLog?.parsedResponse?.KargoTakipNo,
          Barcode:
            createLog?.parsedResponse?.Barcode ??
            createLog?.Barcode,
          BarcodeRaw: barcodeRaw,
          zplSource: barcodeRaw
            ? 'surat.ortakBarkod.BarcodeRaw'
            : 'generated',
          verifiedShipment:
            data.shipment?.verifiedShipment ??
            createLog?.verifiedShipment,
          barcodeSource:
            data.shipment?.barcodeSource ??
            createLog?.barcodeSource,
          trackingSource:
            data.shipment?.trackingSource ??
            createLog?.trackingSource,
          rawRequestIncludesOrtakBarkodOlustur:
            createLog?.rawRequestIncludesOrtakBarkodOlustur,
          rawRequestIncludesGonderiyiKargoyaGonder:
            createLog?.rawRequestIncludesGonderiyiKargoyaGonder,
          rawRequestContainsExpectedOperation:
            createLog?.rawRequestContainsExpectedOperation,
          rawRequestContainsLegacyOperation:
            createLog?.rawRequestContainsLegacyOperation,
          wrongServiceCalled: createLog?.wrongServiceCalled,
          dispatchRegistrationConfirmed:
            data.shipment?.dispatchRegistrationConfirmed ??
            data.dispatchRegistration?.ok,
          dispatchRegistration: data.dispatchRegistration,
          barcodeCreation: data.barcodeCreation,
          TakipUrl: data.shipment?.trackingUrl,
          parsedResponse: createLog?.parsedResponse,
        },
        errorMessage: createLogFailed ? data.message : undefined,
        errorSource:
          createLogFailed
            ? (data.errorSource ?? 'Sürat')
            : undefined,
      })
      if (
        (!response.ok || data?.ok === false) &&
        !['SURAT_BARCODE_FAILED', 'SURAT_DISPATCH_REJECTED'].includes(
          String(data?.shipment?.lifecycleStatus ?? ''),
        )
      ) {
        throw new Error(data.message ?? 'Sürat gönderisi oluşturulamadı.')
      }
      if (data?.shipment) {
        return {
          id: shipmentId,
          provider: 'surat-kargo',
          trackingNumber: data.shipment.trackingNumber ?? '',
          trackingUrl: data.shipment.trackingUrl,
          shipmentCode: data.shipment.shipmentCode,
          satisKodu: data.shipment.satisKodu ?? reference,
          webSiparisKodu: data.shipment.webSiparisKodu ?? reference,
          ozelKargoTakipNo: data.shipment.ozelKargoTakipNo ?? reference,
          shipmentReference:
            data.shipment.shipmentReference ?? reference,
          barcodeValue:
            data.shipment.barcodeValue ?? '',
          desi: data.shipment.desi ?? input.order.desi ?? null,
          desiSource:
            input.order.desiSource ?? data.shipment.desiSource ?? null,
          weightKg:
            data.shipment.weightKg ?? input.order.weightKg ?? null,
          packageCount: input.order.packageCount ?? 1,
          apiRequestDesi:
            data.shipment.apiRequestDesi ?? input.order.desi ?? null,
          apiResponseDesi: data.shipment.apiResponseDesi ?? null,
          dispatchRegistrationConfirmed:
            data.shipment.dispatchRegistrationConfirmed ??
            data.dispatchRegistration?.ok,
          dispatchRegistration:
            data.shipment.dispatchRegistration ??
            data.dispatchRegistration,
          barcodeSource: data.shipment.barcodeSource,
          serviceMode:
            data.shipment.serviceMode ??
            data.serviceMode ??
            createLog?.serviceMode,
          operationName:
            data.shipment.operationName ??
            data.operationName ??
            createLog?.operationName,
          kargoTakipNo:
            data.shipment.kargoTakipNo ??
            operationalBarcodeLog?.KargoTakipNo ??
            createLog?.KargoTakipNo,
          tNo:
            data.shipment.tNo ??
            operationalBarcodeLog?.KargoTakipNo ??
            createLog?.codeMapping?.tNoValue,
          barcode:
            data.shipment.barcode ??
            operationalBarcodeLog?.BarkodNo ??
            createLog?.Barcode ??
            createLog?.parsedResponse?.Barcode,
          barkodNo:
            data.shipment.barkodNo ??
            operationalBarcodeLog?.BarkodNo ??
            createLog?.codeCandidates?.barkodNo,
          gonderiNo:
            data.shipment.gonderiNo ??
            createLog?.codeCandidates?.gonderiNo,
          waybillNo:
            data.shipment.waybillNo ??
            createLog?.codeCandidates?.waybillNo,
          irsaliyeNo:
            data.shipment.irsaliyeNo ??
            createLog?.codeCandidates?.irsaliyeNo,
          cargoKey:
            data.shipment.cargoKey ??
            createLog?.codeCandidates?.cargoKey,
          codeCandidates:
            data.shipment.codeCandidates ??
            createLog?.codeCandidates,
          codeMapping:
            data.shipment.codeMapping ??
            createLog?.codeMapping,
          verificationStage:
            data.shipment.verificationStage ??
            createLog?.verificationStage,
          errorCategory:
            data.shipment.errorCategory ??
            createLog?.errorCategory,
          technicalZplReceived:
            data.shipment.technicalZplReceived ??
            Boolean(barcodeRaw),
          operationalBarcodeVerified:
            data.shipment.operationalBarcodeVerified ??
            data.shipment.verifiedShipment ??
            createLog?.verifiedShipment,
          finalSuratBarcode:
            data.shipment.finalSuratBarcode ??
            operationalBarcodeLog?.BarkodNo ??
            data.shipment.zplAnalysis?.acceptedFinalBarcode,
          internalWebBarcode:
            data.shipment.internalWebBarcode ??
            data.shipment.zplAnalysis?.internalWebBarcode,
          zplAnalysis:
            data.shipment.zplAnalysis ??
            createLog?.zplAnalysis,
          requestValidation:
            data.shipment.requestValidation ??
            createLog?.requestValidation,
          trendyolPreflight:
            data.shipment.trendyolPreflight ??
            createLog?.trendyolPreflight,
          addressNormalization:
            data.shipment.addressNormalization ??
            createLog?.addressNormalization,
          barcodeRaw,
          zplSource:
            data.shipment.zplSource ??
            (barcodeRaw
              ? 'surat.ortakBarkod.BarcodeRaw'
              : 'generated'),
          trackingSource:
            data.shipment.trackingSource ??
            createLog?.trackingSource,
          labelStatus: data.shipment.labelStatus,
          shipmentStatus: data.shipment.shipmentStatus,
          suratVerificationStatus:
            data.shipment.suratVerificationStatus,
          zplReady: data.shipment.zplReady,
          printEnabled: data.shipment.printEnabled,
          matchStatus: data.shipment.matchStatus,
          statusComputedFrom: data.shipment.statusComputedFrom,
          previousStatus: data.shipment.previousStatus,
          newStatus: data.shipment.newStatus,
          previousErrorCleared: data.shipment.previousErrorCleared,
          tabBucket: data.shipment.tabBucket,
          noTrackingReason: data.shipment.noTrackingReason,
          labelBlockedReason: data.shipment.labelBlockedReason,
          zplDisabledReason: data.shipment.zplDisabledReason,
          status: data.shipment.status ?? 'created',
          lifecycleStatus:
            data.shipment.lifecycleStatus ?? 'SHIPMENT_CREATED',
          source: data.source ?? 'real',
          rawResponse: data.shipment.rawResponse ?? data,
          rawSuratCreateResponse:
            data.shipment.rawSuratCreateResponse ??
            data.shipment.suratCreateLog?.rawResponse ??
            data.suratCreateLog?.rawResponse,
          suratCreateLog:
            data.shipment.suratCreateLog ?? data.suratCreateLog,
          suratTrackingLog:
            data.shipment.suratTrackingLog ?? data.suratTrackingLog,
          suratOperationalBarcodeLog: operationalBarcodeLog,
          verifiedShipment:
            data.shipment.verifiedShipment ??
            createLog?.verifiedShipment,
          diagnosticMessage:
            data.shipment.diagnosticMessage ??
            data.createDiagnostics?.noTrackingReason,
          createdAt: new Date().toISOString(),
        }
      }
      throw new Error('Sürat API yanıtında shipment bilgisi bulunamadı.')
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) {
        apiDebugService.append({
          provider: 'Sürat',
          operation: 'Gönderi Oluştur',
          button: 'Sürat Gönderisi Oluştur',
          buttonName: 'Sürat Gönderisi Oluştur',
          providerMethod: 'SuratKargoProvider.createShipment',
          endpoint: input.config.surat.createShipmentPath,
          requestUrl: '/api/shipments/surat/create',
          requestBody: {
            orderNumber: input.order.orderNumber,
            packageId: input.order.packageId,
            SatisKodu: marketplaceOrderNumber,
            WebSiparisKodu: marketplaceOrderNumber,
            OzelKargoTakipNo: marketplaceIntegrationCode,
            ReferansNo: marketplaceIntegrationCode || reference,
            MarketplaceIntegrationCode: marketplaceIntegrationCode,
          },
          responseStatus: 0,
          responseBody: error.message,
          rawResponse: error.message,
          status: 'ERROR',
          durationMs: Math.round(performance.now() - startedAt),
          orderNumber: input.order.orderNumber,
          shipmentId,
          errorMessage: error.message,
          errorSource: 'Frontend',
        })
      }
      if (error instanceof Error && !error.message.includes('Failed to fetch')) {
        throw error
      }
      throw new Error(
        'CargoFlow API proxy erişilemedi. Sürat gönderisi oluşturulamadı.',
        { cause: error },
      )
    }
  }

  async trackShipment(
    input: TrackShipmentInput,
  ): Promise<TrackShipmentResponse> {
    const startedAt = performance.now()
    const { order, shipment, config } = input
    const trackingReferences = Array.from(
      new Set(
        [
          order.cargoTrackingNumber,
          shipment.ozelKargoTakipNo,
          shipment.internalWebBarcode,
          shipment.zplAnalysis?.internalWebBarcode,
          ...(shipment.zplAnalysis?.dataMatrixCandidates ?? []),
          order.orderNumber,
          order.packageId,
          order.shipmentPackageId,
          shipment.shipmentReference,
          shipment.satisKodu,
          shipment.kargoTakipNo,
          shipment.trackingNumber,
          shipment.webSiparisKodu,
        ]
          .map((value) => String(value ?? '').trim())
          .filter(Boolean),
      ),
    )
    const trackingReference = trackingReferences[0] || order.orderNumber

    try {
      const response = await fetch('/api/shipments/surat/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: config.surat,
          webSiparisKodu: trackingReference,
          webSiparisKoduCandidates: trackingReferences,
          orderId: order.id,
          shipmentId: shipment.id,
        }),
      })
      const data = await response.json()
      const resolvedTrackingReference =
        data.trackingReference || trackingReference
      const trackingLog = data.suratTrackingLog

      apiDebugService.append({
        provider: 'Sürat',
        operation: 'Takip Sorgula',
        button: 'Takip Sorgula',
        buttonName: 'Takip Sorgula',
        providerMethod:
          data.providerMethod ?? 'SuratKargoProvider.trackShipment',
        endpoint: data.endpoint ?? 'KargoTakipHareketDetayi',
        requestUrl: '/api/shipments/surat/track',
        requestHeaders: { 'Content-Type': 'application/json' },
        requestBody: trackingLog?.rawRequest ??
          data.rawRequest ?? {
            CariKodu: config.surat.kullaniciAdi,
            WebSiparisKodu: trackingReference,
          },
        responseStatus: Number(
          trackingLog?.responseStatus ?? data.statusCode ?? response.status,
        ),
        responseBody: trackingLog?.rawResponse ?? data.rawResponse ?? data,
        rawResponse: trackingLog?.rawResponse ?? data.rawResponse ?? data,
        status: !response.ok || data.ok === false ? 'ERROR' : 'SUCCESS',
        durationMs: Math.round(performance.now() - startedAt),
        orderNumber: order.orderNumber,
        shipmentId: shipment.id,
        fields: {
          CariKod: config.surat.kullaniciAdi,
          FirmaId: config.surat.firmaId,
          serviceType:
            data.serviceType ?? config.surat.trackingServiceType,
          payloadFormat: data.payloadFormat,
          SatisKodu: trackingLog?.SatisKodu ?? trackingLog?.Satiskodu,
          WebSiparisKodu:
            trackingLog?.WebSiparisKodu ?? trackingReference,
          TakipNo: trackingLog?.TakipNo,
          KargoTakipNo: trackingLog?.KargoTakipNo,
          extractedKargoTakipNo:
            trackingLog?.extractedKargoTakipNo ??
            trackingLog?.TakipUrlTrackingNo,
          TakipUrl: trackingLog?.TakipUrl,
          KargonunDurumu: trackingLog?.KargonunDurumu,
          KargonunDurumuSayi: trackingLog?.KargonunDurumuSayi,
          KargonunBulunduguYer: trackingLog?.KargonunBulunduguYer,
          SonHareketTarihi: trackingLog?.SonHareketTarihi,
          TeslimatSubesi: trackingLog?.TeslimatSubesi,
          TeslimatSubeTel: trackingLog?.TeslimatSubeTel,
          IadeDurum: trackingLog?.IadeDurum,
          DevirDurum: trackingLog?.DevirDurum,
          carrierStatusKey: trackingLog?.carrierStatusKey,
          carrierStatusLabel: trackingLog?.carrierStatusLabel,
          KargoObjId: trackingLog?.KargoObjId,
          SeriNo: trackingLog?.SeriNo,
          SiraNo: trackingLog?.SiraNo,
          Hareketler: trackingLog?.Hareketler,
          GonderilerLength:
            data.gonderilerLength ?? trackingLog?.gonderilerLength,
          trackingState:
            data.trackingState ?? trackingLog?.trackingState,
          trackingAttempts: data.trackingAttempts,
        },
        errorMessage:
          !response.ok || data.ok === false ? data.message : undefined,
        errorSource:
          !response.ok || data.ok === false
            ? (data.errorSource ?? 'Sürat')
            : undefined,
      })

      if (!response.ok || data.ok === false) {
        throw new Error(data.message ?? 'Sürat takip sorgusu başarısız.')
      }

      return {
        trackingReference: resolvedTrackingReference,
        responseStatus: response.status,
        data,
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) {
        apiDebugService.append({
          provider: 'Sürat',
          operation: 'Takip Sorgula',
          button: 'Takip Sorgula',
          buttonName: 'Takip Sorgula',
          providerMethod: 'SuratKargoProvider.trackShipment',
          endpoint: 'KargoTakipHareketDetayi',
          requestUrl: '/api/shipments/surat/track',
          requestBody: {
            CariKodu: config.surat.kullaniciAdi,
            WebSiparisKodu: trackingReference,
          },
          responseStatus: 0,
          responseBody: error.message,
          rawResponse: error.message,
          status: 'ERROR',
          durationMs: Math.round(performance.now() - startedAt),
          orderNumber: order.orderNumber,
          shipmentId: shipment.id,
          errorMessage: error.message,
          errorSource: 'Frontend',
        })
      }
      if (error instanceof Error && !error.message.includes('Failed to fetch')) {
        throw error
      }
      throw new Error(
        'CargoFlow API proxy erişilemedi. Sürat takip sorgusu yapılamadı.',
        { cause: error },
      )
    }
  }

  async getTracking(trackingNumber: string): Promise<TrackingResult> {
    throw new Error(
      `${trackingNumber} için takip sorgusu gerçek KargoTakipHareketDetayi akışından yapılmalıdır.`,
    )
  }

  async cancelShipment(shipment: Shipment): Promise<Shipment> {
    throw new Error(
      `${shipment.shipmentCode} için Sürat iptal endpointi henüz yapılandırılmadı.`,
    )
  }

  async generateLabel(
    order: CargoOrder,
    shipment: Shipment,
    template: LabelTemplate,
  ): Promise<Label> {
    return this.labelProvider.generateSingle({ order, shipment, template })
  }
}
