import type { CSSProperties } from 'react'
import { defaultLabelTypography } from '../services/integrationConfigService'
import type {
  CargoOrder,
  LabelPreviewOverrides,
  LabelTemplate,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import { buildLabelData, type LabelData, type LabelDataItem } from '../utils/labelData'
import { formatDesi } from '../utils/desi'
import { BarcodePreview } from './BarcodePreview'
import {
  PRODUCT_FIT_TIERS,
  PRODUCT_OVERFLOW_MESSAGE,
} from '../utils/labelProductFit'
import { ROUTE_FIT_TIERS } from '../utils/labelRouteFit'
import { resolveLabelLayout } from '../utils/labelLayoutResolver'

// Sigmayan durumda yalniz UYARI gosterilir; asagidaki kademe SADECE CSS
// degiskenleri icin guvenli varsayilandir (etiket zaten basilmaz).
const FALLBACK_PRODUCT_TIER = PRODUCT_FIT_TIERS[PRODUCT_FIT_TIERS.length - 1]
const FALLBACK_ROUTE_TIER = ROUTE_FIT_TIERS[ROUTE_FIT_TIERS.length - 1]
import { QrCodeSvg } from './QrCodeSvg'

interface LabelHtmlPreviewProps {
  order?: CargoOrder
  labelData?: LabelData
  productName?: string
  mappingConfig?: SuratLabelMappingConfig
  template?: LabelTemplate
  overrides?: LabelPreviewOverrides
  compact?: boolean
}

export function LabelHtmlPreview({
  order,
  labelData,
  productName,
  mappingConfig,
  template,
  overrides,
  compact = false,
}: LabelHtmlPreviewProps) {
  const data =
    labelData ??
    buildLabelData(order, order?.shipment, template, mappingConfig)

  if (!order && !labelData) {
    return (
      <div className="label-preview-empty">
        Bu ürünle eşleşen sipariş bulunamadı. Etiket önizlemesi için sipariş
        çekildikten sonra tekrar dene.
      </div>
    )
  }

  const trackingText = data.tNo || '-'
  const leftReference =
    overrides?.leftReference ||
    data.leftVerticalReference ||
    data.shipmentReference ||
    data.orderNumber
  const primaryItem = data.items[0]
  const productTitle =
    overrides?.productTitle ||
    productName ||
    formatProductTitle(primaryItem) ||
    'Ürün bilgisi yok'
  const productMeta =
    overrides?.productMeta ?? formatProductMeta(primaryItem)
  const branchName = overrides?.branchName || data.branchName
  const recipientName = overrides?.recipientName || data.recipientName
  const barcodeValue = data.barcodeValue
  const routeCenter = overrides?.routeCenter || data.routeCenter
  const transferCenter = overrides?.transferCenter || data.transferCenter
  // Onizleme, on kontrol ve baski AYNI cozumleyiciyi kullanir: ayni siparis
  // icin farkli profil/karar CIKMAZ (preview == preflight == print).
  const layout = resolveLabelLayout({
    items: (data.items ?? []).map((line) => ({
      productName: String(line.productName ?? ''),
      quantity: Number(line.quantity) || 1,
      color: line.color,
      size: line.size,
      sku: line.sku,
    })),
    destination: routeCenter,
    transfer: transferCenter,
  })
  const productFit = layout.ok
    ? layout.productFit
    : { fits: false, tier: FALLBACK_PRODUCT_TIER }
  const routeFit = layout.ok
    ? layout.routeFit
    : { tier: FALLBACK_ROUTE_TIER }
  const desi =
    overrides?.desi !== undefined ? overrides.desi : data.desi
  const addressLines = splitAddress(data.address)
  const typography = {
    ...defaultLabelTypography,
    ...template?.typography,
  }
  const labelStyle = {
    '--label-header-name-size': `${fitFont(typography.headerName, recipientName, 28, 11)}px`,
    '--label-address-size': `${typography.address}px`,
    '--label-route-size': `${fitFont(typography.route, routeCenter, 20, 12)}px`,
    '--label-cargo-value-size': `${typography.cargoValue}px`,
    '--label-delivery-title-size': `${typography.deliveryTitle}px`,
    // Baski yoluyla AYNI sigdirma sozlesmesi (resolveProductFit): once normal
    // punto, sigmazsa minimuma kadar kademeli kucultme. Kirpma YOK.
    '--label-product-title-size': `${productFit.tier.titlePt}pt`,
    '--label-product-meta-size': `${productFit.tier.metaPt}pt`,
    '--label-product-line-height': `${productFit.tier.lineHeight}`,
    // Rota puntosu: resolveRouteFit GÜVENLİ ÜST SINIRDIR (baskı ile aynı
    // sözleşme). Şablon editöründeki değer daha KÜÇÜKSE o uygulanır; daha
    // büyükse taşmayı önlemek için kademe kazanır.
    '--label-delivery-route-size': `${Math.min(
      routeFit.tier.destinationPt,
      typography.deliveryRoute * 0.75,
    )}pt`,
    '--label-transfer-size': `${Math.min(
      routeFit.tier.transferPt,
      typography.transfer * 0.75,
    )}pt`,
    '--label-route-line-height': `${routeFit.tier.lineHeight}`,
  } as CSSProperties

  return (
    <div className={compact ? 'html-label-stage compact' : 'html-label-stage'}>
      <article
        className="surat-common-label"
        aria-label="Sürat Kargo ortak barkod etiketi"
        style={labelStyle}
      >
        <aside className="surat-rail">
          <strong>SURAT KARGO</strong>
          <span>Ref No: {leftReference}</span>
        </aside>

        <div className="surat-label-body">
          <header className="surat-section surat-header-section">
            <div className="surat-header-left">
              <span>
                Şube: <strong>{branchName}</strong>
              </span>
              <b>{recipientName}</b>
              <span>MUST.IRS.NO: {data.orderNumber}</span>
            </div>
            <div className="surat-header-right">
              <span>
                T.No: <strong>{trackingText}</strong>
              </span>
              <span>TEL: {maskPhone(data.recipientPhone)}</span>
            </div>
          </header>

          <section className="surat-section surat-barcode-section">
            <BarcodePreview
              value={barcodeValue}
              height={78}
              width={3.4}
              margin={0}
              fontSize={23}
              displayValue
              className="surat-main-barcode"
            />
          </section>

          <section className="surat-section surat-address-section">
            <div className="surat-address-copy">
              <b>{recipientName}</b>
              {addressLines.map((line, index) => (
                <span key={`${line}-${index}`}>{line}</span>
              ))}
              <div className="surat-address-footer">
                <span className="surat-address-phone">
                  TEL: {maskPhone(data.recipientPhone)}
                </span>
                <strong className="surat-address-region">{routeCenter}</strong>
              </div>
            </div>
          </section>

          <section className="surat-section surat-cargo-section">
            <div>
              <span>OdemeTipi</span>
              <strong>POCH</strong>
            </div>
            <div>
              <span>Birim</span>
              <strong>KOLI</strong>
            </div>
            <div>
              <span>Top Ds/Kg</span>
              <strong>{formatDesi(desi).replace('.', ',')}</strong>
            </div>
          </section>

          <section className="surat-section surat-delivery-section">
            <QrCodeSvg
              value={`${data.orderNumber}|${barcodeValue}`}
              title="Büyük teslimat QR kodu"
              className="surat-large-qr"
            />
            <div className="surat-delivery-copy">
              <span>Parca Adedi</span>
              {/* Referans: "1 / 1" ile "Adrese Teslim" AYNI satırda. */}
              <div className="surat-parcel-row">
                <b>1 / 1</b>
                <strong>Adrese Teslim</strong>
              </div>
              <em>{routeCenter}</em>
              <strong className="surat-transfer">{transferCenter}</strong>
            </div>
            <QrCodeSvg
              value={barcodeValue}
              title="Küçük takip QR kodu"
              className="surat-small-qr"
            />
          </section>

          <footer className="surat-section surat-product-section">
            {productFit.fits ? (
              <>
                <strong>{productTitle}</strong>
                <span>{productMeta}</span>
              </>
            ) : (
              <strong className="surat-product-overflow">
                {PRODUCT_OVERFLOW_MESSAGE}
              </strong>
            )}
          </footer>
        </div>
      </article>
    </div>
  )
}

function formatProductTitle(item?: LabelDataItem): string {
  if (!item) return ''
  return `${item.quantity || 1} x ${item.productName}`.trim()
}

// Referans etiketteki biçim: "(Renk: X, Beden: Y) [sku/varyant/model kodu]".
// Eksik alanlar atlanır; boş parantez veya boş köşeli parantez BASILMAZ.
// Yazdırma tarafındaki buildReferenceProductMeta ile AYNI sözleşmedir.
function formatProductMeta(item?: LabelDataItem): string {
  if (!item) return ''
  const attrs = [
    item.color ? `Renk: ${item.color}` : '',
    item.size ? `Beden: ${item.size}` : '',
  ].filter(Boolean)
  const grouped = attrs.length > 0 ? `(${attrs.join(', ')})` : ''
  const code = item.sku ? `[${item.sku}]` : ''
  return [grouped, code].filter(Boolean).join(' ')
}

function splitAddress(address: string): string[] {
  const words = String(address || '-').split(/\s+/).filter(Boolean)
  const lines: string[] = []

  for (const word of words) {
    const current = lines[lines.length - 1] ?? ''
    if (!current || current.length + word.length > 42) {
      if (lines.length < 3) lines.push(word)
    } else {
      lines[lines.length - 1] = `${current} ${word}`
    }
  }

  return lines.length > 0 ? lines : ['-']
}

function maskPhone(phone: string): string {
  const normalized = String(phone ?? '').replace(/\s+/g, '')
  if (normalized.length < 7) return phone || '-'
  return `${normalized.slice(0, 3)}*****${normalized.slice(-2)}`
}

function fitFont(
  baseSize: number,
  value: string,
  comfortableLength: number,
  minimumSize: number,
): number {
  const length = Array.from(String(value || '')).length
  if (length <= comfortableLength) return baseSize
  const fitted = Math.floor((baseSize * comfortableLength) / length)
  return Math.max(minimumSize, Math.min(baseSize, fitted))
}
