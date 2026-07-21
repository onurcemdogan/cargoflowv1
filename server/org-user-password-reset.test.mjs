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
import { eq } from 'drizzle-orm'

// Bozuk (kesik) argon2 hash → login 401 teşhisi ve güvenli sıfırlama testleri.
// Giriş ekranı/auth bypass DEĞİŞTİRİLMEZ; yalnız users.password_hash düzeltilir.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const { hashPassword, verifyPassword } = await import('./auth/password.ts')
const { resetOrganizationUserPassword } = await import('./admin/orgUserPassword.ts')
const { createAuthRouter } = await import('./auth/routes.ts')
const { createSession } = await import('./auth/session.ts')

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

test('argon2id hash biçimi: geçerli hash 97 karakter, 59 karakter geçersiz', async () => {
  const hash = await hashPassword('gecerli123')
  // 1) hashPassword ve verifyPassword AYNI argon2id encoded biçimini kullanır.
  assert.match(hash, /^\$argon2id\$v=19\$/)
  assert.equal(hash.length, 97, 'gerçek argon2id hash 97 karakterdir')
  assert.equal(await verifyPassword(hash, 'gecerli123'), true)

  // 2) 59 karaktere kesilmiş hash ASLA doğrulanmaz (argon2.verify parse edemez).
  const truncated = hash.slice(0, 59)
  assert.equal(truncated.length, 59)
  assert.match(truncated, /^\$argon2id\$/, '59 karakterlik hash de $argon2id$ ile başlar (yanıltıcı)')
  assert.equal(await verifyPassword(truncated, 'gecerli123'), false)
})

test('bozuk hash → login 401; reset sonrası login 200 (oturumlar revoke)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())

  const app = express()
  app.use(cookieParser())
  app.use('/api/auth', createAuthRouter({ db }))
  const server = http.createServer(app)
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`

  // Üretimdeki durumu birebir kur: aktif kullanıcı + 59 karakterlik bozuk hash.
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Oguz Ltd', slug: 'oguz-ltd', status: 'active' })
    .returning()
  const validHash = await hashPassword('dogruparola1')
  const brokenHash = validHash.slice(0, 59)
  const [user] = await db
    .insert(schema.users)
    .values({
      organizationId: org.id,
      username: 'oguz',
      passwordHash: brokenHash,
      status: 'active',
    })
    .returning()

  // Eski bir oturum da olsun (reset sonrası revoke edilmeli).
  const oldSession = await createSession(db, user.id, org.id)

  // 3) Bozuk hash ile login → 401 (kullanıcı aktif olmasına rağmen).
  const failed = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'oguz', password: 'dogruparola1' }),
  })
  assert.equal(failed.status, 401, 'bozuk hash → 401')

  // 4) Güvenli sıfırlama: login ile aynı hashPassword biçimi.
  const result = await resetOrganizationUserPassword(db, 'oguz', 'yeniparola1')
  assert.equal(result.previousHashLength, 59)
  assert.equal(result.newHashLength, 97)
  assert.equal(result.userStatus, 'active')
  assert.ok(result.revokedSessions >= 1, 'eski oturumlar revoke edildi')

  // Yeni parola ile login → 200.
  const ok = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'oguz', password: 'yeniparola1' }),
  })
  assert.equal(ok.status, 200, 'reset sonrası login başarılı')

  // Reset ÖNCESİ oluşturulan oturum revoke edilmiş olmalı (yeni login'in
  // oluşturduğu oturum ise geçerli kalır — beklenen davranış).
  const { hashSessionToken } = await import('./auth/session.ts')
  const oldRows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashSessionToken(oldSession.token)))
  assert.equal(oldRows.length, 1)
  assert.ok(oldRows[0].revokedAt !== null, 'reset öncesi oturum revoke edildi')

  // Tenant/auth kuralları korunur: kullanıcı hâlâ kendi organization'ında.
  const updated = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
  assert.equal(updated[0].organizationId, org.id)
  assert.equal(updated[0].status, 'active')
  // Hash düz parola içermez.
  assert.ok(!String(updated[0].passwordHash).includes('yeniparola1'))
})

test('reset: olmayan kullanıcı ve kısa parola reddedilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  await assert.rejects(
    () => resetOrganizationUserPassword(db, 'yokboyle', 'yeniparola1'),
    /bulunamadı/,
  )
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'X', slug: 'x', status: 'active' })
    .returning()
  await db.insert(schema.users).values({
    organizationId: org.id,
    username: 'kisa',
    passwordHash: await hashPassword('gecerli123'),
    status: 'active',
  })
  await assert.rejects(() => resetOrganizationUserPassword(db, 'kisa', '123'), /kısa/)
})
