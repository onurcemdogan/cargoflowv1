import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { sql } from 'drizzle-orm'

// B2-1b-B2 · FAZ 1-2 — MIGRATION SÖZLEŞMESİ + PROVA.
//
// `0008` (ve `0009`) production'da HENÜZ UYGULANMADI. Bu dosya yükseltmeyi GERÇEK drizzle
// migrator'ı ile (elle SQL exec ederek DEĞİL) atılabilir bir DB üzerinde prova
// eder: önce yalnız 0000-0007 uygulanmış "legacy" bir veritabanı kurulur, içine
// iş verisi yazılır, sonra tam klasörle migrator yeniden koşturulur — üretimde
// olacak şeyin aynısı.
//
// PRODUCTION'A HİÇBİR ŞEY UYGULANMAZ.

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'drizzle')
const journal = JSON.parse(
  readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
)
const TARGET = '0008_busy_wong'
const nl = (v) => v.split('\r\n').join('\n')

/** Yalnız `upTo` dahil olacak şekilde geçici bir migration klasörü kurar. */
function partialMigrationsFolder(upToTag) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-mig-'))
  mkdirSync(join(dir, 'meta'), { recursive: true })
  const cut = journal.entries.findIndex((e) => e.tag === upToTag)
  assert.ok(cut >= 0, `${upToTag} journal'da yok`)
  const entries = journal.entries.slice(0, cut)
  for (const entry of entries) {
    cpSync(join(MIGRATIONS, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2),
  )
  return { dir, appliedCount: entries.length }
}

const rows = (result) => (Array.isArray(result) ? result : result.rows) ?? []

async function tableNames(db) {
  const result = await db.execute(sql.raw(
    `select table_name from information_schema.tables
     where table_schema='public' order by table_name`))
  return rows(result).map((r) => String(r.table_name))
}

async function counts(db, tables) {
  const out = {}
  for (const t of tables) {
    const result = await db.execute(sql.raw(`select count(*)::int as n from ${t}`))
    out[t] = Number(rows(result)[0].n)
  }
  return out
}

/* ═══ FAZ 1 — MIGRATION SÖZLEŞMESİ (STATİK) ════════════════════════════ */

test('MIG-1: 0008 ADDITIVE — yikici ifade YOK', () => {
  const source = nl(readFileSync(join(MIGRATIONS, `${TARGET}.sql`), 'utf8'))
  // İFADE BAZINDA bak: `ON UPDATE no action` bir DML değildir, ham metin
  // taraması onu yanlışlıkla yıkıcı sayardı.
  const statements = source
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)
  const ALLOWED_STARTS = ['CREATE TABLE', 'CREATE UNIQUE INDEX', 'CREATE INDEX']
  for (const statement of statements) {
    const upper = statement.toUpperCase()
    const additive =
      ALLOWED_STARTS.some((prefix) => upper.startsWith(prefix)) ||
      // Yalnız yeni kısıt ekleme biçimindeki ALTER kabul edilir.
      /^ALTER TABLE "ORDER_FILTER_PROJECTION" ADD CONSTRAINT/.test(upper)
    assert.ok(additive, `ADDITIVE OLMAYAN ifade: ${statement.slice(0, 70)}`)
    for (const forbidden of ['DROP ', 'TRUNCATE', 'DELETE FROM', 'ALTER COLUMN']) {
      assert.equal(upper.includes(forbidden), false, `${forbidden} icermemeli`)
    }
  }
  const upper = source.toUpperCase()
  // Yalnız TEK yeni tablo; hiçbir iş tablosuna dokunulmaz.
  assert.equal(upper.split('CREATE TABLE').length - 1, 1)
  for (const business of ['"orders"', '"shipments"', '"shipment_operations"']) {
    const touches = source
      .split('--> statement-breakpoint')
      .filter((s) => s.includes(business) && !s.includes('order_filter_projection'))
    assert.deepEqual(touches, [], `${business} DEGISTIRILMEMELI`)
  }
  // Sır/kimlik bilgisi taşımaz.
  for (const secret of ['password', 'sifre', 'apiKey', 'api_key', 'secret']) {
    assert.equal(source.toLowerCase().includes(secret.toLowerCase()), false)
  }
})

