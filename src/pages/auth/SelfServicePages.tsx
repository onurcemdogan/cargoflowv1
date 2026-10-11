// HERKESE AÇIK AUTH SAYFALARI — kayıt, e-posta doğrulama, şifremi unuttum,
// şifre sıfırlama. Hepsi aynı sade auth kartını kullanır.
//
// Hesap varlığı SIZDIRILMAZ: sunucunun genel yanıtı aynen gösterilir.
// Bağlantıdaki tek kullanımlık token adres çubuğundan HEMEN silinir
// (tarayıcı geçmişinde kalmaz) ve hiçbir depoya yazılmaz.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  forgotPassword,
  getAuthConfig,
  resendVerification,
  resetPassword,
  signup,
  verifyEmail,
  type AuthError,
  type AuthPublicConfig,
} from '../../auth/authService'
import { TurnstileWidget } from '../../auth/TurnstileWidget'
import { isPlausibleEmail, normalizeEmail } from '../../auth/emailPolicy'
import {
  isSelfServicePasswordAcceptable,
  SELF_SERVICE_MIN_PASSWORD_LENGTH,
  SELF_SERVICE_PASSWORD_MESSAGE,
} from '../../auth/passwordPolicy'

function useAuthConfig(): AuthPublicConfig | null {
  const [config, setConfig] = useState<AuthPublicConfig | null>(null)
  useEffect(() => {
    let active = true
    getAuthConfig().then((value) => {
      if (active) setConfig(value)
    })
    return () => {
      active = false
    }
  }, [])
  return config
}

function useLinkToken(): string {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '')
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [])
  return token
}

function errorMessage(error: unknown, fallback: string): string {
  return String((error as AuthError)?.message ?? fallback)
}

function AuthCard({
  title,
  lead,
  children,
  footer,
  onSubmit,
  busy,
}: {
  title: string
  lead?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onSubmit?: (event: FormEvent) => void
  busy?: boolean
}) {
  const body = (
    <>
      <div className="auth-brand">
        <img className="auth-brand-logo" src="/favicon.png" alt="" width={32} height={32} />
        <div>
          <strong>CargoFlow</strong>
          <span>Operasyon Paneli</span>
        </div>
      </div>
      <h1>{title}</h1>
      {lead ? <p className="auth-lead">{lead}</p> : null}
      {children}
      {footer ? <div className="auth-links">{footer}</div> : null}
    </>
  )
  return (
    <div className="auth-screen">
      {onSubmit ? (
        <form className="auth-card" onSubmit={onSubmit} aria-busy={busy} noValidate>
          {body}
        </form>
      ) : (
        <div className="auth-card">{body}</div>
      )}
      <a className="auth-back" href="/">
        CargoFlow ana sayfası
      </a>
    </div>
  )
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoComplete = 'new-password',
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  autoComplete?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <label htmlFor={id}>
      <span>{label}</span>
      <div className="auth-password-row">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          minLength={SELF_SERVICE_MIN_PASSWORD_LENGTH}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          required
        />
        <button
          type="button"
          className="auth-password-toggle"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Şifreyi gizle' : 'Şifreyi göster'}
        >
          {visible ? 'Gizle' : 'Göster'}
        </button>
      </div>
    </label>
  )
}

