import { Download, PackagePlus, Printer, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  CargoOrder,
  CargoProduct,
  OrderItem,
  TenantDesiConfig,
} from '../types/cargoflow'
import { formatCurrency, formatDisplayDate } from '../utils/formatters'
import {
  buildProductMatchDebug,
  resolveProductImage,
  resolveProductImageCandidates,
  type ProductImageResolution,
  type ProductMatchDebug,
} from '../utils/productImage'
import { ProductImageThumb } from './ProductImageThumb'
import {
  canDownloadZpl,
  hasCarrierTracking,
  canMarkPrinted,
} from '../utils/orderStatus'
import { verifySuratShipment } from '../utils/suratVerification'
import { detectOrderLineDuplication } from '../utils/orderLineIntegrity'
import {
  resolveSuratPrintEligibility,
  resolveSuratPrintSource,
} from '../utils/suratPrintEligibility'
import {
  mapMarketplaceStatus,
  mapOperationStatus,
} from '../utils/statusPresentation'
import { displayOrderNumber, sourceOrderNumber } from '../utils/orderDisplay'
import { resolveOrderStatus } from '../utils/shipmentStatus'
import { formatDesi, resolveNormalizedDesi } from '../utils/desi'
import {
  calculateOrderDesi,
  describeLineDesiSource,
  type LineDesiBreakdown,
} from '../utils/orderDesi'
import { SuratShipmentTimeline } from './SuratShipmentTimeline'
import { buildSuratShipmentTimeline } from '../utils/suratShipmentTimeline'
import { StatusBadge } from './StatusBadge'

interface OrderDetailDrawerProps {
  order: CargoOrder
  products: CargoProduct[]
  busy: boolean
  onClose: () => void
  // Ayrı "gönderi oluştur" aksiyonu ARTIK GÖSTERİLMEZ: ana buton create +
  // print zincirini yönetir. Prop geriye dönük uyumluluk için kabul edilir.
  onCreateShipment: (orderId: string) => void
  /** Ortak tek-tuş akışı (Siparişler sayfasıyla AYNI handler). */
  onCreateAndPrintLabel?: (orderId: string) => void
  /** Aynı sipariş için başka bir ekrandan başlamış olabilir. */
  createAndPrintBusy?: boolean
  /** Ortak akıştan gelen aşama metni (uydurulmaz). */
  createAndPrintPhaseText?: string
  onTrackShipment: (orderId: string) => void
  onDownloadZpl: (orderId: string) => void
  onPrintLabel: (orderId: string) => void
  // Manuel desi girişi KALDIRILDI; prop geriye dönük uyumluluk için kabul
  // edilir ama KULLANILMAZ.
  onDesiChange?: (
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) => void
  desiConfig?: TenantDesiConfig
}

