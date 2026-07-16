import { Bug, Download, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import type { ApiDebugLog, ApiDebugProvider, CargoOrder } from '../types/cargoflow'
import { formatDebugDateTime } from '../utils/formatters'
import { verifySuratShipment } from '../utils/suratVerification'

interface IntegrationDebugPageProps {
  logs: ApiDebugLog[]
  orders: CargoOrder[]
  onClear: () => void
}

export function IntegrationDebugPage({
  logs,
  orders,
  onClear,
}: IntegrationDebugPageProps) {
  const [provider, setProvider] = useState<'all' | ApiDebugProvider>('all')
  const filteredLogs =
    provider === 'all' ? logs : logs.filter((log) => log.provider === provider)
  const latestTrendyol = logs.find(
    (log) =>
      log.provider === 'Trendyol' &&
      log.operation.startsWith('Get Orders') &&
      log.status === 'SUCCESS',
  )
  const latestSurat = logs.find(
    (log) =>
      log.provider === 'Sürat' &&
      log.operation === 'Takip Sorgula' &&
      log.status === 'SUCCESS',
  )
  const shipmentResults = useMemo(
    () =>
      orders
        .filter((order) => order.shipment)
        .map((order) => ({ order, verification: verifySuratShipment(order) })),
    [orders],
  )
  const verifiedCount = shipmentResults.filter(
    (item) => item.verification.verifiedShipment,
  ).length
  const unmatchedCount = shipmentResults.length - verifiedCount
  const errors = orders
    .filter(
      (order) =>
        Boolean(order.errorMessage) ||
        Boolean(order.shipment && !verifySuratShipment(order).verifiedShipment),
    )
    .map((order) => ({ order, verification: verifySuratShipment(order) }))

  return (
    <>
      <PageHeader
        title="Entegrasyon Debug Merkezi"
        description="Trendyol ve Sürat API çağrılarını, alan eşleşmelerini ve baskı engellerini incele."
        actions={
          <button
            type="button"
            className="secondary-button danger"
            onClick={onClear}
            disabled={logs.length === 0}
          >
            <Trash2 size={18} />
            Debug Kayıtlarını Temizle
          </button>
        }
      />

      <section className="debug-summary-grid">
        <article className="panel">
          <div className="panel-heading">
            <h2>Trendyol</h2>
            <Bug size={18} />
          </div>
          <div className="summary-list">
            <Summary
              label="Son başarılı senkronizasyon"
              value={
                latestTrendyol ? formatDebugDateTime(latestTrendyol.timestamp) : 'Kayıt yok'
              }
            />
            <Summary label="Sipariş sayısı" value={`${orders.length} sipariş çekildi`} />
            <Summary
              label="Son endpoint"
              value={latestTrendyol?.endpoint || '-'}
            />
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <h2>Sürat</h2>
            <Bug size={18} />
          </div>
          <div className="summary-list">
            <Summary
              label="Son başarılı sorgu"
              value={
                latestSurat ? formatDebugDateTime(latestSurat.timestamp) : 'Kayıt yok'
              }
            />
            <Summary label="Doğrulanan" value={`${verifiedCount} gönderi doğrulandı`} />
            <Summary label="Eşleşmeyen" value={`${unmatchedCount} gönderi eşleşmedi`} />
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Sürat Ortak Barkod Tanı</h2>
          <span>{shipmentResults.length} gönderi</span>
        </div>
        <div className="debug-call-list">
          {shipmentResults.map(({ order, verification }) => {
            const createLog = order.shipment?.suratCreateLog
            const trackingLog = order.shipment?.suratTrackingLog
            const marketplaceIntegrationCode =
              verification.trendyolCargoTrackingNumber ||
              order.cargoTrackingNumber ||
              ''
            const preflight =
              order.shipment?.trendyolPreflight ??
              createLog?.trendyolPreflight
            const statusRejected =
              verification.errorCategory ===
                'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS' ||
              order.shipment?.lifecycleStatus === 'SURAT_DISPATCH_REJECTED'
            return (
              <details key={order.id} className="debug-call-item">
                <summary>
                  <strong>{order.orderNumber}</strong>
                  <span>{order.operationStatus}</span>
                  <b
                    className={
                      verification.verifiedShipment ? 'debug-ok' : 'debug-fail'
                    }
                  >
                    {verification.verifiedShipment
                      ? 'DOĞRULANDI'
                      : verification.technicalZplReceived
                        ? 'TEKNİK ZPL'
                      : 'BARKOD BEKLİYOR'}
                  </b>
                </summary>
                <div className="debug-call-detail">
                  <div className="summary-list">
                    <Summary
                      label="Doğrulama aşaması"
                      value={verification.verificationStage}
                    />
                    <Summary
                      label="Final Sürat barkodu"
                      value={
                        verification.finalSuratBarcode ||
                        'Bulunamadı / doğrulanmadı'
                      }
                    />
                    <Summary
                      label="MarketplaceIntegrationCode"
                      value={marketplaceIntegrationCode || '-'}
                    />
                    <Summary
                      label="Dahili Web barkodu"
                      value={verification.internalWebBarcode || '-'}
                    />
                    <Summary
                      label="T.No"
                      value={verification.tNo || '-'}
                    />
                    <Summary
                      label="Operasyonel baskı"
                      value={
                        verification.operationalPrintAllowed
                          ? 'İzinli'
                          : 'Engelli'
                      }
                    />
                    <Summary
                      label="KargoTakipNo"
                      value={verification.suratKargoTakipNo ? 'VAR' : 'YOK'}
                    />
                    <Summary
                      label="T.No var mı"
                      value={verification.tNo ? 'VAR' : 'YOK'}
                    />
                    <Summary
                      label="Numeric Ana Barkod"
                      value={verification.finalSuratBarcode ? 'VAR' : 'YOK'}
                    />
                    <Summary
                      label="Web Barkod"
                      value={verification.internalWebBarcode ? 'VAR' : 'YOK'}
                    />
                    <Summary
                      label="cargoTrackingNumber"
                      value={
                        verification.trendyolCargoTrackingNumber
                          ? 'VAR'
                          : 'YOK'
                      }
                    />
                    <Summary
                      label="Operasyonel Etiket Basılabilir"
                      value={
                        verification.operationalPrintAllowed ? 'EVET' : 'HAYIR'
                      }
                    />
                    {statusRejected ? (
                      <>
                        <Summary label="Mapping" value="OK" />
                        <Summary label="Sürat response" value="REJECTED" />
                        <Summary label="Error code" value="1002" />
                        <Summary
                          label="Hata nedeni"
                          value="Kargo uygun statüde değil"
                        />
                        <Summary label="ZPL" value="YOK" />
                        <Summary label="Yazdırılabilir" value="HAYIR" />
                      </>
                    ) : null}
                  </div>
                  {marketplaceIntegrationCode ? (
                    <p className="drawer-hint">
                      MarketplaceIntegrationCode Sürat request’te pazaryeri
                      entegrasyon referansı olarak kullanılır; final kargo
                      barkodu değildir.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      downloadSuratDebugPackage(order, verification, logs)
                    }
                  >
                    <Download size={16} />
                    Debug Paketi İndir
                  </button>
                  <DebugJson
                    label="Trendyol Preflight"
                    value={{
                      packageStatus: preflight?.packageStatus,
                      marketplaceStatus: preflight?.marketplaceStatus,
                      orderLineItemStatusName:
                        preflight?.orderLineItemStatusName,
                      shipmentStatus: preflight?.shipmentStatus,
                      canCallSurat: preflight?.canCallSurat,
                      suratAssigned: preflight?.suratAssigned,
                      hasCargoTrackingNumber:
                        preflight?.hasCargoTrackingNumber,
                      existingShipmentDetected:
                        preflight?.existingShipmentDetected,
                      canCallGonderiyiKargoyaGonder:
                        preflight?.canCallGonderiyiKargoyaGonder,
                      reason: preflight?.reason,
                      diagnostics: preflight?.diagnostics,
                      possibleReasons: statusRejected
                        ? [
                            'Trendyol paketi kargoya verilebilir statüde değil.',
                            'Paket daha önce işlem görmüş olabilir.',
                            'Paket iptal/teslim/kargoda/farklı statüde olabilir.',
                            'Trendyol tarafında bu cargoTrackingNumber aktif gönderi oluşturma aşamasında olmayabilir.',
                            'Sipariş farklı kargo firması veya farklı pazaryeri akışıyla eşleşmiş olabilir.',
                            'Aynı packageId/cargoTrackingNumber için daha önce kayıt açılmış olabilir.',
                            'Trendyol bu paket için Sürat gönderi oluşturma işlemine izin vermiyor olabilir.',
                          ]
                        : undefined,
                      recommendedActions: statusRejected
                        ? [
                            'Trendyol panelinde siparişin kargo statüsünü kontrol et.',
                            'Sipariş Sürat’e atanmış mı kontrol et.',
                            'Sipariş daha önce kargoya verilmiş mi kontrol et.',
                            'Sipariş iptal/teslim/kargoda statüsünde mi kontrol et.',
                            'Gerekirse bu packageId ve cargoTrackingNumber ile Trendyol/Sürat destek birimine sor.',
                          ]
                        : undefined,
                    }}
                  />
                  <DebugJson
                    label="ZPL Parse Özeti"
                    value={{
                      code128Candidate:
                        verification.zplAnalysis.mainCode128Candidates[0] ||
                        '-',
                      dataMatrixCandidate:
                        verification.zplAnalysis.dataMatrixCandidates[0] ||
                        '-',
                      qrCandidate:
                        verification.zplAnalysis.qrCandidates[0] || '-',
                      marketplaceIntegrationCode:
                        marketplaceIntegrationCode || '-',
                      finalSuratBarcode:
                        verification.finalSuratBarcode || 'not verified',
                      TNo: verification.tNo || 'not found',
                      operationalPrintable:
                        verification.operationalPrintAllowed,
                      rejectionReason: verification.matchReason,
                    }}
                  />
                  <DebugJson
                    label="Sürat Create Debug"
                    value={{
                      serviceType: createLog?.serviceType,
                      serviceMode: createLog?.serviceMode,
                      operationName: createLog?.operationName,
                      endpoint: createLog?.endpoint,
                      payloadFormat: createLog?.payloadFormat,
                      rawRequest: createLog?.rawRequest,
                      rawResponse: createLog?.rawResponse,
                      responseStatus: createLog?.responseStatus,
                      responseCode: createLog?.responseCode,
                      responseMessage: createLog?.responseMessage,
                      barcodeResponseCodeDetected:
                        createLog?.barcodeResponseCodeDetected,
                      createResponseHasTrackingNumber:
                        createLog?.hasTrackingNumber,
                      createResponseHasBarcode: createLog?.hasBarcode,
                      verifiedShipment: createLog?.verifiedShipment,
                      verificationStage: createLog?.verificationStage,
                      errorCategory: createLog?.errorCategory,
                      requestValidation: createLog?.requestValidation,
                      trendyolPreflight: createLog?.trendyolPreflight,
                      addressNormalization: createLog?.addressNormalization,
                      zplAnalysis: createLog?.zplAnalysis,
                      codeCandidates: createLog?.codeCandidates,
                      codeMapping: createLog?.codeMapping,
                      barcodeSource: createLog?.barcodeSource,
                      rawRequestContainsExpectedOperation:
                        createLog?.rawRequestContainsExpectedOperation,
                      rawRequestContainsLegacyOperation:
                        createLog?.rawRequestContainsLegacyOperation,
                      rawRequestIncludesOrtakBarkodOlustur:
                        createLog?.rawRequestIncludesOrtakBarkodOlustur,
                      rawRequestIncludesGonderiyiKargoyaGonder:
                        createLog?.rawRequestIncludesGonderiyiKargoyaGonder,
                      wrongServiceCalled: createLog?.wrongServiceCalled,
                      preRegistrationOnly: createLog?.preRegistrationOnly,
                      duplicateShipment: createLog?.duplicateShipment,
                      noTrackingReason: createLog?.noTrackingReason,
                      requestReference: createLog?.requestReference,
                      requestMapping: {
                        'orderNumber -> WebSiparisKodu/SatisKodu': {
                          source: order.orderNumber,
                          WebSiparisKodu: readDebugField(
                            createLog?.rawRequest,
                            'WebSiparisKodu',
                          ),
                          SatisKodu: readDebugField(
                            createLog?.rawRequest,
                            'SatisKodu',
                          ),
                        },
                        'packageId -> debug/shipment reference': {
                          source: order.packageId,
                          ReferansNo: readDebugField(
                            createLog?.rawRequest,
                            'ReferansNo',
                          ),
                        },
                        'cargoTrackingNumber -> ReferansNo/MarketplaceIntegrationCode/OzelKargoTakipNo':
                          {
                            source: order.cargoTrackingNumber,
                            ReferansNo: readDebugField(
                              createLog?.rawRequest,
                              'ReferansNo',
                            ),
                            MarketplaceIntegrationCode: readDebugField(
                              createLog?.rawRequest,
                              'MarketplaceIntegrationCode',
                            ),
                            OzelKargoTakipNo: readDebugField(
                              createLog?.rawRequest,
                              'OzelKargoTakipNo',
                            ),
                          },
                      },
                      phoneWarning: createLog?.phoneWarning,
                      parsedResponse: createLog?.parsedResponse,
                      KargoTakipNo: readDebugField(
                        createLog?.parsedResponse,
                        'KargoTakipNo',
                      ) || createLog?.KargoTakipNo,
                      Barcode: readDebugField(
                        createLog?.parsedResponse,
                        'Barcode',
                      ) || createLog?.Barcode,
                      BarcodeRaw: readDebugField(
                        createLog?.parsedResponse,
                        'BarcodeRaw',
                      ) || createLog?.BarcodeRaw,
                      statusComputedFrom:
                        order.shipment?.statusComputedFrom,
                      previousStatus: order.shipment?.previousStatus,
                      newStatus: order.shipment?.newStatus,
                      previousErrorCleared:
                        order.shipment?.previousErrorCleared,
                      tabBucket: order.shipment?.tabBucket,
                      zplSource:
                        order.shipment?.zplSource ||
                        verification.zplSource,
                      Barkod: readDebugField(
                        createLog?.parsedResponse,
                        'Barkod',
                      ),
                      BarkodNo: readDebugField(
                        createLog?.parsedResponse,
                        'BarkodNo',
                      ),
                      TakipNo: readDebugField(
                        createLog?.parsedResponse,
                        'TakipNo',
                      ),
                      TNo: readDebugField(createLog?.parsedResponse, 'TNo'),
                      GonderiNo: readDebugField(
                        createLog?.parsedResponse,
                        'GonderiNo',
                      ),
                      WaybillNo: readDebugField(
                        createLog?.parsedResponse,
                        'WaybillNo',
                      ),
                      IrsaliyeNo: readDebugField(
                        createLog?.parsedResponse,
                        'IrsaliyeNo',
                      ),
                      CargoKey: readDebugField(
                        createLog?.parsedResponse,
                        'CargoKey',
                      ),
                      TakipUrl: readDebugField(
                        createLog?.parsedResponse,
                        'TakipUrl',
                      ),
                      ReferansNo: readDebugField(
                        createLog?.parsedResponse,
                        'ReferansNo',
                      ),
                      OzelKargoTakipNo: readDebugField(
                        createLog?.parsedResponse,
                        'OzelKargoTakipNo',
                      ),
                      trackingSource: createLog?.trackingSource,
                      createdAt: createLog?.createdAt,
                    }}
                  />
                  {createLog?.wrongServiceCalled ? (
                    <p className="drawer-error">
                      Canlı ortak barkod için yanlış servis çağrıldı. Beklenen:
                      OrtakBarkodOlustur, gelen: GonderiyiKargoyaGonder.
                    </p>
                  ) : null}
                  <DebugJson
                    label="Sürat Track Debug"
                    value={{
                      serviceType: trackingLog?.serviceType,
                      endpoint: trackingLog?.endpoint,
                      payloadFormat: trackingLog?.payloadFormat,
                      WebSiparisKodu: trackingLog?.WebSiparisKodu,
                      rawRequest: trackingLog?.rawRequest,
                      rawResponse: trackingLog?.rawResponse,
                      responseStatus: trackingLog?.responseStatus,
                      parsedResponse: trackingLog?.parsedResponse,
                      GonderilerLength: trackingLog?.gonderilerLength,
                      KargoTakipNo: trackingLog?.KargoTakipNo,
                      TakipNo: trackingLog?.TakipNo,
                      TNo: trackingLog?.TNo,
                      BarkodNo: trackingLog?.BarkodNo,
                      Barkod: trackingLog?.Barkod,
                      GonderiNo: trackingLog?.GonderiNo,
                      WaybillNo: trackingLog?.WaybillNo,
                      IrsaliyeNo: trackingLog?.IrsaliyeNo,
                      CargoKey: trackingLog?.CargoKey,
                      TakipUrl: trackingLog?.TakipUrl,
                      extractedKargoTakipNo:
                        trackingLog?.extractedKargoTakipNo,
                      trackingState: trackingLog?.trackingState,
                      trackingAttempts: trackingLog?.trackingAttempts,
                      matchStatus: verification.verifiedShipment,
                      matchReason: verification.matchReason,
                    }}
                  />
                  <DebugJson
                    label="Barkod Mapping Debug"
                    value={{
                      orderNumber: order.orderNumber,
                      packageId: order.packageId,
                      serviceMode: verification.serviceMode,
                      operationName: verification.operationName,
                      shipmentReference: verification.shipmentReference,
                      ReferansNo: createLog?.requestReference,
                      OzelKargoTakipNo: verification.OzelKargoTakipNo,
                      WebSiparisKodu: verification.WebSiparisKodu,
                      SatisKodu: verification.SatisKodu,
                      KargoTakipNo: verification.kargoTakipNo,
                      selectedTrackingNumber:
                        verification.trackingNumber,
                      selectedTrackingSource:
                        verification.trackingNumberSource,
                      TNo: verification.tNo,
                      TNoSource: verification.tNoSource,
                      Barcode: verification.barcode,
                      GonderiNo: verification.gonderiNo,
                      WaybillNo: verification.waybillNo,
                      IrsaliyeNo: verification.irsaliyeNo,
                      CargoKey: verification.cargoKey,
                      BarcodeRaw: verification.barcodeRaw,
                      selectedBarcodeValue:
                        verification.officialBarcodeValue,
                      selectedBarcodeSource:
                        verification.barcodeSource,
                      trackingSource:
                        order.shipment?.trackingSource ||
                        verification.trackingNumberSource,
                      verifiedShipment: verification.verifiedShipment,
                      technicalZplReceived:
                        verification.technicalZplReceived,
                      operationalBarcodeVerified:
                        verification.operationalBarcodeVerified,
                      verificationStage: verification.verificationStage,
                      errorCategory: verification.errorCategory,
                      finalSuratBarcode:
                        verification.finalSuratBarcode,
                      internalWebBarcode:
                        verification.internalWebBarcode,
                      zplAnalysis: verification.zplAnalysis,
                      statusComputedFrom:
                        order.shipment?.statusComputedFrom,
                      previousStatus: order.shipment?.previousStatus,
                      newStatus: order.shipment?.newStatus,
                      previousErrorCleared:
                        order.shipment?.previousErrorCleared,
                      tabBucket: order.shipment?.tabBucket,
                      zplSource: verification.zplSource,
                    }}
                  />
                  <DebugJson
                    label="Print Debug"
                    value={{
                      printRequestedAt:
                        order.label?.printDebug?.printRequestedAt,
                      printConfirmedAt:
                        order.label?.printDebug?.printConfirmedAt,
                      printProvider:
                        order.label?.printDebug?.printProvider,
                      printerName:
                        order.label?.printDebug?.printerName,
                      printJobId: order.label?.printDebug?.printJobId,
                      printResult: order.label?.printDebug?.printResult,
                      browserPrintDebug:
                        order.label?.printDebug?.browserPrintDebug,
                      printRequested:
                        order.label?.printDebug?.browserPrintDebug
                          ?.printRequested,
                      printMode:
                        order.label?.printDebug?.browserPrintDebug
                          ?.printMode,
                      labelHtmlGenerated:
                        order.label?.printDebug?.browserPrintDebug
                          ?.labelHtmlGenerated,
                      labelHtmlLength:
                        order.label?.printDebug?.browserPrintDebug
                          ?.labelHtmlLength,
                      barcodeValue:
                        order.label?.printDebug?.browserPrintDebug
                          ?.barcodeValue,
                      zplAvailable:
                        order.label?.printDebug?.browserPrintDebug
                          ?.zplAvailable,
                      printWindowOpened:
                        order.label?.printDebug?.browserPrintDebug
                          ?.printWindowOpened,
                      printCalled:
                        order.label?.printDebug?.browserPrintDebug
                          ?.printCalled,
                      rejectionReason:
                        order.label?.printDebug?.browserPrintDebug
                          ?.rejectionReason,
                      printableContentPreview:
                        order.label?.printDebug?.browserPrintDebug
                          ?.printableContentPreview,
                      printError: order.label?.printDebug?.printError,
                      zplSource: order.label?.printDebug?.zplSource,
                      zplLength: order.label?.printDebug?.zplLength,
                      labelStatusBefore:
                        order.label?.printDebug?.labelStatusBefore,
                      labelStatusAfter:
                        order.label?.printDebug?.labelStatusAfter,
                      isReprint: order.label?.printDebug?.isReprint,
                      printCountBefore:
                        order.label?.printDebug?.printCountBefore,
                      printCountAfter:
                        order.label?.printDebug?.printCountAfter,
                      printedAt: order.label?.printedAt,
                      lastPrintedAt: order.label?.lastPrintedAt,
                      printedBy: order.label?.printedBy,
                      lastPrintedBy: order.label?.lastPrintedBy,
                      printHistory: order.label?.printHistory,
                    }}
                  />
                </div>
              </details>
            )
          })}
          {shipmentResults.length === 0 ? (
            <p className="empty-state">Henüz Sürat gönderi tanısı yok.</p>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Hata Merkezi</h2>
          <span>{errors.length} kayıt</span>
        </div>
        <div className="error-center-list">
          {errors.map(({ order, verification }) => (
            <article key={order.id} className="error-center-item">
              <strong>Sipariş: {order.orderNumber}</strong>
              <span>Problem: {order.errorMessage || verification.matchReason}</span>
              <span>
                Kullanılan Fallback:{' '}
                {order.shipment?.barcodeSource || verification.shipmentReference || '-'}
              </span>
              <b>Canlı baskı engellendi.</b>
            </article>
          ))}
          {errors.length === 0 ? (
            <p className="empty-state">Canlı baskıyı engelleyen Sürat hatası yok.</p>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="debug-log-toolbar">
          <div>
            <h2>API Çağrıları</h2>
            <span>{filteredLogs.length} kayıt</span>
          </div>
          <select
            value={provider}
            onChange={(event) =>
              setProvider(event.target.value as 'all' | ApiDebugProvider)
            }
          >
            <option value="all">Tüm Sağlayıcılar</option>
            <option value="Trendyol">Trendyol</option>
            <option value="Sürat">Sürat</option>
          </select>
        </div>

        <div className="debug-call-list">
          {filteredLogs.map((log) => (
            <details key={log.id} className="debug-call-item">
              <summary>
                <span>{formatDebugDateTime(log.timestamp)}</span>
                <strong>{log.provider}</strong>
                <span>{log.operation}</span>
                <b className={log.status === 'SUCCESS' ? 'debug-ok' : 'debug-fail'}>
                  {log.status}
                </b>
                <code>{log.durationMs}ms</code>
              </summary>
              <div className="debug-call-detail">
                <DebugValue label="Endpoint" value={log.endpoint} />
                <DebugValue
                  label="Buton"
                  value={log.buttonName || log.button || '-'}
                />
                <DebugValue
                  label="Provider Method"
                  value={log.providerMethod || '-'}
                />
                <DebugValue label="Request URL" value={log.requestUrl} />
                <DebugValue label="Response Status" value={String(log.responseStatus)} />
                <DebugValue label="Hata Kaynağı" value={log.errorSource || '-'} />
                <DebugJson label="Request Headers" value={log.requestHeaders} />
                <DebugJson label="Request / SOAP Request" value={log.requestBody} />
                <DebugJson
                  label="Raw Response / SOAP Response"
                  value={log.rawResponse ?? log.responseBody}
                />
                <DebugJson label="Parse Edilen Alanlar" value={log.fields} />
                {log.errorMessage ? (
                  <DebugValue label="Hata" value={log.errorMessage} />
                ) : null}
              </div>
            </details>
          ))}
          {filteredLogs.length === 0 ? (
            <p className="empty-state">Henüz API debug kaydı yok.</p>
          ) : null}
        </div>
      </section>
    </>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function DebugValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="debug-value">
      <span>{label}</span>
      <code>{value || '-'}</code>
    </div>
  )
}

function DebugJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="debug-json-block">
      <strong>{label}</strong>
      <pre>{value == null ? 'Veri bulunamadı' : JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}

function readDebugField(value: unknown, key: string): string {
  if (typeof value === 'string') {
    const parsed = parseDebugString(value)
    if (parsed !== value) {
      const found = readDebugField(parsed, key)
      if (found) return found
    }
    const text = decodeDebugXml(value)
    const tagMatch = text.match(
      new RegExp(`<[^:>/]*:?${escapeRegExp(key)}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${escapeRegExp(key)}>`, 'i'),
    )
    if (tagMatch?.[1]) return decodeDebugXml(tagMatch[1]).trim()
    const jsonLikeMatch = text.match(
      new RegExp(`["']?${escapeRegExp(key)}["']?\\s*[:=]\\s*["']?([^"',}\\]\\s<]+)`, 'i'),
    )
    return jsonLikeMatch?.[1]?.trim() ?? ''
  }
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readDebugField(item, key)
      if (found) return found
    }
    return ''
  }
  for (const [field, item] of Object.entries(value)) {
    if (field.toLocaleLowerCase('tr-TR') === key.toLocaleLowerCase('tr-TR')) {
      return item == null
        ? ''
        : typeof item === 'object'
          ? JSON.stringify(item)
          : String(item)
    }
    const nested = readDebugField(item, key)
    if (nested) return nested
  }
  return ''
}

function parseDebugString(value: string): unknown {
  const text = value.trim()
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function decodeDebugXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function downloadSuratDebugPackage(
  order: CargoOrder,
  verification: ReturnType<typeof verifySuratShipment>,
  logs: ApiDebugLog[],
) {
  const packageData = {
    exportedAt: new Date().toISOString(),
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      packageId: order.packageId,
      shipmentPackageId: order.shipmentPackageId,
      cargoTrackingNumber: order.cargoTrackingNumber,
      operationStatus: order.operationStatus,
    },
    requestMapping: {
      orderNumber: {
        WebSiparisKodu: order.orderNumber,
        SatisKodu: order.orderNumber,
      },
      packageId: { shipmentReference: order.packageId },
      cargoTrackingNumber: {
        ReferansNo: order.cargoTrackingNumber,
        MarketplaceIntegrationCode: order.cargoTrackingNumber,
        OzelKargoTakipNo: order.cargoTrackingNumber,
      },
    },
    requestValidation: order.shipment?.requestValidation,
    trendyolPreflight: order.shipment?.trendyolPreflight,
    addressNormalization: order.shipment?.addressNormalization,
    createLog: order.shipment?.suratCreateLog,
    trackingLog: order.shipment?.suratTrackingLog,
    trackingAttempts: order.shipment?.suratTrackingLog?.trackingAttempts,
    zplAnalysis: verification.zplAnalysis,
    verification: {
      stage: verification.verificationStage,
      technicalZplReceived: verification.technicalZplReceived,
      operationalBarcodeVerified:
        verification.operationalBarcodeVerified,
      finalSuratBarcode:
        verification.finalSuratBarcode || 'not verified',
      marketplaceIntegrationCode:
        verification.trendyolCargoTrackingNumber ||
        order.cargoTrackingNumber ||
        '',
      internalWebBarcode: verification.internalWebBarcode,
      tNo: verification.tNo,
      matchReason: verification.matchReason,
      errorCategory: verification.errorCategory,
      operationalPrintAllowed:
        verification.operationalPrintAllowed,
    },
    zplCandidateSummary: {
      code128Candidate:
        verification.zplAnalysis.mainCode128Candidates[0] || '',
      dataMatrixCandidate:
        verification.zplAnalysis.dataMatrixCandidates[0] || '',
      qrCandidate: verification.zplAnalysis.qrCandidates[0] || '',
      acceptedFinalBarcode:
        verification.finalSuratBarcode || 'not verified',
      acceptedTNo: verification.tNo || 'not found',
    },
    suratSupportQuestion:
      'OrtakBarkodOlustur servisi isError=false ve Message=016 dönüyor, BarcodeRaw içinde Web barkodlu ZPL var ancak KargoTakipNo ve T.No boş. Serdendip’te görünen numeric T.No ve numeric ana barkod hangi servis/alan ile alınmalıdır?',
    trendyol1002TechnicalNote:
      verification.errorCategory === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
        ? 'Bu kayıtta request mapping doğru görünüyor. MarketplaceIntegrationCode cargoTrackingNumber ile dolu. Sürat/Trendyol 1002 “Kargo uygun bir statüde değil” hatası dönüyor. Kontrol edilmesi gereken alan Trendyol package/shipment status ve bu cargoTrackingNumber’ın Sürat gönderi oluşturma akışına uygun olup olmadığıdır.'
        : undefined,
    relatedApiLogs: logs.filter(
      (log) => log.orderNumber === order.orderNumber,
    ),
    appliedSafetyRules: [
      'Web ile başlayan kod final operasyonel barkod olarak kabul edilmez.',
      'Numeric ana barkod ve numeric T.No doğrulanmadan yazdırma açılamaz.',
      'Teknik BarcodeRaw indirilebilir; operasyonel baskıdan ayrı tutulur.',
    ],
  }
  const blob = new Blob([JSON.stringify(packageData, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `surat-debug-${order.orderNumber}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
