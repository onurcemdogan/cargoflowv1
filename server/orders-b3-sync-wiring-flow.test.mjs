import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// P2/B3 — ARTIMLI İMLECİN GERÇEKTEN BAĞLANDIĞININ KANITI.
//
// `orders-b3-sync-window-flow` politikayı (saf karar) kilitler. Bu dosya
// politikanın ÇALIŞMA ZAMANINA bağlandığını ölçer:
//   · imleç DB'ye pencerenin ÜST SINIRI olarak yazılıyor mu (now DEĞİL),
//   · yazılan imleç bir sonraki pencereyi GERÇEKTEN daraltıyor mu,
//   · kısmi/başarısız sync imleci BOZUYOR mu,
//   · açık istemci tarihi (manuel geri-dolum) hâlâ KAZANIYOR mu,
//   · örtüşen pencere DUPLICATE üretiyor mu.
//
// Ağ YOK, gerçek pazaryeri çağrısı YOK, üretim yazması YOK.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const policy = await import('./orders/syncWindowPolicy.ts')
const onboardingRepo = await import('./onboarding/onboardingRepository.ts')
const orderRepo = await import('./orders/orderRepository.ts')

// Satır sonu (CRLF/LF) checkout ayarına göre değişir; sözleşme assertion'ları
// bundan ETKİLENMEMELİ.
const SOURCE = readFileSync(join(here, 'index.mjs'), 'utf8')
  .split('\r\n')
  .join('\n')

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

async function freshDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'b3', slug: `b3-${randomBytes(4).toString('hex')}` })
    .returning()
  return { db, organizationId: org.id }
}

const readState = (db, organizationId) =>
  onboardingRepo.getSyncState(db, organizationId, 'orders')

const NOW = Date.parse('2026-08-18T12:00:00Z')
const HOUR = 60 * 60 * 1000

/* ═══ index.mjs BAĞLAMA SÖZLEŞMESİ ═══════════════════════════════════ */

