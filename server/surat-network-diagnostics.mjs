// Sürat ağ tanılaması (güvenli). Node fetch/undici hatasının cause zincirini
// GÜVENLİ biçimde sınıflandırır ve DNS/TLS/HTTP erişim probu yapar. ASLA
// credential (KullaniciAdi/Sifre/WebSifresi), SOAP body veya müşteri PII'si
// loglamaz/işlemez. Gönderi CREATE operasyonu YAPMAZ; yalnız salt-okuma probe.
import { lookup as dnsLookup } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect } from 'node:net'

// undici/Node fetch hata kodlarını faz + gönderim durumuna eşler.
// sent='not_sent'  → istek bayt'ları HİÇ yazılmadı (DNS/TCP/TLS/connect-timeout).
// sent='unknown'   → bağlantı kurulduktan sonra koptu; istek gitmiş OLABİLİR.
export function classifyNetworkFailure(error) {
  const cause = error && typeof error === 'object' ? error.cause : undefined
  const code = String(
    (cause && (cause.code || cause.errno)) || (error && error.code) || '',
  ).toUpperCase()
  const hostname =
    (cause && typeof cause.hostname === 'string' && cause.hostname) || null

  // DNS çözümleme hataları — bağlantı kurulmadı.
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL'].includes(code)) {
    return { category: 'DNS_FAILURE', phase: 'dns', code, hostname, sent: 'not_sent' }
  }
  // TCP connect reddi / erişilemez — bağlantı kurulmadı.
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(code)) {
    return { category: 'CONNECT_REFUSED', phase: 'tcp', code, hostname, sent: 'not_sent' }
  }
  // Connect timeout (undici) / bağlantı aşaması timeout — bağlantı kurulmadı.
  if (['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNTIMEOUT'].includes(code)) {
    return { category: 'CONNECT_TIMEOUT', phase: 'connect_timeout', code, hostname, sent: 'not_sent' }
  }
  // TLS/sertifika hataları — handshake istekten önce; bağlantı kurulmadı.
  if (
    code.startsWith('CERT_') ||
    code.startsWith('ERR_TLS') ||
    [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
      'ERR_SSL_WRONG_VERSION_NUMBER',
    ].includes(code)
  ) {
    return { category: 'TLS_FAILURE', phase: 'tls', code, hostname, sent: 'not_sent' }
  }
  // Soket sıfırlama/kapanma — bağlantı kurulmuş olabilir, istek gitmiş OLABİLİR.
  if (
    ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED'].includes(code) ||
    (cause && typeof cause.message === 'string' && /other side closed|socket hang up/i.test(cause.message))
  ) {
    return { category: 'CONNECTION_RESET', phase: 'reset', code, hostname, sent: 'unknown' }
  }
  // Sınıflanamayan: güvenli tarafta belirsiz kabul edilir (kör retry YOK).
  return { category: 'UNKNOWN_NETWORK_ERROR', phase: 'unknown', code: code || 'UNKNOWN', hostname, sent: 'unknown' }
}

// Kullanıcıya gösterilecek güvenli mesaj (secret/PII içermez).
export function userMessageForNetworkFailure(classification) {
  if (!classification) return 'Sürat servisine ulaşılamadı.'
  if (classification.sent === 'unknown') {
    return 'Sürat servisiyle bağlantı kesildi; gönderi oluşturulmuş olabilir. Durumu doğrulamadan tekrar oluşturmayın.'
  }
  return 'Sürat servisine şu anda ulaşılamıyor. Gönderi durumu doğrulanmadan tekrar oluşturmayın.'
}

function withTimeout(promise, ms, onTimeoutValue) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeoutValue), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        resolve({ error })
      },
    )
  })
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n)
}

