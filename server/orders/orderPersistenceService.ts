// Auth modu sipariş persistence servisi. Sync sonucu organization bazında
// PostgreSQL'e yazar; okuma sırasında shipment linkage'i (aynı org + packageId)
// order view-model'ine bağlar. Partial sync sipariş SİLMEZ/ARŞİVLEMEZ.
import { randomUUID } from 'node:crypto'
import {
  archiveMissingOrders,
  countOrdersByOrganization,
  findLinesForOrders,
  findOrderById,
  findOrders,
  findOrdersInRange,
  markOrderLabelPrinted,
  markOrderLabelReady,
  upsertMarketplaceOrders,
  type OrderFilters,
} from './orderRepository.ts'
import { rowToOrder } from './orderMapper.ts'
import { findShipment } from '../shipments/shipmentRepository.ts'
import { SURAT_PERSISTENCE_PROVIDER } from '../shipments/suratProvider.ts'
import { buildPrintableJob } from '../../src/utils/printableLabelJob.ts'
import { sha256Hex } from '../../src/utils/augmentedSuratZpl.ts'
import {
  findLatestOperationByPackage,
  findPrintableZplByPackage,
} from '../shipments/shipmentOperationRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface SyncPersistResult {
  complete: boolean
  fetchedCount: number
  persistedCount: number
  updatedCount: number
  insertedCount: number
  failedCount: number
  archivedCount: number
  syncBatchId: string
}

// Başarılı ve TAM sync (complete=true) reconcile uygular (arşivleme). Partial/
// başarısız sync yalnız gördüğü siparişleri upsert eder; SİLME/ARŞİVLEME yok.
export async function persistSyncResult(
  db: Db,
  organizationId: string,
  normalizedOrders: Record<string, unknown>[],
  options: {
    complete: boolean
    fetchedCount?: number
    // Reconciliation KAPSAMI: mevcut sync'in tarih penceresi (epoch ms). Yalnız
    // bu pencereye giren kayıtlar reconcile edilir; pencere dışı kayıtlar
    // current-active set'te yok diye arşivlenmez.
    window?: { startMs: number; endMs: number }
    // Pazaryeri hesabı kapsamı: upsert edilen kayıtlar bu hesapla damgalanır ve
    // reconcile YALNIZ bu hesabı değerlendirir (başka hesaba dokunmaz). null →
    // legacy/hesapsız kapsam.
    marketplaceAccountId?: string | null
  },
): Promise<SyncPersistResult> {
  const marketplaceAccountId = options.marketplaceAccountId ?? null
  const result = await upsertMarketplaceOrders(
    db,
    organizationId,
    normalizedOrders,
    marketplaceAccountId,
  )
  let archivedCount = 0
  if (options.complete) {
    archivedCount = await archiveMissingOrders(
      db,
      organizationId,
      result.packageIds,
      options.window,
      marketplaceAccountId,
    )
  }
  return {
    complete: options.complete,
    fetchedCount: options.fetchedCount ?? normalizedOrders.length,
    persistedCount: result.persisted,
    updatedCount: result.updated,
    insertedCount: result.inserted,
    failedCount: result.failed,
    archivedCount,
    syncBatchId: randomUUID(),
  }
}

