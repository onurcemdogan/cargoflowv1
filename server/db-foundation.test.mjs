import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Hermetik DB temeli testi: gerçek PostgreSQL motoru (pglite, in-memory)
// üzerinde üretilmiş Drizzle migration'ı uygular ve constraint'leri doğrular.
// Ağ/dosya sistemi yan etkisi yoktur; mevcut uygulama akışlarına dokunmaz.

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')

function loadMigrationStatements() {
  const files = readdirSync(drizzleDir).filter((name) => name.endsWith('.sql'))
  assert.ok(files.length >= 1, 'en az bir migration dosyası üretilmiş olmalı')
  const statements = []
  for (const file of files.sort()) {
    const sql = readFileSync(join(drizzleDir, file), 'utf8')
    statements.push(
      ...sql
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return statements
}

async function rejects(promise, pattern, message) {
  let error = null
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  assert.match(String(error?.message ?? error), pattern, message)
}

test('drizzle migration dört tabloyu ve constraintleri kurar', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  for (const statement of loadMigrationStatements()) {
    await db.exec(statement)
  }

  // Dört tablo mevcut.
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  )
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    ['integration_credentials', 'organizations', 'sessions', 'users'],
  )

  // İki organization.
  const orgA = (
    await db.query(
      `INSERT INTO organizations (name, slug) VALUES ('Şirket A', 'sirket-a') RETURNING id`,
    )
  ).rows[0].id
  const orgB = (
    await db.query(
      `INSERT INTO organizations (name, slug) VALUES ('Şirket B', 'sirket-b') RETURNING id`,
    )
  ).rows[0].id
  // slug unique.
  await rejects(
    db.query(`INSERT INTO organizations (name, slug) VALUES ('Kopya', 'sirket-a')`),
    /organizations_slug_unique|duplicate key/i,
    'aynı slug ikinci kez eklenememeli',
  )

  // Kullanıcılar.
  const userA = (
    await db.query(
      `INSERT INTO users (organization_id, username, password_hash)
       VALUES ($1, 'kullanici-a', 'hash-a') RETURNING id`,
      [orgA],
    )
  ).rows[0].id
  // Aynı username ikinci kez eklenemez (farklı org olsa bile).
  await rejects(
    db.query(
      `INSERT INTO users (organization_id, username, password_hash)
       VALUES ($1, 'kullanici-a', 'hash-x')`,
      [orgB],
    ),
    /users_username_unique|duplicate key/i,
    'aynı username ikinci kez eklenememeli',
  )
  // Aynı organization'a ikinci user eklenemez.
  await rejects(
    db.query(
      `INSERT INTO users (organization_id, username, password_hash)
       VALUES ($1, 'kullanici-a2', 'hash-y')`,
      [orgA],
    ),
    /users_organization_id_unique|duplicate key/i,
    'aynı organization ikinci kullanıcı alamamalı',
  )
  // FK: olmayan organization ile user eklenemez.
  await rejects(
    db.query(
      `INSERT INTO users (organization_id, username, password_hash)
       VALUES (gen_random_uuid(), 'hayalet', 'hash-z')`,
    ),
    /foreign key|users_organization_id_organizations_id_fk/i,
    'olmayan organization FK ile reddedilmeli',
  )

  // Credential: aynı org+provider tekrarlanamaz; farklı org aynı provider'ı ekleyebilir.
  await db.query(
    `INSERT INTO integration_credentials (organization_id, provider, encrypted_payload)
     VALUES ($1, 'trendyol', 'enc-a')`,
    [orgA],
  )
  await rejects(
    db.query(
      `INSERT INTO integration_credentials (organization_id, provider, encrypted_payload)
       VALUES ($1, 'trendyol', 'enc-a2')`,
      [orgA],
    ),
    /integration_credentials_org_provider_unique|duplicate key/i,
    'aynı org/provider tekrar edememeli',
  )
  await db.query(
    `INSERT INTO integration_credentials (organization_id, provider, encrypted_payload)
     VALUES ($1, 'trendyol', 'enc-b')`,
    [orgB],
  )
  // provider check: yalnız trendyol|surat.
  await rejects(
    db.query(
      `INSERT INTO integration_credentials (organization_id, provider, encrypted_payload)
       VALUES ($1, 'hepsijet', 'enc-x')`,
      [orgB],
    ),
    /integration_credentials_provider_check|check constraint/i,
    'geçersiz provider reddedilmeli',
  )

  // Sessions: token_hash unique + FK'ler.
  await db.query(
    `INSERT INTO sessions (organization_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, 'token-hash-1', now() + interval '1 day')`,
    [orgA, userA],
  )
  await rejects(
    db.query(
      `INSERT INTO sessions (organization_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, 'token-hash-1', now() + interval '1 day')`,
      [orgA, userA],
    ),
    /sessions_token_hash_unique|duplicate key/i,
    'token_hash unique olmalı',
  )
  await rejects(
    db.query(
      `INSERT INTO sessions (organization_id, user_id, token_hash, expires_at)
       VALUES ($1, gen_random_uuid(), 'token-hash-2', now() + interval '1 day')`,
      [orgA],
    ),
    /foreign key|sessions_user_id_users_id_fk/i,
    'olmayan user FK ile reddedilmeli',
  )
})

test('db client DATABASE_URL yokken kontrollü disabled durum döner', async (t) => {
  const { createServer } = await import('vite')
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const previous = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  t.after(() => {
    if (previous !== undefined) process.env.DATABASE_URL = previous
  })
  const client = await vite.ssrLoadModule('/server/db/client.ts')
  assert.equal(client.isDatabaseConfigured(), false)
  assert.throws(() => client.getPool(), /DATABASE_URL tanımlı değil/)
  const health = await client.checkDatabaseHealth()
  assert.deepEqual(
    { configured: health.configured, ok: health.ok },
    { configured: false, ok: false },
  )
})
