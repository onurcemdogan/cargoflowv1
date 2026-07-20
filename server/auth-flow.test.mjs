import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import http from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// Hermetik auth testleri (A-N): gerçek PostgreSQL motoru (pglite, in-memory)
// + gerçek express + gerçek HTTP. Ağ/dosya yan etkisi yok; mevcut akışlara
// dokunmaz.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const { createAuthRouter } = await import('./auth/routes.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const statements = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    statements.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return statements
}

async function createTestDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) {
    await pglite.exec(statement)
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function startApp(db, rateLimitOptions) {
  const app = express()
  app.use('/api/auth', createAuthRouter({ db, rateLimit: rateLimitOptions }))
  const server = http.createServer(app)
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function cookieOf(response) {
  const setCookie = response.headers.getSetCookie?.() ?? []
  const sessionCookie = setCookie.find((c) => c.startsWith('cargoflow_session='))
  return sessionCookie ? sessionCookie.split(';')[0] : ''
}

async function post(base, path, body, cookie) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
}

async function getMe(base, cookie, extraHeaders = {}) {
  return fetch(`${base}/api/auth/me`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
  })
}

test('auth akışı A-M: bootstrap, login, session, izolasyon', async (t) => {
  const { pglite, db } = await createTestDb()
  t.after(() => pglite.close())
  const appHandle = await startApp(db, { windowMs: 60_000, limit: 100 })
  t.after(() => appHandle.close())
  const { base } = appHandle

  // A) İlk bootstrap başarılı + otomatik login cookie'si.
  const bootstrapResponse = await post(base, '/api/auth/bootstrap', {
    organizationName: 'Zeyna Moda',
    username: '  ZeynaAdmin  ',
    password: 'cok-gizli-parola-1',
  })
  assert.equal(bootstrapResponse.status, 201)
  const bootstrapCookie = cookieOf(bootstrapResponse)
  assert.ok(bootstrapCookie, 'bootstrap session cookie yazmalı')
  const rawBootstrapToken = bootstrapCookie.split('=')[1]

  // B) İkinci bootstrap 409.
  const secondBootstrap = await post(base, '/api/auth/bootstrap', {
    organizationName: 'Baska Firma',
    username: 'digeradmin',
    password: 'cok-gizli-parola-2',
  })
  assert.equal(secondBootstrap.status, 409)

  // Kısa parola 400.
  const shortPassword = await post(base, '/api/auth/bootstrap', {
    organizationName: 'X',
    username: 'x',
    password: 'kisa',
  })
  assert.ok([400, 409].includes(shortPassword.status))

  // C) Parola DB'de düz metin değil (argon2id).
  const [storedUser] = await db.select().from(schema.users)
  assert.equal(storedUser.username, 'zeynaadmin', 'username normalize edilmeli')
  assert.ok(String(storedUser.passwordHash).startsWith('$argon2id$'))
  assert.ok(!String(storedUser.passwordHash).includes('cok-gizli-parola-1'))

  // F) Session DB'de ham token olarak saklanmaz (yalnız SHA-256 hash).
  const sessionRows = await db.select().from(schema.sessions)
  assert.ok(sessionRows.length >= 1)
  for (const row of sessionRows) {
    assert.notEqual(row.tokenHash, rawBootstrapToken)
    assert.match(String(row.tokenHash), /^[0-9a-f]{64}$/)
  }

  // D) Doğru login başarılı (normalize edilmiş username ile).
  const login = await post(base, '/api/auth/login', {
    username: 'ZEYNAADMIN',
    password: 'cok-gizli-parola-1',
  })
  assert.equal(login.status, 200)
  const sessionCookie = cookieOf(login)
  assert.ok(sessionCookie)
  // Cookie öznitelikleri.
  const rawSetCookie = (login.headers.getSetCookie?.() ?? []).find((c) =>
    c.startsWith('cargoflow_session='),
  )
  assert.match(rawSetCookie, /HttpOnly/i)
  assert.match(rawSetCookie, /SameSite=Lax/i)
  assert.match(rawSetCookie, /Path=\//i)
  // lastLoginAt güncellendi.
  const [afterLogin] = await db.select().from(schema.users)
  assert.ok(afterLogin.lastLoginAt, 'lastLoginAt dolmalı')

  // E) Yanlış kullanıcı ve yanlış parola AYNI genel hatayı verir.
  const wrongUser = await post(base, '/api/auth/login', {
    username: 'olmayan',
    password: 'cok-gizli-parola-1',
  })
  const wrongPassword = await post(base, '/api/auth/login', {
    username: 'zeynaadmin',
    password: 'yanlis-parola-123',
  })
  assert.equal(wrongUser.status, 401)
  assert.equal(wrongPassword.status, 401)
  const wrongUserBody = await wrongUser.json()
  const wrongPasswordBody = await wrongPassword.json()
  assert.equal(wrongUserBody.message, 'Kullanıcı adı veya şifre hatalı')
  assert.deepEqual(wrongUserBody, wrongPasswordBody)

  // G) /me geçerli session ile organization döner (hash/token sızmaz).
  const me = await getMe(base, sessionCookie)
  assert.equal(me.status, 200)
  const meBody = await me.json()
  assert.equal(meBody.authenticated, true)
  assert.equal(meBody.user.username, 'zeynaadmin')
  assert.equal(meBody.user.organization.name, 'Zeyna Moda')
  assert.equal(meBody.user.organization.slug, 'zeyna-moda')
  assert.ok(meBody.user.organization.id)
  const meText = JSON.stringify(meBody)
  assert.ok(!meText.includes('$argon2id$'))
  assert.ok(!/tokenHash|passwordHash/i.test(meText))

  // L) Body/query/header'daki sahte organizationId YOK SAYILIR.
  const fakeOrgId = '00000000-0000-0000-0000-000000000999'
  const meWithFake = await fetch(
    `${base}/api/auth/me?organizationId=${fakeOrgId}`,
    {
      headers: {
        Cookie: sessionCookie,
        'X-Organization-Id': fakeOrgId,
      },
    },
  )
  const meWithFakeBody = await meWithFake.json()
  assert.equal(meWithFakeBody.user.organization.id, meBody.user.organization.id)
  assert.notEqual(meWithFakeBody.user.organization.id, fakeOrgId)

  // M) İkinci organization (DB'den doğrudan kurulur; bootstrap tek seferlik) —
  // her kullanıcı yalnız kendi org'unu görür; org kimliği yalnız session'dan.
  const [orgB] = await db
    .insert(schema.organizations)
    .values({ name: 'Rakip Firma', slug: 'rakip-firma' })
    .returning()
  const { hashPassword } = await import('./auth/password.ts')
  await db.insert(schema.users).values({
    organizationId: orgB.id,
    username: 'rakipadmin',
    passwordHash: await hashPassword('rakip-parola-1234'),
  })
  const loginB = await post(base, '/api/auth/login', {
    username: 'rakipadmin',
    password: 'rakip-parola-1234',
  })
  assert.equal(loginB.status, 200)
  const cookieB = cookieOf(loginB)
  const meB = await (await getMe(base, cookieB)).json()
  assert.equal(meB.user.organization.slug, 'rakip-firma')
  // A kullanıcısının session'ı B org'una geçemez (header/body ne olursa olsun).
  const meAAgain = await (
    await getMe(base, sessionCookie, { 'X-Organization-Id': orgB.id })
  ).json()
  assert.equal(meAAgain.user.organization.slug, 'zeyna-moda')

  // K) Logout: session revoke + cookie temizlenir; tekrarı güvenli.
  const logout = await post(base, '/api/auth/logout', {}, sessionCookie)
  assert.equal(logout.status, 200)
  const clearedCookie = (logout.headers.getSetCookie?.() ?? []).find((c) =>
    c.startsWith('cargoflow_session='),
  )
  assert.ok(clearedCookie, 'logout cookie temizlemeli')
  assert.match(clearedCookie, /Expires=|Max-Age=0/i)
  const logoutAgain = await post(base, '/api/auth/logout', {}, sessionCookie)
  assert.equal(logoutAgain.status, 200)

  // I) Revoked session 401.
  const meAfterLogout = await getMe(base, sessionCookie)
  assert.equal(meAfterLogout.status, 401)

  // H) Expired session 401 (DB'de süresi geçmişe çekilir).
  const freshLogin = await post(base, '/api/auth/login', {
    username: 'zeynaadmin',
    password: 'cok-gizli-parola-1',
  })
  const freshCookie = cookieOf(freshLogin)
  assert.equal((await getMe(base, freshCookie)).status, 200)
  await pglite.exec(
    `UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE revoked_at IS NULL`,
  )
  assert.equal((await getMe(base, freshCookie)).status, 401)

  // J) Disabled user 401.
  const reLogin = await post(base, '/api/auth/login', {
    username: 'zeynaadmin',
    password: 'cok-gizli-parola-1',
  })
  const reCookie = cookieOf(reLogin)
  assert.equal((await getMe(base, reCookie)).status, 200)
  await pglite.exec(`UPDATE users SET status = 'disabled' WHERE username = 'zeynaadmin'`)
  assert.equal((await getMe(base, reCookie)).status, 401)
  await pglite.exec(`UPDATE users SET status = 'active' WHERE username = 'zeynaadmin'`)
})

test('K) ortak parola politikası: 6 karakter kabul, 5 karakter 400', async (t) => {
  const { pglite, db } = await createTestDb()
  t.after(() => pglite.close())
  const appHandle = await startApp(db, { windowMs: 60_000, limit: 100 })
  t.after(() => appHandle.close())
  const { base } = appHandle

  // 5 karakter: backend 400 (frontend ile aynı ortak sabit: MIN=6).
  const tooShort = await post(base, '/api/auth/bootstrap', {
    organizationName: 'Alti Karakter AS',
    username: 'altikarakter',
    password: '12345',
  })
  assert.equal(tooShort.status, 400)
  // 6 karakter: kabul.
  const exactSix = await post(base, '/api/auth/bootstrap', {
    organizationName: 'Alti Karakter AS',
    username: 'altikarakter',
    password: '123456',
  })
  assert.equal(exactSix.status, 201)
  // Login de 6 karakterlik parolayla çalışır.
  const login = await post(base, '/api/auth/login', {
    username: 'altikarakter',
    password: '123456',
  })
  assert.equal(login.status, 200)
})

test('N) login rate limit başarısız denemeleri sınırlar', async (t) => {
  const { pglite, db } = await createTestDb()
  t.after(() => pglite.close())
  const appHandle = await startApp(db, { windowMs: 60_000, limit: 3 })
  t.after(() => appHandle.close())
  const { base } = appHandle

  // 3 başarısız deneme → 4.'sü 429.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await post(base, '/api/auth/login', {
      username: 'yok',
      password: 'yanlis-parola-123',
    })
    assert.equal(response.status, 401)
  }
  const limited = await post(base, '/api/auth/login', {
    username: 'yok',
    password: 'yanlis-parola-123',
  })
  assert.equal(limited.status, 429)
})

test('DATABASE_URL yokken auth endpointleri 503 döner, health değişmez', async () => {
  // Router db enjeksiyonu OLMADAN ve DATABASE_URL boşken kurulur.
  const previous = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  try {
    const app = express()
    app.use('/api/auth', createAuthRouter())
    const server = http.createServer(app)
    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.match(body.message, /DATABASE_URL|PostgreSQL/)
    await new Promise((resolve) => server.close(resolve))
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous
  }
})
