// SAF Dashboard PROJEKSİYON mutabakatı. Ham DB satırlarının (rawDatabaseModel)
// Dashboard'un gerçekten gösterdiği sale/cancel/return kümesine
// (projectedDashboardModel) nasıl indiğini AŞAMA AŞAMA çıkarır ve her düşen
// kaydı güvenli bir bucket'a atar (projectionDiff). CANONICAL disposition/amount/
// dedupe (dashboardSalesMetricDefinition) kullanır → Dashboard ile AYNI kural.
// Ham ID/PII/payload DÖNDÜRMEZ; yalnız sayı/tutar aggregate.
import {
  orderDedupeKey,
  orderDispositionOf,
  resolveCanonicalOrderAmount,
} from '../../src/dashboard/dashboardSalesMetricDefinition.ts'

type OrderLike = Record<string, unknown>

export interface RawDatabaseModel {
  rowCount: number
  distinctPackageCount: number
  totalAmount: number
  lineCount: number
  amountUnresolvedCount: number
}
export interface ProjectedDashboardModel {
  packageCount: number
  salePackageCount: number
  cancelPackageCount: number
  returnPackageCount: number
  saleAmount: number
  cancelAmount: number
  returnAmount: number
  totalAmount: number
  lineCount: number
}
export interface ProjectionDiff {
  droppedPackageCount: number
  droppedAmount: number
  droppedLineCount: number
  // Her düşen kayıt TEK bir bucket'a atanır; toplamları droppedPackageCount'a eşittir.
  droppedBuckets: {
    duplicate_package_id: number
    missing_identifier: number
    sanitizing: number
    date_filtering: number
    archived: number
    missing_lines: number
    unknown: number
  }
  // Bilgilendirme (paket düşüşü DEĞİL): kapsamdaki arşivli / satırsız kayıtlar.
  archivedInScope: number
  ordersWithoutLines: number
  // Yükleyici/DB tutarlılığı: SQL DB satır sayısı ile yüklenen satır sayısı.
  databaseRowCount: number
  loadedRowCount: number
  notLoadedCount: number
  loaderComplete: boolean
  // İNVARYANTLAR (para toleransı 0,01 TL).
  invariants: {
    packageOk: boolean
    amountOk: boolean
    lineOk: boolean
    loaderComplete: boolean
  }
}
export interface ProjectionModel {
  start: string
  end: string
  rawDatabaseModel: RawDatabaseModel
  projectedDashboardModel: ProjectedDashboardModel
  projectionDiff: ProjectionDiff
}

function inRange(order: OrderLike, startMs: number, endMs: number): boolean {
  const t = Date.parse(String(order.orderDate ?? order.createdAt ?? ''))
  return Number.isFinite(t) && t >= startMs && t <= endMs
}
function lineCountOf(order: OrderLike): number {
  return Array.isArray(order.items) ? (order.items as unknown[]).length : 0
}
function amountOf(order: OrderLike): number {
  return resolveCanonicalOrderAmount(order as never) ?? 0
}
function hasRealPackageIdentity(order: OrderLike): boolean {
  return (
    String(order.packageId ?? '').trim() !== '' ||
    String(order.shipmentPackageId ?? '').trim() !== ''
  )
}

// Bir kaydın DÜŞÜŞ (dedupe collision) nedenini güvenli bucket'a atar. Gerçek
// packageId varsa çift packageId; yoksa kimliksiz eşleşme.
function dropBucketFor(order: OrderLike): keyof ProjectionDiff['droppedBuckets'] {
  return hasRealPackageIdentity(order) ? 'duplicate_package_id' : 'missing_identifier'
}

