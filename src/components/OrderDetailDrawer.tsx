import { Download, PackagePlus, Printer, Search, X } from 'lucide-react'
import { useState } from 'react'
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
  canCreateShipment,
  canDownloadZpl,
  hasCarrierTracking,
  hasVerifiedSuratShipment,
  canMarkPrinted,
} from '../utils/orderStatus'
import { verifySuratShipment } from '../utils/suratVerification'
import { resolveSuratPrintEligibility } from '../utils/suratPrintEligibility'
import {
  mapMarketplaceStatus,
  mapOperationStatus,
} from '../utils/statusPresentation'
import { resolveOrderStatus } from '../utils/shipmentStatus'
import { formatDesi, resolveNormalizedDesi } from '../utils/desi'
import {
  calculateOrderDesi,
  describeLineDesiSource,
} from '../utils/orderDesi'
import { StatusBadge } from './StatusBadge'

interface OrderDetailDrawerProps {
  order: CargoOrder
  products: CargoProduct[]
  busy: boolean
  onClose: () => void
  onCreateShipment: (orderId: string) => void
  onTrackShipment: (orderId: string) => void
  onDownloadZpl: (orderId: string) => void
  onPrintLabel: (orderId: string) => void
  onDesiChange: (
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) => void
  desiConfig?: TenantDesiConfig
}

