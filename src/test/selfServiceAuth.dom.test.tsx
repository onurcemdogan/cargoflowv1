import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  SignupPage,
  VerifyEmailPage,
} from '../pages/auth/SelfServicePages'
import { resolvePublicAuthRoute } from '../auth/authView'

// ═══ PHASE2-A — SELF-SERVICE AUTH (GERÇEK DOM) ═══════════════════════════

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown }
let responder: Responder
let calls: Array<{ url: string; method: string; body: string | null }>

beforeEach(() => {
  calls = []
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: (init?.body as string) ?? null })
      const { status, body } = responder(String(url), init)
      return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

const CONFIG_ON = { signupEnabled: true, passwordResetEnabled: true, turnstileSiteKey: null }

test('SSUI-1: kayıt kapalıysa form GÖSTERİLMEZ ve istek atılmaz', async () => {
  responder = () => ({ status: 200, body: { ...CONFIG_ON, signupEnabled: false } })
  render(<SignupPage />)
  expect(await screen.findByText('Kayıt şu anda kapalı')).toBeTruthy()
  expect(screen.queryByLabelText('E-posta')).toBeNull()
  expect(calls.every((call) => call.url === '/api/auth/config')).toBe(true)
})

test('SSUI-2: kayıt → genel yanıt; şifre doğrulanır; hiçbir şey depoya yazılmaz', async () => {
  responder = (url) =>
    url === '/api/auth/config'
      ? { status: 200, body: CONFIG_ON }
      : { status: 202, body: { ok: true, message: 'Kaydınızı aldık. Hesabınızı etkinleştirmek için e-posta adresinize gönderilen bağlantıyı açın.' } }
  render(<SignupPage />)
  const email = await screen.findByLabelText('E-posta')
  fireEvent.change(email, { target: { value: 'ada@ornek.com' } })
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: 'kisa' } })
  fireEvent.change(screen.getByLabelText('Şifre tekrarı'), { target: { value: 'kisa' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Hesap oluştur' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Hesap oluştur' }))
  expect(await screen.findByText('Şifre en az 10 karakter olmalıdır.')).toBeTruthy()
  expect(calls.some((call) => call.url === '/api/auth/signup')).toBe(false)

  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: 'cok-guclu-sifre-1' } })
  fireEvent.change(screen.getByLabelText('Şifre tekrarı'), { target: { value: 'cok-guclu-sifre-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hesap oluştur' }))
  expect(await screen.findByText('E-postanızı kontrol edin')).toBeTruthy()
  const signup = calls.find((call) => call.url === '/api/auth/signup')
  expect(JSON.parse(String(signup?.body))).toEqual({ email: 'ada@ornek.com', password: 'cok-guclu-sifre-1', turnstileToken: '' })
  expect(window.localStorage.length).toBe(0)
})

test('SSUI-3: doğrulama bağlantısı → token adres çubuğundan SİLİNİR ve yalnız BİR KEZ gönderilir', async () => {
  window.history.replaceState(null, '', '/app/verify-email?token=TEK-KULLANIMLIK')
  responder = () => ({ status: 200, body: { ok: true, message: 'E-posta adresiniz doğrulandı. Şimdi giriş yapabilirsiniz.' } })
  render(<VerifyEmailPage />)
  expect(await screen.findByText('E-posta doğrulandı')).toBeTruthy()
  expect(window.location.search).toBe('')
  const posts = calls.filter((call) => call.url === '/api/auth/verify-email')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0].body))).toEqual({ token: 'TEK-KULLANIMLIK' })
  expect(screen.getByRole('link', { name: 'Giriş Yap' }).getAttribute('href')).toBe('/app')
})

