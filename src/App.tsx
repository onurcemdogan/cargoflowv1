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
import { ProductsPage } from './pages/ProductsPage'
import { apiDebugService } from './services/apiDebugService'
import {
  auditLogService,
  integrationConfigService,
  workflowService,
} from './services/appServices'
import type { MaskedIntegrationStatus } from './services/integrationConfigService'
import {
  buildSuratZplDownload,
  suratPrintTrace,
} from './utils/browserLabelPrint'
import { resolveSuratPrintEligibility } from './utils/suratPrintEligibility'
import {
  injectPersistedZpl,
  isReprintEligible,
  resolvePersistedLabelArtifact,
} from './utils/persistedLabel'
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
  ProductCatalogCacheMetadata,
  SuratLabelMappingConfig,
  TrendyolProductSyncDebug,
  WorkflowResult,
} from './types/cargoflow'
import { downloadTextFile } from './utils/download'
import { loadLabelPreviewDrafts } from './utils/labelPreviewDrafts'
import { migrateAlternateLoopbackStorage } from './utils/localStorageMigration'
import { type QuickTab } from './utils/ordersTabs'
import type { OrdersNavigationFilters } from './utils/ordersNavigation'

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
  productsDebug?: TrendyolProductSyncDebug
  metadata?: ProductCatalogCacheMetadata
}