export function OrderDetailDrawer({
  order,
  products,
  busy,
  onClose,
  onCreateShipment,
  onTrackShipment,
  onDownloadZpl,
  onPrintLabel,
  onDesiChange,
  desiConfig,
}: OrderDetailDrawerProps) {
  const suratVerification = verifySuratShipment(order)
  const printEligibility = resolveSuratPrintEligibility(order)
  const operationStatus = mapOperationStatus(order)
  const marketplaceStatus = mapMarketplaceStatus(
    order.marketplace,
    order.marketplaceStatus,
  )
  const resolvedStatus = resolveOrderStatus(order)
  const normalizedDesi = resolveNormalizedDesi(order)
  const desiCalculation = calculateOrderDesi(order, products, desiConfig)
  const [activeTab, setActiveTab] = useState<'details' | 'apiDebug'>('details')

  return (
    <div className="drawer-backdrop" role="presentation">
      <aside className="detail-drawer order-drawer" aria-label="Sipariş detayı">
        <div className="drawer-header">
          <div>
            <span className="eyebrow">{order.marketplace}</span>
            <h2>{order.orderNumber}</h2>
            <div className="drawer-status-stack">
              <StatusBadge
                status={operationStatus.label}
                tone={operationStatus.color}
                title={operationStatus.description}
              />
              <span title={marketplaceStatus.description}>
                Pazaryeri: {marketplaceStatus.label}
              </span>
              <span>Kaynak: {operationStatus.sourceLabel || 'CargoFlow'}</span>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="drawer-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !canCreateShipment(order)}
            onClick={() => onCreateShipment(order.id)}
          >
            <PackagePlus size={18} />
            Sürat Gönderisi Oluştur
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !hasCarrierTracking(order)}
            onClick={() => onTrackShipment(order.id)}
          >
            <Search size={18} />
            Takip Sorgula
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !canDownloadZpl(order)}
            onClick={() => onDownloadZpl(order.id)}
          >
            <Download size={18} />
            ZPL İndir
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !canMarkPrinted(order)}
            title={
              canMarkPrinted(order)
                ? printEligibility.reason
                : printEligibility.reason || 'Önce Sürat gönderisi oluşturulmalı.'
            }
            onClick={() => onPrintLabel(order.id)}
          >
            <Printer size={18} />
            {order.labelStatus === 'PRINTED'
              ? 'Tekrar Yazdır'
              : 'Etiketi Yazdır'}
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

        <div className="drawer-content">
          {activeTab === 'details' ? (
            <>
            <section className="detail-section">
              <h3>Müşteri Bilgileri</h3>
              <div className="detail-grid">
                <Detail label="Ad Soyad" value={order.customerName} />
                <Detail label="Telefon" value={order.customerPhone} />
                <Detail label="E-posta" value={order.customerEmail} />
                <Detail
                  label="Sipariş Tarihi"
                  value={formatDisplayDate(order.orderDate || order.createdAt)}
                />
                <Detail
                  label="Planlanan Teslim Tarihi"
                  value={formatDisplayDate(order.deliveryDate)}
                />
                {resolvedStatus.delivered && order.shipment?.deliveredAt ? (
                  <Detail
                    label="Gerçek Teslim Tarihi"
                    value={formatDisplayDate(order.shipment.deliveredAt)}
                  />
                ) : null}
              </div>
            </section>

            <section className="detail-section">
              <h3>Adres Bilgileri</h3>
              <div className="address-box">
                <strong>
                  {order.district} / {order.city}
                </strong>
                <span>{order.address}</span>
              </div>
            </section>

            <section className="detail-section">
              <h3>Sipariş Kalemleri</h3>
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
                  />
                ))}
              </div>
            </section>

            <section className="detail-section">
              <h3>Kargo ve Paket</h3>
              <div className="detail-grid">
                <Detail label="Toplam Tutar" value={formatCurrency(order.totalAmount)} />
                <Detail label="Paket ID" value={order.packageId || order.shipmentPackageId} />
                <Detail label="Shipment Package ID" value={order.shipmentPackageId} />
                <Detail
                  label="Kargo Firması"
                  value={
                    hasCarrierTracking(order)
                      ? 'Sürat Kargo'
                      : order.cargoProviderName || 'Bekliyor'
                  }
                />
                <Detail label="Pazaryeri Sipariş No" value={order.orderNumber} />
                <Detail
                  label="Sürat Takip No"
                  value={suratVerification.trackingNumber}
                />
                <Detail
                  label="Sürat Barkod No"
                  value={suratVerification.officialBarcodeValue}
                />
                <Detail label="T.No" value={suratVerification.tNo} />
                {order.shipment?.candidateTNo ? (
                  <Detail
                    label="Aday T.No (doğrulanmadı)"
                    value={order.shipment.candidateTNo}
                  />
                ) : null}
                {order.shipment?.candidateBarkodNo ? (
                  <Detail
                    label="Aday Barkod (doğrulanmadı)"
                    value={order.shipment.candidateBarkodNo}
                  />
                ) : null}
                <Detail
                  label="Sürat Gönderi No"
                  value={suratVerification.gonderiNo}
                />
                <Detail
                  label="İrsaliye / Waybill No"
                  value={
                    suratVerification.irsaliyeNo ||
                    suratVerification.waybillNo
                  }
                />
                <Detail
                  label="Cargo Key / API gönderi anahtarı"
                  value={suratVerification.cargoKey}
                />
                <Detail
                  label="CargoFlow iç referansı"
                  value={order.shipment?.shipmentCode}
                />
                {printEligibility.awaitingAcceptance ? (
                  <div className="detail-warning" role="status">
                    Etiket hazır — fiziksel Sürat kabulü bekleniyor. Serendip
                    kaydı tesellümden sonra doğrulanacaktır.
                  </div>
                ) : null}
                {printEligibility.canPrint &&
                !printEligibility.canDownloadZpl ? (
                  <div className="detail-warning" role="status">
                    Bu eski kayıtta taşıyıcının ham ZPL verisi bulunamadı.
                    Etiket canonical T.No/barkod/QR alanlarından HTML olarak
                    yazdırılır; ZPL İndir bu kayıt için kapalıdır.
                  </div>
                ) : null}
                {!printEligibility.awaitingAcceptance &&
                order.shipment?.candidateVerificationStatus ===
                  'PENDING_VERIFICATION' ? (
                  <div className="detail-warning" role="status">
                    Bu kodlar Serendip kaydı doğrulanmadan yazdırılamaz.
                  </div>
                ) : null}
                {order.shipment?.candidateVerificationStatus ===
                'LABEL_CREATED_NOT_REGISTERED' ? (
                  <div className="detail-warning" role="alert">
                    Etiket oluşturuldu ancak Serendip gönderi kaydı açılmadı.
                    Aday T.No ve barkod yazdırılamaz.
                  </div>
                ) : null}
                <div>
                  <span>Toplam koli desisi</span>
                  <input
                    aria-label="Toplam koli desisi"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={normalizedDesi.desi ?? ''}
                    placeholder="Desi girin"
                    onChange={(event) => {
                      const value = Number(
                        event.target.value.replace(',', '.'),
                      )
                      onDesiChange(
                        order.id,
                        Number.isFinite(value) && value > 0 ? value : null,
                        Number.isFinite(value) && value > 0
                          ? 'manual_total'
                          : null,
                      )
                    }}
                  />
                  <strong>
                    {formatDesi(normalizedDesi.desi)} ·{' '}
                    {normalizedDesi.desiSource || 'eksik'}
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
                    <strong>{formatDesi(desiCalculation.calculatedTotalDesi)}</strong>
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
                <Detail
                  label="Pazaryeri Durumu"
                  value={marketplaceStatus.label}
                />
                <Detail
                  label="Operasyon Durumu"
                  value={operationStatus.label}
                />
                <Detail
                  label="Durum Kaynağı"
                  value={operationStatus.sourceLabel}
                />
                <Detail
                  label="Sürat Kargo Durumu"
                  value={order.shipment?.carrierStatusLabel}
                />
                <Detail
                  label="Son Hareket Tarihi"
                  value={formatDisplayDate(
                    order.shipment?.suratTrackingLog?.SonHareketTarihi,
                  )}
                />
                <Detail
                  label="Sürat Doğrulama"
                  value={
                    suratVerification.verifiedShipment
                      ? `Doğrulandı - ${suratVerification.matchReason}`
                      : printEligibility.awaitingAcceptance
                        ? 'Fiziksel kabul bekleniyor'
                        : `Doğrulanmadı - ${suratVerification.matchReason}`
                  }
                />
                <Detail
                  label="Sürat Sistem Kaydı"
                  value={
                    order.shipment?.dispatchRegistrationConfirmed
                      ? 'Gerçek API tarafından kabul edildi'
                      : 'Doğrulanmadı'
                  }
                />
                <Detail
                  label="Sürat Takip No"
                  value={suratVerification.trackingNumber}
                />
                <Detail
                  label="Trendyol Takip No"
                  value={suratVerification.trendyolCargoTrackingNumber}
                />
                <Detail label="Kaynak" value="Gerçek API" />
              </div>
              {hasVerifiedSuratShipment(order) ? (
                <span className="surat-verified-badge">Sürat doğrulandı</span>
              ) : null}
              {order.errorMessage ? (
                <p className="drawer-error">{order.errorMessage}</p>
              ) : null}
            </section>
            <section className="detail-section">
              <h3>Sürat Gönderi Akışı</h3>
              {order.shipment?.suratCreateLog?.wrongServiceCalled ? (
                <p className="drawer-error">
                  Canlı ortak barkod için yanlış servis çağrıldı. Beklenen:
                  OrtakBarkodOlustur, gelen: GonderiyiKargoyaGonder.
                </p>
              ) : null}
              <div className="detail-grid">
                <Detail
                  label="Sürat Gönderi Durumu"
                  value={
                    suratVerification.verifiedShipment
                      ? 'Doğrulandı'
                      : order.operationStatus ===
                          'SURAT_TRANSFERRED_BUT_NO_BARCODE'
                        ? 'Aktarıldı, ortak barkod/takip no dönmedi'
                        : order.operationStatus ===
                            'SURAT_BARCODE_FAILED'
                          ? 'OrtakBarkodOlustur çağrıldı, KargoTakipNo/Barcode alınamadı'
                        : order.operationStatus ===
                            'SURAT_CREATED_NO_TRACKING'
                          ? 'Legacy ön kayıt yapıldı, ortak barkod alınamadı'
                      : order.shipment
                        ? 'Takip doğrulaması bekliyor'
                        : 'Gönderi oluşturulmadı'
                  }
                />
                <Detail
                  label="Gönderi Oluşturuldu mu?"
                  value={
                    order.shipment?.dispatchRegistrationConfirmed === true
                      ? 'Evet'
                      : order.shipment?.suratCreateLog
                        ? 'Hayır - API çağrısı doğrulanmadı'
                        : 'Hayır'
                  }
                />
                <Detail
                  label="Takip Sorgulandı mı?"
                  value={order.shipment?.suratTrackingLog ? 'Evet' : 'Hayır'}
                />
                <Detail
                  label="Sürat Eşleşti mi?"
                  value={suratVerification.verifiedShipment ? 'Eşleşti' : 'Eşleşmedi'}
                />
                <Detail label="Match Reason" value={suratVerification.matchReason} />
                <Detail
                  label="serviceMode"
                  value={suratVerification.serviceMode}
                />
                <Detail
                  label="operationName"
                  value={suratVerification.operationName}
                />
                <Detail
                  label="KargoTakipNo"
                  value={suratVerification.kargoTakipNo}
                />
                <Detail label="Barcode" value={suratVerification.barcode} />
                <Detail
                  label="ZPL Kaynağı"
                  value={suratVerification.zplSource}
                />
                <Detail label="packageId" value={order.packageId} />
                <Detail label="orderNumber" value={order.orderNumber} />
                <Detail
                  label="verifiedShipment"
                  value={String(suratVerification.verifiedShipment)}
                />
                <Detail
                  label="barcodeSource"
                  value={suratVerification.barcodeSource}
                />
                <Detail label="labelStatus" value={order.labelStatus} />
                <Detail
                  label="İlk Baskı"
                  value={formatDisplayDate(order.label?.printedAt)}
                />
                <Detail
                  label="Son Baskı"
                  value={formatDisplayDate(order.label?.lastPrintedAt)}
                />
                <Detail
                  label="Baskı Sayısı"
                  value={String(order.label?.printCount ?? 0)}
                />
                <Detail
                  label="Son Yazdıran"
                  value={order.label?.lastPrintedBy}
                />
                <Detail
                  label="Migration Notu"
                  value={order.printMigrationNote}
                />
                <Detail label="SatisKodu" value={suratVerification.SatisKodu} />
                <Detail
                  label="WebSiparisKodu"
                  value={suratVerification.WebSiparisKodu}
                />
                <Detail
                  label="KargoTakipNo"
                  value={
                    suratVerification.suratKargoTakipNo ||
                    suratVerification.extractedKargoTakipNo
                  }
                />
                <Detail label="TakipUrl" value={suratVerification.suratTakipUrl} />
                <Detail
                  label="Gönderilen Reference"
                  value={suratVerification.shipmentReference}
                />
                <Detail label="Created Shipment ID" value={order.shipment?.id} />
                <Detail
                  label="Tanı Mesajı"
                  value={order.shipment?.diagnosticMessage}
                />
              </div>
              <details className="raw-line-details">
                <summary>Raw SOAP response</summary>
                <pre>
                  {typeof order.shipment?.suratCreateLog?.rawResponse === 'string'
                    ? order.shipment.suratCreateLog.rawResponse
                    : JSON.stringify(
                        order.shipment?.suratCreateLog?.rawResponse,
                        null,
                        2,
                      )}
                </pre>
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
                        order.shipment?.suratTrackingLog?.KargonunDurumu || null,
                      suratKargonunDurumuSayi:
                        order.shipment?.suratTrackingLog?.KargonunDurumuSayi ||
                        null,
                      computedOperationStatus:
                        resolvedStatus.operationStatus,
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
      </aside>
    </div>
  )
}