// Sipariş detay paneli READ-ONLY'dir: açılışı yalnız mevcut store verisini
// okur; hiçbir create/verify/sync/print API çağrısını otomatik tetiklemez.
export function OrderDetailDrawer({
  order,
  products,
  busy,
  onClose,
  onCreateAndPrintLabel,
  createAndPrintBusy = false,
  createAndPrintPhaseText,
  onTrackShipment,
  onDownloadZpl,
  onPrintLabel,
  desiConfig,
}: OrderDetailDrawerProps) {
  // Gelismis Islemler menusu: yalniz GORSEL gruplama. Islem surerken veya
  // ayni siparis icin baska ekranda run varsa kapalidir.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedRef = useRef<HTMLDivElement | null>(null)
  const actionsLocked = createAndPrintBusy
  const menuOpen = advancedOpen && !actionsLocked
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!advancedRef.current?.contains(event.target as Node)) {
        setAdvancedOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAdvancedOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])
  const suratVerification = verifySuratShipment(order)
  const printEligibility = resolveSuratPrintEligibility(order)
  const printSource = resolveSuratPrintSource(order)
  const operationStatus = mapOperationStatus(order)
  const marketplaceStatus = mapMarketplaceStatus(
    order.marketplace,
    order.marketplaceStatus,
  )
  const resolvedStatus = resolveOrderStatus(order)
  const normalizedDesi = resolveNormalizedDesi(order)
  const desiCalculation = calculateOrderDesi(order, products, desiConfig)
  const [activeTab, setActiveTab] = useState<'details' | 'apiDebug'>('details')

  const totalQuantity = order.items.reduce(
    (total, item) => total + (Number(item.quantity) || 0),
    0,
  )

  // DEV/diagnostic bütünlük kontrolü: aynı canonical satır anahtarı birden çok
  // kez var VE sum(lineTotal) totalAmount'ı aşırı aşıyorsa (cross-path duplicate
  // işareti) YALNIZ dev konsoluna uyarı yazar. Üretim UI'ında sessizce quantity
  // düzeltmesi / client-side dedupe YAPMAZ — asıl çözüm persistence katmanında.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const integrity = detectOrderLineDuplication(order)
    if (integrity.suspectedDuplicate) {
      console.warn(
        '[order-line-integrity] Şüpheli duplicate satır (persistence sorunu): ' +
          `duplicateKeyCount=${integrity.duplicateKeyCount} ` +
          `lineTotalSum=${integrity.lineTotalSum} totalAmount=${integrity.orderTotal} ` +
          `ratio=${integrity.ratio}. order-lines:repair CLI ile onarın.`,
      )
    }
  }, [order])
  const packageCountLabel = `${Math.max(1, Math.round(order.packageCount ?? 1))} paket`
  const labelStatusLabel =
    order.labelStatus === 'PRINTED'
      ? 'Etiket Basıldı'
      : printEligibility.canPrint
        ? 'Etiket Hazır'
        : 'Etiket Bekliyor'
  // Kargo durumu alanında fiziksel Sürat kabulü (SDP) bekleme metni GÖSTERİLMEZ;
  // etiket hazır/basılıyken SDP kabulü CargoFlow kriteri değildir.
  const cargoStatusLabel = resolvedStatus.delivered
    ? 'Teslim Edildi'
    : order.shipment?.carrierStatusLabel ||
      (order.shipment ? 'Takip Bekleniyor' : 'Bekliyor')
  const printSourceLabel =
    printSource.source === 'carrier_zpl'
      ? 'Taşıyıcı ZPL etiketi'
      : printSource.source === 'canonical_html'
        ? 'Canonical HTML etiketi'
        : 'Etiket oluşturulamıyor'
  const zplStatusLabel = printEligibility.barcodeRaw
    ? 'Ham ZPL mevcut'
    : printSource.source === 'canonical_html'
      ? 'Ham ZPL mevcut değil'
      : order.shipment
        ? 'ZPL yok'
        : '-'
  const trackingVerificationLabel = suratVerification.verifiedShipment
    ? 'Doğrulandı'
    : printEligibility.awaitingAcceptance
      ? 'Preassigned Awaiting'
      : order.shipment
        ? 'Doğrulanmadı'
        : '-'
  const invoiceComparison = compareInvoiceAddress(order)

  // Yalnız development modunda, PII içermeyen gözlemlenebilirlik logları.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const timeline = buildSuratShipmentTimeline(order)
    console.info('[order-detail] ORDER_DETAIL_OPEN', {
      orderNumber: order.orderNumber,
      hasShipment: Boolean(order.shipment),
    })
    console.info('[order-detail] ORDER_DETAIL_MODEL_READY', {
      orderNumber: order.orderNumber,
      itemCount: order.items.length,
      totalQuantity,
      finalDesi: desiCalculation.finalDesi,
    })
    console.info('[order-detail] ORDER_DETAIL_TIMELINE_STATE', {
      orderNumber: order.orderNumber,
      steps: timeline.map((step) => `${step.key}:${step.status}`),
    })
    console.info('[order-detail] ORDER_DETAIL_PRINT_SOURCE', {
      orderNumber: order.orderNumber,
      source: printSource.source,
      canPrint: printSource.canPrint,
      canDownloadZpl: printSource.canDownloadZpl,
    })
    console.info('[order-detail] ORDER_DETAIL_MISSING_FIELDS', {
      orderNumber: order.orderNumber,
      missingFields: printSource.missingFields,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id])

  return (
    <div className="drawer-backdrop" role="presentation">
      <aside className="detail-drawer order-drawer" aria-label="Sipariş detayı">
        <div className="drawer-header order-drawer-header">
          <div>
            <span className="eyebrow">Sipariş Detayı</span>
            <h2>#{displayOrderNumber(order)}</h2>
            <div className="order-drawer-subtitle">
              <span>Paket {order.packageId || order.shipmentPackageId || '-'}</span>
              <span>·</span>
              <span>{order.marketplace}</span>
              <span>·</span>
              <span>{formatDisplayDate(order.orderDate || order.createdAt)}</span>
            </div>
            <div className="drawer-status-stack">
              <StatusBadge
                status={operationStatus.label}
                tone={operationStatus.color}
                title={operationStatus.description}
              />
              <span title={marketplaceStatus.description}>
                Pazaryeri: {marketplaceStatus.label}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Paneli kapat"
          >
            <X size={20} />
          </button>
        </div>

        <div className="drawer-tabs">
          <button
            type="button"
            className={activeTab === 'details' ? 'active' : ''}
            onClick={() => setActiveTab('details')}
          >
            Sipariş Detayı
          </button>
          <button
            type="button"
            className={activeTab === 'apiDebug' ? 'active' : ''}
            onClick={() => setActiveTab('apiDebug')}
          >
            API Debug
          </button>
        </div>

        <div className="drawer-content order-drawer-content">
          {activeTab === 'details' ? (
            <>
            {/* B. Operasyon özeti */}
            <section className="detail-section order-summary-section">
              <div className="order-summary-grid">
                <SummaryCard
                  label="Sipariş Durumu"
                  value={marketplaceStatus.label}
                  tone="info"
                />
                <SummaryCard
                  label="Etiket Durumu"
                  value={labelStatusLabel}
                  tone={printEligibility.canPrint ? 'ready' : 'waiting'}
                />
                <SummaryCard
                  label="Kargo Durumu"
                  value={cargoStatusLabel}
                  tone={resolvedStatus.delivered ? 'done' : 'waiting'}
                />
                <SummaryCard
                  label="Toplam Desi"
                  value={formatDesi(
                    desiCalculation.finalDesi ?? normalizedDesi.desi,
                  )}
                  tone="info"
                />
                <SummaryCard
                  label="Ürün Adedi"
                  value={`${order.items.length} ürün / ${totalQuantity} adet`}
                  tone="info"
                />
                <SummaryCard
                  label="Paket Adedi"
                  value={packageCountLabel}
                  tone="info"
                />
              </div>
              {order.errorMessage ? (
                <p className="drawer-error">{order.errorMessage}</p>
              ) : null}
            </section>

            {/* C. Sipariş bilgileri */}
            <section className="detail-section">
              <h3>Sipariş Bilgileri</h3>
              <div className="detail-grid">
                <Detail label="Sipariş No" value={displayOrderNumber(order)} />
                <Detail
                  label="Paket ID"
                  value={order.packageId || order.shipmentPackageId}
                />
                <Detail label="Pazaryeri" value={order.marketplace} />
                <Detail
                  label="Sipariş Tarihi"
                  value={formatDisplayDate(order.orderDate || order.createdAt)}
                />
                <Detail
                  label="Planlanan Teslim"
                  value={formatDisplayDate(order.deliveryDate)}
                />
                {resolvedStatus.delivered && order.shipment?.deliveredAt ? (
                  <Detail
                    label="Gerçek Teslim Tarihi"
                    value={formatDisplayDate(order.shipment.deliveredAt)}
                  />
                ) : null}
                <Detail
                  label="Toplam Tutar"
                  value={formatCurrency(order.totalAmount)}
                />
                <Detail label="Para Birimi" value="TRY" />
                <Detail
                  label="Kaynak Sipariş No"
                  value={sourceOrderNumber(order) || order.externalOrderId}
                />
                <Detail
                  label="Trendyol Takip / QR No"
                  value={order.cargoTrackingNumber}
                />
                <Detail
                  label="OzelKargoTakipNo"
                  value={order.shipment?.ozelKargoTakipNo}
                />
                <Detail
                  label="ReferansNo"
                  value={
                    order.shipment?.shipmentReference ||
                    order.shipment?.shipmentCode
                  }
                />
              </div>
            </section>

            {/* D. Müşteri ve teslimat */}
            <section className="detail-section">
              <h3>Müşteri &amp; Teslimat</h3>
              <div className="customer-columns">
                <div className="detail-grid customer-column">
                  <Detail label="Alıcı" value={order.customerName} />
                  <Detail label="Telefon" value={order.customerPhone} />
                  <Detail label="E-posta" value={order.customerEmail} />
                </div>
                <div className="customer-column">
                  <div className="address-box">
                    <span className="address-label">Teslimat Adresi</span>
                    <span>{order.address || '-'}</span>
                    <strong>
                      {[order.district, order.city]
                        .filter(Boolean)
                        .join(' / ') || '-'}
                    </strong>
                  </div>
                </div>
              </div>
              {invoiceComparison.state === 'different' ? (
                <div className="address-box invoice-address">
                  <span className="address-label">Fatura Adresi</span>
                  <span>{invoiceComparison.invoiceAddress}</span>
                </div>
              ) : invoiceComparison.state === 'same' ? (
                <p className="field-note">
                  Fatura adresi teslimat adresiyle aynı.
                </p>
              ) : null}
            </section>

            {/* E. Ürünler */}
            <section className="detail-section">
              <h3>Ürünler ({order.items.length})</h3>
              <div className="order-item-list">
                {order.items.map((item) => (
                  <OrderLine
                    key={item.id}
                    orderNumber={order.orderNumber}
                    item={item}
                    imageResolution={resolveProductImage(item, products)}
                    imageCandidates={resolveProductImageCandidates(
                      item,
                      products,
                    ).map((candidate) => candidate.url)}
                    matchDebug={buildProductMatchDebug(item, products)}
                    desiLine={desiCalculation.lines.find(
                      (line) => line.lineId === String(item.id),
                    )}
                  />
                ))}
              </div>
            </section>

            {/* F. Paket ve kargo */}
            <section className="detail-section">
              <h3>Paket &amp; Kargo</h3>
              <div className="detail-grid">
                <Detail
                  label="Kargo Firması"
                  value={
                    hasCarrierTracking(order)
                      ? 'Sürat Kargo'
                      : order.cargoProviderName || 'Bekliyor'
                  }
                />
                <Detail
                  label="Paket ID"
                  value={order.packageId || order.shipmentPackageId}
                />
                <Detail
                  label="Servis Modu"
                  value={suratVerification.serviceMode}
                />
                <Detail
                  label="Operasyon Adı"
                  value={suratVerification.operationName}
                />
                <Detail label="Sürat T.No" value={printEligibility.trackingNumber || suratVerification.tNo} />
                <Detail
                  label="Sürat Barkod"
                  value={
                    printEligibility.barcode ||
                    suratVerification.officialBarcodeValue
                  }
                />
                <Detail
                  label="Trendyol Takip / QR No"
                  value={
                    order.shipment?.ozelKargoTakipNo ||
                    order.cargoTrackingNumber
                  }
                />
                <Detail
                  label="Toplam Desi"
                  value={formatDesi(
                    desiCalculation.finalDesi ?? normalizedDesi.desi,
                  )}
                />
                <Detail
                  label="Toplam Kg"
                  value={
                    normalizedDesi.weightKg != null
                      ? formatDesi(normalizedDesi.weightKg)
                      : formatDesi(
                          desiCalculation.finalDesi ?? normalizedDesi.desi,
                        )
                  }
                />
                <Detail label="Adet (Koli)" value={packageCountLabel} />
                <Detail label="ZPL Durumu" value={zplStatusLabel} />
                <Detail label="Print Kaynağı" value={printSourceLabel} />
                <Detail
                  label="Takip Doğrulama"
                  value={trackingVerificationLabel}
                />
                {order.shipment?.candidateTNo ? (
                  <Detail
                    label="Aday T.No"
                    value={order.shipment.candidateTNo}
                  />
                ) : null}
                {order.shipment?.candidateBarkodNo ? (
                  <Detail
                    label="Aday Barkod"
                    value={order.shipment.candidateBarkodNo}
                  />
                ) : null}
              </div>
              {printSource.source === 'canonical_html' ? (
                <div className="detail-warning" role="status">
                  Ham ZPL mevcut değil; canonical HTML etiketi yazdırılabilir.
                </div>
              ) : null}
              {printSource.source === 'unavailable' && order.shipment ? (
                <div className="detail-warning" role="status">
                  {printSource.reason}
                </div>
              ) : null}
              {/* Desi GİRİŞİ KALDIRILDI: Ayarlar → "Varsayılan Gönderi
                  Desisi" değerinden (adet çarpanıyla) hesaplanır; burada
                  yalnız SALT OKUNUR gösterilir. */}
              <div className="drawer-desi-editor">
                <span>Toplam koli desisi</span>
                <strong>
                  {formatDesi(normalizedDesi.desi)} ·{' '}
                  {normalizedDesi.desiSource || 'Ayarlar varsayılanı'}
                </strong>
              </div>
              <div className="desi-breakdown" data-testid="desi-breakdown">
                <span>Desi Dökümü (satır × adet)</span>
                {desiCalculation.lines.map((line) => (
                  <div key={line.lineId} className="desi-breakdown-line">
                    <span>
                      {line.productName || line.sku || line.barcode || '-'}
                    </span>
                    <strong>
                      {line.excludedReason === 'duplicate_line'
                        ? 'Tekrarlanan satır — sayılmadı'
                        : line.excludedReason === 'cancelled_line'
                          ? 'İptal — sayılmadı'
                          : line.unitDesi != null
                            ? `${line.quantity} × ${formatDesi(line.unitDesi)} = ${formatDesi(line.lineTotalDesi)} (${describeLineDesiSource(line.unitDesiSource)})`
                            : `${line.quantity} × ? — desi eksik`}
                    </strong>
                  </div>
                ))}
                <div className="desi-breakdown-total">
                  <span>Hesaplanan toplam</span>
                  <strong>
                    {formatDesi(desiCalculation.calculatedTotalDesi)}
                  </strong>
                </div>
                {desiCalculation.manualTotalDesi != null ? (
                  <div className="desi-breakdown-total">
                    <span>Manuel toplam koli desisi</span>
                    <strong>
                      {formatDesi(desiCalculation.manualTotalDesi)} (öncelikli)
                    </strong>
                  </div>
                ) : null}
                {desiCalculation.finalDesi == null ? (
                  <div className="detail-warning" role="alert">
                    Gönderi oluşturulamaz: {desiCalculation.blockedReason}
                  </div>
                ) : null}
              </div>
            </section>

            {/* G. Kargo zaman çizelgesi */}
            <section className="detail-section">
              <h3>Kargo Zaman Çizelgesi</h3>
              <SuratShipmentTimeline order={order} />
            </section>

            {/* H. Teknik durum (varsayılan kapalı; debug amaçlı) */}
            <section className="detail-section">
              <details className="technical-status raw-line-details">
                <summary>Teknik Durum</summary>
                <div className="detail-grid">
                  <Detail
                    label="lifecycleStatus"
                    value={order.shipment?.lifecycleStatus}
                  />
                  <Detail
                    label="verificationStage"
                    value={order.shipment?.verificationStage}
                  />
                  <Detail
                    label="verifiedShipment"
                    value={String(suratVerification.verifiedShipment)}
                  />
                  <Detail
                    label="dispatchRegistrationConfirmed"
                    value={String(
                      order.shipment?.dispatchRegistrationConfirmed ?? '-',
                    )}
                  />
                  <Detail
                    label="operationalBarcodeVerified"
                    value={String(
                      order.shipment?.operationalBarcodeVerified ?? '-',
                    )}
                  />
                  <Detail
                    label="candidateVerificationStatus"
                    value={order.shipment?.candidateVerificationStatus}
                  />
                  <Detail
                    label="trackingSource"
                    value={order.shipment?.trackingSource}
                  />
                  <Detail
                    label="barcodeSource"
                    value={suratVerification.barcodeSource}
                  />
                  <Detail
                    label="zplSource"
                    value={suratVerification.zplSource}
                  />
                  <Detail label="printSource" value={printSource.source} />
                  <Detail
                    label="canPrint"
                    value={String(printSource.canPrint)}
                  />
                  <Detail
                    label="canDownloadZpl"
                    value={String(printSource.canDownloadZpl)}
                  />
                  <Detail
                    label="createCallCount"
                    value={readIdempotencyField(order, 'createCallCount')}
                  />
                  <Detail
                    label="carrierCreateCalled"
                    value={readIdempotencyField(order, 'carrierCreateCalled')}
                  />
                  <Detail
                    label="idempotencyKey"
                    value={readIdempotencyField(order, 'idempotencyKey')}
                  />
                  <Detail
                    label="correlationId"
                    value={readIdempotencyField(order, 'correlationId')}
                  />
                  <Detail
                    label="lastErrorCode"
                    value={
                      order.shipment?.errorCategory ||
                      order.shipment?.suratCreateLog?.responseCode
                    }
                  />
                  <Detail
                    label="diagnosticMessage"
                    value={order.shipment?.diagnosticMessage}
                  />
                  <Detail
                    label="Son Hareket Tarihi"
                    value={formatDisplayDate(
                      order.shipment?.suratTrackingLog?.SonHareketTarihi,
                    )}
                  />
                  <Detail
                    label="Baskı Sayısı"
                    value={String(order.label?.printCount ?? 0)}
                  />
                  <Detail
                    label="Son Baskı"
                    value={formatDisplayDate(order.label?.lastPrintedAt)}
                  />
                </div>
                <details className="raw-line-details">
                  <summary>Raw SOAP response</summary>
                  <pre>
                    {typeof order.shipment?.suratCreateLog?.rawResponse ===
                    'string'
                      ? order.shipment.suratCreateLog.rawResponse
                      : JSON.stringify(
                          order.shipment?.suratCreateLog?.rawResponse,
                          null,
                          2,
                        )}
                  </pre>
                </details>
              </details>
            </section>
            </>
          ) : (
            <section className="detail-section">
              <h3>Trendyol Raw JSON</h3>
              <pre className="api-debug-json">
                {JSON.stringify(
                  {
                    order: {
                      id: order.id,
                      orderNumber: order.orderNumber,
                      packageId: order.packageId,
                      shipmentPackageId: order.shipmentPackageId,
                      cargoTrackingNumber: order.cargoTrackingNumber,
                      marketplaceStatus: order.marketplaceStatus,
                      shipmentAddress: order.shipmentAddress,
                    },
                    lines: order.items.map((item) => item.rawLine ?? item),
                  },
                  null,
                  2,
                )}
              </pre>
              <h3>Sürat Raw JSON</h3>
              <pre className="api-debug-json">
                {JSON.stringify(
                  {
                    shipment: order.shipment,
                    verification: suratVerification,
                    statusSourceDebug: {
                      marketplaceRawStatus: order.marketplaceStatus,
                      marketplaceMappedStatus: marketplaceStatus.label,
                      carrierStatusSource:
                        order.shipment?.carrierStatusSource || null,
                      suratTrackingQueriedAt:
                        order.shipment?.suratTrackingLog?.createdAt || null,
                      suratGonderilerCount:
                        order.shipment?.suratTrackingLog?.gonderilerLength ??
                        order.shipment?.suratTrackingLog?.Gonderiler?.length ??
                        0,
                      suratKargonunDurumu:
                        order.shipment?.suratTrackingLog?.KargonunDurumu ||
                        null,
                      suratKargonunDurumuSayi:
                        order.shipment?.suratTrackingLog
                          ?.KargonunDurumuSayi || null,
                      computedOperationStatus: resolvedStatus.operationStatus,
                      statusSource: resolvedStatus.statusSource,
                      deliveredDetectedFrom:
                        resolvedStatus.deliveredDetectedFrom || null,
                      shippedDetectedFrom:
                        resolvedStatus.shippedDetectedFrom || null,
                      plannedDeliveryDateIgnoredForStatus:
                        resolvedStatus.plannedDeliveryDateIgnoredForStatus,
                    },
                  },
                  null,
                  2,
                )}
              </pre>
            </section>
          )}
        </div>

        {/* I. Normal görünümde TEK ana aksiyon + Gelişmiş İşlemler.
            Ana buton Siparişler sayfasıyla AYNI ortak akışı çağırır; create/
            print iş mantığı buraya KOPYALANMAZ. Eski manuel işlemler menüde
            fallback olarak KORUNUR (handler'ları değişmedi). */}
        <div className="drawer-actions order-drawer-footer">
          <button
            type="button"
            className="primary-button order-detail-create-print"
            disabled={busy || actionsLocked || !onCreateAndPrintLabel}
            title="Etiket yoksa oluşturur, varsa mevcut etiketi yazdırır."
            onClick={() => onCreateAndPrintLabel?.(order.id)}
          >
            <PackagePlus size={18} />
            {actionsLocked
              ? createAndPrintPhaseText || 'İşleniyor…'
              : 'Kargo Etiketi Oluştur ve Yazdır'}
          </button>
          <div className="order-detail-advanced" ref={advancedRef}>
            <button
              type="button"
              className="secondary-button order-detail-advanced-toggle"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy || actionsLocked}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              Gelişmiş İşlemler
            </button>
            {menuOpen ? (
              <div className="order-detail-advanced-menu" role="menu">
                <button
                  type="button"
                  className="secondary-button"
                  role="menuitem"
                  disabled={busy || actionsLocked || !hasCarrierTracking(order)}
                  onClick={() => onTrackShipment(order.id)}
                >
                  <Search size={18} />
                  Takip Sorgula
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  role="menuitem"
                  disabled={busy || actionsLocked || !canDownloadZpl(order)}
                  title={
                    canDownloadZpl(order)
                      ? undefined
                      : printSource.source === 'canonical_html'
                        ? 'Bu eski kayıtta taşıyıcının ham ZPL verisi bulunamadı.'
                        : printEligibility.reason
                  }
                  onClick={() => onDownloadZpl(order.id)}
                >
                  <Download size={18} />
                  ZPL İndir
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  role="menuitem"
                  disabled={busy || actionsLocked || !canMarkPrinted(order)}
                  title={printEligibility.reason}
                  onClick={() => onPrintLabel(order.id)}
                >
                  <Printer size={18} />
                  {order.labelStatus === 'PRINTED'
                    ? 'Tekrar Yazdır'
                    : 'Yazdır / Tekrar Yazdır'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'info' | 'ready' | 'waiting' | 'done' | 'error'
}) {
  return (
    <div className={`summary-card summary-card-${tone}`}>
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  )
}

// Fatura adresi yalnız GÖSTERİM amaçlı karşılaştırılır; shipment/create
// akışına bağlanmaz.
function compareInvoiceAddress(order: CargoOrder): {
  state: 'same' | 'different' | 'unknown'
  invoiceAddress: string
} {
  const invoice = readAddressText(
    readRecord(order.rawOrder, 'invoiceAddress') ??
      readRecord(readRecord(order.rawOrder, 'order'), 'invoiceAddress'),
  )
  if (!invoice) return { state: 'unknown', invoiceAddress: '' }
  const normalize = (value: string) =>
    value.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim()
  const delivery = normalize(
    [order.address, order.district, order.city].filter(Boolean).join(' '),
  )
  return normalize(invoice).slice(0, 40) === delivery.slice(0, 40) ||
    delivery.includes(normalize(invoice).slice(0, 30))
    ? { state: 'same', invoiceAddress: invoice }
    : { state: 'different', invoiceAddress: invoice }
}

function readRecord(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function readAddressText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const full = record.fullAddress ?? record.address1 ?? record.address
  const parts = [full, record.district, record.city]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
  return parts.join(' ')
}

function readIdempotencyField(order: CargoOrder, key: string): string {
  const shipmentRecord = order.shipment as
    | (Record<string, unknown> & { suratCreateLog?: unknown })
    | undefined
  const createLogRecord = shipmentRecord?.suratCreateLog as
    | Record<string, unknown>
    | undefined
  const sources = [
    shipmentRecord?.idempotency,
    createLogRecord?.idempotency,
    createLogRecord,
  ]
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    const value = (source as Record<string, unknown>)[key]
    if (value != null && value !== '') return String(value)
  }
  return '-'
}

