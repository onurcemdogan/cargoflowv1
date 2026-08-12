import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, isNull } from 'drizzle-orm'

// CASE B2-C — ARKA PLAN SENKRONU YANLIS HESAP KAPSAMINA YAZIYORDU.
//
// GOLDEN URETIM VAKASI (PII YOK):
//   orderNumber 11493372619 · packageId 4065907241
//   Trendyol API: Shipped · CargoFlow: Picking + LABEL_PRINTED
//
// KOK NEDEN (kod + sema duzeyinde kanitli):
//   `orders` tekilligi (organization_id, marketplace, marketplace_account_id,
//   package_id) ve UNIQUE **NULLS NOT DISTINCT**. Arka plan senkronu
//   `persistSyncResult`e `marketplaceAccountId` GECMIYORDU → varsayilan null →
//   ON CONFLICT hedefi aktif hesapla damgalanmis GERCEK satirla CAKISMIYOR →
//   satir GUNCELLENMIYOR, NULL kapsaminda AYRI (karantinali) golge satir
//   olusuyordu.
//
// Bu paket hermetiktir (gercek PostgreSQL motoru + gercek migration'lar).
// Surat/SSP, ZPL, etiket, retention KAPSAM DISIDIR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const repo = await import('./orders/orderRepository.ts')
const mapper = await import('./orders/orderMapper.ts')
const service = await import('./orders/orderPersistenceService.ts')

const { orders, organizations, marketplaceAccounts } = schema
const ENTRY_SOURCE = readFileSync('server/index.mjs', 'utf8')

const GOLDEN = { packageId: '4065907241', orderNumber: '11493372619' }

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Test Org', slug: `org-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  const [account] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: '277221',
      isActive: true,
    })
    .returning({ id: marketplaceAccounts.id })
  return { db, organizationId: org.id, accountId: account.id }
}

/** Golden siparisin URETIMDEKI hali: hesap kapsamli, Picking, etiket basilmis. */
async function seedGolden(db, organizationId, accountId) {
  const [row] = await db
    .insert(orders)
    .values({
      organizationId,
      marketplaceAccountId: accountId,
      marketplace: 'Trendyol',
      packageId: GOLDEN.packageId,
      orderNumber: GOLDEN.orderNumber,
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      orderDate: new Date('2026-08-01T10:00:00.000Z'),
    })
    .returning({ id: orders.id })
  return row.id
}

/** `normalizeTrendyolOrders` ciktisiyla ayni sekle sahip Shipped paket. */
const incomingShipped = (overrides = {}) => ({
  id: `ty_order_${GOLDEN.packageId}`,
  marketplace: 'Trendyol',
  packageId: GOLDEN.packageId,
  shipmentPackageId: GOLDEN.packageId,
  externalOrderId: GOLDEN.packageId,
  orderNumber: GOLDEN.orderNumber,
  marketplaceStatus: 'Shipped',
  operationStatus: 'SHIPPED',
  customerFirstName: 'T',
  customerLastName: 'M',
  orderDate: '2026-08-01T10:00:00.000Z',
  items: [],
  ...overrides,
})

const rowsFor = (db, organizationId) =>
  db
    .select({
      id: orders.id,
      packageId: orders.packageId,
      marketplaceAccountId: orders.marketplaceAccountId,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
      marketplaceLastModifiedAt: orders.marketplaceLastModifiedAt,
    })
    .from(orders)
    .where(eq(orders.organizationId, organizationId))

// ═══ B2-PERSIST ═══════════════════════════════════════════════════════════

test('B2-PERSIST-1: hesap kapsamli Picking satiri gelen Shipped ile GUNCELLENIR', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const orderId = await seedGolden(db, organizationId, accountId)

  const result = await repo.upsertMarketplaceOrders(
    db,
    organizationId,
    [incomingShipped()],
    accountId,
  )
  assert.equal(result.updated, 1, 'mevcut satir GUNCELLENMELI')
  assert.equal(result.inserted, 0, 'yeni satir OLUSMAMALI')

  const rows = await rowsFor(db, organizationId)
  assert.equal(rows.length, 1, 'golge satir YOK')
  assert.equal(rows[0].id, orderId, 'AYNI satir')
  assert.equal(rows[0].marketplaceStatus, 'Shipped')
})

test('B2-PERSIST-2: LABEL_PRINTED Shipped guncellemesini ENGELLEMEZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)

  await repo.upsertMarketplaceOrders(
    db,
    organizationId,
    [incomingShipped()],
    accountId,
  )
  const [row] = await rowsFor(db, organizationId)
  assert.equal(row.marketplaceStatus, 'Shipped', 'pazaryeri statusu ilerler')
  assert.equal(row.operationStatus, 'LABEL_PRINTED', 'operasyon durumu KORUNUR')
})