function firstStr(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

function positiveDesi(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.round(num * 100) / 100
}

// Kayıtlı (persisted) etiket desisini ham ZPL'in "Top Ds/Kg" alanından çözer.
// Frontend extractZplDesi ile aynı sözleşme; server tarafında bağımsız uygulanır
// (frontend util import edilmez). Yalnız pozitif değer döner.
function extractDesiFromZpl(zpl: string): number | null {
  if (!zpl) return null
  const index = zpl.toLowerCase().indexOf('top ds/kg')
  if (index < 0) return null
  const after = zpl.slice(index)
  const fields = [...after.matchAll(/\^FD([^^]*?)\^FS/gi)].slice(0, 4)
  for (const field of fields) {
    const parsed = positiveDesi(field[1])
    if (parsed != null) return parsed
  }
  return null
}

// Kalıcı desi kaynağı önceliği: operation payload.desi (kullanıcının ilk create'te
// girdiği kesin değer) → ham ZPL'e gömülü desi (byte-for-byte orijinal etiket) →
// null. YENİ KOLON EKLENMEZ; mevcut persisted payload/ZPL alanları kullanılır.
function resolvePersistedDesi(
  payload: Record<string, unknown>,
  technicalZpl: string,
): number | null {
  const persistedShipment =
    payload.shipment && typeof payload.shipment === 'object'
      ? (payload.shipment as Record<string, unknown>)
      : null
  return (
    positiveDesi(payload.desi) ??
    positiveDesi(payload.apiRequestDesi) ??
    positiveDesi(persistedShipment?.desi) ??
    extractDesiFromZpl(technicalZpl)
  )
}

// GERÇEK persistence shape'i: Sürat create idempotency payload'ı (shipment_
// operations.response_payload) bir `shipment` NESNESİ TUTMAZ. Yazdırılabilir ZPL
// artifact'i `technicalZpl` / `technicalZplSha256` / `technicalZplLength`
// alanlarında; canonical kimlikler `candidate*`/`carrier*` alanlarında; kullanıcıya
// gösterilecek 727 Trendyol referansı `ozelKargoTakipNo` alanında saklanır.
// Bu helper, kalıcı payload'dan güvenli bir shipment görünümü + `hasPrintableLabel`
// bayrağı üretir. (Eski/alternatif payload'lar bir `shipment` içeriyorsa o baz
// alınır.) Böylece sayfa yenilemesinde (DB re-read) display no, buton yetkileri
// ve yazdırılabilir ZPL geçici tarayıcı state'ine BAĞIMLI OLMADAN geri gelir.
function buildShipmentViewFromPayload(
  payload: Record<string, unknown>,
  shipmentRow: Record<string, unknown>,
): {
  shipment: Record<string, unknown>
  hasPrintableLabel: boolean
  ozelKargoTakipNo: string
  desi: number | null
} {
  const persisted =
    payload.shipment && typeof payload.shipment === 'object'
      ? (payload.shipment as Record<string, unknown>)
      : null
  const technicalZpl = firstStr(payload.technicalZpl, persisted?.barcodeRaw)
  const hasPrintableLabel = Boolean(
    technicalZpl ||
      firstStr(payload.technicalZplSha256) ||
      Number(payload.technicalZplLength ?? 0) > 0 ||
      firstStr(persisted?.barcodeRaw) ||
      persisted?.zplReady === true ||
      persisted?.printEnabled === true,
  )
  const tNo = firstStr(
    persisted?.tNo,
    persisted?.trackingNumber,
    payload.carrierTrackingNumber,
    payload.candidateTrackingNumber,
    shipmentRow.trackingNumber,
  )
  const barcode = firstStr(
    persisted?.barkodNo,
    persisted?.barcode,
    payload.carrierBarcodeNumber,
    payload.candidateBarcodeNumber,
    shipmentRow.barcode,
  )
  const ozelKargoTakipNo = firstStr(persisted?.ozelKargoTakipNo, payload.ozelKargoTakipNo)
  // Kalıcı desi (ilk create girişi / ham ZPL'e gömülü). Sayfa yenilemesinde
  // order.desi kaybolduğunda etiket "Top Ds/Kg" alanı boş ("-") kalmasın diye
  // shipment görünümüne ve order.desi'ye geri yansıtılır.
  const desi = resolvePersistedDesi(payload, technicalZpl)
  const shipment: Record<string, unknown> = {
    ...(persisted ?? {}),
    provider: 'surat-kargo',
    ...(desi != null ? { desi } : {}),
    trackingNumber: tNo,
    tNo,
    kargoTakipNo: firstStr(persisted?.kargoTakipNo, tNo),
    barcode,
    barkodNo: barcode,
    barcodeValue: firstStr(persisted?.barcodeValue, barcode),
    ozelKargoTakipNo,
    // Yazdırılabilir ham ZPL orders akışı (ZPL indir / yazdır) için gerekir;
    // Dashboard recentOperations projection'ına EKLENMEZ (yalnız hasPrintableLabel).
    barcodeRaw: technicalZpl,
    zplReady: hasPrintableLabel,
    printEnabled: persisted?.printEnabled ?? hasPrintableLabel,
    lifecycleStatus:
      firstStr(persisted?.lifecycleStatus) ||
      (hasPrintableLabel ? 'LABEL_READY_AWAITING_ACCEPTANCE' : ''),
    candidateVerificationStatus:
      firstStr(persisted?.candidateVerificationStatus) ||
      (hasPrintableLabel ? 'PREASSIGNED_AWAITING_ACCEPTANCE' : ''),
    candidateTNo: firstStr(persisted?.candidateTNo, tNo),
    candidateBarkodNo: firstStr(persisted?.candidateBarkodNo, barcode),
  }
  return { shipment, hasPrintableLabel, ozelKargoTakipNo, desi }
}

// Order view-model'ine shipment linkage ekler. Başka organization shipment'ı
// ASLA bağlanmaz (findShipment org-scoped). local_create → kalıcı operation
// payload'ından güvenli shipment görünümü + hasPrintableLabel; marketplace_external
// → salt okunur.
async function attachShipment(
  db: Db,
  organizationId: string,
  order: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const packageId = String(order.packageId ?? '')
  if (!packageId) return order
  const shipment = await findShipment(db, organizationId, String(order.marketplace), packageId, SURAT_PERSISTENCE_PROVIDER)
  if (!shipment) return order
  if (shipment.source === 'local_create') {
    const operation = await findLatestOperationByPackage(db, organizationId, packageId)
    const payload =
      (operation?.payload as Record<string, unknown> | undefined) ??
      (shipment.carrierPayload as Record<string, unknown> | undefined) ??
      {}
    const view = buildShipmentViewFromPayload(payload, shipment)
    return {
      ...order,
      // 727 Trendyol referansı DB kolonunda boşsa payload'dan doldur. Canonical
      // orderNumber (114...) DEĞİŞMEZ; yalnız görünüm/fallback zenginleşir.
      cargoTrackingNumber: firstStr(order.cargoTrackingNumber, view.ozelKargoTakipNo),
      // Desi orders tablosunda TUTULMAZ; sayfa yenilemesinde kalıcı payload/ZPL'den
      // geri yansıtılır ki reprint etiketi "Top Ds/Kg" alanı "-" kalmasın. Order'da
      // zaten geçerli desi varsa KORUNUR (overwrite yok).
      desi: positiveDesi(order.desi) ?? view.desi ?? order.desi ?? null,
      // Backend güvenli capability bayrağı (raw ZPL değil): kalıcı persistence'tan.
      hasPrintableLabel: view.hasPrintableLabel,
      shipment: view.shipment,
      label: payload.label,
      labelStatus:
        firstStr(payload.labelStatus) ||
        (view.hasPrintableLabel ? 'READY' : firstStr(order.labelStatus)) ||
        undefined,
      shipmentStatus: payload.shipmentStatus,
      suratVerificationStatus: payload.suratVerificationStatus,
    }
  }
  // marketplace_external: salt okunur shipment göstergesi.
  return {
    ...order,
    externalShipment: {
      source: 'marketplace_external',
      trackingNumber: shipment.trackingNumber,
      senderNumber: shipment.senderNumber,
      status: shipment.status,
    },
  }
}

export async function listOrders(
  db: Db,
  organizationId: string,
  filters: OrderFilters = {},
  marketplaceAccountId?: string | null,
): Promise<{
  orders: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}> {
  const { orderRows, total, page, pageSize } = await findOrders(
    db,
    organizationId,
    filters,
    marketplaceAccountId,
  )
  const orderIds = orderRows.map((row) => String(row.id))
  const lineRows = await findLinesForOrders(db, organizationId, orderIds)
  const linesByOrder = new Map<string, Record<string, unknown>[]>()
  for (const line of lineRows) {
    const key = String(line.orderId)
    if (!linesByOrder.has(key)) linesByOrder.set(key, [])
    linesByOrder.get(key)!.push(line)
  }
  const viewModels = []
  for (const row of orderRows) {
    const base = rowToOrder(row, linesByOrder.get(String(row.id)) ?? [])
    viewModels.push(await attachShipment(db, organizationId, base))
  }
  return { orders: viewModels, total, page, pageSize }
}

// Dashboard SATIŞ analitiği: bir tarih aralığındaki TÜM hesap-kapsamlı
// siparişleri CAP'SİZ, view-model (CargoOrder) olarak döner. Provider'a ÇIKMAZ;
// yalnız yerel PostgreSQL orders/order_lines okunur. Shipment/label linkage'i
// (attachShipment) EKLENMEZ — satış aggregate'i için gereksizdir (daha hızlı).
export async function listOrdersForAnalytics(
  db: Db,
  organizationId: string,
  range: { startMs: number; endMs: number },
  marketplaceAccountId?: string | null,
): Promise<Record<string, unknown>[]> {
  const rows = await findOrdersInRange(db, organizationId, range, marketplaceAccountId)
  const orderIds = rows.map((row) => String(row.id))
  const lineRows = await findLinesForOrders(db, organizationId, orderIds)
  const linesByOrder = new Map<string, Record<string, unknown>[]>()
  for (const line of lineRows) {
    const key = String(line.orderId)
    if (!linesByOrder.has(key)) linesByOrder.set(key, [])
    linesByOrder.get(key)!.push(line)
  }
  return rows.map((row) =>
    rowToOrder(row, linesByOrder.get(String(row.id)) ?? []),
  )
}

export async function getOrder(
  db: Db,
  organizationId: string,
  orderId: string,
  marketplaceAccountId?: string | null,
): Promise<Record<string, unknown> | null> {
  const row = await findOrderById(db, organizationId, orderId, marketplaceAccountId)
  if (!row) return null
  const lineRows = await findLinesForOrders(db, organizationId, [String(row.id)])
  const base = rowToOrder(row, lineRows)
  return attachShipment(db, organizationId, base)
}

export interface PersistedLabelResult {
  found: boolean
  eligible: boolean
  hasPrintableLabel: boolean
  operationStatus: string | null
  zpl: string | null
  source: string | null
  // Kalıcı desi: reprint etiketinde "Top Ds/Kg" alanı orijinal değeri korusun
  // diye (order.desi reload'da kaybolduğunda) kalıcı payload/ZPL'den döner.
  desi: number | null
  // Kalıcı baskı modeli özeti (ham payload İSTEMCİYE DÖNMEZ).
  print?: PrintableLabelSummary | null
}

/** Baskı paketindeki tek bir ek fiziksel sayfa. */
export interface PrintableSupplementalPage {
  kind: 'product_detail'
  page: number
  totalPages: number
  zpl: string
  sha256?: string
}

export interface PrintableLabelSummary {
  /**
   * TAM baskı işi kurulabiliyor mu? Paket bozuksa (hash uyuşmazlığı, eksik
   * sayfa, bozuk sıra) FALSE olur ve taşıyıcı sayfa TEK BAŞINA servis
   * EDİLMEZ — Aşama 2'deki "taşıyıcı-only başarı yok" kuralının serving
   * karşılığıdır.
   */
  printReady: boolean
  /**
   * ANA KARGO ETİKETİ basılabilir mi? `printReady` ile AYNI değeri taşır ve
   * baskı kapısıdır; ayrı isim, çağıranın hangi soruyu sorduğunu AÇIK kılar.
   *
   * ÜRÜN POLİTİKASI (fail-open): yardımcı ürün detay katmanının çökmesi ana
   * etiketi ENGELLEMEZ. Engelleyen tek şey, YANLIŞ etiket basma riskidir —
   * bozuk kalıcı paket, kimlik uyuşmazlığı, doğrulanamayan kaynak.
   */
  carrierPrintReady: boolean
  /**
   * `fallback_carrier`: TAM paket kurulamadı, ancak kimliği KANITLANMIŞ
   * taşıyıcı kaynak servis edildi. Bu sonuç KALICI DEĞİLDİR — DB'ye hiçbir
   * artefakt yazılmamıştır.
   */
  printArtifactStatus: 'ready' | 'failed' | 'fallback_carrier'
  /** Yalnız güvenli, tipli sebep; iç ayrıntı SIZDIRILMAZ. */
  printArtifactFailureReason?: string
  /** Ürün detay sayfalarının durumu — taşıyıcıdan BAĞIMSIZ raporlanır. */
  productDetailStatus: 'none' | 'ready' | 'failed'
  /** Tipli sebep; yalnız `productDetailStatus === 'failed'` iken bulunur. */
  productDetailFailureReason?: string
  /** Taşıyıcı DAHİL toplam fiziksel sayfa sayısı. */
  labelPageCount: number
  productDetailPageCount: number
  /** Kalıcı ek sayfalar — canonical sırayla. Eski kayıtta boş dizi. */
  supplementalLabels: PrintableSupplementalPage[]
  printZplSha256: string
  printZplSourceSha256: string
  printZplVersion: string
  footerProfile: string | null
  templateFingerprint: string
  augmentationStatus: 'augmented' | 'source_only'
  renderMode: 'raw-zpl'
}

// Reprint (tekrar yazdırma) için KAYITLI etiket artifact'ini çözer. Provider'a
// ÇIKMAZ, yeni shipment/barkod/T.No OLUŞTURMAZ, desi doğrulaması YAPMAZ. Org
// yalnız çağıran context'ten (req.auth) gelir; getOrder org-scoped olduğundan
// başka tenant'ın siparişi/etiketi ASLA dönmez. ZPL önce full order shipment
// görünümünden (en son operasyon), yoksa pakete ait TÜM operasyonlar taranarak
// (daha eski create operasyonundaki technicalZpl) çözülür. `hasPrintableLabel`
// true olsa bile ham ZPL gerçekten yoksa zpl=null döner (çağıran kontrollü hata
// gösterir); "etiket yok" gibi fresh-create'e düşürülmez.
export async function resolvePersistedLabel(
  db: Db,
  organizationId: string,
  orderId: string,
  marketplaceAccountId?: string | null,
): Promise<PersistedLabelResult> {
  const order = await getOrder(db, organizationId, orderId, marketplaceAccountId)
  if (!order) {
    return {
      found: false,
      eligible: false,
      hasPrintableLabel: false,
      operationStatus: null,
      zpl: null,
      source: null,
      desi: null,
    }
  }
  const operationStatus = firstStr(order.operationStatus) || null
  const shipment = (order.shipment as Record<string, unknown> | undefined) ?? undefined
  const hasPrintableLabel = Boolean(
    order.hasPrintableLabel === true || firstStr(shipment?.barcodeRaw),
  )
  const eligible = Boolean(
    hasPrintableLabel &&
      ['LABEL_READY', 'LABEL_PRINTED'].includes(String(operationStatus ?? '')),
  )
  // 1) Full order görünümündeki (en son operasyon) ham ZPL.
  let zpl = firstStr(shipment?.barcodeRaw)
  let source: string | null = zpl ? 'order.shipment.barcodeRaw' : null
  // 2) Yoksa pakete ait tüm operasyonları tara (daha eski create technicalZpl).
  if (!zpl) {
    const found = await findPrintableZplByPackage(
      db,
      organizationId,
      firstStr(order.packageId),
    )
    if (found) {
      zpl = found.zpl
      source = found.source
    }
  }
  // Kalıcı desi: attachShipment order.desi'yi zaten payload/ZPL'den geri
  // yansıttı; yine de ham ZPL'den ekstraksiyon son güvence olarak eklenir.
  const desi = positiveDesi(order.desi) ?? extractDesiFromZpl(zpl || '')

  // TEK KAYNAK BASKI MODELİ: baskıya giden ZPL, ürün satırı eklenmiş KALICI
  // printZpl'dir. Kayıt varsa AYNEN kullanılır (metadata resolver ÇALIŞMAZ,
  // katalog OKUNMAZ); legacy kayıt ilk kullanımda katalog zenginleştirmeli
  // olarak compare-and-set ile BİR KEZ hydrate edilir. Kaynak SHA
  // uyuşmazlığında AÇIK hata verilir (sessiz kullanım/üzerine yazma YOK).
  let printModel: PrintableLabelSummary | null = null
  if (zpl) {
    const [
      {
        resolvePrintableLabelForServing,
        PRINT_ZPL_SOURCE_MISMATCH_MESSAGE,
        PRINT_ZPL_SOURCE_MISSING_MESSAGE,
      },
      { loadPrintLineItems },
    ] = await Promise.all([
      import('../shipments/printZplRepository.ts'),
      import('../shipments/printZplItems.ts'),
    ])
    const marketplace = firstStr(order.marketplace)
    const packageId = firstStr(order.packageId)
    const provider = firstStr(
      (order.shipment as Record<string, unknown> | undefined)?.provider,
    ) || 'surat-kargo'
    // Kalıcı model BEST-EFFORT'tur: canonical shipment satırı veya payload
    // içinde kaynak ZPL bulunamayan ESKİ kayıtlarda (ör. yalnız operation
    // kaydından çözülen ZPL) MEVCUT davranış korunur ve ham kaynak döner.
    // TEK İSTİSNA: kaynak/print SHA uyuşmazlığı — bu SESSİZCE yutulmaz.
    let model = null
    let fallback = null
    try {
      const resolution = await resolvePrintableLabelForServing(
        db,
        { organizationId, marketplace, packageId, provider },
        {
          // Ürün satırları YALNIZ ilk hydration'da kullanılır; kalıcı kayıt
          // varsa bu yükleyici HİÇ çağrılmaz (tembel).
          loadItems: () =>
            loadPrintLineItems(db, organizationId, marketplace, packageId),
        },
      )
      if (resolution.kind === 'artifact') model = resolution.model
      else fallback = resolution
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === PRINT_ZPL_SOURCE_MISMATCH_MESSAGE) throw error
      if (message !== PRINT_ZPL_SOURCE_MISSING_MESSAGE) {
        // TİPLİ ENGEL: ek sayfa çöktü VE taşıyıcı kaynak doğrulanamadı
        // (kimlik uyuşmuyor / yapı bozuk / canonical değer yok). Yanlış
        // etiket basma riski vardır → kaynağa DÜŞÜLMEZ, baskı KAPALI.
        zpl = ''
        printModel = {
          printReady: false,
          carrierPrintReady: false,
          printArtifactStatus: 'failed',
          printArtifactFailureReason: message || 'print_artifact_failed',
          productDetailStatus: 'failed',
          labelPageCount: 0,
          productDetailPageCount: 0,
          supplementalLabels: [],
          printZplSha256: '',
          printZplSourceSha256: '',
          printZplVersion: '',
          footerProfile: null,
          templateFingerprint: '',
          augmentationStatus: 'source_only',
          renderMode: 'raw-zpl',
        }
      }
      // PRINT_ZPL_SOURCE_MISSING: canonical gönderi satırı YOK (gerçek eski
      // kayıt). MEVCUT davranış korunur — ham kaynak tek sayfa olarak döner.
    }
    if (fallback) {
      // FAIL-OPEN: ürün detay katmanı çöktü, taşıyıcı kimliği KANITLANDI.
      // Ana etiket basılır; ek sayfa yoktur ve bu AÇIKÇA bildirilir.
      // DB'ye hiçbir şey yazılmadı (bkz. resolvePrintableLabelForServing).
      zpl = fallback.carrierZpl
      source = 'shipment.carrierSourceFallback'
      printModel = {
        printReady: true,
        carrierPrintReady: true,
        printArtifactStatus: 'fallback_carrier',
        productDetailStatus: 'failed',
        productDetailFailureReason: fallback.productDetailFailureReason,
        labelPageCount: 1,
        productDetailPageCount: 0,
        supplementalLabels: [],
        printZplSha256: fallback.carrierZplSha256,
        printZplSourceSha256: fallback.carrierZplSha256,
        printZplVersion: '',
        footerProfile: null,
        templateFingerprint: '',
        augmentationStatus: 'source_only',
        renderMode: 'raw-zpl',
      }
    }
    if (model) {
    // Sayfalar KALICI baytlardan gelir: burada ürün toplama, sayfalama,
    // composer veya PNG YOKTUR. Tek merkezi kurucu kullanılır.
    const job = buildPrintableJob({
      carrierZpl: model.printZpl,
      supplementalLabels: model.supplementalLabels ?? [],
      hash: sha256Hex,
    })
    // TAM İŞ YA DA HİÇ: paket bozuksa taşıyıcı sayfa tek başına servis
    // edilmez; `zpl` boş bırakılır ve printReady=false ile bildirilir.
    zpl = job.printReady ? model.printZpl : ''
    source = 'shipment.printZplArtifact'
    printModel = {
      printReady: job.printReady,
      // BOZUK KALICI PAKET fail-open kapsamında DEĞİLDİR: immutable artefaktın
      // bozulması kaynağa düşerek sessizce telafi edilmez, baskı KAPANIR.
      carrierPrintReady: job.printReady,
      printArtifactStatus: job.printReady ? 'ready' : 'failed',
      ...(job.reason ? { printArtifactFailureReason: job.reason } : {}),
      productDetailStatus: !job.printReady
        ? 'failed'
        : (model.supplementalLabels ?? []).length > 0
          ? 'ready'
          : 'none',
      labelPageCount: job.labelPageCount,
      productDetailPageCount: job.productDetailPageCount,
      supplementalLabels: job.pages
        .filter((page) => page.kind === 'product_detail')
        .map((page) => ({
          kind: 'product_detail' as const,
          page: page.page,
          totalPages: job.productDetailPageCount,
          zpl: page.zpl,
          ...(page.sha256 ? { sha256: page.sha256 } : {}),
        })),
      printZplSha256: model.printZplSha256,
      printZplSourceSha256: model.printZplSourceSha256,
      printZplVersion: model.printZplVersion,
      footerProfile: model.printZplFooterProfile,
      templateFingerprint: model.templateFingerprint,
      augmentationStatus: model.augmentationStatus,
      renderMode: model.renderMode,
    }
    }
  }

  return {
    found: true,
    eligible,
    hasPrintableLabel,
    operationStatus,
    zpl: zpl || null,
    source,
    desi,
    print: printModel,
  }
}