/* ─── Kayıt ────────────────────────────────────────────────────────────── */
export function SignupPage() {
  const config = useAuthConfig()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [captcha, setCaptcha] = useState('')
  const [captchaReset, setCaptchaReset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [sent, setSent] = useState<string>()
  const [resendInfo, setResendInfo] = useState<string>()

  const needsCaptcha = Boolean(config?.turnstileSiteKey)
  const emailOk = isPlausibleEmail(normalizeEmail(email))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!emailOk) return setError('Geçerli bir e-posta adresi girin.')
    if (!isSelfServicePasswordAcceptable(password)) return setError(SELF_SERVICE_PASSWORD_MESSAGE)
    if (password !== confirm) return setError('Şifreler aynı değil.')
    if (needsCaptcha && !captcha) return setError('Güvenlik doğrulamasının tamamlanmasını bekleyin.')
    setBusy(true)
    setError(undefined)
    try {
      setSent(await signup(email, password, captcha))
      setPassword('')
      setConfirm('')
    } catch (failure) {
      setError(errorMessage(failure, 'Kayıt tamamlanamadı.'))
    } finally {
      setBusy(false)
      setCaptchaReset((value) => value + 1)
    }
  }

  async function resend() {
    if (busy) return
    if (needsCaptcha && !captcha) return setResendInfo('Güvenlik doğrulamasının tamamlanmasını bekleyin.')
    setBusy(true)
    try {
      setResendInfo(await resendVerification(email, captcha))
    } catch (failure) {
      setResendInfo(errorMessage(failure, 'Bağlantı gönderilemedi.'))
    } finally {
      setBusy(false)
      setCaptchaReset((value) => value + 1)
    }
  }

  if (config && !config.signupEnabled) {
    return (
      <AuthCard
        title="Kayıt şu anda kapalı"
        lead="Yeni hesap oluşturma bu ortamda henüz açık değil."
        footer={<a href="/app">Giriş ekranına dön</a>}
      >
        <span />
      </AuthCard>
    )
  }

  if (sent) {
    return (
      <AuthCard
        title="E-postanızı kontrol edin"
        lead={sent}
        footer={<a href="/app">Giriş ekranına dön</a>}
      >
        <p className="auth-helper">
          E-posta gelmediyse istenmeyen klasörüne bakın ya da bir dakika sonra yeni bağlantı isteyin.
        </p>
        <TurnstileWidget siteKey={config?.turnstileSiteKey ?? null} onToken={setCaptcha} resetKey={captchaReset} />
        {resendInfo ? (
          <p className="auth-info" role="status">
            {resendInfo}
          </p>
        ) : null}
        <button type="button" className="auth-secondary" onClick={() => void resend()} disabled={busy}>
          {busy ? 'Gönderiliyor…' : 'Bağlantıyı yeniden gönder'}
        </button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Kayıt Ol"
      lead="E-posta adresinizle CargoFlow hesabı oluşturun."
      onSubmit={submit}
      busy={busy}
      footer={
        <>
          Zaten hesabınız var mı? <a href="/app">Giriş yapın</a>
        </>
      }
    >
      <label htmlFor="signup-email">
        <span>E-posta</span>
        <input
          id="signup-email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy}
          required
        />
      </label>
      <PasswordField id="signup-password" label="Şifre" value={password} onChange={setPassword} disabled={busy} />
      <PasswordField id="signup-password-confirm" label="Şifre tekrarı" value={confirm} onChange={setConfirm} disabled={busy} />
      <p className="auth-helper">En az {SELF_SERVICE_MIN_PASSWORD_LENGTH} karakter.</p>
      <TurnstileWidget siteKey={config?.turnstileSiteKey ?? null} onToken={setCaptcha} resetKey={captchaReset} />
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className="auth-submit"
        disabled={busy || !config || !email.trim() || !password || !confirm}
      >
        {busy ? 'Hesap oluşturuluyor…' : 'Hesap oluştur'}
      </button>
    </AuthCard>
  )
}

/* ─── E-posta doğrulama ────────────────────────────────────────────────── */
export function VerifyEmailPage() {
  const token = useLinkToken()
  const started = useRef(false)
  const [state, setState] = useState<{ phase: 'working' | 'done' | 'failed'; message: string }>(() =>
    token
      ? { phase: 'working', message: 'E-posta adresiniz doğrulanıyor…' }
      : { phase: 'failed', message: 'Bağlantı eksik. E-postadaki bağlantıyı yeniden açın.' },
  )

  useEffect(() => {
    // Tek kullanımlık token iki kez gönderilmesin (geliştirmede efekt iki kez çalışır).
    if (!token || started.current) return
    started.current = true
    verifyEmail(token)
      .then((message) => setState({ phase: 'done', message }))
      .catch((failure) => setState({ phase: 'failed', message: errorMessage(failure, 'Doğrulama tamamlanamadı.') }))
  }, [token])

  return (
    <AuthCard
      title={state.phase === 'done' ? 'E-posta doğrulandı' : state.phase === 'failed' ? 'Doğrulanamadı' : 'Doğrulanıyor'}
      footer={
        state.phase === 'failed' ? (
          <>
            <a href="/app/signup">Yeni bağlantı iste</a> · <a href="/app">Giriş</a>
          </>
        ) : null
      }
    >
      <p className={state.phase === 'failed' ? 'auth-error' : 'auth-info'} role="status">
        {state.message}
      </p>
      {state.phase === 'done' ? (
        <a className="auth-submit auth-link-button" href="/app">
          Giriş Yap
        </a>
      ) : null}
    </AuthCard>
  )
}