test('B2-PERSIST-3: URETIM HATASI — null kapsam hesap satirini BULAMAZ', async () => {
  // Bu test HATANIN kendisini kilitler: yanlis kapsamla yazmak mevcut satiri
  // guncellemez, AYRI bir golge satir yaratir. Duzeltme bu yolu KULLANMAMAKTIR.
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)

  await repo.upsertMarketplaceOrders(
    db,
    organizationId,
    [incomingShipped()],
    null,
  )
  const rows = await rowsFor(db, organizationId)
  assert.equal(rows.length, 2, 'NULLS NOT DISTINCT → AYRI anahtar, AYRI satir')
  const scoped = rows.find((row) => row.marketplaceAccountId === accountId)
  const shadow = rows.find((row) => row.marketplaceAccountId === null)
  assert.equal(scoped.marketplaceStatus, 'Picking', 'gercek satir GERIDE kalir')
  assert.equal(shadow.marketplaceStatus, 'Shipped', 'golge satir guncellenir')

  // Dogru kapsamla ayni yuk gonderilince gercek satir duzelir (golge kalir;
  // temizligi ayri, onayli bir istir — bu tur DB mutasyonu YAPMAZ).
  await repo.upsertMarketplaceOrders(
    db,
    organizationId,
    [incomingShipped()],
    accountId,
  )
  const after = await rowsFor(db, organizationId)
  assert.equal(
    after.find((row) => row.marketplaceAccountId === accountId).marketplaceStatus,
    'Shipped',
  )
})

test('B2-PERSIST-4: marketplaceUpdateSet Shipped tasir, operasyon alanlarina DOKUNMAZ', () => {
  const set = mapper.marketplaceUpdateSet(incomingShipped())
  assert.equal(set.marketplaceStatus, 'Shipped')
  assert.equal(set.orderNumber, GOLDEN.orderNumber)
  assert.equal('operationStatus' in set, false)
  assert.equal('archivedAt' in set, false)
  assert.equal('lastOperationalActivityAt' in set, false)
  assert.equal('marketplaceAccountId' in set, false, 'hesap kimligi EZILMEZ')
})

test('B2-PERSIST-5: read-after-write → view-model Shipped', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  await service.persistSyncResult(db, organizationId, [incomingShipped()], {
    complete: false,
    fetchedCount: 1,
    marketplaceAccountId: accountId,
  })

  const [row] = await rowsFor(db, organizationId)
  assert.equal(row.marketplaceStatus, 'Shipped')
  const view = mapper.rowToOrder(row, [])
  assert.equal(view.marketplaceStatus, 'Shipped')
  assert.equal(view.operationStatus, 'LABEL_PRINTED')
})

test('B2-PERSIST-6: arka plan turu ARSIVLEME yapmaz (complete=false)', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  // Turda DONMEYEN baska bir siparis.
  await db.insert(orders).values({
    organizationId,
    marketplaceAccountId: accountId,
    marketplace: 'Trendyol',
    packageId: '4000000001',
    orderNumber: '11400000001',
    marketplaceStatus: 'Created',
    orderDate: new Date('2026-08-05T10:00:00.000Z'),
  })

  const result = await service.persistSyncResult(
    db,
    organizationId,
    [incomingShipped()],
    { complete: false, fetchedCount: 1, marketplaceAccountId: accountId },
  )
  assert.equal(result.archivedCount, 0, 'reconcile CALISMAZ')
  const rows = await db
    .select({ packageId: orders.packageId, archivedAt: orders.archivedAt })
    .from(orders)
    .where(
      and(eq(orders.organizationId, organizationId), isNull(orders.archivedAt)),
    )
  assert.equal(rows.length, 2, 'turda donmeyen kayit ARSIVLENMEZ')
})

// ═══ YAZAR ENVANTERI (SECONDARY WRITER) ═══════════════════════════════════

test('B2-SECONDARY-WRITER: marketplace_status yazan TEK yol upsert zinciridir', () => {
  const mapperSource = readFileSync('server/orders/orderMapper.ts', 'utf8')
  // Yazma yuzeyi: YALNIZ saglayici siparisinden okuyan iki kume
  // (toOrderInsertValues + marketplaceUpdateSet).
  const writeSites = mapperSource
    .split(/\r?\n/)
    .filter((line) =>
      line.includes('marketplaceStatus: str(order.marketplaceStatus)'),
    )
  assert.equal(writeSites.length, 2, 'toOrderInsertValues + marketplaceUpdateSet')
  // rowToOrder bir OKUMA projeksiyonudur (DB satirindan okur), yazar degildir.
  assert.ok(mapperSource.includes('marketplaceStatus: str(orderRow.marketplaceStatus)'))

  // Diger order yazarlari marketplace_status'e DOKUNMAZ.
  for (const [file, fn] of [
    ['server/orders/orderRepository.ts', 'markOrderLabelReady'],
    ['server/orders/orderRepository.ts', 'markOrderLabelPrinted'],
    ['server/orders/orderRepository.ts', 'archiveMissingOrders'],
    ['server/orders/orderRetention.ts', 'archiveEligibleOrders'],
    ['server/shipments/suratTrackingReconciler.ts', 'applyTrackingDecision'],
  ]) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const start = lines.findIndex((line) => line.includes(`function ${fn}`))
    assert.ok(start >= 0, `${fn} bulunmali`)
    const end = lines.findIndex((line, index) => index > start && line === '}')
    const body = lines
      .slice(start, end)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    // YALNIZ `.set({...})` (yazma) kumeleri incelenir; `.select({...})`
    // projeksiyonlarinda alanin gecmesi YAZMA DEGILDIR.
    const writeBlocks = body
      .split('.set(')
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf('})')))
    for (const block of writeBlocks) {
      assert.equal(
        block.includes('marketplaceStatus'),
        false,
        `${fn} marketplace_status YAZMAMALI`,
      )
    }
  }
})

