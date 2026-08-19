import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { sql } from 'drizzle-orm'

// MIGRATION KAYIT (REGISTRATION) REGRESYONU.
//
// ═══ NEDEN BU DOSYA VAR ══════════════════════════════════════════════════
//
// ÖLÇÜLEN ÜRETİM KUSURU: `drizzle/0009_surat_trace_attempts.sql` DOSYA OLARAK
// vardı, doğru SQL'i içeriyordu, ama `drizzle/meta/_journal.json` 0007'de
// bitiyordu. Drizzle'ın klasör migrator'ı KLASÖRÜ TARAMAZ — JOURNAL'I okur.
// Sonuç: `npm run db:migrate` BAŞARIYLA çıkıyor ve HİÇBİR ŞEY yapmıyordu.
// Tablo üretimde hiç oluşmadı.
//
// AYNI KUSUR 0008'de de vardı (pazaryeri kimlik allowlist'i) — o da
// kaydedilmemişti, yani üretimde Hepsiburada/n11 kimliği YAZILAMAZ durumdaydı.
//
// ═══ ÖNCEKİ TESTLER BUNU NEDEN KAÇIRDI ═══════════════════════════════════
//
// Mevcut hermetik testler migration'ları şöyle uyguluyordu:
//     readdirSync(drizzle).filter(f => f.endsWith('.sql'))
// yani DOSYALARI DOĞRUDAN okuyup çalıştırıyordu. Bu, journal'ı BYPASS eder.
// Test yeşil, üretim kırık. Bu dosya bu boşluğu kapatır: GERÇEK mekanizmayı
// (journal tabanlı `migrate(...)`) çalıştırır.

const here = dirname(fileURLToPath(import.meta.url))
const drizzleFolder = join(here, '..', 'drizzle')
const journalPath = join(drizzleFolder, 'meta', '_journal.json')

const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
const sqlFiles = readdirSync(drizzleFolder)
  .filter((name) => name.endsWith('.sql'))
  .sort()

const TRACE_TABLE = 'surat_trace_attempts'
const TRACE_UNIQUE_INDEX = 'surat_trace_attempts_org_trace_unique'
const TRACE_TAG = '0009_surat_trace_attempts'

/* ═══ 1..2 — DOSYA ve JOURNAL KAYDI ═════════════════════════════════ */

test('MIG-1: 0009 SQL dosyasi VARDIR', () => {
  assert.ok(
    sqlFiles.includes(`${TRACE_TAG}.sql`),
    `${TRACE_TAG}.sql bulunamadi`,
  )
})

test('MIG-2: journal 0009 etiketini TAM olarak icerir', () => {
  const tags = journal.entries.map((entry) => entry.tag)
  assert.ok(
    tags.includes(TRACE_TAG),
    `journal ${TRACE_TAG} kaydini TASIMIYOR — migrator dosyayi GORMEZ`,
  )
})

/* ═══ 3..4 — SIRA ve TEKILLIK ═══════════════════════════════════════ */

test('MIG-3: journal idx sirasi 0dan artan ve BOSLUKSUZ', () => {
  journal.entries.forEach((entry, position) => {
    assert.equal(entry.idx, position, `idx bozuk: ${entry.tag}`)
  })
  // `when` monoton artmali; aksi halde uygulama sirasi belirsizlesir.
  for (let i = 1; i < journal.entries.length; i += 1) {
    assert.ok(
      Number(journal.entries[i].when) > Number(journal.entries[i - 1].when),
      `when monoton DEGIL: ${journal.entries[i].tag}`,
    )
  }
})

test('MIG-4: journalda TEKRARLANAN etiket YOK', () => {
  const tags = journal.entries.map((entry) => entry.tag)
  assert.equal(new Set(tags).size, tags.length, 'journalda duplicate etiket var')
})

test('MIG-4b: HER SQL dosyasi journalda KAYITLI (sessiz dosya YOK)', () => {
  // Kusurun ta kendisi: kayitsiz bir .sql dosyasi sessizce YOK SAYILIR.
  const tags = new Set(journal.entries.map((entry) => entry.tag))
  const unregistered = sqlFiles
    .map((name) => name.replace(/\.sql$/, ''))
    .filter((tag) => !tags.has(tag))
  assert.deepEqual(
    unregistered, [],
    `journalda KAYITLI OLMAYAN migration(lar): ${unregistered.join(', ')}`,
  )
})

test('MIG-4c: HER journal kaydinin SQL dosyasi VAR', () => {
  const files = new Set(sqlFiles.map((name) => name.replace(/\.sql$/, '')))
  const missing = journal.entries
    .map((entry) => entry.tag)
    .filter((tag) => !files.has(tag))
  assert.deepEqual(missing, [], `SQL dosyasi OLMAYAN journal kaydi: ${missing}`)
})

