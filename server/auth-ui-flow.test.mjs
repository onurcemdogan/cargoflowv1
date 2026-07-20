import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

// Frontend auth akışı testleri (A-P'nin frontend kısmı). Ağ yok: global
// fetch shim'lenir. Sürat/persistence akışlarına dokunmaz.

async function loadModules(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  return { vite, renderToStaticMarkup, createElement }
}

function installFetchShim(t, responder) {
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }
  const storageWrites = []
  const previousWindow = globalThis.window
  globalThis.window = {
    location: { hostname: 'localhost' },
    localStorage: {
      getItem: () => null,
      setItem: (key) => storageWrites.push(key),
      removeItem: () => {},
    },
  }
  t.after(() => {
    globalThis.fetch = previousFetch
    globalThis.window = previousWindow
  })
  return { calls, storageWrites }
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

test('authService sözleşmesi: credentials, hata modeli, saklama yok (E,J,L,M,O,P)', async (t) => {
  const { vite } = await loadModules(t)
  const service = await vite.ssrLoadModule('/src/auth/authService.ts')
  const { calls, storageWrites } = installFetchShim(t, (url, init) => {
    if (url === '/api/auth/me') return jsonResponse(401, { ok: false })
    if (url === '/api/auth/login') {
      const body = JSON.parse(String(init.body))
      if (body.username === 'dogru' && body.password === 'parola-dogru') {
        return jsonResponse(200, { ok: true })
      }
      return jsonResponse(401, {
        ok: false,
        message: 'Kullanıcı adı veya şifre hatalı',
      })
    }
    if (url === '/api/auth/bootstrap') {
      return jsonResponse(409, {
        ok: false,
        message: 'Sistem zaten kurulmuş; bootstrap yalnız bir kez çalışır.',
      })
    }
    if (url === '/api/auth/logout') return jsonResponse(200, { ok: true })
    throw new Error(`beklenmeyen istek: ${url}`)
  })

  // C benzeri: /me 401 → unauthenticated.
  assert.deepEqual(await service.getCurrentUser(), { kind: 'unauthenticated' })

  // D/E) login: username trim+lowercase; yanlış girişte backend'in GENEL
  // mesajı aynen taşınır ({status, message} modeli).
  await service.login('  DOGRU  ', 'parola-dogru')
  let loginError = null
  try {
    await service.login('dogru', 'yanlis')
  } catch (error) {
    loginError = error
  }
  assert.deepEqual(loginError, {
    status: 401,
    message: 'Kullanıcı adı veya şifre hatalı',
  })

  // I benzeri: bootstrap 409 hata modeli.
  let bootstrapError = null
  try {
    await service.bootstrap('Firma', 'admin', 'gecerli-parola')
  } catch (error) {
    bootstrapError = error
  }
  assert.equal(bootstrapError.status, 409)

  // J) 6 karakterden kısa parola: istek ATILMAZ.
  const callCountBefore = calls.length
  let shortError = null
  try {
    await service.bootstrap('Firma', 'admin', '12345')
  } catch (error) {
    shortError = error
  }
  assert.equal(shortError.status, 400)
  assert.equal(calls.length, callCountBefore, 'kısa parola fetch üretmemeli')

  // O) logout iş verisine dokunmaz; G) logout çağrısı yapılır.
  await service.logout()

  // M) TÜM auth istekleri credentials:'include' kullanır.
  assert.ok(calls.length >= 4)
  for (const call of calls) {
    assert.equal(
      call.init.credentials,
      'include',
      `credentials eksik: ${call.url}`,
    )
  }
  // P) Yalnız /api/auth istekleri; Sürat create yok.
  assert.ok(calls.every((call) => call.url.startsWith('/api/auth/')))
  assert.ok(!calls.some((call) => /surat|shipment/i.test(call.url)))
  // organizationId/tenantId/token asla gönderilmez.
  for (const call of calls) {
    const body = String(call.init?.body ?? '')
    assert.ok(!/organizationId|tenantId|token/i.test(body), call.url)
  }
  // L) Frontend hiçbir şeyi storage'a yazmaz.
  assert.equal(storageWrites.length, 0)
})

test('authService 503 durumunu kontrollü mesaja çevirir', async (t) => {
  const { vite } = await loadModules(t)
  const service = await vite.ssrLoadModule('/src/auth/authService.ts')
  installFetchShim(t, () => jsonResponse(503, { ok: false, message: 'db yok' }))
  const result = await service.getCurrentUser()
  assert.equal(result.kind, 'unavailable')
  assert.match(result.message, /PostgreSQL yapılandırılmamış/)
})

test('resolveAuthView: girişsiz uygulama görünmez (A,B,C,H)', async (t) => {
  const { vite } = await loadModules(t)
  const { resolveAuthView } = await vite.ssrLoadModule('/src/auth/authView.ts')
  assert.equal(resolveAuthView('loading'), 'loading')
  assert.equal(resolveAuthView('unauthenticated'), 'login')
  assert.equal(resolveAuthView('setup_required'), 'bootstrap')
  assert.equal(resolveAuthView('authenticated'), 'app')
})

test('AuthGate loading iken uygulamayı render etmez (A)', async (t) => {
  const { vite, renderToStaticMarkup, createElement } = await loadModules(t)
  installFetchShim(t, () => jsonResponse(401, { ok: false }))
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.tsx')
  const { AuthGate } = await vite.ssrLoadModule('/src/auth/AuthGate.tsx')
  // SSR'da effect çalışmaz → status 'loading' kalır: uygulama içeriği yok.
  const html = renderToStaticMarkup(
    createElement(
      AuthProvider,
      null,
      createElement(AuthGate, null, createElement('div', null, 'GIZLI-UYGULAMA')),
    ),
  )
  assert.ok(!html.includes('GIZLI-UYGULAMA'))
  assert.match(html, /Oturum kontrol ediliyor/)
})

