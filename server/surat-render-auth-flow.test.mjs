import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// RESMÎ SÜRAT RENDER UCU — AUTH PROPAGATION REGRESYONU.
//
// CANLI HATA (master 191949a): doğru şablon yolu seçiliyor (printMode
// surat-official-png) ama POST /api/labels/render/surat 404 "Sipariş
// persistence yalnız auth modda kullanılabilir." dönüyordu.
//
// KÖK NEDEN: uç, ana app'teki TENANT_AUTH_PATHS listesinde YOKTU. Express
// `app.use(path, mw)` ÖN EK eşleşmesi yapar; '/api/labels/zpl',
// '/api/labels/render/surat' ile EŞLEŞMEZ. Bu yüzden tenantAuth (requireAuth)
// bu uçta HİÇ çalışmıyor, geçerli `cargoflow_session` cookie'sine rağmen
// `request.auth` boş kalıyor ve requireOrderPersistenceContext reddediyordu.
//
// İstemci sözleşmesi (aynı origin + credentials:'include') ZATEN DOĞRUYDU.
//
// Testler GERÇEK PGlite, GERÇEK session ve GERÇEK requireAuth kullanır.
// Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
const { createAuthRouter } = await import('./auth/routes.ts')
const { requireAuth } = await import('./auth/middleware.ts')

const indexSource = readFileSync(join(here, 'index.mjs'), 'utf8')

/** index.mjs içindeki GERÇEK TENANT_AUTH_PATHS listesini okur. */
function readTenantAuthPaths() {
  const start = indexSource.indexOf('const TENANT_AUTH_PATHS = [')
  assert.ok(start > 0, 'TENANT_AUTH_PATHS bulundu')
  const end = indexSource.indexOf(']', start)
  const block = indexSource.slice(start, end)
  return [...block.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1])
}

/** Express `app.use(path, mw)` ön-ek eşleşmesi. */
function isCoveredByMount(url, mountPaths) {
  return mountPaths.some((p) => url === p || url.startsWith(`${p}/`))
}

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
function cookieFrom(response, name) {
  const setCookie = response.headers.getSetCookie?.() ?? []
  const c = setCookie.find((x) => x.startsWith(`${name}=`))
  return c ? c.split(';')[0] : null
}

/**
 * Ana app wiring'i BİREBİR yeniden kurar: cookieParser + auth router +
 * GERÇEK TENANT_AUTH_PATHS listesi üzerinde requireAuth. Render ucu,
 * index.mjs'teki guard'ın aynısını uygular (request.auth yoksa 404).
 */
function buildApp(db, mountPaths) {
  const app = express()
  app.use(cookieParser())
  app.use(express.json())
  app.use('/api/auth', createAuthRouter({ db }))
  app.use(mountPaths, requireAuth(db))
  const renderGuard = (request, response) => {
    // requireOrderPersistenceContext ile AYNI kural: organization YALNIZ
    // request.auth'tan. Body/query override KABUL EDİLMEZ.
    if (!request.auth?.organizationId) {
      response.status(404).json({
        ok: false,
        message: 'Sipariş persistence yalnız auth modda kullanılabilir.',
      })
      return
    }
    for (const forbidden of ['zpl', 'printZpl', 'technicalZpl', 'barcodeRaw']) {
      if (request.body?.[forbidden] !== undefined) {
        response.status(400).json({ ok: false, code: 'raw_zpl_not_accepted' })
        return
      }
    }
    response.json({
      ok: true,
      organizationId: request.auth.organizationId,
      orderId: String(request.body?.orderId ?? ''),
    })
  }
  app.post('/api/labels/render/surat', renderGuard)
  app.get('/api/orders', renderGuard)
  return app
}

async function makeOrgUser(db, slug, username) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug, status: 'active' })
    .returning()
  const { hashPassword } = await import('./auth/password.ts')
  await db.insert(schema.users).values({
    organizationId: org.id,
    username,
    passwordHash: await hashPassword('sifre123'),
    status: 'active',
  })
  return org.id
}

// ═══ RA-1..RA-3: MOUNT SÖZLEŞMESİ (kaynak seviyesi) ══════════════════════

test('RA-1: render ucu TENANT_AUTH_PATHS ile KAPSANIR', () => {
  const paths = readTenantAuthPaths()
  assert.equal(
    isCoveredByMount('/api/labels/render/surat', paths),
    true,
    'resmî Sürat render ucu auth mount kapsamında olmalı',
  )
})

test('RA-2: render ucu, çalışan uçlarla AYNI auth kapısındadır', () => {
  const paths = readTenantAuthPaths()
  for (const url of [
    '/api/orders',
    '/api/products',
    '/api/labels/zpl/anything',
    '/api/printing/zebra/raw',
    '/api/labels/render/surat',
  ]) {
    assert.equal(isCoveredByMount(url, paths), true, `kapsanmalı: ${url}`)
  }
  // Auth GEREKTİRMEYEN uçlar kapsam DIŞINDA kalır (uç public yapılmadı,
  // tersine: koruma genişletildi).
  for (const url of ['/api/health', '/api/auth/login']) {
    assert.equal(isCoveredByMount(url, paths), false, `kapsanmamalı: ${url}`)
  }
})