test('MIG-2: journal MONOTON — gecmis yeniden yazilmamis', () => {
  // 0008 yerinde ve sonrasina yalniz EKLENMIS olmali (yeniden numaralandirma
  // veya tarih duzenlemesi YOK). Yeni migration eklendikce bu test yasar.
  const index = journal.entries.findIndex((entry) => entry.tag === TARGET)
  assert.ok(index >= 0, '0008 journal da olmali')
  for (let i = 0; i < journal.entries.length; i += 1) {
    assert.equal(journal.entries[i].idx, i, 'idx yeniden numaralandirilmamis')
    if (i > 0) {
      assert.ok(
        journal.entries[i].when > journal.entries[i - 1].when,
        `${journal.entries[i].tag} tarihi geriye gitmis`,
      )
    }
  }
})

/* ═══ FAZ 2 — PROVA (GERÇEK MIGRATOR) ══════════════════════════════════ */

test('MIG-3: BOS DB — tum migrationlar gercek runner ile gecer', async (t) => {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  const db = drizzle(pglite)

  await migrate(db, { migrationsFolder: MIGRATIONS })

  const tables = await tableNames(db)
  assert.ok(tables.includes('order_filter_projection'))
  for (const required of ['orders', 'shipments', 'shipment_operations', 'organizations']) {
    assert.ok(tables.includes(required), `${required} olmali`)
  }
  // Migrator kendi defterini tutar: tum girdiler uygulanmis.
  const applied = await db.execute(sql.raw(
    `select count(*)::int as n from drizzle.__drizzle_migrations`))
  assert.equal(Number(rows(applied)[0].n), journal.entries.length)
})

test('MIG-4: LEGACY DB — 0008 verilere DOKUNMADAN uygulanir', async (t) => {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  const db = drizzle(pglite)
  const { dir, appliedCount } = partialMigrationsFolder(TARGET)
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // 1) 0008 ÖNCESİ durum.
  await migrate(db, { migrationsFolder: dir })
  const before = await tableNames(db)
  assert.equal(before.includes('order_filter_projection'), false, '0008 henuz YOK')

  // 2) Gerçekçi iş verisi (sipariş + gönderi + operasyon + kimlik kaydı).
  await db.execute(sql.raw(
    `insert into organizations (id, name, slug)
     values ('11111111-1111-1111-1111-111111111111','Org','org-legacy')`))
  for (let i = 0; i < 5; i += 1) {
    await db.execute(sql.raw(
      `insert into orders (organization_id, marketplace, package_id, order_number,
         marketplace_status, operation_status, shipping_city, order_date)
       values ('11111111-1111-1111-1111-111111111111','Trendyol','PKG-${i}','ORD-${i}',
         'Created','NEW','İstanbul','2026-01-0${i + 1}T09:00:00.000Z')`))
    await db.execute(sql.raw(
      `insert into shipments (organization_id, marketplace, package_id, provider,
         source, status, tracking_number)
       values ('11111111-1111-1111-1111-111111111111','Trendyol','PKG-${i}','surat',
         'local_create','created','TRK-${i}')`))
    await db.execute(sql.raw(
      `insert into shipment_operations (organization_id, marketplace, package_id,
         provider, operation_type, idempotency_key, status)
       values ('11111111-1111-1111-1111-111111111111','Trendyol','PKG-${i}','surat',
         'CREATE','IDEM-${i}','succeeded')`))
  }
  const BUSINESS = ['organizations', 'orders', 'shipments', 'shipment_operations']
  const countsBefore = await counts(db, BUSINESS)
  const ordersBefore = rows(await db.execute(sql.raw(
    `select id, package_id, order_number, marketplace_status, operation_status,
            shipping_city from orders order by package_id`)))

  // 3) YÜKSELTME: tam klasörle migrator — yalnız 0008 uygulanmalı.
  await migrate(db, { migrationsFolder: MIGRATIONS })

  const applied = Number(rows(await db.execute(sql.raw(
    `select count(*)::int as n from drizzle.__drizzle_migrations`)))[0].n)
  // 0008 VE ondan sonraki tüm BEKLEYEN migrationlar uygulanır — fazlası değil.
  // Sayı sabitlenmez: yeni migration eklendikçe bu test yaşar.
  assert.equal(
    applied, journal.entries.length,
    'bekleyen migrationlarin TAMAMI uygulanmali',
  )
  assert.ok(applied > appliedCount, 'en az bir migration eklenmeli')

  // 4) İş verisi BİREBİR korunur.
  assert.deepEqual(await counts(db, BUSINESS), countsBefore, 'satir sayilari DEGISMEMELI')
  const ordersAfter = rows(await db.execute(sql.raw(
    `select id, package_id, order_number, marketplace_status, operation_status,
            shipping_city from orders order by package_id`)))
  assert.deepEqual(ordersAfter, ordersBefore, 'siparis satirlari DEGISMEMELI')

  // 5) Projeksiyon tablosu oluştu ve BOŞ (backfill ayrı adım).
  assert.ok((await tableNames(db)).includes('order_filter_projection'))
  assert.deepEqual(await counts(db, ['order_filter_projection']), {
    order_filter_projection: 0,
  })
})