function App() {
  const ordersFetchRequestId = useRef(0)
  // Eşzamanlı Trendyol sync koruması (çift tıklama / hızlı ardışık istek):
  // bir sync sürerken ikinci çağrı NO-OP olur (frontend kilidi; backend org
  // kilidi ayrıca vardır). state yerine ref: anında ve render-bağımsız.
  const ordersSyncInFlight = useRef(false)
  // Dashboard "Yenile" (yerel DB reload) için eşzamanlılık kilidi: çift tıklama
  // ikinci bir GET /api/orders başlatmaz (paralel istek yok). Trendyol sync'ten
  // ayrıdır; bu yalnız yerel yeniden okumayı korur.
  const ordersReloadInFlight = useRef(false)
  const productsSyncInFlight = useRef(false)
  const [activePage, setActivePage] = useState<PageKey>('dashboard')
  const [integrationConfig, setIntegrationConfig] = useState<IntegrationConfig>(
    () => integrationConfigService.loadIntegrationConfig(),
  )
  const [integrationHydrated, setIntegrationHydrated] = useState(false)
  const [integrationConfigRevision, setIntegrationConfigRevision] = useState(0)
  const [maskedIntegrationStatus, setMaskedIntegrationStatus] =
    useState<MaskedIntegrationStatus | null>(null)
  // Yazıcı Ayarları SAYFASI kaldırıldı; ayarlar kayıtlıdan yüklenir ve print
  // akışında kullanılmaya devam eder (yazdırma altyapısı korunur).
  const [printerSettings] = useState<PrinterSettings>(() =>
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
    filters?: OrdersNavigationFilters
  }>()
  const orders = ordersState.orders
  const products = productsState.products

  // Yazıcı Ayarları sayfası kaldırıldı; eski route'a düşen kullanıcı boş
  // ekran görmesin diye Dashboard'a yönlendirilir (yazdırma ALTYAPISI
  // korunur; yalnız ayar SAYFASI kapatıldı).
  const effectivePage: PageKey =
    activePage === 'printers' ? 'dashboard' : activePage

  const pageResult = useMemo(
    () =>
      effectivePage === 'integrations' || effectivePage === 'labelTemplates'
        ? lastResult
        : undefined,
    [effectivePage, lastResult],
  )
  const integrationBusy =
    busy || ordersState.ordersLoading || productsState.productsLoading

  useEffect(() => {
    let active = true
    void (async () => {
      await migrateAlternateLoopbackStorage()
      const hydrated =
        await integrationConfigService.hydrateIntegrationConfig()
      // Auth modu bağlantı response mode sözleşmesinden gelir (auth/me +
      // integration hydrate). Frontend organizationId'sinden türetilmez.
      const authMode = integrationConfigService.isAuthMode()
      workflowService.setAuthMode(authMode)
      if (active) {
        setMaskedIntegrationStatus(
          integrationConfigService.getMaskedStatus(),
        )
        workflowService.setMarketplaceAccount(
          hydrated.trendyol.sellerId,
        )
        const cachedCatalog = await workflowService.hydrateProductCatalog()
        const cachedProducts = cachedCatalog.products
        // Auth modda sipariş kaynak-of-truth PostgreSQL'dir: yenilemede
        // sunucudan (org-scoped) yüklenir. Legacy modda localStorage'tan.
        const baseOrders = authMode
          ? await workflowService.loadOrdersFromServer().catch(() => [])
          : workflowService.loadOrders()
        setIntegrationConfig(hydrated)
        setIntegrationConfigRevision((current) => current + 1)
        setSelectedIds([])
        setOrdersState({
          orders: workflowService.enrichOrderImages(
            baseOrders,
            cachedProducts,
          ),
          ordersLoading: false,
        })
        setProductsState({
          products: cachedProducts,
          productsLoading: false,
          metadata: cachedCatalog.metadata,
        })
        setIntegrationHydrated(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  // Yalnız DB'den (auth: GET /api/orders, legacy: localStorage) okur; Trendyol'a
  // İSTEK ATMAZ. Route/tab/mount/dashboard geçişleri bunu kullanır. Trendyol
  // sync YALNIZ açık "Şimdi Yenile / Senkronize Et" butonuyla (handleFetchOrders).
  async function handleReloadOrders() {
    // Yalnız yerel DB okur (auth: GET /api/orders, legacy: localStorage);
    // sync/etiket/desi/create akışına GİRMEZ. ordersError yalnız yükleme hatası.
    if (ordersReloadInFlight.current) return
    ordersReloadInFlight.current = true
    if (integrationConfigService.isAuthMode()) {
      // Yeni yükleme: önceki (bayat) yükleme hatası TEMİZLENİR.
      setOrdersState((current) => ({
        ...current,
        ordersLoading: true,
        ordersError: undefined,
      }))
      try {
        const baseOrders = await workflowService.loadOrdersFromServer()
        setOrdersState((current) => ({
          ...current,
          orders: workflowService.enrichOrderImages(
            baseOrders,
            productsState.products,
          ),
          ordersLoading: false,
          ordersError: undefined,
        }))
      } catch {
        // Ağ/yükleme hatasında mevcut liste KORUNUR (silinmez). Banner'da yalnız
        // güvenli, yükleme kapsamlı mesaj gösterilir (etiket/desi metni değil).
        setOrdersState((current) => ({
          ...current,
          ordersLoading: false,
          ordersError:
            'Sipariş verileri yüklenemedi. Bağlantıyı kontrol edip tekrar deneyin.',
        }))
      } finally {
        ordersReloadInFlight.current = false
      }
      return
    }
    // Legacy: siparişler zaten localStorage'tan yüklü; yeniden oku.
    try {
      setOrdersState((current) => ({
        ...current,
        orders: workflowService.enrichOrderImages(
          workflowService.loadOrders(),
          productsState.products,
        ),
        ordersError: undefined,
      }))
    } finally {
      ordersReloadInFlight.current = false
    }
  }

  function handleNavigate(page: PageKey) {
    setActivePage(page)
    if (page === 'orders') {
      // Sayfa açılışında YALNIZ DB'den oku; Trendyol'a otomatik istek YOK.
      void handleReloadOrders()
    }
  }

  // Dashboard kartından Siparişler'e tek geçiş noktası: yeni navigation id
  // OrdersPage'i remount eder (marketplace/status/kargo/tarih/arama filtreleri
  // varsayılana döner), eski toplu seçim temizlenir ve yalnız kartın hedef
  // sekmesi uygulanır. Böylece kart sayısı ile açılan liste eşleşir.
  function handleDashboardNavigateOrders(
    tab: QuickTab = 'all',
    orderId?: string,
    filters?: OrdersNavigationFilters,
  ) {
    setActivePage('orders')
    setSelectedIds([])
    setOrdersNavigationRequest({
      id: Date.now(),
      tab,
      orderId,
      filters,
    })
    // Dashboard kartından geçiş: YALNIZ DB'den oku; Trendyol'a otomatik istek YOK.
    void handleReloadOrders()
  }

  function refreshLogs() {
    setLogs(auditLogService.load())
    setApiDebugLogs(apiDebugService.load())
  }

  // NOT: Görsel eksikliğinde ürün kataloğunu OTOMATİK Trendyol sync'iyle
  // tazeleyen efekt KALDIRILDI — mount/render sırasında istem dışı Trendyol
  // isteği (ve rate limit) üretiyordu. Ürün senkronu artık YALNIZ açık
  // "Ürünleri Senkronize Et" butonuyla yapılır. Görsel çözümleme, kayıtlı
  // katalogdan (DB/cache) yapılmaya devam eder.

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
    // Operasyonel iş akışı (create/track). Hata/başarı YALNIZ ordersMessage'a
    // yazılır (OrdersPage banner'ı). Dashboard yükleme banner'ının okuduğu
    // ordersError'a DOKUNULMAZ: etiket/desi/create hataları dashboard'a sızmaz.
    setOrdersState((current) => ({
      ...current,
      ordersLoading: true,
    }))
    try {
      const response = await action()
      setOrdersState((current) => ({
        ...current,
        orders: response.orders,
        ordersLoading: false,
        ordersMessage: response.result,
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
    // Eşzamanlı/çift sync koruması: bir sipariş sync'i sürerken ikinci çağrı
    // NO-OP olur (yeni Trendyol isteği başlatılmaz).
    if (ordersSyncInFlight.current) return
    ordersSyncInFlight.current = true
    const defaultSyncRange = marketplaceSyncRange()
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
          ? defaultSyncRange.startDate
          : options.startDate ?? defaultSyncRange.startDate,
        endDate: options.allDates
          ? defaultSyncRange.endDate
          : options.endDate ?? defaultSyncRange.endDate,
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
            productsDebug: productResponse.result.productSyncDebug,
            metadata: workflowService.loadProductCatalog().metadata,
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
      ordersSyncInFlight.current = false
      refreshLogs()
      if (requestId === ordersFetchRequestId.current) {
        setOrdersState((current) => ({ ...current, ordersLoading: false }))
      }
    }
  }

  async function handleFetchProducts(config = integrationConfig) {
    // Eşzamanlı/çift ürün sync koruması.
    if (productsSyncInFlight.current) return
    productsSyncInFlight.current = true
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
        productsDebug: response.result.productSyncDebug,
        metadata: workflowService.loadProductCatalog().metadata,
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
      productsSyncInFlight.current = false
      refreshLogs()
      setProductsState((current) => ({ ...current, productsLoading: false }))
    }
  }

  async function saveConfigAndActivateMarketplaceAccount(
    config: IntegrationConfig,
  ) {
    const saved = integrationConfigService.saveIntegrationConfig(config)
    const persisted = await integrationConfigService.waitForPendingPersistence()
    if (integrationConfigService.isAuthMode() && !persisted) {
      throw new Error(
        'Entegrasyon bilgileri sunucuya kaydedilemedi. Test eski bilgilerle çalıştırılmadı.',
      )
    }
    setMaskedIntegrationStatus(integrationConfigService.getMaskedStatus())
    const accountChanged = workflowService.setMarketplaceAccount(
      saved.trendyol.sellerId,
    )
    setIntegrationConfig(saved)
    if (accountChanged) {
      setSelectedIds([])
      const emptyCatalog = workflowService.loadProductCatalog()
      setOrdersState({
        orders: workflowService.enrichOrderImages(
          workflowService.loadOrders(),
          emptyCatalog.products,
        ),
        ordersLoading: false,
      })
      setProductsState({
        products: emptyCatalog.products,
        productsLoading: false,
        metadata: emptyCatalog.metadata,
      })
      void workflowService.hydrateProductCatalog().then((catalog) => {
        setProductsState({
          products: catalog.products,
          productsLoading: false,
          metadata: catalog.metadata,
        })
        setOrdersState((current) => ({
          ...current,
          orders: workflowService.enrichOrderImages(
            current.orders,
            catalog.products,
          ),
        }))
      })
    }
    return { saved, accountChanged }
  }

  async function handleTestTrendyol(config: IntegrationConfig) {
    setBusy(true)
    try {
      const { saved } = await saveConfigAndActivateMarketplaceAccount(config)
      const result = await workflowService.testTrendyolConnection(saved)
      setTrendyolTest(result)
      setLastResult({
        level: result.ok ? 'success' : 'warning',
        source: result.source,
        message: result.message,
      })
    } catch (error) {
      setLastResult({
        level: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Trendyol bağlantı testi başlatılamadı.',
      })
    } finally {
      refreshLogs()
      setBusy(false)
    }
  }

  async function handleTestSurat(config: IntegrationConfig) {
    setBusy(true)
    try {
      const { saved } = await saveConfigAndActivateMarketplaceAccount(config)
      const result = await workflowService.testSuratConnection(saved)
      setSuratTest(result)
      setLastResult({
        level: result.ok ? 'success' : 'warning',
        source: result.source,
        message: result.message,
      })
    } catch (error) {
      setLastResult({
        level: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Sürat bağlantı testi başlatılamadı.',
      })
    } finally {
      refreshLogs()
      setBusy(false)
    }
  }

  async function handleIntegrationFetchOrders(config: IntegrationConfig) {
    setBusy(true)
    try {
      const { saved } = await saveConfigAndActivateMarketplaceAccount(config)
      await handleFetchOrders(saved)
    } catch (error) {
      setLastResult({
        level: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Trendyol sipariş senkronu başlatılamadı.',
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleIntegrationFetchProducts(config: IntegrationConfig) {
    setBusy(true)
    try {
      const { saved } = await saveConfigAndActivateMarketplaceAccount(config)
      await handleFetchProducts(saved)
    } catch (error) {
      setLastResult({
        level: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Trendyol ürün senkronu başlatılamadı.',
      })
    } finally {
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
    void handleDownloadZplForIds([orderId])
  }

  // ZPL İndir: shipment.barcodeRaw içeriğini doğrudan .zpl dosyası olarak
  // indirir. Modal/print/create akışı çağrılmaz. Kayıtlı etiketi olan ama ham
  // ZPL'i bellekte olmayan siparişler için "Etiketi Yazdır" ile AYNI merkezî
  // fetch yolu (hydratePersistedLabels) kullanılır; iki buton aynı artifact'i
  // çözer.
  async function handleDownloadZplForIds(ids: string[]) {
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
    const { effectiveOrders } = await hydratePersistedLabels(ids)
    const selectedDownloadOrders = effectiveOrders.filter((order) =>
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

  // REPRINT artifact çözümü: seçili siparişlerden kayıtlı etiketi olan ama ham
  // ZPL'i bellekte bulunmayanlar için tenant-scoped uçtan (GET /api/orders/:id/
  // label) ham ZPL getirilir ve order.shipment.barcodeRaw'a enjekte edilir.
  // Provider create ÇAĞRILMAZ, desi İSTENMEZ, yeni shipment/barkod OLUŞTURULMAZ.
  // "ZPL İndir" ve "Etiketi Yazdır" bu ortak yolu kullanır. ZPL gerçekten
  // getirilemezse sipariş `unresolved` olarak işaretlenir (kontrollü mesaj).
  async function hydratePersistedLabels(
    orderIds: string[],
  ): Promise<{ effectiveOrders: CargoOrder[]; unresolved: string[] }> {
    const idSet = new Set(orderIds)
    const zplById = new Map<string, string>()
    const unresolved: string[] = []
    await Promise.all(
      orders
        .filter((order) => idSet.has(order.id) && isReprintEligible(order))
        .map(async (order) => {
          const artifact = resolvePersistedLabelArtifact(order)
          if (artifact.zpl) return
          try {
            const fetched = await workflowService.fetchPersistedLabel(order.id)
            if (fetched?.zpl) {
              zplById.set(order.id, fetched.zpl)
            } else if (artifact.hasPrintableLabel) {
              unresolved.push(order.orderNumber)
            }
          } catch {
            if (artifact.hasPrintableLabel) unresolved.push(order.orderNumber)
          }
        }),
    )
    const effectiveOrders =
      zplById.size === 0
        ? orders
        : orders.map((order) =>
            zplById.has(order.id)
              ? injectPersistedZpl(order, zplById.get(order.id) as string)
              : order,
          )
    return { effectiveOrders, unresolved }
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
    // Etiket yazdırma: sonuç YALNIZ ordersMessage'a yazılır (OrdersPage banner).
    // Desi/label hataları dashboard yükleme banner'ına (ordersError) SIZMAZ.
    setOrdersState((current) => ({
      ...current,
      ordersLoading: true,
    }))
    const confirmedAt = new Date().toISOString()
    try {
      // Kayıtlı etiketi olan (LABEL_READY/LABEL_PRINTED) ama ham ZPL'i bellekte
      // olmayan siparişler için ZPL uçtan getirilip enjekte edilir; böylece
      // reprint desi İSTEMEDEN kayıtlı etiketi basar.
      const { effectiveOrders, unresolved } =
        await hydratePersistedLabels(orderIds)
      const response = await workflowService.printLabels(
        effectiveOrders,
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
      const unresolvedNote =
        unresolved.length > 0
          ? ` Kayıtlı etiket alınamayan sipariş(ler): ${unresolved.join(', ')}.`
          : ''
      setOrdersState((current) => ({
        ...current,
        orders: response.orders,
        ordersMessage: {
          ...response.result,
          message: `${response.result.message}${unresolvedNote}`,
        },
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
    // Önizleme onayı ile yazdırma: sonuç YALNIZ ordersMessage'a yazılır.
    // Desi/label hataları dashboard yükleme banner'ına (ordersError) SIZMAZ.
    setOrdersState((current) => ({
      ...current,
      ordersLoading: true,
    }))
    const confirmedAt = new Date().toISOString()
    try {
      const { effectiveOrders, unresolved } =
        await hydratePersistedLabels(orderIds)
      const response = await workflowService.printLabels(
        effectiveOrders,
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
      const unresolvedNote =
        unresolved.length > 0
          ? ` Kayıtlı etiket alınamayan sipariş(ler): ${unresolved.join(', ')}.`
          : ''
      setOrdersState((current) => ({
        ...current,
        orders: response.orders,
        ordersMessage: {
          ...response.result,
          message: `${response.result.message}${unresolvedNote}`,
        },
      }))
      if (response.result.level !== 'error') {
        setPrintPreview(undefined)
        // Başarılı baskı sonrası listeyi DB'den yeniden oku: canonical
        // LABEL_PRINTED, Etiket Hazır sayaçları ve rozet güncellenir; eski
        // optimistic/hata state'i temizlenir. (Baskı hatasında buraya girilmez,
        // durum DEĞİŞTİRİLMEZ.)
        await handleReloadOrders()
      }
    } finally {
      refreshLogs()
      // Not: Print motoru kalıcı iframe kullanır; başarılı yolda hiçbir
      // pencere/iframe kapatılmaz.
      setOrdersState((current) => ({ ...current, ordersLoading: false }))
    }
  }

  function handleMarkHandedToCargo() {
    // Operasyonel aksiyon: sonuç YALNIZ ordersMessage'a (OrdersPage). Dashboard
    // yükleme banner'ının okuduğu ordersError'a dokunulmaz.
    const response = workflowService.markSelectedHandedToCargo(orders, selectedIds)
    setOrdersState((current) => ({
      ...current,
      orders: response.orders,
      ordersMessage: response.result,
      ordersDebug: response.result.debug,
    }))
    refreshLogs()
  }

  async function handleSaveIntegrations(config: IntegrationConfig) {
    setBusy(true)
    try {
      const { accountChanged } =
        await saveConfigAndActivateMarketplaceAccount(config)
      const nextLogs = auditLogService.append({
        action: 'Entegrasyon kaydedildi',
        level: 'success',
        details: 'Trendyol ve Sürat Kargo bağlantı bilgileri kaydedildi.',
      })
      setLogs(nextLogs)
      setLastResult({
        level: 'success',
        message: accountChanged
          ? 'Yeni Trendyol hesabı kaydedildi. Siparişleri görmek için "Senkronize Et" ile Trendyol\'dan çekebilirsiniz.'
          : 'Entegrasyon bilgileri kaydedildi.',
      })
      if (accountChanged) {
        // Hesap değişince YALNIZ DB'den oku; Trendyol'a OTOMATİK istek YOK.
        // Kullanıcı gerektiğinde açık "Senkronize Et" ile çeker.
        void handleReloadOrders()
      }
    } catch (error) {
      setLastResult({
        level: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Entegrasyon bilgileri kaydedilemedi.',
      })
    } finally {
      setBusy(false)
    }
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
    <AppShell activePage={effectivePage} onNavigate={handleNavigate}>
      {effectivePage === 'dashboard' ? (
        <DashboardPage
          orders={orders}
          products={products}
          integrationConfig={integrationConfig}
          maskedIntegrationStatus={maskedIntegrationStatus}
          printerSettings={printerSettings}
          apiDebugLogs={apiDebugLogs}
          loading={ordersState.ordersLoading || !integrationHydrated}
          error={ordersState.ordersError}
          lastSyncedAt={ordersState.lastSyncedAt}
          onNavigatePage={handleNavigate}
          onNavigateOrders={handleDashboardNavigateOrders}
          onDownloadOrder={handleDownloadZplForOrder}
          onPrintOrder={handleMarkPrintedForOrder}
          onCreateShipment={handleCreateShipmentForOrder}
          onTrackShipment={handleTrackShipmentForOrder}
          onDesiChange={handleOrderDesiChange}
          desiConfig={integrationConfig.desi}
          onRefresh={handleReloadOrders}
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
          initialFilters={ordersNavigationRequest?.filters}
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
          debug={productsState.productsDebug}
          metadata={productsState.metadata}
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
          maskedStatus={maskedIntegrationStatus}
          onSave={handleSaveIntegrations}
          onTestTrendyol={handleTestTrendyol}
          onTestSurat={handleTestSurat}
          onFetchOrders={handleIntegrationFetchOrders}
          onFetchProducts={handleIntegrationFetchProducts}
        />
      ) : null}

      {activePage === 'debug' ? (
        <IntegrationDebugPage
          logs={apiDebugLogs}
          orders={orders}
          onClear={handleClearApiDebugLogs}
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