export interface LabelReadyResult {
  found: boolean
  updated: boolean
  reason?: 'shipment_required'
  operationStatus: string | null
  order: Record<string, unknown> | null
}

// Etiket başarıyla oluşturulduğunda siparişi canonical LABEL_READY durumuna
// geçirir ve KALICI olarak DB'ye yazar. Backend-doğrulamalı: önce siparişin
// GERÇEK (persistlenmiş) bir Sürat gönderisi olduğunu kontrol eder — client
// state'e GÜVENMEZ; gönderi yoksa geçiş yapmaz (reason='shipment_required').
// Geçiş atomik + idempotent + no-regress (markOrderLabelReady). marketplaceStatus
// AYRI alandır, dokunulmaz. Güncel sipariş view-model'i döner.
export async function markLabelReady(
  db: Db,
  organizationId: string,
  orderId: string,
  marketplaceAccountId?: string | null,
): Promise<LabelReadyResult> {
  const orderRow = await findOrderById(db, organizationId, orderId, marketplaceAccountId)
  if (!orderRow) {
    return { found: false, updated: false, operationStatus: null, order: null }
  }
  const shipment = await findShipment(
    db,
    organizationId,
    String(orderRow.marketplace),
    String(orderRow.packageId),
    SURAT_PERSISTENCE_PROVIDER,
  )
  if (!shipment) {
    // Gönderi kaydı olmadan etiket-hazır olunamaz: önceki durum korunur.
    return {
      found: true,
      updated: false,
      reason: 'shipment_required',
      operationStatus: (orderRow.operationStatus as string | null) ?? null,
      order: null,
    }
  }
  const result = await markOrderLabelReady(db, organizationId, orderId)
  const order = await getOrder(db, organizationId, orderId)
  return { ...result, order }
}