test('B3W-1: cekim penceresi IMLECTEN turetilir (sabit 7 gun DEGIL)', () => {
  assert.match(
    SOURCE,
    /const syncWindow = resolveSyncWindow\(\{\s*\n\s*checkpointMs: priorCheckpointMs,/,
    'sync handler resolveSyncWindow ile pencere turetmiyor',
  )
  assert.ok(
    SOURCE.includes("await import('./orders/syncWindowPolicy.ts')"),
    'politika modulu sync yolunda YUKLENMIYOR',
  )
  // Imlec DB'den okunur, istemciden DEGIL.
  assert.match(
    SOURCE,
    /priorCheckpointMs = epochMsOrNull\(priorSyncState\?\.lastSuccessfulSyncAt\)/,
  )
})

test('B3W-2: acik istemci tarihi KAZANIR (manuel geri-dolum korunur)', () => {
  assert.match(SOURCE, /startDate: clientStartMs \?\? syncWindow\.startMs/)
  assert.match(SOURCE, /endDate: clientEndMs \?\? syncWindow\.endMs/)
})

test('B3W-3: reconcile penceresi cekim penceresiyle AYNI kaynaktan gelir', () => {
  // Ayri varsayilan hesaplayan eski blok KALMAMALI: fetch 7 gun, reconcile
  // baska bir 7 gun hesaplarsa arsivleme kapsami ayrisir.
  assert.ok(
    !SOURCE.includes('const windowStart = Number(query.startDate)'),
    'reconcile penceresi hala AYRI varsayilan hesapliyor',
  )
  assert.match(
    SOURCE,
    /const reconcileWindow = \{\s*\n\s*startMs: Number\(query\.startDate\),\s*\n\s*endMs: Number\(query\.endDate\),/,
  )
})

test('B3W-4: imlec advanceCheckpoint kararindan yazilir', () => {
  assert.match(SOURCE, /const checkpoint = advanceCheckpoint\(\{/)
  assert.match(SOURCE, /candidateCheckpointMs: syncWindow\.candidateCheckpointMs/)
  assert.match(SOURCE, /complete: persistResult\.complete/)
  assert.match(SOURCE, /successfulSyncAt: checkpointAt/)
})

/* ═══ epochMsOrNull — "yok" ile "1970" AYRIMI ════════════════════════ */

/** Yardimciyi index.mjs'ten IZOLE calistirir (boot YOK). */
function loadEpochHelper() {
  const lines = SOURCE.split('\n')
  const start = lines.findIndex((line) => line.startsWith('function epochMsOrNull'))
  assert.ok(start >= 0, 'epochMsOrNull bulunamadi')
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const block = lines.slice(start, end + 1).join('\n')
  return new Function(`${block}\nreturn epochMsOrNull`)()
}

test('B3W-5: imlecsiz kiraci 1970 kovasina DUSMEZ', () => {
  const epochMsOrNull = loadEpochHelper()
  // KRITIK: Number(null) === 0. 0 donerse pencere 1970'ten baslar ve
  // callTrendyolOrders'in 30 gunluk ust siniri cekimi TAMAMEN reddeder.
  assert.equal(epochMsOrNull(null), null)
  assert.equal(epochMsOrNull(undefined), null)
  assert.equal(epochMsOrNull(''), null)
  assert.equal(epochMsOrNull('gecersiz'), null)
  assert.equal(epochMsOrNull(new Date(NOW)), NOW)
  assert.equal(epochMsOrNull(NOW), NOW)
  assert.equal(epochMsOrNull('2026-08-18T12:00:00.000Z'), NOW)
  assert.equal(epochMsOrNull(String(NOW)), NOW)
})

/* ═══ İMLEÇ = WATERMARK (now DEĞİL) ══════════════════════════════════ */

test('B3W-6: basarili sync imleci PENCERENIN UST SINIRINA yazar', async () => {
  const { db, organizationId } = await freshDb()
  await onboardingRepo.recordSyncState(db, organizationId, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    fetchedCount: 3,
    successfulSyncAt: new Date(NOW),
  })
  const state = await readState(db, organizationId)
  assert.equal(
    new Date(state.lastSuccessfulSyncAt).getTime(),
    NOW,
    'imlec now() ile yazildi — cekim suresince olusan siparisler KAYBOLUR',
  )
})

test('B3W-7: watermark verilmezse ESKI davranis (now) korunur', async () => {
  const { db, organizationId } = await freshDb()
  const before = Date.now()
  await onboardingRepo.recordSyncState(db, organizationId, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    fetchedCount: 1,
  })
  const state = await readState(db, organizationId)
  const written = new Date(state.lastSuccessfulSyncAt).getTime()
  assert.ok(written >= before - 1000, `geriye gitti: ${written}`)
  assert.ok(written <= Date.now() + 1000)
})

test('B3W-8: kismi/basarisiz sync imleci BOZMAZ', async () => {
  const { db, organizationId } = await freshDb()
  await onboardingRepo.recordSyncState(db, organizationId, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    successfulSyncAt: new Date(NOW),
  })
  for (const status of ['partial', 'failed']) {
    await onboardingRepo.recordSyncState(db, organizationId, {
      provider: 'trendyol',
      resource: 'orders',
      status,
      errorCode: status === 'failed' ? '502' : null,
    })
    const state = await readState(db, organizationId)
    assert.equal(
      new Date(state.lastSuccessfulSyncAt).getTime(),
      NOW,
      `${status} imleci EZDI — cekilemeyen aralik kalici olarak atlanir`,
    )
  }
})

/* ═══ YAZILAN İMLEÇ SONRAKİ PENCEREYİ GERÇEKTEN DARALTIR ═════════════ */

test('B3W-9: DBye yazilan imlec sonraki cekimi DARALTIR', async () => {
  const { db, organizationId } = await freshDb()
  // 1) Imlec YOK → bootstrap (7 gun).
  const bootstrap = policy.resolveSyncWindow({ checkpointMs: null, nowMs: NOW })
  assert.equal(bootstrap.mode, 'BOOTSTRAP')

  // 2) Tam basarili sync → imlec pencerenin ust sinirina yazilir.
  const advanced = policy.advanceCheckpoint({
    currentCheckpointMs: null,
    candidateCheckpointMs: bootstrap.candidateCheckpointMs,
    complete: true,
  })
  assert.equal(advanced.advanced, true)
  await onboardingRepo.recordSyncState(db, organizationId, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    successfulSyncAt: new Date(advanced.checkpointMs),
  })

  // 3) Sonraki kosu imleci DB'den okur.
  const state = await readState(db, organizationId)
  const checkpointMs = new Date(state.lastSuccessfulSyncAt).getTime()
  const next = policy.resolveSyncWindow({
    checkpointMs,
    nowMs: NOW + HOUR,
    lastReconciliationAtMs: policy.deriveReconciliationAnchorMs({ checkpointMs }),
  })
  assert.equal(next.mode, 'INCREMENTAL')
  const bootstrapSpan = bootstrap.endMs - bootstrap.startMs
  const nextSpan = next.endMs - next.startMs
  assert.ok(
    nextSpan < bootstrapSpan,
    `pencere DARALMADI: ${nextSpan} >= ${bootstrapSpan}`,
  )
  // Emniyet payi korunur: bosluk YOK.
  assert.ok(next.startMs <= bootstrap.endMs, 'pencereler arasinda BOSLUK var')
})

test('B3W-10: hesaplar birbirinin imlecini GORMEZ', async () => {
  const { db, organizationId } = await freshDb()
  const [accountA] = await db
    .insert(schema.marketplaceAccounts)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      providerAccountId: '277221',
      displayName: 'A',
    })
    .returning()
  const [accountB] = await db
    .insert(schema.marketplaceAccounts)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      providerAccountId: '999999',
      displayName: 'B',
    })
    .returning()

  await onboardingRepo.recordSyncState(db, organizationId, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    marketplaceAccountId: accountA.id,
    successfulSyncAt: new Date(NOW),
  })
  const stateB = await onboardingRepo.getSyncState(
    db, organizationId, 'orders', accountB.id,
  )
  assert.ok(
    !stateB?.lastSuccessfulSyncAt,
    'hesap B, hesap Anin imlecini devraldi — B eksik cekim yapar',
  )
  const stateA = await onboardingRepo.getSyncState(
    db, organizationId, 'orders', accountA.id,
  )
  assert.equal(new Date(stateA.lastSuccessfulSyncAt).getTime(), NOW)
})

