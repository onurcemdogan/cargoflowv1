import {
  Barcode,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Filter,
  PackagePlus,
  RefreshCcw,
  Stamp,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
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
import { buildVisibleOrders } from '../utils/orderClassification'
import {
  resolveLegacyTab,
  statusesForFetch,
  type OperationTabFilter,
  type QuickTab,
} from '../utils/ordersTabs'
import { mapMarketplaceStatus } from '../utils/statusPresentation'
import { formatDisplayDate } from '../utils/formatters'
import {
  paginateOrders,
  sortOrdersForWorkspace,
  visiblePageNumbers,
  type OrdersSortDirection,
  type OrdersSortKey,
} from '../utils/ordersWorkspace'
import type {
  OrdersActionFilter,
  OrdersDatePreset,
  OrdersNavigationFilters,
} from '../utils/ordersNavigation'
import { buildOrderCountSummary } from '../utils/orderCounts'
import { buildOrdersDateRange } from '../utils/orderDateRange'

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
  'Unknown',
  'Ön Kayıt Yapıldı',
  'Kargo Oluşturuldu',
  'Etiket Hazır',
  'Etiket Oluşturuldu',
  'Etiket Basıldı',
  'Hata',
]

const cargoOptions: CargoFilter[] = ['all', 'Sürat Kargo', 'Bekliyor', 'Hatalı']

// Görünür ana sekmeler: yalnız temel iş akışı. Teknik durumlar "İşlem
// Durumu" filtresiyle, "Bugün Gelenler" ise tarih filtresiyle erişilir.
// Mevcut tab key'leri, classifier'ları ve sayaç hesapları korunur.
const quickTabs: Array<{ key: QuickTab; label: string }> = [
  { key: 'newOrders', label: 'Yeni Siparişler' },
  { key: 'labelStage', label: 'Etiket Hazır' },
  { key: 'handedToCargo', label: 'Kargoya Verildi' },
  { key: 'delivered', label: 'Teslim Edildi' },
  { key: 'cancelReturn', label: 'İptal / İade' },
  { key: 'all', label: 'Tümü' },
]