test('B2-SECONDARY-WRITER-2: arka plan senkronu AKTIF HESAP kapsamini gecirir', () => {
  const lines = ENTRY_SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function syncTrendyolOrdersForOrganization'),
  )
  assert.ok(start >= 0)
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines
    .slice(start, end)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  // Manuel akisla AYNI kanonik hesap cozumu.
  // SOZLESME GUNCELLENDI (NULL yazim engelleme): artik ayrimli cozumleyici
  // kullanilir; hata SESSIZCE null'a DUSMEZ, tur ATLANIR.
  assert.ok(body.includes('resolveActiveMarketplaceAccountScope('))
  assert.equal(
    body.includes('resolveActiveMarketplaceAccountId('),
    false,
    'null dondurebilen okuma yardimcisi YAZMA yolunda KULLANILMAZ',
  )
  assert.ok(body.includes("accountScope.status !== 'ok'"))
  assert.ok(body.includes('skipped: accountScope.status'))
  assert.ok(body.includes('marketplaceAccountId,'), 'persist cagrisina gecirilir')
  assert.ok(
    body.includes('requireMarketplaceAccount: true'),
    'persist katmaninda derinlemesine savunma',
  )
  // Arka plan turu reconcile/arsivleme TETIKLEMEZ.
  assert.ok(body.includes('complete: false'))
  // Kanonik zincir korunur (ikinci bir mapping/persistence YOK).
  assert.ok(body.includes('callTrendyolOrdersByStatuses(credentials'))
  assert.ok(body.includes('normalizeTrendyolOrders(result.data)'))
  assert.ok(body.includes('service.persistSyncResult('))
  // Istemciden hesap kimligi ALINMAZ.
  assert.equal(body.includes('request.'), false)
})

test('B2-SCOPE: stale-merge fix ve bayrak sozlesmeleri KORUNUR', () => {
  // 670ffd7 fix'i yerinde.
  assert.ok(ENTRY_SOURCE.includes('incomingIsNewer'))
  assert.ok(ENTRY_SOURCE.includes('function definedFieldsOf'))
  // Surat mutabakati varsayilan KAPALI.
  const surat = readFileSync('server/shipments/suratTrackingScheduler.ts', 'utf8')
  assert.ok(surat.includes("raw === 'true' || raw === '1'"))
  // Manuel sync hesap kapsamini gecirmeye devam eder.
  assert.ok(ENTRY_SOURCE.includes('marketplaceAccountId: syncAccountId,'))
})

// ═══ FRESHNESS DAMGASI (AUDIT BULGUSU) ════════════════════════════════════

test('B2-FRESHNESS: marketplace_last_modified_at IKI SEBEPLE null kaliyor', () => {
  // SEBEP 1 — `normalizeTrendyolOrders` ciktisinda `lastModifiedDate` alani
  // YOKTUR; damga yalnizca `rawOrder` icinde tasinir.
  const set = mapper.marketplaceUpdateSet(incomingShipped())
  assert.equal(set.marketplaceLastModifiedAt, null)

  // SEBEP 2 — alan tasinsa BILE mapper epoch-ms SAYIYI cozemez: `optionalDate`
  // Date.parse(String(value)) kullanir; "1786444609067" gecerli bir tarih
  // metni degildir → null. Trendyol bu alani epoch ms olarak dondurur.
  const epochMs = mapper.marketplaceUpdateSet(
    incomingShipped({ lastModifiedDate: 1_786_444_609_067 }),
  )
  assert.equal(epochMs.marketplaceLastModifiedAt, null, 'epoch ms COZULEMIYOR')

  // ISO metin verilirse yazilabiliyor — yani kolon/mapper sozlesmesi saglam,
  // eksik olan besleme ve sayisal damga cozumu.
  const iso = mapper.marketplaceUpdateSet(
    incomingShipped({ lastModifiedDate: '2026-08-11T10:36:49.067Z' }),
  )
  assert.ok(iso.marketplaceLastModifiedAt instanceof Date)

  // Bu AYRI bir kusurdur ve bu commit'te DUZELTILMEZ: alani doldurmak
  // `archiveMissingOrders` pencere capasini orderDate'ten
  // marketplaceLastModifiedAt'e kaydirir (reconcile davranis degisikligi).
  const repoSource = readFileSync('server/orders/orderRepository.ts', 'utf8')
  assert.ok(repoSource.includes('row.marketplaceLastModifiedAt ?? row.orderDate'))
})
