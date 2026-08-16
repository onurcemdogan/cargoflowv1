import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// B1-A — ARŞİV YOLLARININ SINIFLANDIRMASI.
//
// KANITLANAN MEVCUT DAVRANIŞ: `buildOrderWhere` `archivedAt` üzerinde HİÇBİR
// yüklem içermez ve `OrderFilters.includeArchived` hiçbir yerde okunmaz.
// Yani arşivleme, bugünkü normal listeleme sonuçlarını DEĞİŞTİRMEZ.
//
// SONUÇ: projeksiyonun arşiv yaşam döngüsünü izlemesi mevcut sözleşme
// açısından GEREKSİZDİR. Projeksiyon satırını silmek veya `archived_at`
// kolonu eklemek MEVCUT DAVRANIŞI DEĞİŞTİRİR ve shadow parity'yi BOZAR.
//
// Bu testler ürün davranışının ideal olduğunu SÖYLEMEZ; yalnız projeksiyon
// optimizasyonunun bugünkü davranışı değiştirmediğini kilitler. "Arşivlenmiş
// sipariş listede görünmesin" AYRI bir ürün değişikliğidir, B1 kapsamı DEĞİL.

const nl = (v) => v.split('\r\n').join('\n')
const REPO = nl(readFileSync('server/orders/orderRepository.ts', 'utf8'))
const RETENTION = nl(readFileSync('server/orders/orderRetention.ts', 'utf8'))

/** `buildOrderWhere` gövdesi — okuma uygunluk sözleşmesinin tek yeri. */
function buildOrderWhereBody() {
  const start = REPO.indexOf('export function buildOrderWhere')
  assert.ok(start > 0, 'buildOrderWhere bulunmali')
  const end = REPO.indexOf('\n}', start)
  return REPO.slice(start, end)
}

test('ARCHIVE_NOT_FILTERED_CURRENT_BEHAVIOR: okuma yolu archivedAt FILTRELEMEZ', () => {
  const body = buildOrderWhereBody()
  // Okuma sozlesmesinde arsiv yuklemi YOK.
  assert.equal(body.includes('archivedAt'), false, 'buildOrderWhere archivedAt kullanmamali')
  assert.equal(body.includes('includeArchived'), false)
  // Tenant + hesap kapsami ve mevcut filtreler KORUNUR (regresyon koruması).
  assert.ok(body.includes('eq(orders.organizationId, organizationId)'))
  assert.ok(body.includes('accountClause(marketplaceAccountId)'))
})

test('ARCHIVE_NOT_FILTERED: includeArchived su an ETKISIZ (olu alan)', () => {
  // Tip tanimi var ama hicbir yerde OKUNMUYOR.
  assert.ok(REPO.includes('includeArchived?: boolean'), 'alan tanimli olmali')
  const reads = REPO.split('includeArchived').length - 1
  assert.equal(reads, 1, `includeArchived yalnız tanımda geçmeli (${reads})`)
})

test('archiveMissingOrders: NOT_REQUIRED_BY_DESIGN_ARCHIVE_NOT_FILTERED', () => {
  const start = REPO.indexOf('export async function archiveMissingOrders')
  assert.ok(start > 0)
  const body = REPO.slice(start, start + 3000)
  // Yalnız archivedAt yazar; projeksiyon token kaynağı DEĞİŞMEZ.
  assert.ok(body.includes('archivedAt: new Date()'))
  // Projeksiyon bakımı EKLENMEDİ (bilinçli): arşiv okuma uygunluğunu
  // değiştirmediği için projeksiyonun haberdar olmasına gerek yok.
  assert.equal(body.includes('refreshOrderProjectionFragment'), false)
  assert.equal(body.includes('deleteOrderProjection'), false)
})

test('archiveEligibleOrders: NOT_REQUIRED_BY_DESIGN_ARCHIVE_NOT_FILTERED', () => {
  const start = RETENTION.indexOf('export async function archiveEligibleOrders')
  assert.ok(start > 0)
  const body = RETENTION.slice(start, start + 3000)
  assert.ok(body.includes('archivedAt: now'))
  assert.equal(body.includes('refreshOrderProjectionFragment'), false)
  assert.equal(body.includes('deleteOrderProjection'), false)
})

test('ARCHIVE: projeksiyon semasinda archived_at YOK (parite korunur)', () => {
  const schema = nl(readFileSync('server/db/schema.ts', 'utf8'))
  const start = schema.indexOf("pgTable(\n  'order_filter_projection'")
  assert.ok(start > 0, 'projeksiyon tablosu bulunmali')
  const body = schema.slice(start, schema.indexOf('\n)', start))
  // Arşiv kolonu EKLENMEDİ: eklemek bugünkü davranışı değiştirirdi.
  assert.equal(body.includes('archivedAt'), false)
  assert.equal(body.includes('archived_at'), false)
})

// ═══ ORDER KAPSAMA MATRİSİ ════════════════════════════════════════════════

test('ORDER COVERAGE: 5 REQUIRED bagli, 2 archive sinifladirilmis, 0 unclassified', () => {
  const reconciler = nl(
    readFileSync('server/shipments/suratTrackingReconciler.ts', 'utf8'),
  )
  const legacyImport = nl(
    readFileSync('server/orders/importLegacyOrders.ts', 'utf8'),
  )
  const hookName = 'refreshOrderProjectionFragment'

  // REQUIRED_HOOKED (5)
  const upsert = REPO.slice(
    REPO.indexOf('export async function upsertMarketplaceOrders'),
    REPO.indexOf('export async function archiveMissingOrders'),
  )
  assert.ok(upsert.includes(hookName), 'upsertMarketplaceOrders bagli olmali')
  const ready = REPO.slice(
    REPO.indexOf('export async function markOrderLabelReady'),
    REPO.indexOf('export async function touchOrderOperationalActivity'),
  )
  assert.ok(ready.includes(hookName), 'markOrderLabelReady bagli olmali')
  const printed = REPO.slice(REPO.indexOf('export async function markOrderLabelPrinted'))
  assert.ok(printed.includes(hookName), 'markOrderLabelPrinted bagli olmali')
  assert.ok(reconciler.includes(hookName), 'suratTrackingReconciler bagli olmali')
  assert.ok(legacyImport.includes(hookName), 'importLegacyOrders bagli olmali')

  // NOT_REQUIRED_BY_DESIGN (2) — yukarıdaki testlerle kilitli.
  // touchOrderOperationalActivity: yalnız aktivite damgası → token kaynağı yok.
  const touch = REPO.slice(
    REPO.indexOf('export async function touchOrderOperationalActivity'),
    REPO.indexOf('export async function markOrderLabelPrinted'),
  )
  assert.equal(
    touch.includes(hookName), false,
    'touchOrderOperationalActivity NOT_REQUIRED_BY_DESIGN olmali',
  )
})

test('BATCH CARDINALITY: toplu yollar satir basina sorgu URETMEZ', () => {
  const legacyImport = nl(
    readFileSync('server/orders/importLegacyOrders.ts', 'utf8'),
  )
  // Kimlikler toplanır, TEK toplu yenileme yapılır.
  for (const source of [REPO, legacyImport]) {
    assert.ok(source.includes('projectedOrderIds'), 'kimlikler toplanmali')
  }
  // importOne (satır başına) içinde yenileme çağrısı YOK.
  const importOne = legacyImport.slice(
    legacyImport.indexOf('async function importOne'),
    legacyImport.indexOf('export async function importLegacyOrders'),
  )
  assert.equal(importOne.includes('refreshOrderProjectionFragment'), false)
})