// "İşlem Durumu" filtresi seçenekleri: teknik yaşam-döngüsü durumlarına
// (mevcut classifier'lar) kullanıcı dostu etiketlerle erişim.
const operationTabOptions: Array<{ key: OperationTabFilter; label: string }> = [
  { key: 'all', label: 'Tüm İşlem Durumları' },
  { key: 'barcodePending', label: 'Barkod Bekliyor' },
  { key: 'shipmentPending', label: 'Kargo Oluşturulacak' },
  { key: 'suratVerificationPending', label: 'Doğrulama Bekliyor' },
  { key: 'labelReady', label: 'Etiket Basılacak' },
  { key: 'labelPrinted', label: 'Etiket Basıldı' },
  { key: 'archive', label: 'Arşiv' },
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
  const [district, setDistrict] = useState('all')
  const [status, setStatus] = useState<OrderStatusFilter>('all')
  const [cargo, setCargo] = useState<CargoFilter>('all')
  const [query, setQuery] = useState('')
  const [customerQuery, setCustomerQuery] = useState('')
  const [productQuery, setProductQuery] = useState('')
  const [orderNumberQuery, setOrderNumberQuery] = useState('')
  const [cargoSlipQuery, setCargoSlipQuery] = useState('')
  const [multiProductFilter, setMultiProductFilter] = useState<
    'all' | 'single' | 'multi'
  >('all')
  const [filtersExpanded, setFiltersExpanded] = useState(true)
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
    () => resolveLegacyTab(initialQuickTab).tab,
  )
  const [operationTab, setOperationTab] = useState<OperationTabFilter>(
    () => resolveLegacyTab(initialQuickTab).operationTab,
  )
  const [activeOrderId, setActiveOrderId] = useState<string | undefined>(
    initialOrderId,
  )
  const [expandedOrderId, setExpandedOrderId] = useState<string>()
  const [sortKey, setSortKey] = useState<OrdersSortKey>('orderDate')
  const [sortDirection, setSortDirection] =
    useState<OrdersSortDirection>('desc')
  const [pageSize, setPageSize] = useState(25)
  const [currentPage, setCurrentPage] = useState(1)
  const activeOrder = orders.find((order) => order.id === activeOrderId)
  const dateRange = useMemo(
    () => buildOrdersDateRange(datePreset, customStartDate, customEndDate),
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
        districtFilter: district,
        multiProductFilter,
        actionFilter,
        operationTabFilter: operationTab,
        dateFilter: {
          preset: datePreset,
          startTime: dateRange.startTime,
          endTime: dateRange.endTime,
          timezone: dateRange.timezone,
        },
        searchQuery: query,
        customerQuery,
        productQuery,
        orderNumberQuery,
        cargoSlipQuery,
      }),
    [
      activeQuickTab,
      actionFilter,
      operationTab,
      cargo,
      cargoSlipQuery,
      city,
      customerQuery,
      datePreset,
      dateRange.endTime,
      dateRange.startTime,
      dateRange.timezone,
      marketplace,
      district,
      multiProductFilter,
      orderNumberQuery,
      orders,
      productQuery,
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
  const printableDisabledReason = bulkDisabledReason(
    busy,
    selectedIds.length,
    hasPrintableSelection,
    'Seçimde yazdırılabilir etiket yok.',
  )
  const createDisabledReason = bulkDisabledReason(
    busy,
    selectedIds.length,
    hasShipmentCreatableSelection,
    'Seçimde kargo gönderisi oluşturulabilecek sipariş yok.',
  )
  const zplDisabledReason = bulkDisabledReason(
    busy,
    selectedIds.length,
    hasZplDownloadableSelection,
    'Seçimde indirilebilir ZPL yok.',
  )
  const handedDisabledReason = bulkDisabledReason(
    busy,
    selectedIds.length,
    hasHandedToCargoSelection,
    'Seçimde kargoya verildi yapılabilecek sipariş yok.',
  )
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
            districtFilter: district,
            multiProductFilter,
            actionFilter,
            // operationTab (İşlem Durumu) SAYAÇLARA uygulanmaz: ana sekme
            // sayaçları aşama toplamını gösterir, teknik alt-filtre yalnız
            // görünür listeyi daraltır.
            dateFilter: {
              preset: datePreset,
              startTime: dateRange.startTime,
              endTime: dateRange.endTime,
              timezone: dateRange.timezone,
            },
            searchQuery: query,
            customerQuery,
            productQuery,
            orderNumberQuery,
            cargoSlipQuery,
          }).visibleOrders.length,
        ]),
      ) as Record<QuickTab, number>,
    [
      actionFilter,
      cargo,
      cargoSlipQuery,
      city,
      customerQuery,
      datePreset,
      dateRange.endTime,
      dateRange.startTime,
      dateRange.timezone,
      marketplace,
      district,
      multiProductFilter,
      orderNumberQuery,
      orders,
      productQuery,
      query,
      status,
    ],
  )
  const cityOptions = useMemo(
    () =>
      Array.from(
        new Set(orders.map((order) => String(order.city || '').trim()).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right, 'tr-TR')),
    [orders],
  )
  const districtOptions = useMemo(
    () =>
      Array.from(
        new Set(
          orders
            .filter(
              (order) => city === 'all' || String(order.city || '') === city,
            )
            .map((order) => String(order.district || '').trim())
            .filter(Boolean),
        ),
      ).sort((left, right) => left.localeCompare(right, 'tr-TR')),
    [city, orders],
  )
  const sortedOrders = useMemo(
    () => sortOrdersForWorkspace(filteredOrders, sortKey, sortDirection),
    [filteredOrders, sortDirection, sortKey],
  )
  const pagination = useMemo(
    () => paginateOrders(sortedOrders, currentPage, pageSize),
    [currentPage, pageSize, sortedOrders],
  )
  const pageNumbers = useMemo(
    () => visiblePageNumbers(pagination.page, pagination.pageCount),
    [pagination.page, pagination.pageCount],
  )


  const selectionText =
    selectedIds.length === 0
      ? 'Seçili sipariş yok'
      : `${selectedIds.length} sipariş seçildi`
  const listedCounts = useMemo(
    () => buildOrderCountSummary(filteredOrders),
    [filteredOrders],
  )

  function refreshForTab(tab: QuickTab) {
    setActiveQuickTab(tab)
    setOperationTab('all')
    setMarketplace('all')
    setStatus('all')
    setCargo('all')
    setCity('all')
    setDistrict('all')
    setMultiProductFilter('all')
    setActionFilter('all')
    setQuery('')
    setCustomerQuery('')
    setProductQuery('')
    setOrderNumberQuery('')
    setCargoSlipQuery('')
    setCurrentPage(1)
    setExpandedOrderId(undefined)
    onFetchOrders({
      statuses: statusesForFetch(tab),
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      allDates: datePreset === 'all',
    })
  }

  function clearFilters() {
    setOperationTab('all')
    setMarketplace('all')
    setStatus('all')
    setCargo('all')
    setCity('all')
    setDistrict('all')
    setMultiProductFilter('all')
    setActionFilter('all')
    setQuery('')
    setCustomerQuery('')
    setProductQuery('')
    setOrderNumberQuery('')
    setCargoSlipQuery('')
    setDatePreset('all')
    setCustomStartDate('')
    setCustomEndDate('')
    setCurrentPage(1)
  }

  function changeSort(nextKey: OrdersSortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(nextKey)
      setSortDirection(nextKey === 'orderDate' ? 'desc' : 'asc')
    }
    setCurrentPage(1)
  }

  return (
    <div className="orders-workspace">
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

      <section className="orders-filter-card">
        <header className="orders-filter-header">
          <div>
            <Filter size={17} />
            <strong>Filtreler</strong>
          </div>
          <button
            type="button"
            className="orders-filter-toggle"
            aria-expanded={filtersExpanded}
            onClick={() => setFiltersExpanded((current) => !current)}
          >
            {filtersExpanded ? 'Filtreleri Gizle' : 'Filtreleri Göster'}
            {filtersExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </header>
        {filtersExpanded ? (
          <div className="filter-panel orders-filter-grid">
        <label>
          <span>İşlem Durumu</span>
          <select
            value={operationTab}
            onChange={(event) => {
              setOperationTab(event.target.value as OperationTabFilter)
              setCurrentPage(1)
            }}
          >
            {operationTabOptions.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Pazaryeri</span>
          <select
            value={marketplace}
            onChange={(event) => {
              setMarketplace(event.target.value as 'all' | MarketplaceName)
              setCurrentPage(1)
            }}
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
            onChange={(event) => {
              setStatus(event.target.value as OrderStatusFilter)
              setCurrentPage(1)
            }}
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
            onChange={(event) => {
              setCargo(event.target.value as CargoFilter)
              setCurrentPage(1)
            }}
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
          <select
            value={city}
            onChange={(event) => {
              setCity(event.target.value)
              setDistrict('all')
              setCurrentPage(1)
            }}
          >
            <option value="all">Tümü</option>
            {cityOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>İlçe</span>
          <select
            value={district}
            onChange={(event) => {
              setDistrict(event.target.value)
              setCurrentPage(1)
            }}
          >
            <option value="all">Tümü</option>
            {districtOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Müşteri</span>
          <input
            aria-label="Müşteri"
            value={customerQuery}
            onChange={(event) => {
              setCustomerQuery(event.target.value)
              setCurrentPage(1)
            }}
            placeholder="Müşteri adını girin"
          />
        </label>
        <label>
          <span>Ürün</span>
          <input
            aria-label="Ürün"
            value={productQuery}
            onChange={(event) => {
              setProductQuery(event.target.value)
              setCurrentPage(1)
            }}
            placeholder="Ürün adı, SKU veya barkod"
          />
        </label>
        <label>
          <span>Sipariş No</span>
          <input
            aria-label="Sipariş No"
            value={orderNumberQuery}
            onChange={(event) => {
              setOrderNumberQuery(event.target.value)
              setCurrentPage(1)
            }}
            placeholder="Sipariş numarası girin"
          />
        </label>
        <label>
          <span>Kargo Fişi No</span>
          <input
            aria-label="Kargo Fişi No"
            value={cargoSlipQuery}
            onChange={(event) => {
              setCargoSlipQuery(event.target.value)
              setCurrentPage(1)
            }}
            placeholder="Kargo fişi numarası girin"
          />
        </label>
        <label>
          <span>Çok Çeşitli Sipariş</span>
          <select
            value={multiProductFilter}
            onChange={(event) => {
              setMultiProductFilter(
                event.target.value as 'all' | 'single' | 'multi',
              )
              setCurrentPage(1)
            }}
          >
            <option value="all">Tümü</option>
            <option value="multi">Birden çok ürün</option>
            <option value="single">Tek ürün</option>
          </select>
        </label>
        <label>
          <span>Tarih</span>
          <select
            value={datePreset}
            onChange={(event) => {
              setDatePreset(event.target.value as OrdersDatePreset)
              setCurrentPage(1)
            }}
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
                onChange={(event) => {
                  setCustomStartDate(event.target.value)
                  setCurrentPage(1)
                }}
              />
            </label>
            <label>
              <span>Bitiş</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(event) => {
                  setCustomEndDate(event.target.value)
                  setCurrentPage(1)
                }}
              />
            </label>
          </>
        ) : null}
            <button
              type="button"
              className="orders-clear-filters"
              onClick={clearFilters}
            >
              <RefreshCcw size={15} />
              Filtreleri Temizle
            </button>
          </div>
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
          <span>{listedCounts.packageCount} paket</span>
          <span>{listedCounts.lineCount} kalem</span>
          <span>{listedCounts.quantityTotal} ürün</span>
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkPrinted}
            title={printableDisabledReason}
            disabled={busy || selectedIds.length === 0 || !hasPrintableSelection}
          >
            <Barcode size={18} />
            Barkod Bas
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onCreateShipments}
            title={createDisabledReason}
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
            title={
              busy
                ? 'İşlem devam ediyor.'
                : selectedIds.length === 0
                  ? 'Önce en az bir sipariş seçin.'
                  : undefined
            }
            disabled={busy || selectedIds.length === 0}
          >
            <RefreshCcw size={18} />
            Seçilenleri Yenile / Doğrula
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onDownloadZpl}
            title={zplDisabledReason}
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
            title={printableDisabledReason}
            disabled={busy || selectedIds.length === 0 || !hasPrintableSelection}
          >
            <Stamp size={18} />
            Yazdır / Tekrar Yazdır
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkHandedToCargo}
            title={handedDisabledReason}
            disabled={busy || selectedIds.length === 0 || !hasHandedToCargoSelection}
          >
            <PackagePlus size={18} />
            Kargoya Verildi Yap
          </button>
        </div>
      </section>

      <ActionResult result={lastResult} />

      <OrdersTable
        orders={pagination.items}
        products={products}
        selectedIds={selectedIds}
        onToggleOrder={onToggleOrder}
        onToggleAll={() => onToggleAll(pagination.items.map((order) => order.id))}
        onOpenOrder={setActiveOrderId}
        expandedOrderId={expandedOrderId}
        onToggleExpand={(orderId) =>
          setExpandedOrderId((current) =>
            current === orderId ? undefined : orderId,
          )
        }
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSortChange={changeSort}
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

      <footer className="orders-pagination" aria-label="Sipariş sayfalama">
        <span>
          {pagination.totalItems === 0
            ? '0 paket'
            : `${listedCounts.packageCount.toLocaleString('tr-TR')} paketten ${(
                pagination.startIndex + 1
              ).toLocaleString('tr-TR')}–${pagination.endIndex.toLocaleString(
                'tr-TR',
              )} arası gösteriliyor`}
        </span>
        <div>
          <label>
            <span>Sayfa boyutu</span>
            <select
              aria-label="Sayfa boyutu"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value))
                setCurrentPage(1)
                setExpandedOrderId(undefined)
              }}
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size} / sayfa
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label="Önceki sayfa"
            disabled={pagination.page <= 1}
            onClick={() => {
              setCurrentPage((current) => Math.max(1, current - 1))
              setExpandedOrderId(undefined)
            }}
          >
            <ChevronLeft size={17} />
          </button>
          {pageNumbers.map((pageNumber, index) => {
            const previousNumber = pageNumbers[index - 1]
            return (
              <Fragment key={pageNumber}>
                {previousNumber && pageNumber - previousNumber > 1 ? (
                  <span className="orders-page-ellipsis">…</span>
                ) : null}
                <button
                  type="button"
                  className={
                    pagination.page === pageNumber ? 'active' : undefined
                  }
                  aria-current={
                    pagination.page === pageNumber ? 'page' : undefined
                  }
                  onClick={() => {
                    setCurrentPage(pageNumber)
                    setExpandedOrderId(undefined)
                  }}
                >
                  {pageNumber}
                </button>
              </Fragment>
            )
          })}
          <button
            type="button"
            aria-label="Sonraki sayfa"
            disabled={pagination.page >= pagination.pageCount}
            onClick={() => {
              setCurrentPage((current) =>
                Math.min(pagination.pageCount, current + 1),
              )
              setExpandedOrderId(undefined)
            }}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </footer>

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
    </div>
  )
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

function bulkDisabledReason(
  busy: boolean,
  selectedCount: number,
  hasEligibleSelection: boolean,
  ineligibleReason: string,
): string | undefined {
  if (busy) return 'İşlem devam ediyor.'
  if (selectedCount === 0) return 'Önce en az bir sipariş seçin.'
  if (!hasEligibleSelection) return ineligibleReason
  return undefined
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
    'Unknown',
  ]
  return marketplaceStatuses.includes(item)
    ? mapMarketplaceStatus('trendyol', item).label
    : item
}
