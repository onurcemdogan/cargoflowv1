import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { sql } from 'drizzle-orm'

// B3 — KALICI ARTIMLI SENKRON DEFTERİ.
//
// EN KRİTİK DEĞİŞMEZ: watermark, sağlayıcı çekimi başarılı olduğunda DEĞİL,
// o pencerenin KALICILAŞTIRMASI başarılı olduğunda ilerler. Aksi hâlde
// "çektim ama yazamadım" penceresi atlanır ve sipariş kalıcı olarak kaybolur.

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'drizzle')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const checkpoint = await import('./sync/marketplaceSyncCheckpoint.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []

async function makeDb() {
  const pglite = new PGlite()
  const db = drizzle(pglite, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  return { pglite, db }
}

async function makeOrg(db) {
  const result = await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('Org','org-${randomBytes(5).toString('hex')}') returning id`))
  return String(rowsOf(result)[0].id)
}

const AT = (iso) => new Date(iso)

/* ═══ ŞEMA ═════════════════════════════════════════════════════════════ */

test('CHK-1: 0009 ADDITIVE — mevcut satir/kolonlar korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const columns = rowsOf(await db.execute(sql.raw(
    `select column_name, is_nullable from information_schema.columns
     where table_name='integration_sync_state' order by column_name`)))
  const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]))
  // Yeni kolonlar NULLABLE (mevcut satırlar bozulmaz).
  assert.equal(byName.last_attempted_at.is_nullable, 'YES')
  assert.equal(byName.sync_watermark_at.is_nullable, 'YES')
  // Mevcut sözleşme KORUNDU.
  for (const existing of [
    'last_successful_sync_at', 'last_sync_status', 'last_fetched_count',
    'last_error_code', 'marketplace_account_id',
  ]) {
    assert.ok(byName[existing], `${existing} korunmali`)
  }
  const migration = nl(readFileSync(join(MIGRATIONS, '0009_fresh_zarda.sql'), 'utf8'))
  assert.equal(/DROP|TRUNCATE|DELETE FROM/i.test(migration), false, 'yikici ifade YOK')
  assert.equal(migration.toUpperCase().split('ADD COLUMN').length - 1, 2)
})

/* ═══ WATERMARK İLERLEME KURALI ════════════════════════════════════════ */

test('CHK-2: kalicilastirma BASARILI ise watermark ilerler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)

  const before = await checkpoint.readSyncCheckpoint(db, org, null)
  assert.equal(before.syncWatermarkAt, null, 'ilk turda konum YOK')

  const windowEnd = AT('2026-03-01T10:00:00.000Z')
  await checkpoint.recordSyncAttempt(db, org, null, AT('2026-03-01T09:59:00.000Z'))
  await checkpoint.commitSyncWatermark(db, org, null, windowEnd, { fetchedCount: 12 })

  const after = await checkpoint.readSyncCheckpoint(db, org, null)
  assert.equal(after.syncWatermarkAt.toISOString(), windowEnd.toISOString())
  assert.equal(after.lastSuccessfulAt.toISOString(), windowEnd.toISOString())
  assert.equal(after.lastStatus, 'success')
  assert.notEqual(after.lastAttemptedAt, null)
})

test('CHK-3: KALICILASTIRMA COKERSE watermark ILERLEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const firstWindow = AT('2026-03-01T10:00:00.000Z')
  await checkpoint.commitSyncWatermark(db, org, null, firstWindow)

  // "Sağlayıcı çekimi BAŞARILI, persistence DÜŞTÜ" → yalnız hata kaydı.
  await checkpoint.recordSyncFailure(db, org, null, 'PERSISTENCE')

  const after = await checkpoint.readSyncCheckpoint(db, org, null)
  assert.equal(
    after.syncWatermarkAt.toISOString(), firstWindow.toISOString(),
    'konum DEGISMEMELI — o pencere tekrar denenmeli',
  )
  assert.equal(
    after.lastSuccessfulAt.toISOString(), firstWindow.toISOString(),
    'onceki basari KORUNMALI',
  )
  assert.equal(after.lastStatus, 'failed')
  assert.equal(after.lastErrorCode, 'PERSISTENCE')
})

test('CHK-4: her hata sinifinda watermark KORUNUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const anchor = AT('2026-03-01T10:00:00.000Z')
  await checkpoint.commitSyncWatermark(db, org, null, anchor)

  for (const code of ['429', '503', 'TIMEOUT', '401', '403', 'CONTRACT', 'PERSISTENCE']) {
    await checkpoint.recordSyncFailure(db, org, null, code)
    const state = await checkpoint.readSyncCheckpoint(db, org, null)
    assert.equal(state.syncWatermarkAt.toISOString(), anchor.toISOString(), code)
    assert.equal(state.lastSuccessfulAt.toISOString(), anchor.toISOString(), code)
  }
})

/* ═══ MONOTONLUK ═══════════════════════════════════════════════════════ */

test('CHK-5: BAYAT tur daha yeni checkpointi EZEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)

  const newer = AT('2026-03-01T12:00:00.000Z')
  await checkpoint.commitSyncWatermark(db, org, null, newer)
  // Askıda kalmış eski tur GEÇ tamamlanıyor ve eski konumu yazmaya çalışıyor.
  const stale = AT('2026-03-01T08:00:00.000Z')
  await checkpoint.commitSyncWatermark(db, org, null, stale)

  const state = await checkpoint.readSyncCheckpoint(db, org, null)
  assert.equal(
    state.syncWatermarkAt.toISOString(), newer.toISOString(),
    'watermark GERIYE GITMEZ',
  )
  assert.equal(state.lastSuccessfulAt.toISOString(), newer.toISOString())
})

/* ═══ ARTIMLI PENCERE + SINIR ══════════════════════════════════════════ */

test('CHK-6: ilk turda pencere UYDURULMAZ', () => {
  const window = checkpoint.buildIncrementalWindow({
    syncWatermarkAt: null, lastSuccessfulAt: null,
  })
  assert.equal(window.initial, true)
  assert.equal(window.startTime, null, 'uydurma baslangic tarihi YOK')
})

test('CHK-7: artimli pencere GUVENLI ORTUSME ile kurulur', () => {
  const watermark = AT('2026-03-01T10:00:00.000Z')
  const now = AT('2026-03-01T10:30:00.000Z')
  const window = checkpoint.buildIncrementalWindow({ syncWatermarkAt: watermark }, now)

  assert.equal(window.initial, false)
  assert.equal(window.endTime.toISOString(), now.toISOString())
  assert.equal(
    window.startTime.getTime(),
    watermark.getTime() - checkpoint.SAFE_OVERLAP_MS,
    'ortusme kadar GERIDEN baslamali',
  )
  // Her turda tam tarih taraması YAPILMAZ.
  assert.ok(window.startTime.getTime() > AT('2026-01-01T00:00:00.000Z').getTime())
})

test('CHK-8: SAAT SINIRI — watermark cevresindeki kayitlar KACMAZ', () => {
  const watermark = AT('2026-03-01T10:00:00.000Z')
  const window = checkpoint.buildIncrementalWindow(
    { syncWatermarkAt: watermark },
    AT('2026-03-01T10:30:00.000Z'),
  )
  const inWindow = (iso) => {
    const t = AT(iso).getTime()
    return t >= window.startTime.getTime() && t <= window.endTime.getTime()
  }
  // T-1ms, T ve T+1ms: ÜÇÜ DE pencerede olmalı (örtüşme sayesinde).
  assert.equal(inWindow('2026-03-01T09:59:59.999Z'), true, 'T-1ms')
  assert.equal(inWindow('2026-03-01T10:00:00.000Z'), true, 'T')
  assert.equal(inWindow('2026-03-01T10:00:00.001Z'), true, 'T+1ms')
  // Örtüşme sınırının hemen dışı kapsanmaz (pencere sınırsız değil).
  assert.equal(inWindow('2026-03-01T09:50:00.000Z'), false, 'ortusme SINIRLI')
})

/* ═══ TENANT KAPSAMI ═══════════════════════════════════════════════════ */

test('CHK-9: checkpoint TENANT+HESAP kapsamli', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)

  await checkpoint.commitSyncWatermark(db, orgA, null, AT('2026-03-01T10:00:00.000Z'))
  const b = await checkpoint.readSyncCheckpoint(db, orgB, null)
  assert.equal(b.syncWatermarkAt, null, 'B ETKILENMEMELI')

  // Aynı org, farklı hesap AYRI defter.
  const accountRows = rowsOf(await db.execute(sql.raw(
    `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, display_name)
     values ('${orgA}','Trendyol','277221','A') returning id`)))
  const accountId = String(accountRows[0].id)
  const scoped = await checkpoint.readSyncCheckpoint(db, orgA, accountId)
  assert.equal(scoped.syncWatermarkAt, null, 'hesap bazinda AYRI defter')
})

/* ═══ BAYAT DURUM KURTARMA ═════════════════════════════════════════════ */

test('CHK-10: bayat `running` kurtarilir ama ILERLEME sayilmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const anchor = AT('2026-03-01T10:00:00.000Z')
  await checkpoint.commitSyncWatermark(db, org, null, anchor)
  // Süreç çöktü: satır `running` kaldı.
  await checkpoint.recordSyncAttempt(db, org, null, AT('2026-03-01T11:00:00.000Z'))
  assert.equal((await checkpoint.readSyncCheckpoint(db, org, null)).lastStatus, 'running')

  const recovery = await checkpoint.recoverStaleSyncState(
    db, 30 * 60 * 1000, AT('2026-03-01T12:00:00.000Z'),
  )
  assert.equal(recovery.recovered, 1)

  const state = await checkpoint.readSyncCheckpoint(db, org, null)
  assert.equal(state.lastStatus, 'stale_recovered')
  assert.equal(
    state.syncWatermarkAt.toISOString(), anchor.toISOString(),
    'kurtarma ILERLEME DEGILDIR',
  )
  assert.equal(state.lastSuccessfulAt.toISOString(), anchor.toISOString())
})

test('CHK-11: TAZE `running` kurtarma ile DUSURULMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await checkpoint.recordSyncAttempt(db, org, null, AT('2026-03-01T11:59:00.000Z'))
  const recovery = await checkpoint.recoverStaleSyncState(
    db, 30 * 60 * 1000, AT('2026-03-01T12:00:00.000Z'),
  )
  assert.equal(recovery.recovered, 0)
  assert.equal((await checkpoint.readSyncCheckpoint(db, org, null)).lastStatus, 'running')
})

/* ═══ YAPISAL ══════════════════════════════════════════════════════════ */

test('CHK-12: ikinci durum tablosu ACILMADI, saglayici TANINMIYOR', () => {
  const raw = nl(readFileSync('server/sync/marketplaceSyncCheckpoint.ts', 'utf8'))
  const code = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ')
  // Mevcut tablo kullanılır.
  assert.ok(code.includes('integrationSyncState'))
  assert.equal(code.includes('pgTable'), false, 'yeni tablo TANIMLANMAZ')
  for (const forbidden of ['fetch(', 'Trendyol', 'trendyolClient', 'axios', 'credential']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  // Başarısızlık yolu watermark kolonlarını SET ETMEZ.
  const failure = raw.slice(raw.indexOf('export async function recordSyncFailure'))
  const failureBody = failure.slice(0, failure.indexOf('\n}\n'))
  assert.equal(failureBody.includes('syncWatermarkAt:'), false)
  assert.equal(failureBody.includes('lastSuccessfulSyncAt:'), false)
})