function OrderLine({
  orderNumber,
  item,
  imageResolution,
  imageCandidates,
  matchDebug,
  desiLine,
}: {
  orderNumber: string
  item: OrderItem
  imageResolution: ProductImageResolution
  imageCandidates: string[]
  matchDebug: ProductMatchDebug
  desiLine?: LineDesiBreakdown
}) {
  const imageResolvedFrom = imageResolution.imageResolvedFrom
  const product = imageResolution.matchedProduct
  const color = item.color || findVariantValue(item, 'Renk') || product?.color
  const size = item.size || findVariantValue(item, 'Beden') || product?.size
  const hasVariantInfo =
    Boolean(color || size) || Boolean(item.variantAttributes?.length)
  const quantity = Math.max(1, Number(item.quantity) || 1)
  const lineTotal = item.price != null ? item.price * quantity : undefined

  return (
    <div className="order-line">
      <ProductImageThumb
        candidates={imageCandidates}
        alt={item.productName}
        placeholderClassName="line-image-placeholder"
        placeholderText="Fotoğraf yok"
      />
      <div className="order-line-content">
        <strong>{item.productName}</strong>
        <div className="order-line-grid">
          <LineDetail label="Renk" value={color} />
          <LineDetail label="Beden" value={size} />
          <LineDetail label="Barkod" value={item.barcode} />
          <LineDetail
            label="SKU / Merchant SKU"
            value={[item.sku, item.merchantSku].filter(Boolean).join(' / ')}
          />
          <LineDetail
            label="Stok Kodu"
            value={item.stockCode || product?.stockCode}
          />
          <LineDetail label="Adet" value={String(quantity)} />
          <LineDetail
            label="Birim Fiyat"
            value={item.price != null ? formatCurrency(item.price) : undefined}
          />
          <LineDetail
            label="Satır Toplamı"
            value={lineTotal != null ? formatCurrency(lineTotal) : undefined}
          />
          <LineDetail
            label="Birim Desi"
            value={
              desiLine?.unitDesi != null
                ? formatDesi(desiLine.unitDesi)
                : undefined
            }
          />
          <LineDetail
            label="Satır Desisi"
            value={
              desiLine?.lineTotalDesi != null
                ? formatDesi(desiLine.lineTotalDesi)
                : undefined
            }
          />
          <LineDetail
            label="Desi Kaynağı"
            value={
              desiLine
                ? describeLineDesiSource(desiLine.unitDesiSource)
                : undefined
            }
          />
          <LineDetail
            label="Ürün ID / Content ID"
            value={[item.productCode, item.productContentId]
              .filter(Boolean)
              .join(' / ')}
          />
        </div>
        {item.variantAttributes?.length ? (
          <div className="variant-list">
            {item.variantAttributes.map((attribute) => (
              <span key={`${attribute.name}-${attribute.value}`}>
                <b>{attribute.name}:</b> {attribute.value}
              </span>
            ))}
          </div>
        ) : null}
        {!hasVariantInfo ? (
          <p className="variant-warning">
            Trendyol response içinde varyant bilgisi gelmedi
          </p>
        ) : null}
        <details className="raw-line-details">
          <summary>Ürün Görsel Debug</summary>
          <pre>
            {JSON.stringify(
              {
                orderNumber,
                lineId: item.id,
                productName: item.productName,
                productContentId: item.productContentId,
                productMainId: item.productMainId,
                barcode: item.barcode,
                merchantSku: item.merchantSku,
                sku: item.sku,
                productImageUrl: imageResolution.url || null,
                imageCandidates,
                imageSource: imageResolution.imageSource,
                imageResolvedFrom,
                imageLoadError: Boolean(item.imageLoadError),
                matchedProductId: imageResolution.matchedProductId || null,
                matchedBy: imageResolution.matchedBy,
                normalizedBarcode: matchDebug.normalizedBarcode,
                normalizedSku: matchDebug.normalizedSku,
                normalizedStockCode: matchDebug.normalizedStockCode,
                normalizedMerchantSku: matchDebug.normalizedMerchantSku,
                normalizedProductName: matchDebug.normalizedProductName,
                extractedModelCode: matchDebug.extractedModelCode,
                extractedColor: matchDebug.extractedColor,
                extractedSize: matchDebug.extractedSize,
                exactBarcodeMatches: matchDebug.exactBarcodeMatches,
                exactSkuMatches: matchDebug.exactSkuMatches,
                exactStockCodeMatches: matchDebug.exactStockCodeMatches,
                modelTokenMatches: matchDebug.modelTokenMatches,
                normalizedNameMatches: matchDebug.normalizedNameMatches,
                colorMatches: matchDebug.colorMatches,
                sizeMatches: matchDebug.sizeMatches,
                candidateProductIds: matchDebug.candidateProductIds,
                rejectionReasons: matchDebug.rejectionReasons,
                finalFailureReason: matchDebug.finalFailureReason || null,
              },
              null,
              2,
            )}
          </pre>
        </details>
        <details className="raw-line-details">
          <summary>Ham Ürün Verisi</summary>
          <pre>{JSON.stringify(item.rawLine ?? item, null, 2)}</pre>
        </details>
      </div>
    </div>
  )
}

function LineDetail({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  )
}

function findVariantValue(item: OrderItem, name: string): string {
  const normalized = name.toLocaleLowerCase('tr-TR')
  return (
    item.variantAttributes?.find(
      (attribute) =>
        attribute.name.toLocaleLowerCase('tr-TR') === normalized,
    )?.value ?? ''
  )
}

function Detail({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  )
}