test('RA-3: backend guard KORUNDU, organization override YOK', () => {
  const endpoint = indexSource.slice(
    indexSource.indexOf("app.post('/api/labels/render/surat'"),
    indexSource.indexOf("app.post('/api/orders/:id/label-ready'"),
  )
  assert.ok(endpoint.length > 0, 'uç bulundu')
  // Guard yerinde.
  assert.match(endpoint, /requireOrderPersistenceContext\(request, response\)/)
  assert.match(endpoint, /if \(!context\) return/)
  // organizationId yalnız context'ten (auth) gelir; body/query'den ASLA.
  assert.match(endpoint, /organizationId: context\.organizationId/)
  assert.equal(
    /body\.organizationId|query\.organizationId|body\.marketplaceAccountId/.test(
      endpoint,
    ),
    false,
    'istemciden organization/kapsam override KABUL EDİLMEZ',
  )
  // Ham ZPL reddi korunur.
  assert.match(endpoint, /raw_zpl_not_accepted/)
  // Guard'ı devre dışı bırakan bir bayrak eklenmedi.
  assert.equal(/isTenantAuthMode\(\) \?/.test(endpoint), false)
})

// ═══ RA-4..RA-8: GERÇEK SESSION İLE UÇTAN UCA ════════════════════════════

test('RA-4..RA-8: geçerli session render ucuna ULAŞIR, oturumsuz istek 401', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const mountPaths = readTenantAuthPaths()
  const server = http.createServer(buildApp(db, mountPaths))
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`
  const organizationId = await makeOrgUser(db, 'alfa', 'alfauser')

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alfauser', password: 'sifre123' }),
  })
  assert.equal(login.status, 200)
  const cookie = cookieFrom(login, 'cargoflow_session')
  assert.ok(cookie, 'session cookie alındı')

  // RA-4: AYNI cookie ile render ucu → 200 ve organization SESSION'dan gelir.
  const ok = await fetch(`${base}/api/labels/render/surat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ orderId: 'order-1' }),
  })
  assert.equal(ok.status, 200, 'geçerli oturumda uç ÇALIŞIR')
  const body = await ok.json()
  assert.equal(body.organizationId, organizationId)
  assert.equal(body.orderId, 'order-1')

  // RA-5: render ucu, çalışan /api/orders ile AYNI davranır.
  const orders = await fetch(`${base}/api/orders`, { headers: { Cookie: cookie } })
  assert.equal(orders.status, 200)

  // RA-6: oturumsuz istek → requireAuth 401 (404 persistence mesajı DEĞİL).
  const anonymous = await fetch(`${base}/api/labels/render/surat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'order-1' }),
  })
  assert.equal(anonymous.status, 401, 'uç PUBLIC DEĞİL')
  assert.equal((await anonymous.json()).message, 'Oturum gerekli.')

  // RA-7: geçersiz/expired cookie → yine 401.
  const bogus = await fetch(`${base}/api/labels/render/surat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'cargoflow_session=gecersiz-token',
    },
    body: JSON.stringify({ orderId: 'order-1' }),
  })
  assert.equal(bogus.status, 401)

  // RA-8: gövdedeki organizationId override HİÇBİR ETKİ YAPMAZ.
  const override = await fetch(`${base}/api/labels/render/surat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ orderId: 'order-1', organizationId: 'baska-org' }),
  })
  assert.equal((await override.json()).organizationId, organizationId)
})

// ═══ RA-9: İSTEMCİ SÖZLEŞMESİ ════════════════════════════════════════════

test('RA-9: istemci ortak authenticated helper kullanır, kimlik göndermez', () => {
  const helper = readFileSync(
    join(here, '..', 'src/services/authenticatedApiRequest.ts'), 'utf8')
  const client = readFileSync(
    join(here, '..', 'src/services/suratLabelRenderClient.ts'), 'utf8')
  // Sözleşme helper'da tanımlı: aynı origin + session cookie.
  assert.match(helper, /credentials: AUTH_CREDENTIALS_MODE/)
  assert.match(helper, /'include'/)
  // Render client çıplak fetch KULLANMAZ.
  assert.equal(/\bfetch\(/.test(client), false, 'çıplak fetch kalmadı')
  assert.match(client, /authenticatedApiRequest\(SURAT_RENDER_ENDPOINT/)
  // Gövde YALNIZ canonical kimlik.
  assert.match(client, /json: \{ orderId: key \}/)
  for (const forbidden of [
    'organizationId', 'marketplaceAccountId', 'technicalZpl', 'barcodeRaw',
  ]) {
    assert.equal(
      client.includes(`${forbidden}:`), false, `istemci göndermemeli: ${forbidden}`,
    )
  }
  // Hardcoded credential / Authorization HEADER'ı YOK (yorumdaki sözleşme
  // açıklaması değil, GERÇEK header ataması aranır: `Authorization:`).
  assert.equal(/Authorization\s*:/.test(helper), false, 'helper Authorization header set etmez')
  assert.equal(/Authorization\s*:/.test(client), false, 'client Authorization header set etmez')
  assert.equal(/document\.cookie/.test(client), false, 'cookie elle okunmaz')
  assert.equal(/Bearer |token:/.test(helper + client), false, 'hardcoded credential yok')
})