// orders: (rowToOrder ile eşlenmiş) YÜKLENEN satırlar; period penceresine göre
// filtrelenir. databaseRowCount: aynı pencere için SQL DB satır sayısı (yükleme
// eksikliğini/truncation'ı tespit için). Sonuç: rawDatabaseModel /
// projectedDashboardModel / projectionDiff.
export function buildProjectionModel(
  orders: OrderLike[],
  period: { startMs: number; endMs: number },
  databaseRowCount: number,
): ProjectionModel {
  const inPeriod = orders.filter((order) => inRange(order, period.startMs, period.endMs))

  const rawAmount = inPeriod.reduce((sum, order) => sum + amountOf(order), 0)
  const rawLine = inPeriod.reduce((sum, order) => sum + lineCountOf(order), 0)
  const amountUnresolvedCount = inPeriod.filter(
    (order) => resolveCanonicalOrderAmount(order as never) == null,
  ).length

  // DEDUPE: aynı canonical dedupe anahtarı → ilk kayıt kalır, sonrakiler düşer.
  const seen = new Set<string>()
  const survivors: OrderLike[] = []
  const dropped: OrderLike[] = []
  for (const order of inPeriod) {
    const key = orderDedupeKey(order as never)
    if (seen.has(key)) dropped.push(order)
    else {
      seen.add(key)
      survivors.push(order)
    }
  }

  // SINIFLANDIRMA (canonical disposition): her survivor tek dispozisyona düşer.
  const sale: OrderLike[] = []
  const cancel: OrderLike[] = []
  const ret: OrderLike[] = []
  for (const order of survivors) {
    const disposition = orderDispositionOf(order as never)
    if (disposition === 'cancel') cancel.push(order)
    else if (disposition === 'return') ret.push(order)
    else sale.push(order)
  }
  const sumAmount = (arr: OrderLike[]) => arr.reduce((sum, order) => sum + amountOf(order), 0)
  const sumLines = (arr: OrderLike[]) => arr.reduce((sum, order) => sum + lineCountOf(order), 0)

  const projectedTotalAmount = sumAmount(survivors)
  const projectedLine = sumLines(survivors)
  const droppedAmount = sumAmount(dropped)
  const droppedLine = sumLines(dropped)

  const droppedBuckets = {
    duplicate_package_id: 0,
    missing_identifier: 0,
    sanitizing: 0,
    date_filtering: 0,
    archived: 0,
    missing_lines: 0,
    unknown: 0,
  }
  for (const order of dropped) droppedBuckets[dropBucketFor(order)] += 1

  const notLoadedCount = Math.max(0, databaseRowCount - inPeriod.length)
  const loaderComplete = notLoadedCount === 0

  const packageOk =
    inPeriod.length === sale.length + cancel.length + ret.length + dropped.length
  const amountOk =
    Math.abs(rawAmount - (sumAmount(sale) + sumAmount(cancel) + sumAmount(ret) + droppedAmount)) <=
    0.01
  const lineOk = rawLine === projectedLine + droppedLine

  return {
    start: new Date(period.startMs).toISOString(),
    end: new Date(period.endMs).toISOString(),
    rawDatabaseModel: {
      rowCount: inPeriod.length,
      distinctPackageCount: survivors.length,
      totalAmount: rawAmount,
      lineCount: rawLine,
      amountUnresolvedCount,
    },
    projectedDashboardModel: {
      packageCount: survivors.length,
      salePackageCount: sale.length,
      cancelPackageCount: cancel.length,
      returnPackageCount: ret.length,
      saleAmount: sumAmount(sale),
      cancelAmount: sumAmount(cancel),
      returnAmount: sumAmount(ret),
      totalAmount: projectedTotalAmount,
      lineCount: projectedLine,
    },
    projectionDiff: {
      droppedPackageCount: dropped.length,
      droppedAmount,
      droppedLineCount: droppedLine,
      droppedBuckets,
      archivedInScope: inPeriod.filter((order) => order.archived === true).length,
      ordersWithoutLines: inPeriod.filter((order) => lineCountOf(order) === 0).length,
      databaseRowCount,
      loadedRowCount: inPeriod.length,
      notLoadedCount,
      loaderComplete,
      invariants: { packageOk, amountOk, lineOk, loaderComplete },
    },
  }
}
