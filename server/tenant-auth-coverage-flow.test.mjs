// TENANT AUTH KAPSAMI — ORG KAPSAMLI HER UÇ `tenantAuth` ARKASINDA.
//
// KÖK NEDEN (üç kez yaşandı): `tenantAuth` yalnız `TENANT_AUTH_PATHS`
// önekleriyle bağlanır (`app.use(TENANT_AUTH_PATHS, tenantAuth)`). Listede
// olmayan org kapsamlı uçta `request.auth` boş kalır; auth modda (üretim)
// geçerli oturuma rağmen guard 404 döner. Doğrudan handler çağıran testler
// bunu GÖRMEZ.
//
// Bu test tek tek yol listelemez: `server/index.mjs` içindeki HER route
// gövdesini tarar, org kapsamı isteyenleri (`requireOnboardingContext(` ya da
// `request.auth`) bulur ve kapsamı GERÇEK Express önek eşleşmesiyle ölçer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import express from 'express'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, 'index.mjs'), 'utf8')

function tenantAuthPaths() {
  const start = SOURCE.indexOf('const TENANT_AUTH_PATHS = [')
  assert.ok(start >= 0, 'TENANT_AUTH_PATHS bulunamadı')
  const block = SOURCE.slice(start, SOURCE.indexOf(']', start))
  return [...block.matchAll(/'(\/api\/[^']+)'/g)].map((match) => match[1])
}

function orgScopedRoutes() {
  const routeRe = /^app\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm
  const routes = [...SOURCE.matchAll(routeRe)].map((match) => ({
    method: match[1].toUpperCase(),
    path: match[2],
    index: match.index,
  }))
  return routes.filter((route, i) => {
    const body = SOURCE.slice(route.index, routes[i + 1]?.index ?? SOURCE.length)
    return /requireOnboardingContext\(|request\.auth\b/.test(body)
  })
}

async function ungatedRoutes(paths, routes) {
  const app = express()
  app.use(paths, (request, _response, next) => {
    request.gated = true
    next()
  })
  app.all('*splat', (request, response) => response.json({ gated: Boolean(request.gated) }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const { port } = server.address()
    const ungated = []
    for (const route of routes) {
      const url = route.path.replace(/:[A-Za-z]+/g, 'x')
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: route.method })
      const { gated } = await response.json()
      if (!gated) ungated.push(`${route.method} ${route.path}`)
    }
    return ungated
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('TAC-1: org kapsamlı her uç tenantAuth önekiyle kapsanır (gerçek Express eşleşmesi)', async () => {
  const routes = orgScopedRoutes()
  // Tarayıcı gerçekten iş görüyor: bilinen org uçları listede.
  const seen = new Set(routes.map((route) => `${route.method} ${route.path}`))
  for (const known of [
    'GET /api/onboarding/status',
    'GET /api/integrations/health',
    'GET /api/subscription/status',
    'GET /api/shipping/payer',
    'GET /api/integrations/woocommerce/stores',
    'GET /api/integrations/aras/stores',
    'GET /api/integrations/ikas/stores',
  ]) {
    assert.ok(seen.has(known), `org kapsamlı uç taramada yok: ${known}`)
  }
  assert.deepEqual(await ungatedRoutes(tenantAuthPaths(), routes), [])
})

test('TAC-2: ölçüm gerçek — listeden çıkarılan önek ilgili uçları açıkta bırakır', async () => {
  const routes = orgScopedRoutes()
  const without = tenantAuthPaths().filter((path) => path !== '/api/subscription')
  assert.deepEqual(await ungatedRoutes(without, routes), ['GET /api/subscription/status'])
})

test('TAC-3: public uçlar kapıya alınmadı (webhook, auth, health)', async () => {
  const paths = tenantAuthPaths()
  const gatedPublic = await ungatedRoutes(paths, [
    { method: 'POST', path: '/api/webhooks/woocommerce/x' },
    { method: 'POST', path: '/api/auth/login' },
    { method: 'GET', path: '/api/health' },
  ])
  assert.equal(gatedPublic.length, 3, 'public uç tenantAuth arkasına düştü')
})