test('LoginPage ve BootstrapPage erişilebilir formlar üretir', async (t) => {
  const { vite, renderToStaticMarkup, createElement } = await loadModules(t)
  const { AuthContext } = await vite.ssrLoadModule('/src/auth/AuthProvider.tsx')
  const { LoginPage } = await vite.ssrLoadModule('/src/pages/LoginPage.tsx')
  const { BootstrapPage } = await vite.ssrLoadModule('/src/pages/BootstrapPage.tsx')
  const noop = async () => {}
  const contextValue = {
    status: 'unauthenticated',
    user: null,
    devBypass: false,
    signIn: noop,
    signOut: noop,
    initializeOrganization: noop,
    refreshSession: noop,
    requestSetup: () => {},
    cancelSetup: () => {},
  }
  const withContext = (component) =>
    renderToStaticMarkup(
      createElement(AuthContext.Provider, { value: contextValue }, createElement(component)),
    )
  const loginHtml = withContext(LoginPage)
  assert.match(loginHtml, /CargoFlow/)
  assert.match(loginHtml, /autocomplete="username"/i)
  assert.match(loginHtml, /autocomplete="current-password"/i)
  assert.match(loginHtml, /for="login-username"/)
  assert.match(loginHtml, /for="login-password"/)
  assert.match(loginHtml, /Giriş Yap/)
  // Public "İlk kurulumu yap" bağlantısı kaldırıldı: organization hesapları
  // platform yöneticisi tarafından oluşturulur (backend bootstrap koruması ayrı).
  assert.doesNotMatch(loginHtml, /İlk kurulumu yap/)
  const bootstrapHtml = withContext(BootstrapPage)
  assert.match(bootstrapHtml, /Şirket adı/)
  assert.match(bootstrapHtml, /Şifre tekrarı/)
  assert.match(bootstrapHtml, /autocomplete="new-password"/i)
})

test('integrationConfigService auth modda secret localStorage\'a yazmaz (M)', async (t) => {
  const { vite } = await loadModules(t)
  const module = await vite.ssrLoadModule('/src/services/integrationConfigService.ts')
  const storageWrites = []
  const putBodies = []
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = {
    location: { hostname: 'localhost' },
    localStorage: {
      getItem: () => null,
      setItem: (key, value) => storageWrites.push({ key, value }),
      removeItem: () => {},
    },
  }
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PUT') putBodies.push(String(init.body))
    // GET/PUT → auth mode maskeli yanıt (secret yok).
    return {
      ok: true,
      json: async () => ({
        mode: 'auth',
        configured: true,
        trendyol: { configured: true, sellerId: 'S1', apiKeyMasked: '••••1234' },
        surat: { configured: false, customerCode: '', usernameMasked: '' },
      }),
    }
  }
  t.after(() => {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  })

  const service = new module.IntegrationConfigService()
  await service.hydrateIntegrationConfig()
  assert.equal(service.isAuthMode(), true, 'mode:auth tespit edilmeli')

  // Auth modda kaydetme: secret localStorage'a YAZILMAZ, sunucuya PUT edilir.
  service.saveIntegrationConfig({
    trendyol: { sellerId: 'S1', apiKey: 'GIZLI-APIKEY', apiSecret: 'GIZLI-SECRET', environment: 'prod', userAgentName: '' },
    surat: {},
    desi: undefined,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Hiçbir localStorage yazımında secret olmamalı (integration key hiç yazılmadı).
  const wroteIntegration = storageWrites.some((w) => w.key === 'cargoflow.integrationConfig')
  assert.equal(wroteIntegration, false, 'auth modda integration config localStorage\'a yazılmaz')
  for (const write of storageWrites) {
    assert.ok(!String(write.value).includes('GIZLI-SECRET'))
    assert.ok(!String(write.value).includes('GIZLI-APIKEY'))
  }
  // Secret sunucuya PUT ile gitti.
  assert.ok(putBodies.some((b) => b.includes('GIZLI-SECRET')))
})

test('AppShell oturum bilgisi ve Çıkış Yap gösterir (N)', async (t) => {
  const { vite, renderToStaticMarkup, createElement } = await loadModules(t)
  const { AuthContext } = await vite.ssrLoadModule('/src/auth/AuthProvider.tsx')
  const { AppShell } = await vite.ssrLoadModule('/src/components/AppShell.tsx')
  const noop = async () => {}
  const html = renderToStaticMarkup(
    createElement(
      AuthContext.Provider,
      {
        value: {
          status: 'authenticated',
          user: {
            username: 'zeynaadmin',
            organization: { id: 'o1', name: 'Zeyna Moda', slug: 'zeyna-moda' },
          },
          devBypass: false,
          signIn: noop,
          signOut: noop,
          initializeOrganization: noop,
          refreshSession: noop,
          requestSetup: () => {},
          cancelSetup: () => {},
        },
      },
      createElement(
        AppShell,
        { activePage: 'dashboard', onNavigate: () => {} },
        createElement('div', null, 'İÇERİK'),
      ),
    ),
  )
  assert.match(html, /Zeyna Moda/)
  assert.match(html, /zeynaadmin/)
  assert.match(html, /Çıkış Yap/)
  // Context yokken (izole render) shell yine çalışır, menü gizli.
  const bare = renderToStaticMarkup(
    createElement(
      AppShell,
      { activePage: 'dashboard', onNavigate: () => {} },
      createElement('div', null, 'İÇERİK'),
    ),
  )
  assert.ok(!bare.includes('Çıkış Yap'))
  assert.match(bare, /İÇERİK/)
})