// Salt-okuma ağ probu: DNS resolve, TCP connect, TLS handshake, güvenli HTTP GET.
// CREATE/SOAP operasyonu YAPMAZ. Çıktı yalnız güvenli alanlar içerir.
export async function runNetworkProbe(urlString, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 12000)
  const selectedEnvironment = options.selectedEnvironment ?? 'unknown'
  const started = nowMs()
  let hostname = ''
  let port = 443
  try {
    const url = new URL(urlString)
    hostname = url.hostname
    port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  } catch {
    return {
      selectedEnvironment,
      hostname: null,
      error: { category: 'INVALID_URL', code: 'INVALID_URL' },
      elapsedMs: nowMs() - started,
    }
  }

  const result = {
    selectedEnvironment,
    hostname,
    port,
    dns: { addresses: [], families: [], error: null },
    tcp: { connected: false, error: null },
    tls: { authorized: false, protocol: null, certSubjectCN: null, certIssuerCN: null, error: null },
    http: { status: null, error: null },
    elapsedMs: 0,
  }

  // 1) DNS resolve (tüm adresler + aile). Adres değerleri güvenli teknik bilgidir.
  const dnsRes = await withTimeout(dnsLookup(hostname, { all: true }), timeoutMs, { error: { code: 'DNS_TIMEOUT' } })
  if (dnsRes && Array.isArray(dnsRes)) {
    result.dns.addresses = dnsRes.map((a) => a.address)
    result.dns.families = [...new Set(dnsRes.map((a) => `IPv${a.family}`))]
  } else if (dnsRes && dnsRes.error) {
    result.dns.error = classifyNetworkFailure(dnsRes.error).code
  }

  const firstAddress = result.dns.addresses[0]
  if (!firstAddress) {
    result.elapsedMs = nowMs() - started
    return result
  }

  // 2) TCP connect (ilk adres).
  const tcpProbe = new Promise((resolve) => {
    const socket = netConnect({ host: firstAddress, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve({ connected: true })
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve({ error: { code: 'TCP_TIMEOUT' } })
    })
    socket.once('error', (error) => {
      resolve({ error: { code: String(error.code || 'TCP_ERROR') } })
    })
  })
  const tcpRes = await withTimeout(tcpProbe, timeoutMs + 500, { error: { code: 'TCP_TIMEOUT' } })
  result.tcp.connected = Boolean(tcpRes && tcpRes.connected)
  result.tcp.error = tcpRes && tcpRes.error ? tcpRes.error.code : null

  // 3) TLS handshake (SNI = hostname). Sertifika ÖZETİ (CN) — secret değil.
  if (result.tcp.connected) {
    const tlsProbe = new Promise((resolve) => {
      const socket = tlsConnect({ host: firstAddress, servername: hostname, port }, () => {
        const cert = socket.getPeerCertificate()
        const info = {
          authorized: socket.authorized,
          protocol: socket.getProtocol(),
          certSubjectCN: cert && cert.subject ? cert.subject.CN ?? null : null,
          certIssuerCN: cert && cert.issuer ? cert.issuer.CN ?? null : null,
          error: socket.authorized ? null : String(socket.authorizationError || 'TLS_UNAUTHORIZED'),
        }
        socket.destroy()
        resolve(info)
      })
      socket.setTimeout(timeoutMs)
      socket.once('timeout', () => {
        socket.destroy()
        resolve({ error: 'TLS_TIMEOUT' })
      })
      socket.once('error', (error) => {
        resolve({ error: String(error.code || 'TLS_ERROR') })
      })
    })
    const tlsRes = await withTimeout(tlsProbe, timeoutMs + 500, { error: 'TLS_TIMEOUT' })
    result.tls.authorized = Boolean(tlsRes && tlsRes.authorized)
    result.tls.protocol = (tlsRes && tlsRes.protocol) || null
    result.tls.certSubjectCN = (tlsRes && tlsRes.certSubjectCN) || null
    result.tls.certIssuerCN = (tlsRes && tlsRes.certIssuerCN) || null
    result.tls.error = tlsRes && tlsRes.error ? tlsRes.error : null
  }

  // 4) Güvenli HTTP GET (SOAP değil; sadece erişilebilirlik). CREATE YAPMAZ.
  const controller = new AbortController()
  const httpTimer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(urlString, { method: 'GET', signal: controller.signal })
    result.http.status = response.status
    // Gövde okunmaz/işlenmez (SOAP değil, PII yok).
  } catch (error) {
    result.http.error = classifyNetworkFailure(error).code
  } finally {
    clearTimeout(httpTimer)
  }

  result.elapsedMs = nowMs() - started
  return result
}