/* ─── Şifremi unuttum ──────────────────────────────────────────────────── */
export function ForgotPasswordPage() {
  const config = useAuthConfig()
  const [email, setEmail] = useState('')
  const [captcha, setCaptcha] = useState('')
  const [captchaReset, setCaptchaReset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!isPlausibleEmail(normalizeEmail(email))) return setError('Geçerli bir e-posta adresi girin.')
    if (config?.turnstileSiteKey && !captcha) return setError('Güvenlik doğrulamasının tamamlanmasını bekleyin.')
    setBusy(true)
    setError(undefined)
    try {
      setDone(await forgotPassword(email, captcha))
    } catch (failure) {
      setError(errorMessage(failure, 'İstek gönderilemedi.'))
    } finally {
      setBusy(false)
      setCaptchaReset((value) => value + 1)
    }
  }

  if (config && !config.passwordResetEnabled) {
    return (
      <AuthCard
        title="Şifre sıfırlama kullanılamıyor"
        lead="Bu ortamda e-posta ile şifre sıfırlama henüz açık değil. Hesap yöneticinize başvurun."
        footer={<a href="/app">Giriş ekranına dön</a>}
      >
        <span />
      </AuthCard>
    )
  }

  if (done) {
    return (
      <AuthCard title="E-postanızı kontrol edin" lead={done} footer={<a href="/app">Giriş ekranına dön</a>}>
        <p className="auth-helper">Bağlantı 30 dakika geçerlidir.</p>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Şifremi unuttum"
      lead="Hesabınızın e-posta adresini girin; şifre sıfırlama bağlantısı gönderelim."
      onSubmit={submit}
      busy={busy}
      footer={<a href="/app">Giriş ekranına dön</a>}
    >
      <label htmlFor="forgot-email">
        <span>E-posta</span>
        <input
          id="forgot-email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy}
          required
        />
      </label>
      <TurnstileWidget siteKey={config?.turnstileSiteKey ?? null} onToken={setCaptcha} resetKey={captchaReset} />
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="auth-submit" disabled={busy || !config || !email.trim()}>
        {busy ? 'Gönderiliyor…' : 'Bağlantı gönder'}
      </button>
    </AuthCard>
  )
}

/* ─── Şifre sıfırlama ──────────────────────────────────────────────────── */
export function ResetPasswordPage() {
  const token = useLinkToken()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!isSelfServicePasswordAcceptable(password)) return setError(SELF_SERVICE_PASSWORD_MESSAGE)
    if (password !== confirm) return setError('Şifreler aynı değil.')
    setBusy(true)
    setError(undefined)
    try {
      setDone(await resetPassword(token, password))
      setPassword('')
      setConfirm('')
    } catch (failure) {
      setError(errorMessage(failure, 'Şifre güncellenemedi.'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthCard title="Şifreniz güncellendi" lead={done}>
        <a className="auth-submit auth-link-button" href="/app">
          Giriş Yap
        </a>
      </AuthCard>
    )
  }

  if (!token) {
    return (
      <AuthCard
        title="Bağlantı eksik"
        lead="E-postadaki şifre sıfırlama bağlantısını yeniden açın ya da yeni bağlantı isteyin."
        footer={<a href="/app/forgot-password">Yeni bağlantı iste</a>}
      >
        <span />
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Yeni şifre belirleyin"
      lead="Şifreniz değişince açık oturumlarınız kapatılır."
      onSubmit={submit}
      busy={busy}
      footer={<a href="/app/forgot-password">Yeni bağlantı iste</a>}
    >
      <PasswordField id="reset-password" label="Yeni şifre" value={password} onChange={setPassword} disabled={busy} />
      <PasswordField id="reset-password-confirm" label="Yeni şifre tekrarı" value={confirm} onChange={setConfirm} disabled={busy} />
      <p className="auth-helper">En az {SELF_SERVICE_MIN_PASSWORD_LENGTH} karakter.</p>
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="auth-submit" disabled={busy || !password || !confirm}>
        {busy ? 'Kaydediliyor…' : 'Şifreyi güncelle'}
      </button>
    </AuthCard>
  )
}