test('SSUI-4: geçersiz/süresi dolmuş bağlantı açık hata ve yeni bağlantı yolu gösterir', async () => {
  window.history.replaceState(null, '', '/app/verify-email?token=ESKI')
  responder = () => ({ status: 400, body: { ok: false, code: 'INVALID_OR_EXPIRED_LINK', message: 'Bağlantı geçersiz ya da süresi dolmuş. Yeni bir bağlantı isteyin.' } })
  render(<VerifyEmailPage />)
  expect(await screen.findByText('Doğrulanamadı')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Yeni bağlantı iste' })).toBeTruthy()
})

test('SSUI-5: şifremi unuttum genel yanıtı gösterir; sıfırlama tokenı adres çubuğunda kalmaz', async () => {
  responder = (url) =>
    url === '/api/auth/config'
      ? { status: 200, body: CONFIG_ON }
      : { status: 202, body: { ok: true, message: 'Bu e-postaya bağlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi.' } }
  render(<ForgotPasswordPage />)
  fireEvent.change(await screen.findByLabelText('E-posta'), { target: { value: 'ada@ornek.com' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Bağlantı gönder' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Bağlantı gönder' }))
  expect(await screen.findByText(/hesap varsa şifre sıfırlama bağlantısı gönderildi/)).toBeTruthy()

  window.history.replaceState(null, '', '/app/reset-password?token=SIFIRLAMA')
  responder = () => ({ status: 200, body: { ok: true, message: 'Şifreniz güncellendi. Yeni şifrenizle giriş yapın.' } })
  render(<ResetPasswordPage />)
  expect(window.location.search).toBe('')
  fireEvent.change(screen.getByLabelText('Yeni şifre'), { target: { value: 'yepyeni-sifre-42' } })
  fireEvent.change(screen.getByLabelText('Yeni şifre tekrarı'), { target: { value: 'yepyeni-sifre-42' } })
  fireEvent.click(screen.getByRole('button', { name: 'Şifreyi güncelle' }))
  expect(await screen.findByText('Şifreniz güncellendi')).toBeTruthy()
  const reset = calls.find((call) => call.url === '/api/auth/reset-password')
  expect(JSON.parse(String(reset?.body))).toEqual({ token: 'SIFIRLAMA', password: 'yepyeni-sifre-42' })
})

test('SSUI-6: herkese açık auth yolları', () => {
  expect(resolvePublicAuthRoute('/app/signup')).toBe('signup')
  expect(resolvePublicAuthRoute('/app/verify-email/')).toBe('verify-email')
  expect(resolvePublicAuthRoute('/app/forgot-password')).toBe('forgot-password')
  expect(resolvePublicAuthRoute('/app/reset-password')).toBe('reset-password')
  expect(resolvePublicAuthRoute('/app')).toBeNull()
  expect(resolvePublicAuthRoute('/app/signupx')).toBeNull()
})

test('SSUI-7: ilk giriş çalışma alanı formu firma adını gönderir ve oturumu yeniler', async () => {
  const { WorkspaceSetupPage } = await import('../pages/WorkspaceSetupPage')
  const { AuthContext } = await import('../auth/AuthProvider')
  const refreshSession = vi.fn(async () => undefined)
  responder = () => ({ status: 201, body: { ok: true, organization: { id: 'org-1', name: 'Ada Moda', slug: 'ada-moda' } } })
  const value = {
    status: 'workspace_required',
    user: { username: 'ada@ornek.com', email: 'ada@ornek.com', organization: null },
    devBypass: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    initializeOrganization: vi.fn(),
    refreshSession,
    requestSetup: vi.fn(),
    cancelSetup: vi.fn(),
  } as unknown as import('../auth/AuthProvider').AuthContextValue
  render(
    <AuthContext.Provider value={value}>
      <WorkspaceSetupPage />
    </AuthContext.Provider>,
  )
  fireEvent.change(screen.getByLabelText('Firma adı'), { target: { value: 'Ada Moda' } })
  fireEvent.click(screen.getByRole('button', { name: 'Çalışma alanını oluştur' }))
  await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))
  const post = calls.find((call) => call.url === '/api/auth/workspace')
  expect(JSON.parse(String(post?.body))).toEqual({ name: 'Ada Moda' })
  expect(String(post?.body)).not.toMatch(/organizationId/)
})