test('MIG-5: uygulanan sema, kod sozlesmesiyle BIREBIR', async (t) => {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  const db = drizzle(pglite)
  await migrate(db, { migrationsFolder: MIGRATIONS })

  // Kolonlar + nullability + varsayilanlar.
  const columns = rows(await db.execute(sql.raw(
    `select column_name, data_type, is_nullable, column_default
     from information_schema.columns
     where table_name='order_filter_projection' order by column_name`)))
  const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]))
  const NOT_NULL = ['id', 'organization_id', 'order_id', 'projection_version',
    'created_at', 'updated_at']
  const NULLABLE = ['marketplace_token', 'operation_status_token', 'marketplace_status',
    'shipping_city_token', 'shipping_district_token', 'customer_search_token',
    'order_number_order_token', 'order_number_shipment_token', 'cargo_slip_order_token',
    'cargo_slip_shipment_token', 'cargo_slip_operation_token', 'order_date']
  assert.deepEqual(
    Object.keys(byName).sort(),
    [...NOT_NULL, ...NULLABLE].sort(),
    'kolon kumesi sozlesmeden FARKLI',
  )
  for (const name of NOT_NULL) assert.equal(byName[name].is_nullable, 'NO', name)
  for (const name of NULLABLE) assert.equal(byName[name].is_nullable, 'YES', name)
  assert.match(String(byName.projection_version.column_default), /1/)
  assert.match(String(byName.created_at.column_default), /now\(\)/)
  assert.match(String(byName.updated_at.column_default), /now\(\)/)
  assert.equal(byName.order_date.data_type, 'timestamp with time zone')

  // Birincil anahtar.
  const pk = rows(await db.execute(sql.raw(
    `select kcu.column_name from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name
     where tc.table_name='order_filter_projection' and tc.constraint_type='PRIMARY KEY'`)))
  assert.deepEqual(pk.map((r) => r.column_name), ['id'])

  // Yabanci anahtarlar + ON DELETE davranisi.
  const fks = rows(await db.execute(sql.raw(
    `select tc.constraint_name, rc.delete_rule, kcu.column_name
     from information_schema.table_constraints tc
       join information_schema.referential_constraints rc on rc.constraint_name=tc.constraint_name
       join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name
     where tc.table_name='order_filter_projection' and tc.constraint_type='FOREIGN KEY'
     order by kcu.column_name`)))
  const deleteRules = Object.fromEntries(fks.map((f) => [f.column_name, f.delete_rule]))
  assert.equal(deleteRules.order_id, 'CASCADE', 'order silinince projeksiyon DUSMELI')
  assert.equal(deleteRules.organization_id, 'NO ACTION', 'organizasyon KORUNMALI')

  // Indeksler.
  const indexes = rows(await db.execute(sql.raw(
    `select indexname, indexdef from pg_indexes
     where tablename='order_filter_projection' order by indexname`)))
  const defs = Object.fromEntries(indexes.map((i) => [i.indexname, i.indexdef]))
  assert.ok(defs.order_filter_projection_org_order_unique, 'tekillik indeksi YOK')
  assert.match(defs.order_filter_projection_org_order_unique, /UNIQUE/)
  assert.match(
    defs.order_filter_projection_org_order_unique,
    /organization_id,\s*order_id/,
  )
  assert.ok(defs.order_filter_projection_org_version_idx, 'surum indeksi YOK')
})

test('MIG-6: prova TEKRARLANABILIR — ikinci kosum NO-OP', async (t) => {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  const db = drizzle(pglite)
  await migrate(db, { migrationsFolder: MIGRATIONS })
  const first = Number(rows(await db.execute(sql.raw(
    `select count(*)::int as n from drizzle.__drizzle_migrations`)))[0].n)
  // Aynı klasörle tekrar: migrator hiçbir şey uygulamamalı.
  await migrate(db, { migrationsFolder: MIGRATIONS })
  const second = Number(rows(await db.execute(sql.raw(
    `select count(*)::int as n from drizzle.__drizzle_migrations`)))[0].n)
  assert.equal(second, first, 'tekrar kosum yeni migration UYGULAMAMALI')
})
