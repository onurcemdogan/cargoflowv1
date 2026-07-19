import { Barcode, Download, PackagePlus, RefreshCcw, Stamp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { OrderDetailDrawer } from '../components/OrderDetailDrawer'
import { OrdersTable } from '../components/OrdersTable'
import { PageHeader } from '../components/PageHeader'
import type {
  CargoFilter,
  CargoOrder,
  CargoProduct,
  MarketplaceName,
  MarketplaceStatus,
  OrderStatusFilter,
  SuratLabelMappingConfig,
  TenantDesiConfig,
  TrendyolOrderDebug,
  WorkflowResult,
} from '../types/cargoflow'
import {
  canCreateShipment,
  canDownloadZpl,
  canMarkHandedToCargo,
  canMarkPrinted,
} from '../utils/orderStatus'
import {
  buildVisibleOrders,
  classifyOrderForTabs,
} from '../utils/orderClassification'
import {
  statusesForFetch,
  type QuickTab,
} from '../utils/ordersTabs'
import { mapMarketplaceStatus } from '../utils/statusPresentation'
import { formatDisplayDate } from '../utils/formatters'
import type {
  OrdersActionFilter,
  OrdersDatePreset,
  OrdersNavigationFilters,
} from '../utils/ordersNavigation'

interface OrdersPageProps {
  orders: CargoOrder[]
  products: CargoProduct[]
  selectedIds: string[]
  lastResult?: WorkflowResult
  syncDebug?: TrendyolOrderDebug
  busy: boolean
  lastSyncAt?: string
  initialQuickTab?: QuickTab
  initialOrderId?: string
  initialFilters?: OrdersNavigationFilters
  onToggleOrder: (orderId: string) => void
  onToggleAll: (visibleIds: string[]) => void
  onFetchOrders: (options?: OrdersFetchOptions) => void
  onCreateShipments: () => void
  onCreateShipmentForOrder: (orderId: string) => void
  onTrackShipments: () => void
  onTrackShipmentForOrder: (orderId: string) => void
  onDownloadZpl: () => void
  onDownloadZplForOrder: (
    orderId: string,
    mappingConfig?: SuratLabelMappingConfig,
  ) => void
  onDesiChange: (
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) => void
  desiConfig?: TenantDesiConfig
  onMarkPrinted: () => void
  onMarkPrintedForOrder: (orderId: string) => void
  onMarkHandedToCargo: () => void
}

export interface OrdersFetchOptions {
  statuses?: MarketplaceStatus[]
  startDate?: Date
  endDate?: Date
  allDates?: boolean
  silent?: boolean
}

const marketplaces: Array<'all' | MarketplaceName> = [
  'all',
  'Trendyol',
  'Hepsiburada',
  'N11',
  'Shopify',
  'Manuel',
]

const statusOptions: OrderStatusFilter[] = [
  'all',
  'Yeni',
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'Delivered',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
  'AtCollectionPoint',
  'Ön Kayıt Yapıldı',
  'Kargo Oluşturuldu',
  'Etiket Hazır',
  'Etiket Oluşturuldu',
  'Etiket Basıldı',
  'Hata',
]

const cargoOptions: CargoFilter[] = ['all', 'Sürat Kargo', 'Bekliyor', 'Hatalı']

const quickTabs: Array<{ key: QuickTab; label: string }> = [
  { key: 'currentSync', label: 'Bugün Gelen Siparişler' },
  { key: 'open', label: 'Tüm Açık Operasyonlar' },
  { key: 'barcodePending', label: 'Barkod Bekleyenler' },
  { key: 'shipmentPending', label: 'Kargo Oluşturulacaklar' },
  { key: 'suratVerificationPending', label: 'Sürat Doğrulama Bekleyenler' },
  { key: 'labelReady', label: 'Etiket Basılacaklar' },
  { key: 'labelPrinted', label: 'Etiket Basılanlar' },
  { key: 'handedToCargo', label: 'Kargoya Verilenler' },
  { key: 'delivered', label: 'Teslim Edilenler' },
  { key: 'cancelReturn', label: 'İptal / İade' },
  { key: 'archive', label: 'Arşiv' },
  { key: 'all', label: 'Tümü' },
]

const dateRangeOptions: Array<{ key: OrdersDatePreset; label: string }> = [
  { key: 'all', label: 'Tüm Tarihler' },
  { key: 'today', label: 'Bugün' },
  { key: 'yesterday', label: 'Dün' },
  { key: 'last3', label: 'Son 3 Gün' },
  { key: 'last7', label: 'Son 7 Gün' },
  { key: 'last30', label: 'Son 30 Gün' },
  { key: 'custom', label: 'Tarih Aralığı' },
]

export function OrdersPage({
  orders,
  products,
  selectedIds,
  lastResult,
  syncDebug,
  busy,
  lastSyncAt,
  initialQuickTab,
  initialOrderId,
  initialFilters,
  onToggleOrder,
  onToggleAll,
  onFetchOrders,
  onCreateShipments,
  onCreateShipmentForOrder,
  onTrackShipments,
  onTrackShipmentForOrder,
  onDownloadZpl,
  onDownloadZplForOrder,
  onDesiChange,
  desiConfig,
  onMarkPrinted,
  onMarkPrintedForOrder,
  onMarkHandedToCargo,
}: OrdersPageProps) {
  const [marketplace, setMarketplace] = useState<'all' | MarketplaceName>(
    initialFilters?.marketplace ?? 'all',
  )
  const [city, setCity] = useState(initialFilters?.city ?? 'all')
  const [status, setStatus] = useState<OrderStatusFilter>('all')
  const [cargo, setCargo] = useState<CargoFilter>('all')
  const [query, setQuery] = useState('')
  const [datePreset, setDatePreset] = useState<OrdersDatePreset>(
    initialFilters?.datePreset ?? 'all',
  )
  const [customStartDate, setCustomStartDate] = useState(
    initialFilters?.customStartDate ?? '',
  )
  const [customEndDate, setCustomEndDate] = useState(
    initialFilters?.customEndDate ?? '',
  )
  const [actionFilter, setActionFilter] = useState<OrdersActionFilter>(
    initialFilters?.actionFilter ?? 'all',
  )
  const [activeQuickTab, setActiveQuickTab] = useState<QuickTab>(
    initialQuickTab ?? 'currentSync',
  )
  const [activeOrderId, setActiveOrderId] = useState<string | undefined>(
    initialOrderId,
  )
  const activeOrder = orders.find((order) => order.id === activeOrderId)
  const dateRange = useMemo(
    () => buildDateRange(datePreset, customStartDate, customEndDate),
    [customEndDate, customStartDate, datePreset],
  )

  const visibleOrdersResult = useMemo(
    () =>
      buildVisibleOrders({
        persistentOrders: orders,
        selectedTab: activeQuickTab,
        marketplaceFilter: marketplace,
        operationStatusFilter: status,
        cargoFilter: cargo,
        cityFilter: city,
        actionFilter,
        dateFilter: {
          preset: datePreset,
          startTime: dateRange.startTime,
          endTime: dateRange.endTime,
        },
        searchQuery: query,
      }),
    [
      activeQuickTab,
      actionFilter,
      cargo,
      city,
      datePreset,
      dateRange.endTime,
      dateRange.startTime,
      marketplace,
      orders,
      query,
      status,
    ],
  )
  const filteredOrders = visibleOrdersResult.visibleOrders

  const selectedOrders = useMemo(
    () => orders.filter((order) => selectedIds.includes(order.id)),
    [orders, selectedIds],
  )
  const hasShipmentCreatableSelection = selectedOrders.some(canCreateShipment)
  const hasZplDownloadableSelection = selectedOrders.some(canDownloadZpl)
  const hasPrintableSelection = selectedOrders.some(canMarkPrinted)
  const hasHandedToCargoSelection = selectedOrders.some(canMarkHandedToCargo)
  const tabCounts = useMemo(
    () =>
      Object.fromEntries(
        quickTabs.map((tab) => [
          tab.key,
          buildVisibleOrders({
            persistentOrders: orders,
            selectedTab: tab.key,
            marketplaceFilter: marketplace,
            operationStatusFilter: status,
            cargoFilter: cargo,
            cityFilter: city,
            actionFilter,
            dateFilter: {
              preset: datePreset,
              startTime: dateRange.startTime,
              endTime: dateRange.endTime,
            },
            searchQuery: query,
          }).visibleOrders.length,
        ]),
      ) as Record<QuickTab, number>,
    [
      actionFilter,
      cargo,
      city,
      datePreset,
      dateRange.endTime,
      dateRange.startTime,
      marketplace,
      orders,
      query,
      status,
    ],
  )
  const orderSummary = useMemo(() => {
    const classifications = orders.map(classifyOrderForTabs)
    return {
      totalOrders: orders.length,
      openOperations: classifications.filter((item) => item.isOpenOperation)
        .length,
    }
  }, [orders])
  const cityOptions = useMemo(
    () =>
      Array.from(
        new Set(orders.map((order) => String(order.city || '').trim()).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right, 'tr-TR')),
    [orders],
  )

  const selectionText =
    selectedIds.length === 0
      ? 'Seçili sipariş yok'
      : `${selectedIds.length} sipariş seçildi`
  const listedLineCount = filteredOrders.reduce(
    (total, order) => total + order.items.length,
    0,
  )
  const listedQuantity = filteredOrders.reduce(
    (total, order) =>
      total + order.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0),
    0,
  )

  function refreshForTab(tab: QuickTab) {
    setActiveQuickTab(tab)
    setMarketplace('all')
    setStatus('all')
    setCargo('all')
    setCity('all')
    setActionFilter('all')
    setQuery('')
    onFetchOrders({
      statuses: statusesForFetch(tab),
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      allDates: datePreset === 'all',
    })
  }

  return (
    <>
      <PageHeader
        title="Siparişler"
        description="Pazaryeri, statü, kargo, arama ve tarih filtresiyle operasyon listesini yönet."
        actions={
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              onFetchOrders({
                statuses: statusesForFetch(activeQuickTab),
                startDate: dateRange.startDate,
                endDate: dateRange.endDate,
                allDates: datePreset === 'all',
              })
            }
            disabled={busy}
          >
            <RefreshCcw size={18} />
            Şimdi Yenile
          </button>
        }
      />

      <section className="sync-strip">
        <span className="sync-ok">● Son senkronizasyon: {formatSyncTime(lastSyncAt)}</span>
        {busy ? <span className="sync-running">↻ Senkronizasyon sürüyor...</span> : null}
      </section>

      <section className="quick-tabs" aria-label="Sipariş hızlı sekmeleri">
        {quickTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={activeQuickTab === tab.key ? 'active' : ''}
            onClick={() => refreshForTab(tab.key)}
            disabled={busy && activeQuickTab === tab.key}
          >
            {tab.label} ({tabCounts[tab.key]})
            {busy && activeQuickTab === tab.key ? ' · yenileniyor' : ''}
          </button>
        ))}
      </section>

      <section className="filter-panel">
        <label>
          <span>Pazaryeri</span>
          <select
            value={marketplace}
            onChange={(event) =>
              setMarketplace(event.target.value as 'all' | MarketplaceName)
            }
          >
            {marketplaces.map((item) => (
              <option key={item} value={item}>
                {item === 'all' ? 'Tümü' : item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Statü</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as OrderStatusFilter)}
          >
            {statusOptions.map((item) => (
              <option key={item} value={item}>
                {statusOptionLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Kargo</span>
          <select
            value={cargo}
            onChange={(event) => setCargo(event.target.value as CargoFilter)}
          >
            {cargoOptions.map((item) => (
              <option key={item} value={item}>
                {item === 'all' ? 'Tümü' : item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Şehir</span>
          <select value={city} onChange={(event) => setCity(event.target.value)}>
            <option value="all">Tümü</option>
            {cityOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Arama</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Sipariş no, müşteri, telefon, ürün, SKU"
          />
        </label>
        <label>
          <span>Tarih</span>
          <select
            value={datePreset}
            onChange={(event) => setDatePreset(event.target.value as OrdersDatePreset)}
          >
            {dateRangeOptions.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {datePreset === 'custom' ? (
          <>
            <label>
              <span>Başlangıç</span>
              <input
                type="date"
                value={customStartDate}
                onChange={(event) => setCustomStartDate(event.target.value)}
              />
            </label>
            <label>
              <span>Bitiş</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(event) => setCustomEndDate(event.target.value)}
              />
            </label>
          </>
        ) : null}
      </section>

      {actionFilter !== 'all' ? (
        <button
          type="button"
          className="orders-dashboard-filter-chip"
          onClick={() => setActionFilter('all')}
        >
          Dashboard aksiyon filtresi: {actionFilterLabel(actionFilter)} ×
        </button>
      ) : null}

      <section className="toolbar">
        <div>
          <strong>{selectionText}</strong>
          <span>{filteredOrders.length} paket/sipariş listeleniyor.</span>
          <span>{listedLineCount} ürün kalemi</span>
          <span>{listedQuantity} toplam adet</span>
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkPrinted}
            disabled={busy || selectedIds.length === 0 || !hasPrintableSelection}
          >
            <Barcode size={18} />
            Barkod Bas
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onCreateShipments}
            disabled={
              busy || selectedIds.length === 0 || !hasShipmentCreatableSelection
            }
          >
            <PackagePlus size={18} />
            Ortak Barkod Oluştur / Tamamla
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onTrackShipments}
            disabled={busy || selectedIds.length === 0}
          >
            <RefreshCcw size={18} />
            Seçilenleri Yenile / Doğrula
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onDownloadZpl}
            disabled={
              busy || selectedIds.length === 0 || !hasZplDownloadableSelection
            }
          >
            <Download size={18} />
            ZPL İndir
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkPrinted}
            disabled={busy || selectedIds.length === 0 || !hasPrintableSelection}
          >
            <Stamp size={18} />
            Yazdır / Tekrar Yazdır
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkHandedToCargo}
            disabled={busy || selectedIds.length === 0 || !hasHandedToCargoSelection}
          >
            <PackagePlus size={18} />
            Kargoya Verildi Yap
          </button>
        </div>
      </section>

      <ActionResult result={lastResult} />

      <section className="debug-panel orders-filter-debug">
        <strong>Sipariş Listeleme Debug</strong>
        <div>
          <span>rawOrdersCount</span>
          <code>
            {syncDebug?.rawOrdersCount ??
              lastResult?.debug?.rawOrdersCount ??
              '-'}
          </code>
        </div>
        <div>
          <span>normalizedOrdersCount</span>
          <code>
            {syncDebug?.normalizedOrdersCount ??
              lastResult?.debug?.normalizedOrdersCount ??
              '-'}
          </code>
        </div>
        <div><span>persistentOrdersCount</span><code>{orders.length}</code></div>
        <div><span>OrdersPageCatalogCount</span><code>{products.length}</code></div>
        <div><span>catalogRevision</span><code>{products.length}</code></div>
        <div><span>latestSyncAt</span><code>{visibleOrdersResult.debug.latestSyncAt ? formatDisplayDate(visibleOrdersResult.debug.latestSyncAt) : '-'}</code></div>
        <div><span>latestSyncOrderCount</span><code>{visibleOrdersResult.debug.latestSyncCount}</code></div>
        <div><span>dashboardSummary.totalOrders</span><code>{orderSummary.totalOrders}</code></div>
        <div><span>dashboardSummary.openOperations</span><code>{orderSummary.openOperations}</code></div>
        <div><span>visibleOrdersCount</span><code>{filteredOrders.length}</code></div>
        <div><span>selectedTab</span><code>{activeQuickTab}</code></div>
        <div><span>selectedMarketplaceFilter</span><code>{marketplace}</code></div>
        <div><span>selectedStatusFilter</span><code>{status}</code></div>
        <div><span>selectedCargoFilter</span><code>{cargo}</code></div>
        <div><span>selectedDateFilter</span><code>{datePreset}</code></div>
        <div><span>selectedActionFilter</span><code>{actionFilter}</code></div>
        <div><span>searchQuery</span><code>{query || '-'}</code></div>
        <div><span>afterTabFilterCount</span><code>{visibleOrdersResult.debug.afterTabFilter}</code></div>
        <div><span>afterMarketplaceFilterCount</span><code>{visibleOrdersResult.debug.afterMarketplaceFilter}</code></div>
        <div><span>afterStatusFilterCount</span><code>{visibleOrdersResult.debug.afterOperationStatusFilter}</code></div>
        <div><span>afterCargoFilterCount</span><code>{visibleOrdersResult.debug.afterCargoFilter}</code></div>
        <div><span>afterActionFilterCount</span><code>{visibleOrdersResult.debug.afterActionFilter}</code></div>
        <div><span>afterDateFilterCount</span><code>{visibleOrdersResult.debug.afterDateFilter}</code></div>
        <div><span>afterSearchFilterCount</span><code>{visibleOrdersResult.debug.afterSearch}</code></div>
      </section>

      {lastResult?.bulkActionDebug ? (
        <section className="debug-panel bulk-action-debug">
          <strong>Toplu İşlem Debug</strong>
          {Object.entries(lastResult.bulkActionDebug).map(([key, value]) => (
            <div key={key}>
              <span>{key}</span>
              <code>
                {Array.isArray(value) ? value.join(', ') || '-' : String(value)}
              </code>
            </div>
          ))}
        </section>
      ) : null}

      <OrdersTable
        orders={filteredOrders}
        products={products}
        selectedIds={selectedIds}
        onToggleOrder={onToggleOrder}
        onToggleAll={() => onToggleAll(filteredOrders.map((order) => order.id))}
        onOpenOrder={setActiveOrderId}
        onDesiChange={onDesiChange}
        emptyMessage={
          orders.length > 0
            ? 'Bu filtreye uygun sipariş bulunamadı.'
            : 'Henüz sipariş çekilmedi.'
        }
        emptyDetails={
          orders.length > 0
            ? [
                `Tab: ${quickTabs.find((tab) => tab.key === activeQuickTab)?.label ?? activeQuickTab}`,
                `Pazaryeri: ${marketplace === 'all' ? 'Tümü' : marketplace}`,
                `Statü: ${status === 'all' ? 'Tümü' : statusOptionLabel(status)}`,
                `Kargo: ${cargo === 'all' ? 'Tümü' : cargo}`,
                `Tarih: ${dateRangeOptions.find((item) => item.key === datePreset)?.label ?? datePreset}`,
                `Arama: ${query || '-'}`,
              ]
            : []
        }
      />

      {activeOrder ? (
        <OrderDetailDrawer
          order={activeOrder}
          products={products}
          busy={busy}
          onClose={() => setActiveOrderId(undefined)}
          onCreateShipment={onCreateShipmentForOrder}
          onTrackShipment={onTrackShipmentForOrder}
          onDownloadZpl={onDownloadZplForOrder}
          onPrintLabel={onMarkPrintedForOrder}
          onDesiChange={onDesiChange}
          desiConfig={desiConfig}
        />
      ) : null}
    </>
  )
}

function buildDateRange(
  preset: OrdersDatePreset,
  customStartDate: string,
  customEndDate: string,
) {
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now)
  todayEnd.setHours(23, 59, 59, 999)

  if (preset === 'all') {
    return {
      startDate: undefined,
      endDate: undefined,
      startTime: Number.NEGATIVE_INFINITY,
      endTime: Number.POSITIVE_INFINITY,
    }
  }
  if (preset === 'today') return toDateRange(todayStart, todayEnd)
  if (preset === 'yesterday') {
    const start = new Date(todayStart)
    start.setDate(start.getDate() - 1)
    const end = new Date(todayEnd)
    end.setDate(end.getDate() - 1)
    return toDateRange(start, end)
  }
  if (preset === 'custom' && customStartDate && customEndDate) {
    return toDateRange(
      new Date(`${customStartDate}T00:00:00`),
      new Date(`${customEndDate}T23:59:59.999`),
    )
  }

  const days = preset === 'last3' ? 3 : preset === 'last30' ? 30 : 7
  const start = new Date(todayStart)
  start.setDate(start.getDate() - (days - 1))
  return toDateRange(start, todayEnd)
}

function toDateRange(startDate: Date, endDate: Date) {
  return {
    startDate,
    endDate,
    startTime: startDate.getTime(),
    endTime: endDate.getTime(),
  }
}

function formatSyncTime(value?: string): string {
  return value ? formatDisplayDate(value) : 'Bekleniyor'
}

function actionFilterLabel(filter: OrdersActionFilter): string {
  if (filter === 'createEligible') return 'Barkod oluşturulabilir'
  if (filter === 'printEligible') return 'Etiketi basılabilir'
  if (filter === 'critical') return 'Hatalı / kritik bilgi eksik'
  return 'Tümü'
}

function statusOptionLabel(item: OrderStatusFilter): string {
  if (item === 'all') return 'Tümü'
  const marketplaceStatuses = [
    'Created',
    'Picking',
    'Invoiced',
    'Shipped',
    'Delivered',
    'Cancelled',
    'Returned',
    'UnDelivered',
    'UnSupplied',
    'AtCollectionPoint',
  ]
  return marketplaceStatuses.includes(item)
    ? mapMarketplaceStatus('trendyol', item).label
    : item
}