export interface LabelPrintedResult {
  found: boolean
  updated: boolean
  reason?: 'label_required'
  operationStatus: string | null
  order: Record<string, unknown> | null
}

// Kullanıcı Yazdır / Tekrar Yazdır aksiyonunu başarıyla başlattığında siparişi
// canonical LABEL_PRINTED durumuna KALICI geçirir. Geçiş atomik + idempotent +
// no-regress (markOrderLabelPrinted): yalnız LABEL_READY'den yazılır; zaten
// basılmış/ileri statüler idempotent kabul edilir; yazdırılabilir etiket yoksa
// reason='label_required'. Yeni shipment/barkod OLUŞTURMAZ; marketplaceStatus
// AYRI alandır, dokunulmaz. NOT: tarayıcı fiziksel baskıyı kesin doğrulayamaz;
// LABEL_PRINTED kullanıcının yazdırma aksiyonunu başlattığını ifade eder.
export async function markLabelPrinted(
  db: Db,
  organizationId: string,
  orderId: string,
  marketplaceAccountId?: string | null,
): Promise<LabelPrintedResult> {
  // Aktif hesap kapsamı dışındaki sipariş (başka hesap/legacy) GÜNCELLENEMEZ:
  // önce hesap-kapsamlı varlık kontrolü (org+id UPDATE'i tek başına hesap
  // sızıntısına izin vermesin diye).
  if (marketplaceAccountId !== undefined) {
    const scoped = await findOrderById(db, organizationId, orderId, marketplaceAccountId)
    if (!scoped) {
      return { found: false, updated: false, operationStatus: null, order: null }
    }
  }
  const result = await markOrderLabelPrinted(db, organizationId, orderId)
  if (!result.found) {
    return { found: false, updated: false, operationStatus: null, order: null }
  }
  if (result.reason === 'label_required') {
    return {
      found: true,
      updated: false,
      reason: 'label_required',
      operationStatus: result.operationStatus,
      order: null,
    }
  }
  const order = await getOrder(db, organizationId, orderId)
  return {
    found: true,
    updated: result.updated,
    operationStatus: result.operationStatus,
    order,
  }
}

export { countOrdersByOrganization }
