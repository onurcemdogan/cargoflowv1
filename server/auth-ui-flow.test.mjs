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
  assert.match(loginHtml, /İlk kurulumu yap/)
  const bootstrapHtml = withContext(BootstrapPage)
  assert.match(bootstrapHtml, /Şirket adı/)
  assert.match(bootstrapHtml, /Şifre tekrarı/)
  assert.match(bootstrapHtml, /autocomplete="new-password"/i)
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
