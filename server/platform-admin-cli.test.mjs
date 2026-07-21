import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// Platform admin oluşturma/sıfırlama CLI çekirdeği testleri.
// Doğrulananlar: oluşturma başarılı, duplicate engellenir, geçerli argon2id
// (97 karakter) yazılır, status=active, login başarılı, yanlış parola 401.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const {
  createPlatformAdmin,
  describePlatformAdmin,
  resetPlatformAdminPassword,
} = await import('./admin/platformAdminAccount.ts')
const { createPlatformAdminRouter } = await import('./admin/adminRoutes.ts')

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
  return { pglite, db: drizzle(pglite, { schema }) }
}
function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
}

test('admin oluşturma: başarılı, status=active, geçerli argon2id (97)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())

  const created = await createPlatformAdmin(db, 'Admin', 'gizliparola1')
  // Kullanıcı adı normalize edilir (küçük harf) — login ile tutarlı.
  assert.equal(created.username, 'admin')

  const described = await describePlatformAdmin(db, 'admin')
  assert.equal(described.username, 'admin')
  assert.equal(described.status, 'active', 'status=active yazılır')
  assert.equal(described.hashLength, 97, 'geçerli argon2id hash uzunluğu')

  // Hash düz parola içermez ve argon2id biçimindedir.
  const rows = await db.select().from(schema.platformAdmins)
  assert.match(String(rows[0].passwordHash), /^\$argon2id\$v=19\$/)
  assert.ok(!String(rows[0].passwordHash).includes('gizliparola1'))
})

test('duplicate admin engellenir (açık hata)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  await createPlatformAdmin(db, 'admin', 'gizliparola1')
  await assert.rejects(
    () => createPlatformAdmin(db, 'admin', 'baskaparola1'),
    /zaten var/,
    'aynı kullanıcı adı için açık hata',
  )
  // Tek kayıt kalır (sessiz üzerine yazma yok).
  assert.equal((await db.select().from(schema.platformAdmins)).length, 1)
})

test('kısa parola reddedilir; olmayan admin sıfırlanamaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  await assert.rejects(() => createPlatformAdmin(db, 'admin', '123'), /kısa/)
  await assert.rejects(
    () => resetPlatformAdminPassword(db, 'yokboyle', 'gecerliparola1'),
    /bulunamadı/,
  )
})

test('admin login: doğru parola 200, yanlış parola 401, reset sonrası yeni parola geçerli', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  await createPlatformAdmin(db, 'admin', 'gizliparola1')

  const app = express()
  app.use(cookieParser())
  app.use('/api/platform-admin', createPlatformAdminRouter({ db }))
  const server = http.createServer(app)
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}/api/platform-admin`

  const login = (username, password) =>
    fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })

  // Doğru parola → 200 + admin cookie.
  const ok = await login('admin', 'gizliparola1')
  assert.equal(ok.status, 200)
  const setCookie = ok.headers.getSetCookie?.() ?? []
  assert.ok(setCookie.some((c) => c.startsWith('cargoflow_admin_session=')))

  // Yanlış parola → 401 genel hata.
  const bad = await login('admin', 'yanlisparola')
  assert.equal(bad.status, 401)
  assert.match((await bad.json()).message, /Yönetici kullanıcı adı veya şifre hatalı/)

  // Olmayan kullanıcı → aynı genel hata (kullanıcı var/yok sızdırılmaz).
  const missing = await login('yokboyle', 'herhangi')
  assert.equal(missing.status, 401)

  // Reset sonrası: eski parola 401, yeni parola 200.
  await resetPlatformAdminPassword(db, 'admin', 'yeniparola1')
  assert.equal((await login('admin', 'gizliparola1')).status, 401)
  assert.equal((await login('admin', 'yeniparola1')).status, 200)
  assert.equal((await describePlatformAdmin(db, 'admin')).hashLength, 97)
})

test('CLI: TTY yoksa açık hata verir (sessizce asılı kalmaz) + stdin desteği', () => {
  const prompt = readFileSync(join(here, 'admin', 'promptSecret.ts'), 'utf8')
  // TTY guard: sessiz askıda kalma yerine açık hata.
  assert.match(prompt, /isInteractiveTty/)
  assert.match(prompt, /TTY\) gerekli/)
  // Etkileşimsiz ortam için stdin yolu.
  assert.match(prompt, /--password-stdin/)
  assert.match(prompt, /readPasswordFromStdin/)

  // CLI'lar parolayı argv'den OKUMAZ (shell geçmişine düşmesin).
  const createCli = readFileSync(join(here, 'admin', 'createPlatformAdminCli.ts'), 'utf8')
  assert.doesNotMatch(createCli, /parseArg\('password'\)/)
  // DB hedefi doğrulanır ve kayıt sonrası tekrar okunur.
  assert.match(createCli, /describeDatabaseTarget/)
  assert.match(createCli, /describePlatformAdmin/)
  assert.match(createCli, /hashLength !== 97/)
})
