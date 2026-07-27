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
  markOrderLabelPrinted,
  markOrderLabelReady,
  upsertMarketplaceOrders,
  type OrderFilters,
} from './orderRepository.ts'
import { rowToOrder } from './orderMapper.ts'
import { findShipment } from '../shipments/shipmentRepository.ts'
import { findLatestOperationByPackage } from '../shipments/shipmentOperationRepository.ts'

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
  options: { complete: boolean; fetchedCount?: number },
): Promise<SyncPersistResult> {
  const result = await upsertMarketplaceOrders(db, organizationId, normalizedOrders)
  let archivedCount = 0
  if (options.complete) {
    archivedCount = await archiveMissingOrders(db, organizationId, result.packageIds)
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
): { shipment: Record<string, unknown>; hasPrintableLabel: boolean; ozelKargoTakipNo: string } {
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
  const shipment: Record<string, unknown> = {
    ...(persisted ?? {}),
    provider: 'surat-kargo',
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
  return { shipment, hasPrintableLabel, ozelKargoTakipNo }
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
  const shipment = await findShipment(db, organizationId, String(order.marketplace), packageId, 'surat')
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

export async function getOrder(
  db: Db,
  organizationId: string,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const row = await findOrderById(db, organizationId, orderId)
  if (!row) return null
  const lineRows = await findLinesForOrders(db, organizationId, [String(row.id)])
  const base = rowToOrder(row, lineRows)
  return attachShipment(db, organizationId, base)
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
): Promise<LabelReadyResult> {
  const orderRow = await findOrderById(db, organizationId, orderId)
  if (!orderRow) {
    return { found: false, updated: false, operationStatus: null, order: null }
  }
  const shipment = await findShipment(
    db,
    organizationId,
    String(orderRow.marketplace),
    String(orderRow.packageId),
    'surat',
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
): Promise<LabelPrintedResult> {
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