/* ═══ ÖRTÜŞEN PENCERE DUPLICATE ÜRETMEZ (replay güvenliği) ═══════════ */

test('B3W-11: ortusen pencere ayni siparisi TEKRARLAMAZ', async () => {
  const { db, organizationId } = await freshDb()
  const order = {
    marketplace: 'Trendyol',
    packageId: 'PKG-REPLAY-1',
    shipmentPackageId: 'PKG-REPLAY-1',
    orderNumber: '1141234567',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'A',
    customerLastName: 'B',
    city: 'İstanbul',
    totalAmount: 100,
    currency: 'TRY',
    orderDate: new Date(NOW).toISOString(),
    // Satirlar `items`ten turetilir (orderMapper.toLineInsertValues).
    items: [
      { lineId: 'L-1', productName: 'X', quantity: 1, price: 100, barcode: 'BC1' },
    ],
  }
  // Emniyet payi yuzunden ayni kayit ARDISIK iki pencerede de gelir.
  await orderRepo.upsertMarketplaceOrders(db, organizationId, [order])
  await orderRepo.upsertMarketplaceOrders(db, organizationId, [order])

  const rows = await db.select().from(schema.orders)
  assert.equal(rows.length, 1, `ortusme DUPLICATE uretti: ${rows.length} satir`)
  const lines = await db.select().from(schema.orderLines)
  assert.equal(lines.length, 1, `satir duplicate: ${lines.length}`)
})