/* ═══ 5..7 — SQL İÇERİĞİ ════════════════════════════════════════════ */

const traceSql = readFileSync(join(drizzleFolder, `${TRACE_TAG}.sql`), 'utf8')

test('MIG-5: SQL surat_trace_attempts tablosunu OLUSTURUR', () => {
  assert.match(traceSql, new RegExp(`CREATE TABLE[^;]*"${TRACE_TABLE}"`, 'i'))
})

test('MIG-6: SQL unique indeksi OLUSTURUR', () => {
  assert.match(traceSql, new RegExp(`CREATE UNIQUE INDEX[^;]*"${TRACE_UNIQUE_INDEX}"`, 'i'))
})

test('MIG-7: unique semantigi organization_id + trace_id', () => {
  const match = traceSql.match(
    new RegExp(`"${TRACE_UNIQUE_INDEX}"[\\s\\S]*?\\(([^)]*)\\)`, 'i'),
  )
  assert.ok(match, 'unique indeks kolonlari okunamadi')
  const columns = match[1]
    .split(',')
    .map((part) => part.trim().replace(/"/g, ''))
  assert.deepEqual(
    columns, ['organization_id', 'trace_id'],
    'unique kapsam organization_id + trace_id DEGIL',
  )
})

/* ═══ EN ÖNEMLİSİ — GERÇEK MİGRATOR ═════════════════════════════════ */

async function migrateFresh() {
  const pglite = new PGlite()
  const db = drizzle(pglite)
  // GERÇEK mekanizma: journal tabanli klasor migrator. Dosyalari elle
  // okumaz — bu yuzden KAYIT EKSIKLIGINI yakalar.
  await migrate(db, { migrationsFolder: drizzleFolder })
  return { pglite, db }
}

const regclass = async (db, name) => {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${name}`}) AS reg`)
  const rows = result.rows ?? result
  return rows[0]?.reg ?? null
}

test('MIG-8: GERCEK migrator temiz DBde tabloyu OLUSTURUR', async () => {
  const { db } = await migrateFresh()
  const reg = await regclass(db, TRACE_TABLE)
  assert.notEqual(
    reg, null,
    `to_regclass('public.${TRACE_TABLE}') NULL — migration KAYITLI DEGIL`,
  )
})

test('MIG-9: GERCEK migrator unique indeksi de olusturur', async () => {
  const { db } = await migrateFresh()
  const result = await db.execute(sql`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = ${TRACE_TABLE} AND indexname = ${TRACE_UNIQUE_INDEX}
  `)
  const rows = result.rows ?? result
  assert.equal(rows.length, 1, 'unique indeks OLUSMADI')
  // Semantik: iki kolon birlikte tekil.
  assert.match(String(rows[0].indexdef), /organization_id/)
  assert.match(String(rows[0].indexdef), /trace_id/)
})

test('MIG-9b: unique kisit GERCEKTEN ayni (org, traceId) ikilisini engeller', async () => {
  const { db } = await migrateFresh()
  const [org] = (await db.execute(sql`
    INSERT INTO organizations (name, slug) VALUES ('mig', 'mig-test')
    RETURNING id
  `)).rows
  const insert = async () => db.execute(sql`
    INSERT INTO surat_trace_attempts (organization_id, trace_id, stages)
    VALUES (${org.id}, 'TR-DUP', '[]'::jsonb)
  `)
  await insert()
  await assert.rejects(insert, 'ayni (org, traceId) IKINCI kez yazilabildi')
})

test('MIG-10: ikinci kez calistirmak migration TEKRARLAMAZ', async () => {
  const { db } = await migrateFresh()
  // Ayni DBde tekrar: idempotent taninmali, hata VERMEMELI.
  await migrate(db, { migrationsFolder: drizzleFolder })
  const reg = await regclass(db, TRACE_TABLE)
  assert.notEqual(reg, null, 'tekrar kosuda tablo kayboldu')
  // Journal kaydi sayisi kadar uygulanmis migration olmali; fazlasi YOK.
  const applied = await db.execute(sql`
    SELECT count(*)::int AS total FROM drizzle.__drizzle_migrations
  `)
  const rows = applied.rows ?? applied
  assert.equal(
    Number(rows[0].total), journal.entries.length,
    'migration TEKRAR uygulandi (journal sayisiyla uyusmuyor)',
  )
})

/* ═══ 0008 de AYNI KUSURU TASIYORDU ════════════════════════════════ */

test('MIG-11: 0008 kimlik allowlisti de GERCEKTEN uygulanir', () => {
  // 0008 da kayitsizdi: uretimde Hepsiburada/n11 kimligi YAZILAMAZDI.
  const tags = journal.entries.map((entry) => entry.tag)
  assert.ok(
    tags.includes('0008_marketplace_provider_allowlist'),
    '0008 journalda kayitli DEGIL',
  )
})

test('MIG-12: 0008 sonrasi allowlist hepsiburada/n11 kabul eder', async () => {
  const { db } = await migrateFresh()
  const [org] = (await db.execute(sql`
    INSERT INTO organizations (name, slug) VALUES ('mig2', 'mig-test-2')
    RETURNING id
  `)).rows
  for (const provider of ['trendyol', 'surat', 'hepsiburada', 'n11']) {
    await db.execute(sql`
      INSERT INTO integration_credentials
        (organization_id, provider, encrypted_payload)
      VALUES (${org.id}, ${provider}, 'x')
    `)
  }
  const count = await db.execute(sql`
    SELECT count(*)::int AS total FROM integration_credentials
    WHERE organization_id = ${org.id}
  `)
  const rows = count.rows ?? count
  assert.equal(Number(rows[0].total), 4, 'allowlist genislemesi UYGULANMADI')
})

/* ═══ SNAPSHOT TUTARLILIĞI — sessiz duplicate migration ONLENIR ═════ */

test('MIG-13: EN SON journal kaydinin snapshotu VARDIR', () => {
  // OLCULEN RISK: snapshot 0007de kalinca `drizzle-kit generate` semayi 0007
  // ile kiyaslar ve 0008/0009u YENIDEN uretir. Gercekten olctuk: uretilen
  // 0010, ayni tabloyu TEKRAR olusturuyor ve provider check kisitini
  // DUSURUYORDU. Bu yuzden en son migrationun snapshotu ZORUNLUDUR.
  const lastTag = journal.entries[journal.entries.length - 1].tag
  const prefix = lastTag.split('_')[0]
  const snapshots = readdirSync(join(drizzleFolder, 'meta'))
    .filter((name) => name.endsWith('_snapshot.json'))
  assert.ok(
    snapshots.includes(`${prefix}_snapshot.json`),
    `EN SON migration (${lastTag}) icin snapshot YOK — sonraki generate `
    + 'duplicate migration uretir',
  )
})

test('MIG-14: snapshot zinciri KIRIK DEGIL', () => {
  const metaDir = join(drizzleFolder, 'meta')
  const snapshots = readdirSync(metaDir)
    .filter((name) => name.endsWith('_snapshot.json'))
    .sort()
  const byId = new Map()
  for (const name of snapshots) {
    const snap = JSON.parse(readFileSync(join(metaDir, name), 'utf8'))
    byId.set(snap.id, name)
  }
  // Her snapshotun prevId'i ya baska bir snapshotu gosterir ya da baslangictir.
  for (const name of snapshots) {
    const snap = JSON.parse(readFileSync(join(metaDir, name), 'utf8'))
    if (!snap.prevId || /^0{8}-0{4}/.test(String(snap.prevId))) continue
    assert.ok(
      byId.has(snap.prevId),
      `${name} prevId zincirde YOK (${snap.prevId})`,
    )
  }
})

test('MIG-15: EN SON snapshot mevcut semayi yansitir', () => {
  // `drizzle-kit generate` "No schema changes" demeli. Bunu dogrudan
  // cagirmadan olcmek icin: en son snapshot, semadaki YENI tablolari
  // icermelidir.
  const lastTag = journal.entries[journal.entries.length - 1].tag
  const prefix = lastTag.split('_')[0]
  const snap = JSON.parse(
    readFileSync(join(drizzleFolder, 'meta', `${prefix}_snapshot.json`), 'utf8'),
  )
  const tables = Object.keys(snap.tables ?? {})
  assert.ok(
    tables.some((name) => name.endsWith(TRACE_TABLE)),
    'en son snapshot surat_trace_attempts TASIMIYOR',
  )
  // 0008in genisletilmis allowlisti de snapshotta olmali.
  const credentials = snap.tables['public.integration_credentials']
    ?? snap.tables.integration_credentials
  const check = credentials?.checkConstraints?.integration_credentials_provider_check
  assert.ok(check, 'provider check kisiti snapshotta YOK')
  for (const provider of ['hepsiburada', 'n11']) {
    assert.match(
      String(check.value), new RegExp(provider),
      `snapshot allowlisti ${provider} icermiyor`,
    )
  }
})