function OrderLine({
  orderNumber,
  item,
  imageResolution,
  imageCandidates,
  matchDebug,
}: {
  orderNumber: string
  item: OrderItem
  imageResolution: ProductImageResolution
  imageCandidates: string[]
  matchDebug: ProductMatchDebug
}) {
  const imageResolvedFrom = imageResolution.imageResolvedFrom
  const product = imageResolution.matchedProduct
  const color = item.color || findVariantValue(item, 'Renk') || product?.color
  const size = item.size || findVariantValue(item, 'Beden') || product?.size
  const hasVariantInfo =
    Boolean(color || size) || Boolean(item.variantAttributes?.length)

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
          <LineDetail label="Stok Kodu" value={item.stockCode || product?.stockCode} />
          <LineDetail label="Adet" value={String(item.quantity)} />
          <LineDetail
            label="Birim Fiyat"
            value={item.price != null ? formatCurrency(item.price) : undefined}
          />
          <LineDetail
            label="Ürün ID / Content ID"
            value={[item.productCode, item.productContentId].filter(Boolean).join(' / ')}
          />
          <LineDetail label="Product Main ID" value={item.productMainId} />
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
                normalizedMerchantSku: matchDebug.normalizedMerchantSku,
                extractedModelCode: matchDebug.extractedModelCode,
                extractedSize: matchDebug.extractedSize,
                exactBarcodeMatches: matchDebug.exactBarcodeMatches,
                exactSkuMatches: matchDebug.exactSkuMatches,
                parentModelMatches: matchDebug.parentModelMatches,
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
