import { useEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './components/AppShell'
import {
  PrintPreviewModal,
  type PrintPreviewMode,
} from './components/PrintPreviewModal'
import { AuditLogsPage } from './pages/AuditLogsPage'
import { CargoOperationsPage } from './pages/CargoOperationsPage'
import { DashboardPage } from './pages/DashboardPage'
import { IntegrationsPage } from './pages/IntegrationsPage'
import { IntegrationDebugPage } from './pages/IntegrationDebugPage'
import { LabelTemplatesPage } from './pages/LabelTemplatesPage'
import { OrdersPage, type OrdersFetchOptions } from './pages/OrdersPage'
import { PrinterSettingsPage } from './pages/PrinterSettingsPage'
import { ProductsPage } from './pages/ProductsPage'
import { ZebraZplLabelProvider } from './providers/labels/ZebraZplLabelProvider'
import { TrendyolProvider } from './providers/marketplace/TrendyolProvider'
import { BrowserDownloadPrintProvider } from './providers/printing/BrowserDownloadPrintProvider'
import { SuratKargoProvider } from './providers/shipping/SuratKargoProvider'
import { AuditLogService } from './services/auditLogService'
import { apiDebugService } from './services/apiDebugService'
import { IntegrationConfigService } from './services/integrationConfigService'
import { OrderWorkflowService } from './services/orderWorkflowService'
import {
  buildSuratZplDownload,
  suratPrintTrace,
} from './utils/browserLabelPrint'
import { resolveSuratPrintEligibility } from './utils/suratPrintEligibility'
import type {
  AuditLog,
  ApiDebugLog,
  CargoOrder,
  CargoProduct,
  IntegrationConfig,
  IntegrationTestResult,
  LabelTemplate,
  PageKey,
  PrinterSettings,
  SuratLabelMappingConfig,
  WorkflowResult,
} from './types/cargoflow'
import { downloadTextFile } from './utils/download'
import { loadLabelPreviewDrafts } from './utils/labelPreviewDrafts'
import { migrateAlternateLoopbackStorage } from './utils/localStorageMigration'
import {
  ACTIVE_MARKETPLACE_STATUSES,
  ARCHIVE_MARKETPLACE_STATUSES,
} from './utils/orderStatus'
import { statusesForFetch, type QuickTab } from './utils/ordersTabs'

interface OrdersState {
  orders: CargoOrder[]
  ordersLoading: boolean
  ordersMessage?: WorkflowResult
  ordersError?: string
  ordersDebug?: WorkflowResult['debug']
  lastSyncedAt?: string
}

interface ProductsState {
  products: CargoProduct[]
  productsLoading: boolean
  productsMessage?: WorkflowResult
  productsError?: string
  productsDebug?: WorkflowResult['debug']
}

const integrationConfigService = new IntegrationConfigService()
const auditLogService = new AuditLogService()
const workflowService = new OrderWorkflowService(
  new TrendyolProvider(),
  new SuratKargoProvider(),
  new ZebraZplLabelProvider(),
  new BrowserDownloadPrintProvider(),
  auditLogService,
)

function App() {
  const ordersFetchRequestId = useRef(0)
  const [activePage, setActivePage] = useState<PageKey>('dashboard')
  const [integrationConfig, setIntegrationConfig] = useState<IntegrationConfig>(
    () => integrationConfigService.loadIntegrationConfig(),
  )
  const [integrationHydrated, setIntegrationHydrated] = useState(false)
  const [integrationConfigRevision, setIntegrationConfigRevision] = useState(0)
  const [printerSettings, setPrinterSettings] = useState<PrinterSettings>(() =>
    integrationConfigService.loadPrinterSettings(),
  )
  const [labelTemplate, setLabelTemplate] = useState<LabelTemplate>(() =>
    integrationConfigService.loadLabelTemplate(),
  )
  const [ordersState, setOrdersState] = useState<OrdersState>(() => ({
    orders: [],
    ordersLoading: true,
  }))
  const [productsState, setProductsState] = useState<ProductsState>(() => ({
    products: [],
    productsLoading: false,
  }))
  const [logs, setLogs] = useState<AuditLog[]>(() => auditLogService.load())
  const [apiDebugLogs, setApiDebugLogs] = useState<ApiDebugLog[]>(() =>
    apiDebugService.load(),
  )
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [lastResult, setLastResult] = useState<WorkflowResult>()
  const [trendyolTest, setTrendyolTest] = useState<IntegrationTestResult>()
  const [suratTest, setSuratTest] = useState<IntegrationTestResult>()
  const [labelMappingConfig, setLabelMappingConfig] =
    useState<SuratLabelMappingConfig>({ barcodeSourceOverride: 'auto' })
  const [labelPreviewDrafts] = useState(() =>
    loadLabelPreviewDrafts(),
  )
  const [busy, setBusy] = useState(false)
  const [printPreview, setPrintPreview] = useState<{
    mode: PrintPreviewMode
    orderIds: string[]
  }>()
  const [ordersNavigationRequest, setOrdersNavigationRequest] = useState<{
    id: number
    tab?: QuickTab
    orderId?: string
  }>()
  const orders = ordersState.orders
  const products = productsState.products

  const pageResult = useMemo(
    () =>
      activePage === 'integrations' ||
      activePage === 'printers' ||
      activePage === 'labelTemplates'
        ? lastResult
        : undefined,
    [activePage, lastResult],
  )
  const integrationBusy =
    busy || ordersState.ordersLoading || productsState.productsLoading

  useEffect(() => {
    let active = true
    void (async () => {
      await migrateAlternateLoopbackStorage()
      const hydrated =
        await integrationConfigService.hydrateIntegrationConfig()
      if (active) {
        workflowService.setMarketplaceAccount(
          hydrated.trendyol.sellerId,
        )
        const cachedProducts = workflowService.loadProducts()
        setIntegrationConfig(hydrated)
        setIntegrationConfigRevision((current) => current + 1)
        setSelectedIds([])
        setOrdersState({
          orders: workflowService.enrichOrderImages(
            workflowService.loadOrders(),
            cachedProducts,
          ),
          ordersLoading: false,
        })
        setProductsState({
          products: cachedProducts,
          productsLoading: false,
        })
        setIntegrationHydrated(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  function handleNavigate(page: PageKey) {
    setActivePage(page)
    if (page === 'orders') {
      void handleFetchOrders(integrationConfig, {
        statuses: [
          ...ACTIVE_MARKETPLACE_STATUSES,
          ...ARCHIVE_MARKETPLACE_STATUSES,
        ],
        ...marketplaceSyncRange(),
        silent: true,
      })
    }
  }

  // Dashboard kartından Siparişler'e tek geçiş noktası: yeni navigation id
  // OrdersPage'i remount eder (marketplace/status/kargo/tarih/arama filtreleri
  // varsayılana döner), eski toplu seçim temizlenir ve yalnız kartın hedef
  // sekmesi uygulanır. Böylece kart sayısı ile açılan liste eşleşir.
  function handleDashboardNavigateOrders(
    tab: QuickTab = 'all',
    orderId?: string,
  ) {
    setActivePage('orders')
    setSelectedIds([])
    setOrdersNavigationRequest({
      id: Date.now(),
      tab,
      orderId,
    })
    void handleFetchOrders(integrationConfig, {
      statuses: statusesForFetch(tab),
      silent: true,
    })
  }

  function refreshLogs() {
    setLogs(auditLogService.load())
    setApiDebugLogs(apiDebugService.load())
  }

  // Açılışta persisted siparişlerde görseli çözülemeyen satır varsa ürün
  // cache'i BİR kez arka planda tazelenir (bayat localStorage ürün listesi,
  // render-time çözümlemenin eşleşememesinin ana nedeni). Sipariş/Sürat
  // akışına dokunmaz; yalnız productsState güncellenir.
  const productsAutoRefreshAttempted = useRef(false)
  useEffect(() => {
    if (
      productsAutoRefreshAttempted.current ||
      orders.length === 0 ||
      !ordersMissingImages(orders)
    ) {
      return
    }
    productsAutoRefreshAttempted.current = true
    void handleFetchProducts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders])

  function toggleOrder(orderId: string) {
    setSelectedIds((current) =>
      current.includes(orderId)
        ? current.filter((id) => id !== orderId)
        : [...current, orderId],
    )
  }

  function toggleVisibleOrders(visibleIds: string[]) {
    setSelectedIds((current) => {
      const allVisibleSelected = visibleIds.every((id) => current.includes(id))
      if (allVisibleSelected) {
        return current.filter((id) => !visibleIds.includes(id))
      }
      return Array.from(new Set([...current, ...visibleIds]))
    })
  }

  async function runOrderWorkflow(
    action: () => Promise<{ orders: CargoOrder[]; result: WorkflowResult }>,
  ) {
    setOrdersState((current) => ({
      ...current,
      ordersLoading: true,
      ordersError: undefined,
    }))
    try {
      const response = await action()
      setOrdersState((current) => ({
        ...current,
        orders: response.orders,
        ordersLoading: false,
        ordersMessage: response.result,
        ordersError:
          response.result.level === 'error' ? response.result.message : undefined,
        ordersDebug: response.result.debug,
      }))
    } finally {
      refreshLogs()
      setOrdersState((current) => ({ ...current, ordersLoading: false }))
    }
  }

  async function handleFetchOrders(
    config = integrationConfig,
    options: OrdersFetchOptions = {},
  ) {
    const requestId = ++ordersFetchRequestId.current
    setOrdersState((current) => ({
      ...current,
      ordersLoading: true,
      ordersMessage: options.silent ? current.ordersMessage : undefined,
      ordersError: undefined,
      ordersDebug: options.silent ? current.ordersDebug : undefined,
    }))
    try {
      const response = await workflowService.fetchOrders(config, {
        statuses: options.statuses,
        startDate: options.allDates
          ? undefined
          : options.startDate ?? marketplaceSyncRange().startDate,
        endDate: options.allDates
          ? undefined
          : options.endDate ?? marketplaceSyncRange().endDate,
      })
      let productCatalog = productsState.products
      let nextOrders = workflowService.enrichOrderImages(
        response.orders,
        productCatalog,
      )
      if (ordersMissingImages(nextOrders)) {
        try {
          const productResponse = await workflowService.fetchProducts(config)
          productCatalog = productResponse.products
          nextOrders = workflowService.enrichOrderImages(
            nextOrders,
            productCatalog,
          )
          setProductsState((current) => ({
            ...current,
            products: productCatalog,
            productsMessage: productResponse.result,
            productsError:
              productResponse.result.level === 'error'
                ? productResponse.result.message
                : undefined,
          }))
        } catch (imageError) {
          setProductsState((current) => ({
            ...current,
            productsError:
              imageError instanceof Error
                ? `Ürün görseli enrichment tamamlanamadı: ${imageError.message}`
                : 'Ürün görseli enrichment tamamlanamadı.',
          }))
        }
      }
      if (requestId !== ordersFetchRequestId.current) return
      setOrdersState((current) => ({
        ...current,
        orders: nextOrders,
        ordersLoading: false,
        ordersMessage: options.silent ? current.ordersMessage : response.result,
        ordersError:
          response.result.level === 'error' ? response.result.message : undefined,
        ordersDebug: response.result.debug,
        lastSyncedAt: new Date().toISOString(),
      }))
      if (!options.silent) setSelectedIds([])
    } finally {
      refreshLogs()
      if (requestId === ordersFetchRequestId.current) {
        setOrdersState((current) => ({ ...current, ordersLoading: false }))
      }
    }
  }

  async function handleFetchProducts(config = integrationConfig) {
    setProductsState((current) => ({
      ...current,
      productsLoading: true,
      productsMessage: undefined,
      productsError: undefined,
      productsDebug: undefined,
    }))
    try {
      const response = await workflowService.fetchProducts(config)
      setProductsState((current) => ({
        ...current,
        products: response.products,
        productsLoading: false,
        productsMessage: response.result,
        productsError:
          response.result.level === 'error' ? response.result.message : undefined,
        productsDebug: response.result.debug,
      }))
      // Ürün cache'i değişti: lookup index yeni ürün dizisiyle otomatik
      // yeniden kurulur; çözülememiş görseller bayat matchedProductId=null
      // sonucunda takılı kalmasın diye siparişler yeniden çözülür.
      setOrdersState((current) => ({
        ...current,
        orders: workflowService.enrichOrderImages(
          current.orders,
          response.products,
        ),
      }))
    } finally {
      refreshLogs()
      setProductsState((current) => ({ ...current, productsLoading: false }))
    }
  }

  function saveConfigAndActivateMarketplaceAccount(config: IntegrationConfig) {
    const saved = integrationConfigService.saveIntegrationConfig(config)
    const accountChanged = workflowService.setMarketplaceAccount(
      saved.trendyol.sellerId,
    )
    setIntegrationConfig(saved)
    if (accountChanged) {
      setSelectedIds([])
      setOrdersState({
        orders: workflowService.enrichOrderImages(
          workflowService.loadOrders(),
          workflowService.loadProducts(),
        ),
        ordersLoading: false,
      })
      setProductsState({
        products: workflowService.loadProducts(),
        productsLoading: false,
      })
    }
    return { saved, accountChanged }
  }

  async function handleTestTrendyol(config: IntegrationConfig) {
    setBusy(true)
    try {
      const { saved } = saveConfigAndActivateMarketplaceAccount(config)
      const result = await workflowService.testTrendyolConnection(saved)
      setTrendyolTest(result)
      setLastResult({
        level: result.ok ? 'success' : 'warning',
        source: result.source,
        message: result.message,
      })
    } finally {
      refreshLogs()
      setBusy(false)
    }
  }

  async function handleTestSurat(config: IntegrationConfig) {
    setBusy(true)
    try {
      const { saved } = saveConfigAndActivateMarketplaceAccount(config)
      const result = await workflowService.testSuratConnection(saved)
      setSuratTest(result)
      setLastResult({
        level: result.ok ? 'success' : 'warning',
        source: result.source,
        message: result.message,
      })
    } finally {
      refreshLogs()
      setBusy(false)
    }
  }

  async function handleCreateShipments() {
    await handleCreateShipmentsForIds(selectedIds)
  }

  async function handleCreateShipmentForOrder(orderId: string) {
    await handleCreateShipmentsForIds([orderId])
  }

  async function handleCreateShipmentsForIds(ids: string[]) {
    await runOrderWorkflow(() =>
      workflowService.createShipments(orders, ids, integrationConfig),
    )
  }

  async function handleTrackShipments() {
    await runOrderWorkflow(() =>
      workflowService.trackShipments(orders, selectedIds, integrationConfig),
    )
  }

  async function handleTrackShipmentForOrder(orderId: string) {
    await runOrderWorkflow(() =>
      workflowService.trackShipments(orders, [orderId], integrationConfig),
    )
  }

  // ZPL İndir: yalnız .zpl dosyası indirir; modal açmaz, print/create tetiklemez.
  async function handleDownloadZpl() {
    await handleDownloadZplForIds(selectedIds)
  }

  function handleDownloadZplForOrder(
    orderId: string,
    mappingConfig = labelMappingConfig,
  ) {
    setLabelMappingConfig(mappingConfig)
    handleDownloadZplForIds([orderId])
  }

  // ZPL İndir: shipment.barcodeRaw içeriğini doğrudan .zpl dosyası olarak
  // indirir. Modal/print/create akışı çağrılmaz.
  function handleDownloadZplForIds(ids: string[]) {
    if (ids.length === 0) {
      setOrdersState((current) => ({
        ...current,
        ordersMessage: {
          level: 'warning',
          message: 'ZPL indirmek için en az bir sipariş seçmelisin.',
        },
      }))
      return
    }
    const selectedDownloadOrders = orders.filter((order) =>
      ids.includes(order.id),
    )
    const download = buildSuratZplDownload(selectedDownloadOrders)
    if (!download || !download.content.trim()) {
      const reason =
        download?.skipped?.[0]?.reason ||
        'Yazdırılabilir ZPL bulunamadı. Önce Sürat etiketi hazır olmalı.'
      setOrdersState((current) => ({
        ...current,
        ordersMessage: { level: 'warning', message: reason },
      }))
      refreshLogs()
      return
    }
    downloadTextFile(download.fileName, download.content)
    const skippedSummary =
      download.skipped.length > 0
        ? ` ${download.skipped.length} sipariş atlandı.`
        : ''
    setOrdersState((current) => ({
      ...current,
      ordersMessage: {
        level: download.skipped.length > 0 ? 'warning' : 'success',
        message: `${download.models.length} etiket için ${download.fileName} indirildi.${skippedSummary}`,
      },
    }))
    refreshLogs()
  }

  function handleMarkPrinted() {
    void handlePrintLabelsForIds(selectedIds)
  }

  function handleMarkPrintedForOrder(orderId: string) {
    void handlePrintLabelsForIds([orderId])
  }

  // Tekli ve toplu yazdırma aynı doğrudan akışı kullanır: ara önizleme
  // modalı açılmaz, Chrome print dialogu bir kez açılır ve otomatik
  // kapatılmaz.
  async function handlePrintLabelsForIds(orderIds: string[]) {
    if (orderIds.length === 0) {
      setOrdersState((current) => ({
        ...current,
        ordersMessage: {
          level: 'warning',
          message: 'Yazdırmak için en az bir sipariş seçmelisin.',
        },
      }))
      return
    }

    const selectedOrders = orders.filter((order) =>
      orderIds.includes(order.id),
    )
    const allPreviouslyPrinted =
      selectedOrders.length > 0 &&
      selectedOrders.every(
        (order) =>
          order.labelStatus === 'PRINTED' && Boolean(order.label?.printedAt),
      )
    const effectivePrinterSettings = {
      ...printerSettings,
      mode: 'browser-print' as const,
    }
    // Popup rezervasyonu yok; print motoru kalıcı gizli iframe kullanır ve
    // başarılı yolda hiçbir pencere/iframe kapatılmaz.
    suratPrintTrace('PRINT_BUTTON_CLICK', {
      orderNumbers: selectedOrders.map((order) => order.orderNumber),
      orderIds,
      allPreviouslyPrinted,
    })
    // Render ile click aynı helper'ı kullanır; sonuç click anında loglanır.
    for (const order of selectedOrders) {
      const eligibility = resolveSuratPrintEligibility(order)
      suratPrintTrace('PRINT_ELIGIBILITY_RESULT', {
        orderNumber: order.orderNumber,
        lifecycleStatus: order.shipment?.lifecycleStatus ?? '',
        printEnabled: order.shipment?.printEnabled === true,
        verifiedShipment: order.shipment?.verifiedShipment === true,
        operationalBarcodeVerified:
          order.shipment?.operationalBarcodeVerified === true,
        dispatchRegistrationConfirmed:
          order.shipment?.dispatchRegistrationConfirmed === true,
        hasZpl: Boolean(eligibility.barcodeRaw),
        trackingNumber: eligibility.trackingNumber,
        barcode: eligibility.barcode,
        canPrint: eligibility.canPrint,
        reason: eligibility.reason,
      })
    }
    setOrdersState((current) => ({
      ...current,
      ordersLoading: true,
      ordersError: undefined,
    }))
    const confirmedAt = new Date().toISOString()
    try {
      const response = await workflowService.printLabels(
        orders,
        orderIds,
        effectivePrinterSettings,
        labelTemplate,
        labelMappingConfig,
        {
          confirmedAt,
          printedBy: 'local user',
          includePreviouslyPrinted: allPreviouslyPrinted,
        },
      )
      setOrdersState((current) => ({
        ...current,
        orders: response.orders,
        ordersMessage: response.result,
        ordersError:
          response.result.level === 'error'
            ? response.result.message
            : undefined,
      }))
    } catch (error) {
      suratPrintTrace('PRINT_ERROR', {
        source: 'handlePrintLabelsForIds',
        reason: error instanceof Error ? error.message : String(error),
      })
      setOrdersState((current) => ({
        ...current,
        ordersMessage: {
          level: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Etiket yazdırma başarısız oldu.',
        },
        ordersError:
          error instanceof Error
            ? error.message
            : 'Etiket yazdırma başarısız oldu.',
      }))
    } finally {
      refreshLogs()
      setOrdersState((current) => ({ ...current, ordersLoading: false }))
    }
  }

  async function handlePrintPreviewConfirm(
    orderIds: string[],
    includePreviouslyPrinted: boolean,
  ) {
    if (!printPreview) return
    if (printPreview.mode === 'download') {
      setPrintPreview(undefined)
      await handleDownloadZplForIds(orderIds)
      return
    }
    if (printPreview.mode !== 'print') return

    const effectivePrinterSettings = {
      ...printerSettings,
      mode: 'browser-print' as const,
    }
    setOrdersState((current) => ({
      ...current,
      ordersLoading: true,
      ordersError: undefined,
    }))
    const confirmedAt = new Date().toISOString()
    try {
      const response = await workflowService.printLabels(
        orders,
        orderIds,
        effectivePrinterSettings,
        labelTemplate,
        labelMappingConfig,
        {
          confirmedAt,
          printedBy: 'local user',
          includePreviouslyPrinted,
        },
      )
      setOrdersState((current) => ({
        ...current,
        orders: response.orders,
        ordersMessage: response.result,
        ordersError:
          response.result.level === 'error'
            ? response.result.message
            : undefined,
      }))
      if (response.result.level !== 'error') {
        setPrintPreview(undefined)
      }
    } finally {
      refreshLogs()
      // Not: Print motoru kalıcı iframe kullanır; başarılı yolda hiçbir
      // pencere/iframe kapatılmaz.
      setOrdersState((current) => ({ ...current, ordersLoading: false }))
    }
  }

  function handleMarkHandedToCargo() {
    const response = workflowService.markSelectedHandedToCargo(orders, selectedIds)
    setOrdersState((current) => ({
      ...current,
      orders: response.orders,
      ordersMessage: response.result,
      ordersError:
        response.result.level === 'error' ? response.result.message : undefined,
      ordersDebug: response.result.debug,
    }))
    refreshLogs()
  }

  function handleSaveIntegrations(config: IntegrationConfig) {
    const { saved, accountChanged } =
      saveConfigAndActivateMarketplaceAccount(config)
    const nextLogs = auditLogService.append({
      action: 'Entegrasyon kaydedildi',
      level: 'success',
      details: 'Trendyol ve Sürat Kargo bağlantı bilgileri kaydedildi.',
    })
    setLogs(nextLogs)
    setLastResult({
      level: 'success',
      message: accountChanged
        ? 'Yeni Trendyol hesabı kaydedildi. Siparişler bu hesaba göre yenileniyor.'
        : 'Entegrasyon bilgileri kaydedildi.',
    })
    if (accountChanged) {
      void handleFetchOrders(saved, {
        statuses: [
          ...ACTIVE_MARKETPLACE_STATUSES,
          ...ARCHIVE_MARKETPLACE_STATUSES,
        ],
        ...marketplaceSyncRange(),
      })
    }
  }

  function handleSavePrinterSettings(settings: PrinterSettings) {
    const saved = integrationConfigService.savePrinterSettings(settings)
    setPrinterSettings(saved)
    const nextLogs = auditLogService.append({
      action: 'Yazıcı ayarı kaydedildi',
      level: 'success',
      details: `${settings.printerName} için ${settings.mode} modu kaydedildi.`,
    })
    setLogs(nextLogs)
    setLastResult({
      level: 'success',
      message: 'Yazıcı ayarları kaydedildi.',
    })
  }

  function handleSaveLabelTemplate(template: LabelTemplate) {
    const saved = integrationConfigService.saveLabelTemplate(template)
    setLabelTemplate(saved)
    const nextLogs = auditLogService.append({
      action: 'Etiket şablonu kaydedildi',
      level: 'success',
      details: `${saved.name}: ${saved.widthDots}x${saved.heightDots} dot olarak kaydedildi.`,
    })
    setLogs(nextLogs)
    setLastResult({
      level: 'success',
      message: 'Etiket şablonu kaydedildi. Yeni ZPL üretimleri bu şablonu kullanacak.',
    })
  }

  function handleOrderDesiChange(
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) {
    setOrdersState((current) => ({
      ...current,
      orders: workflowService.updateOrderDesi(
        current.orders,
        orderId,
        desi,
        desiSource,
      ),
    }))
  }

  function handleClearLogs() {
    setLogs(auditLogService.clear())
  }

  function handleClearApiDebugLogs() {
    setApiDebugLogs(apiDebugService.clear())
  }

  return (
    <AppShell activePage={activePage} onNavigate={handleNavigate}>
      {activePage === 'dashboard' ? (
        <DashboardPage
          orders={orders}
          products={products}
          integrationConfig={integrationConfig}
          printerSettings={printerSettings}
          apiDebugLogs={apiDebugLogs}
          loading={ordersState.ordersLoading || !integrationHydrated}
          error={ordersState.ordersError}
          lastSyncedAt={ordersState.lastSyncedAt}
          onNavigatePage={handleNavigate}
          onNavigateOrders={handleDashboardNavigateOrders}
          onDownloadOrder={handleDownloadZplForOrder}
          onPrintOrder={handleMarkPrintedForOrder}
          onRefresh={() =>
            handleFetchOrders(integrationConfig, {
              statuses: [
                ...ACTIVE_MARKETPLACE_STATUSES,
                ...ARCHIVE_MARKETPLACE_STATUSES,
              ],
              ...marketplaceSyncRange(),
              silent: true,
            })
          }
        />
      ) : null}

      {activePage === 'orders' ? (
        <OrdersPage
          key={ordersNavigationRequest?.id ?? 'orders-default'}
          orders={orders}
          products={products}
          selectedIds={selectedIds}
          lastResult={ordersState.ordersMessage}
          syncDebug={ordersState.ordersDebug}
          busy={ordersState.ordersLoading}
          lastSyncAt={ordersState.lastSyncedAt}
          initialQuickTab={ordersNavigationRequest?.tab}
          initialOrderId={ordersNavigationRequest?.orderId}
          onToggleOrder={toggleOrder}
          onToggleAll={toggleVisibleOrders}
          onFetchOrders={(options) => handleFetchOrders(integrationConfig, options)}
          onCreateShipments={handleCreateShipments}
          onCreateShipmentForOrder={handleCreateShipmentForOrder}
          onTrackShipments={handleTrackShipments}
          onTrackShipmentForOrder={handleTrackShipmentForOrder}
          onDownloadZpl={handleDownloadZpl}
          onDownloadZplForOrder={handleDownloadZplForOrder}
          onDesiChange={handleOrderDesiChange}
          desiConfig={integrationConfig.desi}
          onMarkPrinted={handleMarkPrinted}
          onMarkPrintedForOrder={handleMarkPrintedForOrder}
          onMarkHandedToCargo={handleMarkHandedToCargo}
        />
      ) : null}

      {activePage === 'products' ? (
        <ProductsPage
          products={products}
          orders={orders}
          result={productsState.productsMessage}
          busy={productsState.productsLoading}
          onFetchProducts={() => handleFetchProducts()}
        />
      ) : null}

      {activePage === 'cargo' ? (
        <CargoOperationsPage
          orders={orders}
          selectedIds={selectedIds}
          result={ordersState.ordersMessage}
          busy={ordersState.ordersLoading}
          onNavigateOrders={() => handleNavigate('orders')}
          onCreateShipments={handleCreateShipments}
          onTrackShipments={handleTrackShipments}
          onPrintLabels={handleMarkPrinted}
          onDownloadZpl={handleDownloadZpl}
        />
      ) : null}

      {activePage === 'labelTemplates' ? (
        <LabelTemplatesPage
          template={labelTemplate}
          result={pageResult}
          orders={orders}
          onSave={handleSaveLabelTemplate}
        />
      ) : null}

      {activePage === 'integrations' ? (
        <IntegrationsPage
          key={`integrations-${integrationConfigRevision}`}
          config={integrationConfig}
          result={pageResult}
          busy={integrationBusy}
          trendyolTest={trendyolTest}
          suratTest={suratTest}
          onSave={handleSaveIntegrations}
          onTestTrendyol={handleTestTrendyol}
          onTestSurat={handleTestSurat}
          onFetchOrders={(config) => handleFetchOrders(config)}
          onFetchProducts={(config) => handleFetchProducts(config)}
        />
      ) : null}

      {activePage === 'debug' ? (
        <IntegrationDebugPage
          logs={apiDebugLogs}
          orders={orders}
          onClear={handleClearApiDebugLogs}
        />
      ) : null}

      {activePage === 'printers' ? (
        <PrinterSettingsPage
          settings={printerSettings}
          result={pageResult}
          onSave={handleSavePrinterSettings}
        />
      ) : null}

      {activePage === 'logs' ? (
        <AuditLogsPage logs={logs} onClearLogs={handleClearLogs} />
      ) : null}

      {printPreview ? (
        <PrintPreviewModal
          key={`${printPreview.mode}:${printPreview.orderIds.join(',')}`}
          orders={printPreview.orderIds
            .map((orderId) => orders.find((order) => order.id === orderId))
            .filter((order): order is CargoOrder => Boolean(order))}
          canonicalOrders={orders}
          mode={printPreview.mode}
          template={labelTemplate}
          mappingConfig={labelMappingConfig}
          previewDrafts={labelPreviewDrafts}
          printerSettings={printerSettings}
          busy={ordersState.ordersLoading}
          onClose={() => setPrintPreview(undefined)}
          onConfirm={handlePrintPreviewConfirm}
          onDesiChange={handleOrderDesiChange}
          onModeChange={(mode) =>
            setPrintPreview((current) =>
              current ? { ...current, mode } : current,
            )
          }
        />
      ) : null}
    </AppShell>
  )
}

export default App

function marketplaceSyncRange(): Pick<
  OrdersFetchOptions,
  'startDate' | 'endDate'
> {
  const startDate = new Date()
  startDate.setHours(0, 0, 0, 0)
  startDate.setDate(startDate.getDate() - 29)
  const endDate = new Date()
  return { startDate, endDate }
}

function ordersMissingImages(orders: CargoOrder[]): boolean {
  return orders.some((order) =>
    order.items.some((item) => !item.imageUrl && !item.productImageUrl),
  )
}
