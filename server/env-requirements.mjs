// Self-hosted kurulum için ZORUNLU ortam değişkenleri sözleşmesi.
// Hem uygulama başlangıcı (server/index.mjs) hem kurulum scripti
// (scripts/setup-server.mjs) AYNI listeyi kullanır. Secret DEĞERLERİ asla
// loglanmaz; yalnız değişken ADI ve eksiklik durumu raporlanır.

export const REQUIRED_PRODUCTION_ENV = [
  {
    name: 'DATABASE_URL',
    hint: 'postgresql://kullanici:parola@127.0.0.1:5432/cargoflow_db',
  },
  { name: 'SESSION_SECRET', hint: 'openssl rand -base64 32' },
  { name: 'CREDENTIAL_ENCRYPTION_KEY', hint: 'openssl rand -base64 32 (32 byte)' },
  { name: 'SHIPMENT_ENCRYPTION_KEY', hint: 'openssl rand -base64 32 (32 byte)' },
  { name: 'ORDER_DATA_ENCRYPTION_KEY', hint: 'openssl rand -base64 32 (32 byte)' },
  { name: 'PRODUCT_DATA_ENCRYPTION_KEY', hint: 'openssl rand -base64 32 (32 byte)' },
]

// Doldurulmamış sayılan değerler: boş, ya da .env.example'daki <...> şablonu.
function isMissingValue(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return true
  if (value.startsWith('<') && value.endsWith('>')) return true
  return false
}

export function findMissingProductionEnv(env = process.env) {
  return REQUIRED_PRODUCTION_ENV.filter((entry) => isMissingValue(env[entry.name]))
}

export function isProductionEnvironment(env = process.env) {
  return String(env.NODE_ENV ?? '').trim() === 'production'
}

// TRUST_PROXY: "false"/"0"/"off"/boş → KAPALI. Sayı → hop sayısı.
// Diğer metinler Express'e olduğu gibi geçer (ör. "loopback").
export function resolveTrustProxy(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value || value === 'false' || value === '0' || value === 'off' || value === 'no') {
    return null
  }
  if (/^\d+$/.test(value)) return Number(value)
  return String(raw).trim()
}

// COOKIE_SECURE: açıkça verilirse ONA uyulur; verilmezse production'da true.
// Düz HTTP (http://IP:PORT) ile çalışırken false OLMALIDIR; aksi halde tarayıcı
// Secure cookie'yi geri göndermez ve oturum açılmış görünse de 401 alınır.
export function resolveCookieSecure(env = process.env) {
  const raw = String(env.COOKIE_SECURE ?? '').trim().toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  return isProductionEnvironment(env)
}
