import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { execFile } from 'node:child_process'
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { deriveSuratLifecycleState } from './surat-lifecycle.mjs'

const app = express()
const execFileAsync = promisify(execFile)
const serverDirectory = dirname(fileURLToPath(import.meta.url))
const BUILD_REVISION = await resolveBuildRevision()
loadLocalEnvFile(join(serverDirectory, '..', '.env'))
// Production (Railway) PORT/HOST enjekte eder; local geliştirme mevcut portu
// korur. Host varsayılanı 0.0.0.0 (container'da dış erişim için gereklidir).
const port = Number(process.env.PORT ?? process.env.CARGOFLOW_API_PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'
const localConfigDirectory =
  process.env.CARGOFLOW_CONFIG_DIR ||
  join(process.env.LOCALAPPDATA || homedir(), 'CargoFlow')
const localConfigKeyPath = join(localConfigDirectory, 'local-config.key')
const localIntegrationConfigPath = join(
  localConfigDirectory,
  'integration-config.enc.json',
)
const suratCreateOperationPath = join(
  localConfigDirectory,
  'surat-create-operations.json',
)
const suratCreateLocks = new Map()
let suratCreateStoreQueue = Promise.resolve()
const SURAT_SOAP_URL =
  process.env.SURAT_SOAP_URL ||
  'https://webservices.suratkargo.com.tr/services.asmx'
const SURAT_REST_LIVE_BASE_URL =
  process.env.SURAT_REST_LIVE_BASE_URL ||
  'https://api01.suratkargo.com.tr'
const SURAT_REST_TEST_BASE_URL =
  process.env.SURAT_REST_TEST_BASE_URL ||
  'https://api02.suratkargo.com.tr'
const SURAT_ENV =
  process.env.SURAT_ENV === 'live' || process.env.SURAT_ENV === 'test'
    ? process.env.SURAT_ENV
    : ''
const TRENDYOL_PROD_BASE_URL =
  process.env.TRENDYOL_PROD_BASE_URL || 'https://apigw.trendyol.com'
const TRENDYOL_STAGE_BASE_URL =
  process.env.TRENDYOL_STAGE_BASE_URL || 'https://stageapigw.trendyol.com'
const ACTIVE_TRENDYOL_ORDER_STATUSES = ['Created', 'Picking', 'Invoiced']
const ARCHIVE_TRENDYOL_ORDER_STATUSES = [
  'Shipped',
  'Delivered',
  'AtCollectionPoint',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
]
const ALL_TRENDYOL_ORDER_STATUSES = [
  ...ACTIVE_TRENDYOL_ORDER_STATUSES,
  ...ARCHIVE_TRENDYOL_ORDER_STATUSES,
]
const TRENDYOL_ACTIVE_STATUS_WINDOW_MS = 10 * 24 * 60 * 60 * 1000
// Claims (iade) API tarih penceresi. Trendyol getClaims için doküman net
// bir üst sınır vermiyor; sipariş API'sinin 30 günlük sınırının altında,
// güvenli 14 günlük dilimler halinde çekilir.
const TRENDYOL_CLAIMS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const SURAT_LABEL_REGISTRATION_GRACE_MS = 30 * 60 * 1000
const SURAT_BARCODE_FAILED_MESSAGE =
  'OrtakBarkodOlustur çağrıldı ancak Sürat KargoTakipNo/Barcode döndürmedi. Sürat ortak barkod yetkisi, SOAP parametreleri veya hesap ayarları kontrol edilmeli.'

const SURAT_INVALID_CODES_MESSAGE =
  'Sürat gönderisi oluşturuldu gibi döndü ancak geçerli takip/barkod kodu alınamadı. Etiket basılamaz.'

const TRENDYOL_1002_POSSIBLE_REASONS = [
  'Trendyol paketi kargoya verilebilir statüde değil.',
  'Paket daha önce işlem görmüş olabilir.',
  'Paket iptal/teslim/kargoda/farklı statüde olabilir.',
  'Trendyol tarafında bu cargoTrackingNumber aktif gönderi oluşturma aşamasında olmayabilir.',
  'Sipariş farklı kargo firması veya farklı pazaryeri akışıyla eşleşmiş olabilir.',
  'Aynı packageId/cargoTrackingNumber için daha önce kayıt açılmış olabilir.',
  'Trendyol bu paket için Sürat gönderi oluşturma işlemine izin vermiyor olabilir.',
]
const SURAT_RETRY_DELAYS_SECONDS = [30, 60, 90, 120, 180]
const SURAT_RESPONSE_ID_TABLE = {
  '001': { category: 'ERROR', description: 'Kullanıcı Adı Veya Şifre Yanlış' },
  '002': { category: 'ERROR', description: 'Kişi/Kurum Bilgisi Olmalıdır' },
  '003': { category: 'ERROR', description: 'Alıcı Adresi Bilgisi Olmalıdır' },
  '004': { category: 'ERROR', description: 'İl/İlçe Bilgisi Olmalıdır' },
  '005': { category: 'ERROR', description: 'İrsaliye Sıra No sadece sayısal olmalıdır' },
  '006': { category: 'ERROR', description: 'Birim Desi ve Birim Kg sıfırdan büyük olmalıdır' },
  '007': { category: 'ERROR', description: 'Teslim şekli tanımlı olmalıdır' },
  '008': { category: 'ERROR', description: 'Adet bilgisi sıfırdan büyük olmalıdır' },
  '009': { category: 'DUPLICATE_EXISTS', description: 'Bu siparişe ait gönderi oluşmuştur' },
  '010': { category: 'PARTIAL', description: 'Sipariş kaydedildi, varış merkezi bulunamadı' },
  '011': { category: 'PARTIAL', description: 'Önceki siparişin varış merkezi tespiti yapılmadı, desi güncellendi' },
  '012': { category: 'PARTIAL', description: 'Önceki siparişin varış merkezi tespiti yapılmadı' },
  '013': { category: 'BARCODE_SUCCESS', description: 'Barkod tekrardan iletilmiştir' },
  '014': { category: 'BARCODE_SUCCESS', description: 'Desi/Kg güncellendi, barkod tekrar iletildi' },
  '015': { category: 'BARCODE_SUCCESS', description: 'Desi/Kg güncellendi, barkod iletildi' },
  '016': { category: 'BARCODE_SUCCESS', description: 'Barkod gönderilmiştir' },
  '017': { category: 'ERROR', description: 'PPD barkod oluşturmada hata' },
  '018': { category: 'ERROR', description: 'Sözleşme bulunamadı' },
  '019': { category: 'ERROR', description: 'Ev telefonu formatı hatalı' },
  '020': { category: 'ERROR', description: 'Telefon numarası sayılardan oluşmalıdır' },
  '021': { category: 'ERROR', description: '12 haneli cep telefonu 905 ile başlamalıdır' },
  '022': { category: 'ERROR', description: '11 haneli cep telefonu 05 ile başlamalıdır' },
  '023': { category: 'ERROR', description: '10 haneli cep telefonu 5 ile başlamalıdır' },
  '024': { category: 'ERROR', description: 'Cep telefonu en az 10 haneli olmalıdır' },
  '025': { category: 'ERROR', description: 'Taşıma şekli tanımlı olmalıdır' },
  '026': { category: 'ERROR', description: 'Kapıdan ödeme tutarı sıfırdan küçük olamaz' },
  '027': { category: 'ERROR', description: 'Ödeme tipi bilgisi olmalıdır' },
  '028': { category: 'ERROR', description: 'Ödeme tipi geçerli olmalıdır' },
  '029': { category: 'ERROR', description: 'Kargo türü bilgisi olmalıdır' },
  '030': { category: 'ERROR', description: 'Kargo türü geçerli olmalıdır' },
  '031': { category: 'ERROR', description: 'Dosya kargo türünde desi/kg 0 olmalıdır' },
  '032': { category: 'ERROR', description: 'Mİ kargo türünde desi/kg 1 olmalıdır' },
  '033': { category: 'ERROR', description: 'Kapıdan ödeme olmayan caride kapıdan ödeme tutarı dolu olamaz' },
  '034': { category: 'ERROR', description: 'Kapıdan ödemede irsaliye seri/sıra no girilmelidir' },
  '035': { category: 'ERROR', description: 'Kapıdan ödeme tutarında nokta yerine virgül kullanılmalıdır' },
  '036': { category: 'ERROR', description: 'Kapıdan ödeme tutarı formatı hatalı' },
  '037': { category: 'ERROR', description: 'Kapıdan ödeme tutarı olmalıdır' },
  '038': { category: 'RETRY', description: 'Kargo takip numarası oluşturulamadı, tekrar deneyiniz' },
  '039': { category: 'PARTIAL', description: 'Sipariş kaydedildi, barkod oluşturulamadı' },
  '040': { category: 'ERROR', description: 'Barkod okuma hatası' },
  '041': { category: 'ERROR', description: 'Dokümanda açıklaması bulunmayan Response ID' },
  '042': { category: 'ERROR', description: 'Sistem hatası' },
  '043': { category: 'TRENDYOL_PROXY', description: 'Trendyol proxy/pazaryeri özel kontrol hatası' },
}

const TRENDYOL_1002_RECOMMENDED_ACTIONS = [
  'Trendyol panelinde siparişin kargo statüsünü kontrol et.',
  'Sipariş Sürat’e atanmış mı kontrol et.',
  'Sipariş daha önce kargoya verilmiş mi kontrol et.',
  'Sipariş iptal/teslim/kargoda statüsünde mi kontrol et.',
  'Gerekirse bu packageId ve cargoTrackingNumber ile Trendyol/Sürat destek birimine sor.',
]

app.use(cors())
app.use(express.json({ limit: '10mb' }))
// KRİTİK: tenantAuth (requireAuth) ve onboarding/orders/products endpoint'leri
// ana app üzerinde çalışır ve session token'ını request.cookies'ten okur.
// cookie-parser burada kayıtlı OLMAZSA request.cookies undefined kalır ve auth
// modunda (production/DATABASE_URL) geçerli cargoflow_session cookie'si gelse
// bile 401 "Oturum gerekli" döner. /api/auth ve /api/platform-admin router'ları
// kendi cookieParser'larını çalıştırdığından bu sorun yalnız ana app route'larını
// etkiler. cookieParser idempotent'tir; router içi ikinci çağrı zararsızdır.
app.use(cookieParser())

// /api/auth: organization bazlı backend auth (faz 2). Router lazy yüklenir;
// DATABASE_URL yoksa router kendi içinde 503 döner, TS modülü yüklenemezse
// da 503 — mevcut yerel kullanım davranışı hiçbir durumda etkilenmez.
let authRouterPromise = null
app.use('/api/auth', (request, response, next) => {
  if (!authRouterPromise) {
    authRouterPromise = import('./auth/routes.ts').then((module) =>
      module.createAuthRouter(),
    )
  }
  authRouterPromise
    .then((router) => router(request, response, next))
    .catch(() => {
      authRouterPromise = null
      response.status(503).json({
        ok: false,
        message: 'Auth servisi yüklenemedi; PostgreSQL yapılandırmasını kontrol edin.',
      })
    })
})

// /api/platform-admin: organization kullanıcılarından AYRI platform yönetici
// paneli (ayrı cookie, ayrı tablo, requirePlatformAdmin). Router lazy yüklenir;
// DATABASE_URL yoksa router 503 döner. Organization cargoflow_session cookie'si
// admin erişimi SAĞLAMAZ.
let adminRouterPromise = null
app.use('/api/platform-admin', (request, response, next) => {
  if (!adminRouterPromise) {
    adminRouterPromise = import('./admin/adminRoutes.ts').then((module) =>
      module.createPlatformAdminRouter(),
    )
  }
  adminRouterPromise
    .then((router) => router(request, response, next))
    .catch(() => {
      adminRouterPromise = null
      response.status(503).json({
        ok: false,
        message: 'Platform admin servisi yüklenemedi; PostgreSQL yapılandırmasını kontrol edin.',
      })
    })
})

// --- Tenant izolasyonu (faz 3) -------------------------------------------
// İki mod: (1) DATABASE_URL yoksa LEGACY — mevcut local-config akışı ve
// isTrustedLocalConfigRequest guard'ı aynen çalışır, auth zorunlu değildir
// (mevcut yerel geliştirme ve test davranışı korunur). (2) DATABASE_URL
// varsa AUTH — korumalı route'lar requireAuth ister, credential yalnız
// oturumdaki organization'ın PostgreSQL kaydından çözülür, local/global
// config'e DÜŞÜLMEZ. organizationId yalnız req.auth'tan gelir.
function isTenantAuthMode() {
  return Boolean(String(process.env.DATABASE_URL ?? '').trim())
}
const CREDENTIAL_ENCRYPTION_MISSING = 'CREDENTIAL_ENCRYPTION_MISSING'

// Korumalı route middleware: auth modda requireAuth; legacy modda no-op.
async function tenantAuth(request, response, next) {
  if (!isTenantAuthMode()) return next()
  try {
    const [{ requireAuth }, { getDb }] = await Promise.all([
      import('./auth/middleware.ts'),
      import('./db/client.ts'),
    ])
    return requireAuth(getDb())(request, response, next)
  } catch {
    response.status(503).json({
      ok: false,
      message: 'Kimlik doğrulama katmanı yüklenemedi; PostgreSQL yapılandırmasını kontrol edin.',
    })
  }
}

// Oturumdaki organization credential'ını (DB) normalize config olarak çözer.
// Auth modda encryption key yoksa özel hata fırlatır (endpoint 503 döner).
async function loadRequestOrgConfig(request) {
  const { isCredentialEncryptionConfigured, loadOrganizationIntegrationConfig } =
    await import('./integrations/credentialService.ts')
  if (!isCredentialEncryptionConfigured()) {
    const error = new Error('CREDENTIAL_ENCRYPTION_KEY tanımlı değil.')
    error.code = CREDENTIAL_ENCRYPTION_MISSING
    throw error
  }
  const { getDb } = await import('./db/client.ts')
  const config = await loadOrganizationIntegrationConfig(
    getDb(),
    request.auth.organizationId,
  )
  return normalizeLocalIntegrationConfig(config)
}

// Korumalı POST route'ları için: auth modda body'deki config/credentials'ı
// DB'den gelen org credential'ıyla EZER (frontend'in gönderdiği credential/
// organizationId yok sayılır). Sürat create/idempotency ve mevcut handler'lar
// değişmez; yalnız credential KAYNAĞI değişir.
async function tenantInjectCredentials(request, response, next) {
  if (!isTenantAuthMode() || !request.auth) return next()
  try {
    const config = await loadRequestOrgConfig(request)
    if (request.body && typeof request.body === 'object') {
      request.body.config = config
      request.body.credentials = config.trendyol
    }
    next()
  } catch (error) {
    if (error?.code === CREDENTIAL_ENCRYPTION_MISSING) {
      response.status(503).json({
        ok: false,
        message: 'Credential şifreleme anahtarı (CREDENTIAL_ENCRYPTION_KEY) yapılandırılmamış.',
      })
      return
    }
    response.status(500).json({ ok: false, message: 'Organization credential çözülemedi.' })
  }
}

// Auth modda org config, legacy modda local şifreli config. Production'da
// auth modda local/global fallback KULLANILMAZ.
async function getRequestIntegrationConfig(request) {
  if (isTenantAuthMode() && request.auth?.organizationId) {
    return loadRequestOrgConfig(request)
  }
  if (isTenantAuthMode() && process.env.NODE_ENV === 'production') {
    return null
  }
  const stored = await readEncryptedIntegrationConfig()
  return stored ? normalizeLocalIntegrationConfig(stored) : null
}

// Korumalı route ön ekleri: auth (hepsi) + credential injection (body
// kullananlar). Route tanımlarından ÖNCE kayıtlıdır.
const TENANT_AUTH_PATHS = [
  '/api/local-config/integration',
  '/api/trendyol',
  '/api/integrations/trendyol',
  '/api/integrations/surat',
  '/api/analytics/orders',
  '/api/analytics/claims',
  '/api/orders',
  '/api/products',
  '/api/onboarding',
  '/api/shipments/surat',
  '/api/labels/zpl',
  '/api/printing/zebra',
]
const TENANT_INJECT_PATHS = [
  '/api/trendyol',
  '/api/integrations/trendyol',
  '/api/integrations/surat',
  '/api/orders/sync',
  '/api/products/sync',
  '/api/shipments/surat',
]
app.use(TENANT_AUTH_PATHS, tenantAuth)
app.use(TENANT_INJECT_PATHS, tenantInjectCredentials)

app.get('/api/health', async (_request, response) => {
  // Mevcut davranış korunur: DATABASE_URL tanımlı değilse yanıt eskisiyle
  // birebir aynıdır (db alanı eklenmez, ok:true kalır). DB yalnız
  // yapılandırıldığında opsiyonel `db` alanı olarak raporlanır; DB hatası
  // health'i başarısız YAPMAZ.
  const payload = {
    ok: true,
    service: 'cargoflow-api',
    buildRevision: BUILD_REVISION,
    checkedAt: new Date().toISOString(),
  }
  if (String(process.env.DATABASE_URL ?? '').trim()) {
    try {
      const { checkDatabaseHealth } = await import('./db/client.ts')
      payload.db = await checkDatabaseHealth()
    } catch (error) {
      payload.db = {
        configured: true,
        ok: false,
        message:
          error instanceof Error ? error.message : 'DB health kontrol edilemedi.',
      }
    }
  }
  response.json(payload)
})

app.get('/api/local-config/integration', async (request, response) => {
  // Auth modda: yalnız oturumdaki organization'ın MASKELENMİŞ durumu; secret
  // DÖNMEZ. organizationId yalnız req.auth'tan gelir.
  if (isTenantAuthMode()) {
    try {
      const { isCredentialEncryptionConfigured, getMaskedIntegrationStatus } =
        await import('./integrations/credentialService.ts')
      if (!isCredentialEncryptionConfigured()) {
        response.status(503).json({
          ok: false,
          message: 'Credential şifreleme anahtarı (CREDENTIAL_ENCRYPTION_KEY) yapılandırılmamış.',
        })
        return
      }
      const { getDb } = await import('./db/client.ts')
      const status = await getMaskedIntegrationStatus(
        getDb(),
        request.auth.organizationId,
      )
      response.json({
        ok: true,
        mode: 'auth',
        configured: status.trendyol.configured || status.surat.configured,
        trendyol: status.trendyol,
        surat: status.surat,
      })
    } catch {
      response.status(500).json({
        ok: false,
        message: 'Organization entegrasyon durumu okunamadı.',
      })
    }
    return
  }
  if (!isTrustedLocalConfigRequest(request)) {
    response.status(403).json({
      ok: false,
      message: 'Entegrasyon ayarları yalnızca bu bilgisayardan okunabilir.',
    })
    return
  }
  try {
    const storedConfig = await readEncryptedIntegrationConfig()
    const config = storedConfig
      ? normalizeLocalIntegrationConfig(storedConfig)
      : undefined
    if (
      storedConfig &&
      JSON.stringify(storedConfig) !== JSON.stringify(config)
    ) {
      await writeEncryptedIntegrationConfig(config)
    }
    response.json({
      ok: true,
      configured: hasIntegrationCredentials(config),
      config: config || null,
    })
  } catch {
    response.status(500).json({
      ok: false,
      message: 'Yerel entegrasyon ayarları okunamadı.',
    })
  }
})

app.put('/api/local-config/integration', async (request, response) => {
  // Auth modda: yalnız oturum organization'ına yazar; boş secret eski değeri
  // korur; frontend'den gelen organizationId yok sayılır; DB'ye şifreli yazar.
  if (isTenantAuthMode()) {
    const incoming = request.body?.config
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      response.status(400).json({ ok: false, message: 'Geçerli entegrasyon ayarı gerekli.' })
      return
    }
    try {
      const {
        isCredentialEncryptionConfigured,
        saveIntegrationCredential,
        getMaskedIntegrationStatus,
      } = await import('./integrations/credentialService.ts')
      if (!isCredentialEncryptionConfigured()) {
        response.status(503).json({
          ok: false,
          message: 'Credential şifreleme anahtarı (CREDENTIAL_ENCRYPTION_KEY) yapılandırılmamış.',
        })
        return
      }
      const { getDb } = await import('./db/client.ts')
      const db = getDb()
      const organizationId = request.auth.organizationId
      const normalized = normalizeLocalIntegrationConfig(incoming)
      if (incoming.trendyol && typeof incoming.trendyol === 'object') {
        await saveIntegrationCredential(db, organizationId, 'trendyol', normalized.trendyol)
      }
      if (incoming.surat && typeof incoming.surat === 'object') {
        await saveIntegrationCredential(db, organizationId, 'surat', normalized.surat)
      }
      const status = await getMaskedIntegrationStatus(db, organizationId)
      response.json({
        ok: true,
        mode: 'auth',
        configured: status.trendyol.configured || status.surat.configured,
        trendyol: status.trendyol,
        surat: status.surat,
        message: 'Entegrasyon bilgileri organization için şifreli olarak saklandı.',
      })
    } catch {
      response.status(500).json({ ok: false, message: 'Organization entegrasyon ayarları kaydedilemedi.' })
    }
    return
  }
  if (!isTrustedLocalConfigRequest(request)) {
    response.status(403).json({
      ok: false,
      message: 'Entegrasyon ayarları yalnızca bu bilgisayardan kaydedilebilir.',
    })
    return
  }
  const config = request.body?.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    response.json({
      ok: false,
      message: 'Geçerli entegrasyon ayarı gerekli.',
    })
    return
  }
  try {
    const normalized = normalizeLocalIntegrationConfig(config)
    await writeEncryptedIntegrationConfig(normalized)
    response.json({
      ok: true,
      configured: hasIntegrationCredentials(normalized),
      message: 'Entegrasyon ayarları bu bilgisayarda şifreli olarak saklandı.',
    })
  } catch {
    response.status(500).json({
      ok: false,
      message: 'Yerel entegrasyon ayarları kaydedilemedi.',
    })
  }
})

app.post('/api/integrations/trendyol/save', (request, response) => {
  response.json({
    ok: true,
    source: 'local',
    message: 'Trendyol bağlantı bilgileri kaydedildi.',
    received: redact(request.body),
  })
})

app.post('/api/integrations/trendyol/test', async (request, response) => {
  const credentials = request.body?.credentials ?? {}
  const result = await callTrendyolOrders(credentials, {
    page: 0,
    size: 1,
    includeSortParams: false,
  })
  response.json(toIntegrationTestResult('trendyol', result))
})

app.post('/api/trendyol/orders/fetch', handleTrendyolOrdersFetch)
app.post('/api/integrations/trendyol/orders', handleTrendyolOrdersFetch)
app.post('/api/integrations/trendyol/fetch-orders', handleTrendyolOrdersFetch)

// AUTH modu sipariş persistence API'si. Kaynak-of-truth PostgreSQL; her
// organization YALNIZ kendi siparişlerini görür (org req.auth'tan gelir,
// query/body'den ASLA). Legacy modda (DATABASE_URL yok) bu route'lar 404
// döner; frontend legacy akışı localStorage'da kalır ve buraya çağrı yapmaz.
function strOrUndef(value) {
  const text = String(value ?? '').trim()
  return text ? text : undefined
}

async function requireOrderPersistenceContext(request, response) {
  if (!isTenantAuthMode() || !request.auth?.organizationId) {
    response.status(404).json({ ok: false, message: 'Sipariş persistence yalnız auth modda kullanılabilir.' })
    return null
  }
  try {
    const [{ getDb }, service] = await Promise.all([
      import('./db/client.ts'),
      import('./orders/orderPersistenceService.ts'),
    ])
    return { db: getDb(), service, organizationId: request.auth.organizationId }
  } catch {
    response.status(503).json({
      ok: false,
      message: 'Sipariş persistence katmanı yüklenemedi; PostgreSQL yapılandırmasını kontrol edin.',
    })
    return null
  }
}

// GET /api/orders — org-scoped, server-side sayfalı liste. Filtreler yalnız
// query string'ten okunur; organization override edilemez.
app.get('/api/orders', async (request, response) => {
  const context = await requireOrderPersistenceContext(request, response)
  if (!context) return
  try {
    const query = request.query ?? {}
    const result = await context.service.listOrders(context.db, context.organizationId, {
      status: strOrUndef(query.status),
      operationStatus: strOrUndef(query.operationStatus),
      search: strOrUndef(query.search),
      startDate: strOrUndef(query.startDate),
      endDate: strOrUndef(query.endDate),
      city: strOrUndef(query.city),
      district: strOrUndef(query.district),
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort === 'orderDateAsc' ? 'orderDateAsc' : 'orderDateDesc',
    })
    response.json({
      ok: true,
      orders: result.orders,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    })
  } catch {
    response.status(500).json({ ok: false, message: 'Siparişler yüklenemedi.' })
  }
})

// GET /api/orders/:id — org-scoped tekil sipariş. Başka org'un siparişi
// (veya yok) 404 döner (findOrderById zaten org filtresi uygular).
app.get('/api/orders/:id', async (request, response) => {
  const context = await requireOrderPersistenceContext(request, response)
  if (!context) return
  try {
    const order = await context.service.getOrder(
      context.db,
      context.organizationId,
      String(request.params.id),
    )
    if (!order) {
      response.status(404).json({ ok: false, message: 'Sipariş bulunamadı.' })
      return
    }
    response.json({ ok: true, order })
  } catch {
    response.status(500).json({ ok: false, message: 'Sipariş yüklenemedi.' })
  }
})

// POST /api/orders/sync — mevcut Trendyol sync ile (org credential DB'den
// enjekte edilir) çeker, normalize eder ve org bazında upsert eder. KISMİ/
// başarısız sync sipariş SİLMEZ/ARŞİVLEMEZ; arşivleme yalnız kanıtlı TAM
// sync'te (complete=true) reconcile ile yapılır.
app.post('/api/orders/sync', async (request, response) => {
  const context = await requireOrderPersistenceContext(request, response)
  if (!context) return
  const credentials = request.body?.credentials ?? {}
  const query = request.body?.query ?? {}
  let result
  try {
    result = await callTrendyolOrdersByStatuses(credentials, { size: 50, ...query })
  } catch {
    response.status(502).json({ ok: false, message: 'Trendyol sipariş senkronu başarısız.' })
    return
  }

  const complete = Boolean(result.ok) && result.debug?.syncStatus === 'COMPLETE'
  if (!result.ok) {
    // Başarısız çekim: mevcut siparişlere DOKUNMA (silme/arşivleme/ezme yok).
    await recordOnboardingSyncState(context.db, context.organizationId, {
      provider: 'trendyol',
      resource: 'orders',
      status: 'failed',
      errorCode: result.statusCode ? String(result.statusCode) : null,
    })
    response.status(502).json({
      ok: false,
      complete: false,
      message: `Trendyol sipariş senkronu başarısız: ${result.message}`,
      fetchedCount: 0,
      persistedCount: 0,
      updatedCount: 0,
      insertedCount: 0,
      failedCount: 0,
      syncBatchId: null,
    })
    return
  }

  try {
    const normalized = normalizeTrendyolOrders(result.data)
    const persistResult = await context.service.persistSyncResult(
      context.db,
      context.organizationId,
      normalized.orders,
      { complete, fetchedCount: normalized.orders.length },
    )
    response.json({
      ok: true,
      complete: persistResult.complete,
      fetchedCount: persistResult.fetchedCount,
      persistedCount: persistResult.persistedCount,
      updatedCount: persistResult.updatedCount,
      insertedCount: persistResult.insertedCount,
      failedCount: persistResult.failedCount,
      archivedCount: persistResult.archivedCount,
      syncBatchId: persistResult.syncBatchId,
    })
  } catch {
    response.status(500).json({ ok: false, message: 'Siparişler kaydedilemedi.' })
  }
})

// Dashboard SATIŞ analitiği için CAP'SİZ, read-only dönemsel sipariş
// kaynağı. Operational store'a yazmaz, Sürat/shipment işlemi yapmaz,
// persistOrders zinciriyle ilişkisi yoktur; yalnız istenen aralığın
// normalize edilmiş Trendyol sipariş/paket verisini döndürür. Kimlik
// bilgileri sunucudaki şifreli local-config'ten okunur.
const ANALYTICS_ORDER_STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'Delivered',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
  'AtCollectionPoint',
]

app.get('/api/analytics/orders', async (request, response) => {
  // Auth modda requireAuth (tenantAuth) gate'i geçilmiştir; legacy modda
  // local-trust guard'ı korunur.
  if (!isTenantAuthMode() && !isTrustedLocalConfigRequest(request)) {
    response.status(403).json({
      ok: false,
      message: 'Analitik verisi yalnızca bu bilgisayardan okunabilir.',
    })
    return
  }
  const startDate = Date.parse(String(request.query?.startDate ?? ''))
  const endDate = Date.parse(String(request.query?.endDate ?? ''))
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate) || startDate > endDate) {
    response.status(400).json({
      ok: false,
      message: 'Geçerli startDate/endDate (ISO) gerekli.',
    })
    return
  }
  try {
    const orgConfig = await getRequestIntegrationConfig(request)
    const credentials = orgConfig?.trendyol
    if (!credentials?.sellerId || !credentials?.apiKey || !credentials?.apiSecret) {
      response.status(422).json({
        ok: false,
        message:
          'Trendyol entegrasyonu yapılandırılmadan satış analitiği verisi çekilemez.',
      })
      return
    }
    // Trendyol orders API uzun aralıkları reddeder; pasif statüler sync
    // akışında pencerelenmediği için aralık BURADA aktif-statü penceresi
    // boyutunda dilimlenir ve sonuçlar paket kimliğiyle birleştirilir.
    // Analitik statü listesi zaten tamdır; sync'in unfiltered discovery
    // adımına gerek yoktur. Statü×pencere istekleri rate limite takılmasın
    // diye istekler aralıklı gönderilir, 429'da uzun beklemeyle tekrar
    // denenir.
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const windowContents = []
    let windowCursor = startDate
    while (windowCursor <= endDate) {
      const windowEnd = Math.min(
        endDate,
        windowCursor + TRENDYOL_ACTIVE_STATUS_WINDOW_MS,
      )
      for (const status of ANALYTICS_ORDER_STATUSES) {
        let result
        for (let attempt = 0; attempt <= 6; attempt += 1) {
          if (attempt > 0) {
            const rateLimited =
              Number(result?.statusCode) === 429 ||
              /rate limit/i.test(String(result?.message ?? ''))
            await wait(rateLimited ? 15000 : 1500 * attempt)
          }
          result = await callTrendyolOrdersAllPages(credentials, {
            status,
            startDate: windowCursor,
            endDate: windowEnd,
            size: 200,
          })
          if (result.ok) break
        }
        if (!result.ok) {
          response.json({
            ok: false,
            message: `Satış analitiği verisi alınamadı (${status}): ${result.message}`,
            statusCode: result.statusCode,
          })
          return
        }
        windowContents.push(getTrendyolOrderPackagesArray(result.data))
        await wait(500)
      }
      if (windowEnd === endDate) break
      windowCursor = windowEnd + 1
    }
    const combinedContent = mergeTrendyolPackageCollections(...windowContents)
    const normalized = normalizeTrendyolOrders({
      content: combinedContent,
      totalElements: combinedContent.length,
      totalPages: 1,
    })
    const orders = normalized.orders ?? []
    const packageCount = new Set(
      orders.map((order) =>
        String(
          order.packageId ??
            order.shipmentPackageId ??
            `${order.marketplace}::${order.orderNumber}`,
        ),
      ),
    ).size
    response.json({
      ok: true,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      totalElements: combinedContent.length,
      fetchedCount: orders.length,
      packageCount,
      orders,
    })
  } catch (error) {
    if (error?.code === CREDENTIAL_ENCRYPTION_MISSING) {
      response.status(503).json({
        ok: false,
        message: 'Credential şifreleme anahtarı (CREDENTIAL_ENCRYPTION_KEY) yapılandırılmamış.',
      })
      return
    }
    response.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Satış analitiği verisi alınamadı.',
    })
  }
})

// Dashboard SATIŞ analitiği için read-only iade (claims) veri yolu. Teslim
// sonrası kabul edilen iadeler orders API'de çoğunlukla Delivered kalır;
// bu endpoint claim event tarihine göre iadeleri döner. persistOrders,
// operational store veya Sürat çağrısı YAPMAZ.
app.get('/api/analytics/claims', async (request, response) => {
  if (!isTenantAuthMode() && !isTrustedLocalConfigRequest(request)) {
    response.status(403).json({
      ok: false,
      message: 'İade analitiği yalnızca bu bilgisayardan okunabilir.',
    })
    return
  }
  const startDate = Date.parse(String(request.query?.startDate ?? ''))
  const endDate = Date.parse(String(request.query?.endDate ?? ''))
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate) || startDate > endDate) {
    response.status(400).json({
      ok: false,
      message: 'Geçerli startDate/endDate (ISO) gerekli.',
    })
    return
  }
  try {
    const orgConfig = await getRequestIntegrationConfig(request)
    const credentials = orgConfig?.trendyol
    if (!credentials?.sellerId || !credentials?.apiKey || !credentials?.apiSecret) {
      response.status(422).json({
        ok: false,
        message:
          'Trendyol entegrasyonu yapılandırılmadan iade analitiği verisi çekilemez.',
      })
      return
    }
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const rawClaims = []
    let cursor = startDate
    while (cursor <= endDate) {
      const windowEnd = Math.min(endDate, cursor + TRENDYOL_CLAIMS_WINDOW_MS)
      const windowResult = await fetchTrendyolClaimsWindow(
        credentials,
        cursor,
        windowEnd,
        wait,
      )
      if (!windowResult.ok) {
        response.json({
          ok: false,
          message: `İade analitiği verisi alınamadı: ${windowResult.message}`,
          statusCode: windowResult.statusCode,
        })
        return
      }
      rawClaims.push(...windowResult.claims)
      if (windowEnd === endDate) break
      cursor = windowEnd + 1
      await wait(400)
    }
    const normalized = normalizeTrendyolClaims(rawClaims)
    response.json({
      ok: true,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      fetchedCount: normalized.claims.length,
      uniqueClaimCount: normalized.uniqueClaimCount,
      affectedPackageCount: normalized.affectedPackageCount,
      amountBasis: normalized.amountBasis,
      claims: normalized.claims,
    })
  } catch (error) {
    response.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'İade analitiği verisi alınamadı.',
    })
  }
})

app.post('/api/trendyol/products/fetch', handleTrendyolProductsFetch)
app.post('/api/integrations/trendyol/products', handleTrendyolProductsFetch)

// AUTH modu ürün kataloğu persistence API'si. Kaynak-of-truth PostgreSQL; her
// organization YALNIZ kendi ürünlerini görür (org req.auth'tan; query/body'den
// ASLA). Legacy modda (DATABASE_URL yok) bu route'lar 404 döner; frontend legacy
// akışı IndexedDB/localStorage'da kalır ve buraya çağrı yapmaz.
// Onboarding sync metadata kaydı (best-effort). Sync akışını BOZMAZ: hata
// olursa sessizce yutulur. Dashboard analytics sync'leri buraya YAZILMAZ.
async function recordOnboardingSyncState(db, organizationId, entry) {
  try {
    const { recordSyncState } = await import('./onboarding/onboardingRepository.ts')
    await recordSyncState(db, organizationId, entry)
  } catch {
    // metadata kaydı best-effort; sync sonucunu etkilemez
  }
}

async function requireProductPersistenceContext(request, response) {
  if (!isTenantAuthMode() || !request.auth?.organizationId) {
    response.status(404).json({ ok: false, message: 'Ürün persistence yalnız auth modda kullanılabilir.' })
    return null
  }
  try {
    const [{ getDb }, service] = await Promise.all([
      import('./db/client.ts'),
      import('./products/productPersistenceService.ts'),
    ])
    return { db: getDb(), service, organizationId: request.auth.organizationId }
  } catch {
    response.status(503).json({
      ok: false,
      message: 'Ürün persistence katmanı yüklenemedi; PostgreSQL yapılandırmasını kontrol edin.',
    })
    return null
  }
}

// GET /api/products — org-scoped, server-side sayfalı düz varyant listesi.
app.get('/api/products', async (request, response) => {
  const context = await requireProductPersistenceContext(request, response)
  if (!context) return
  try {
    const query = request.query ?? {}
    const archivedParam = strOrUndef(query.archived)
    const result = await context.service.listProducts(context.db, context.organizationId, {
      search: strOrUndef(query.search),
      barcode: strOrUndef(query.barcode),
      merchantSku: strOrUndef(query.merchantSku),
      archived:
        archivedParam === undefined
          ? undefined
          : archivedParam === 'true' || archivedParam === '1',
      page: query.page,
      pageSize: query.pageSize,
      sort:
        query.sort === 'titleDesc' || query.sort === 'recent'
          ? query.sort
          : 'titleAsc',
    })
    response.json({
      ok: true,
      products: result.products,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    })
  } catch {
    response.status(500).json({ ok: false, message: 'Ürünler yüklenemedi.' })
  }
})

// GET /api/products/:id — org-scoped tekil ürün (düz view-model id = varyant id).
// Başka org'un ürünü (veya yok) 404 döner.
app.get('/api/products/:id', async (request, response) => {
  const context = await requireProductPersistenceContext(request, response)
  if (!context) return
  try {
    const product = await context.service.getProduct(
      context.db,
      context.organizationId,
      String(request.params.id),
    )
    if (!product) {
      response.status(404).json({ ok: false, message: 'Ürün bulunamadı.' })
      return
    }
    response.json({ ok: true, product })
  } catch {
    response.status(500).json({ ok: false, message: 'Ürün yüklenemedi.' })
  }
})

// POST /api/products/sync — mevcut Trendyol ürün sync altyapısıyla (org credential
// DB'den enjekte edilir) çeker, normalize eder ve org bazında upsert eder.
// KISMİ/başarısız sync ürün SİLMEZ/ARŞİVLEMEZ; arşivleme yalnız kanıtlı TAM
// sync'te (complete=true) reconcile ile yapılır.
app.post('/api/products/sync', async (request, response) => {
  const context = await requireProductPersistenceContext(request, response)
  if (!context) return
  const credentials = request.body?.credentials ?? {}
  let result
  try {
    result = await callTrendyolProducts(credentials)
  } catch {
    response.status(502).json({ ok: false, message: 'Trendyol ürün senkronu başarısız.' })
    return
  }

  if (!result.ok) {
    // Başarısız çekim: mevcut kataloğa DOKUNMA (silme/arşivleme/ezme yok).
    await recordOnboardingSyncState(context.db, context.organizationId, {
      provider: 'trendyol',
      resource: 'products',
      status: 'failed',
      errorCode: result.statusCode ? String(result.statusCode) : null,
    })
    response.status(502).json({
      ok: false,
      complete: false,
      message: `Trendyol ürün senkronu başarısız: ${result.message}`,
      fetchedProductCount: 0,
      fetchedVariantCount: 0,
      insertedProducts: 0,
      updatedProducts: 0,
      insertedVariants: 0,
      updatedVariants: 0,
      failedCount: 0,
      syncBatchId: null,
    })
    return
  }

  try {
    const products = normalizeTrendyolProducts(result.data)
    const expectedTotal = Number(result.debug?.expectedTotal ?? products.length)
    const normalizedRatio =
      expectedTotal > 0
        ? products.length / expectedTotal
        : products.length === 0
          ? 1
          : 0
    // Tam sync kararı mevcut ürün fetch'iyle aynı eşik (%99) üzerinden verilir.
    const complete = result.debug?.status === 'COMPLETE' && normalizedRatio >= 0.99
    const persistResult = await context.service.persistProductSyncResult(
      context.db,
      context.organizationId,
      products,
      { complete },
    )
    await recordOnboardingSyncState(context.db, context.organizationId, {
      provider: 'trendyol',
      resource: 'products',
      status: complete ? 'success' : 'partial',
      fetchedCount: persistResult.fetchedVariantCount,
    })
    response.json({
      ok: true,
      complete: persistResult.complete,
      fetchedProductCount: persistResult.fetchedProductCount,
      fetchedVariantCount: persistResult.fetchedVariantCount,
      insertedProducts: persistResult.insertedProducts,
      updatedProducts: persistResult.updatedProducts,
      insertedVariants: persistResult.insertedVariants,
      updatedVariants: persistResult.updatedVariants,
      failedCount: persistResult.failedCount,
      archivedCount: persistResult.archivedCount,
      syncBatchId: persistResult.syncBatchId,
    })
  } catch {
    response.status(500).json({ ok: false, message: 'Ürünler kaydedilemedi.' })
  }
})

// AUTH modu onboarding (organization kurulum) API'si. Durum GERÇEK DB
// kayıtlarından türetilir; secret/credential DÖNMEZ. org yalnız req.auth'tan.
// Legacy modda (DATABASE_URL yok) bu route'lar 404 döner.
async function requireOnboardingContext(request, response) {
  if (!isTenantAuthMode() || !request.auth?.organizationId) {
    response.status(404).json({ ok: false, message: 'Onboarding yalnız auth modda kullanılabilir.' })
    return null
  }
  try {
    const [{ getDb }, service] = await Promise.all([
      import('./db/client.ts'),
      import('./onboarding/onboardingService.ts'),
    ])
    return { db: getDb(), service, organizationId: request.auth.organizationId }
  } catch {
    response.status(503).json({
      ok: false,
      message: 'Onboarding katmanı yüklenemedi; PostgreSQL yapılandırmasını kontrol edin.',
    })
    return null
  }
}

// GET /api/onboarding/status — org-scoped kurulum durumu (DB'den türetilir).
app.get('/api/onboarding/status', async (request, response) => {
  const context = await requireOnboardingContext(request, response)
  if (!context) return
  try {
    const status = await context.service.deriveOnboardingStatus(
      context.db,
      context.organizationId,
    )
    response.json({ ok: true, ...status })
  } catch {
    response.status(500).json({ ok: false, message: 'Onboarding durumu okunamadı.' })
  }
})

// POST /api/onboarding/complete — koşullar sağlanmıyorsa 409 + eksik adımlar;
// sağlanıyorsa onboardingCompleted=true. Sürat create çağrısı YAPILMAZ.
app.post('/api/onboarding/complete', async (request, response) => {
  const context = await requireOnboardingContext(request, response)
  if (!context) return
  try {
    const result = await context.service.completeOnboarding(
      context.db,
      context.organizationId,
    )
    if (!result.ok) {
      response.status(409).json({
        ok: false,
        message: 'Onboarding tamamlanamadı; eksik adımlar var.',
        missing: result.missing,
        ...result.status,
      })
      return
    }
    response.json({ ok: true, ...result.status })
  } catch {
    response.status(500).json({ ok: false, message: 'Onboarding tamamlanamadı.' })
  }
})

async function handleTrendyolOrdersFetch(request, response) {
  const credentials = request.body?.credentials ?? {}
  const query = request.body?.query ?? {}
  const result = await callTrendyolOrdersByStatuses(credentials, {
    size: 20,
    ...query,
  })

  if (result.ok) {
    const normalized = normalizeTrendyolOrders(result.data)
    response.json({
      ok: true,
      source: 'real',
      message: 'Trendyol siparişleri gerçek API üzerinden alındı.',
      orders: normalized.orders,
      debug: {
        ...normalized.debug,
        syncStatus: 'COMPLETE',
        fetchDebug: result.debug,
        statusRequests: result.debug?.statusRequests,
        pageRequests: result.debug?.pageRequests,
      },
      totalPages: result.data?.totalPages,
      hasNextPage:
        typeof result.data?.totalPages === 'number'
          ? Number(query.page ?? 0) + 1 < result.data.totalPages
          : false,
      rawPreview: preview(result.debug ?? result.data),
    })
    return
  }

  response.json({
    ok: false,
    source: result.source ?? 'real',
    message: `Gerçek API başarısız: ${result.message}`,
    orders: [],
    statusCode: result.statusCode,
    error: result.message,
    debug: result.debug,
    rawPreview: preview(result.debug ?? result.data),
  })
}

async function handleTrendyolProductsFetch(request, response) {
  const credentials = request.body?.credentials ?? {}
  const result = await callTrendyolProducts(credentials)

  if (result.ok) {
    const products = normalizeTrendyolProducts(result.data)
    const expectedTotal = Number(result.debug?.expectedTotal ?? products.length)
    const normalizedRatio =
      expectedTotal > 0
        ? products.length / expectedTotal
        : products.length === 0
          ? 1
          : 0
    const normalizedComplete =
      result.debug?.status === 'COMPLETE' && normalizedRatio >= 0.99
    const debug = {
      ...result.debug,
      backendBuildRevision: BUILD_REVISION,
      normalizedProductsCount: products.length,
      uniqueBarcodeCount: countUniqueProductField(products, 'barcode'),
      uniqueProductContentIdCount: countUniqueProductField(
        products,
        'productContentId',
      ),
      uniqueProductMainIdCount: countUniqueProductField(
        products,
        'productMainId',
      ),
      uniqueExternalVariantIdCount: countUniqueProductField(
        products,
        'externalVariantId',
      ),
      uniqueVariantCount: countUniqueProductVariants(products),
      completenessRatio: Math.min(
        Number(result.debug?.completenessRatio ?? 1),
        normalizedRatio,
      ),
      status: normalizedComplete ? 'COMPLETE' : 'PARTIAL',
      targetTraces: [
        ...(result.debug?.targetTraces ?? []),
        ...traceProductCatalogTargets('normalized', products),
      ],
    }
    if (!normalizedComplete) {
      response.status(502).json({
        ok: false,
        source: 'real',
        message:
          'Trendyol ürün kataloğu normalize edilirken eksik kaldı. Kısmi katalog ana cache olarak kaydedilmedi.',
        products: [],
        statusCode: 502,
        debug,
        rawPreview: preview(debug),
      })
      return
    }
    response.json({
      ok: true,
      source: 'real',
      message: 'Trendyol ürünleri gerçek API üzerinden alındı.',
      products,
      debug,
      rawPreview: preview(result.debug ?? result.data),
    })
    return
  }

  response.json({
    ok: false,
    source: result.source ?? 'real',
    message: `Gerçek API başarısız: ${result.message}`,
    products: [],
    statusCode: result.statusCode,
    error: result.message,
    debug: result.debug,
    rawPreview: preview(result.debug ?? result.data),
  })
}

app.post('/api/integrations/surat/save', (request, response) => {
  response.json({
    ok: true,
    source: 'local',
    message: 'Sürat bağlantı bilgileri kaydedildi.',
    received: redact(request.body),
  })
})

app.post('/api/integrations/surat/test', async (request, response) => {
  const config = normalizeSuratConfig(request.body?.config)
  const validation = validateSuratSoapCredentials(config)

  if (validation) {
    response.json(validation)
    return
  }

  const webPasswordInfo = resolveSuratWebPassword(config)
  if (!webPasswordInfo.value) {
    response.json({
      provider: 'surat-kargo',
      ok: false,
      source: 'real',
      message:
        'Sürat bağlantı testi için e-Sürat WebPassword / sorgulama şifresi gerekli.',
      checkedAt: new Date().toISOString(),
    })
    return
  }

  const today = new Date()
  const yesterday = new Date(Date.now() - 1000 * 60 * 60 * 24)
  const soap = await callSuratSoap(
    'CariKoduveSifre',
    `
      <GonderenCariKodu>${xmlEscape(config.kullaniciAdi)}</GonderenCariKodu>
      <WebPassword>${xmlEscape(webPasswordInfo.value)}</WebPassword>
      <BasTar>${formatSoapDate(yesterday)}</BasTar>
      <BitTar>${formatSoapDate(today)}</BitTar>
      <IsWebSiparisKoduOlsun>true</IsWebSiparisKoduOlsun>
    `,
  )
  const message = extractTag(soap.text, 'Mesaj')
  const authError = isSuratAuthError(message)

  response.json({
    provider: 'surat-kargo',
    ok: soap.ok && !authError,
    source: 'real',
    message: authError
      ? message
      : message
        ? `Sürat servisi yanıt verdi: ${message}`
        : 'Sürat SOAP servisi yanıt verdi. Cari kodu ve şifre isteği kabul edildi.',
    checkedAt: new Date().toISOString(),
    statusCode: soap.statusCode,
    rawPreview: {
      operation: 'CariKoduveSifre',
      endpoint: SURAT_SOAP_URL,
      message,
      bodyPreview: soap.text.slice(0, 1200),
    },
  })
})

app.post('/api/shipments/surat', createSuratShipment)
app.post('/api/shipments/surat/create', createSuratShipment)
app.post('/api/shipments/surat/label', createSuratLabelForRegisteredShipment)

app.post('/api/diagnostics/surat/common-barcode-loop', (request, response) => {
  const order = request.body?.order ?? {}
  const config = normalizeSuratConfig(
    request.body?.config?.surat ?? request.body?.config ?? {},
  )
  response.json(buildSuratCommonBarcodeLoopDiagnostic({
    order,
    config,
    lastResponse: request.body?.lastResponse,
  }))
})

app.post('/api/shipments/surat/track', async (request, response) => {
  const config = normalizeSuratConfig(request.body?.config)
  const queryReference = resolveSuratTrackingQueryReference(request.body)
  const validation = validateSuratSoapCredentials(config)

  if (validation) {
    response.json(validation)
    return
  }

  if (!queryReference.ok) {
    response.status(400).json({
      ok: false,
      source: 'real',
      errorCode: 'SURAT_TRACKING_REFERENCE_INVALID',
      message: queryReference.message,
      acceptedReferenceType: 'WEB_SIPARIS_KODU',
      rejectedReferenceType: queryReference.type,
      ignoredLegacyFields: queryReference.ignoredLegacyFields,
    })
    return
  }

  const webSiparisKodu = queryReference.value
  const trackingRequestBody = {
    ...request.body,
    webSiparisKodu,
    queryReference,
  }
  const result =
    config.trackingServiceType === 'KargoTakipHareketDetayiRest'
      ? await trackShipmentRest(config, webSiparisKodu, trackingRequestBody)
      : await trackShipmentSoap(config, webSiparisKodu, trackingRequestBody)
  result.trackingReference = webSiparisKodu
  result.trackingReferenceType = queryReference.type
  result.trackingReferenceSource = queryReference.source
  result.trackingAttempts = [
    buildTrackingAttemptDebug(webSiparisKodu, result, queryReference),
  ]
  // KargoTakipHareketDetayi anlık tutarsız dönebiliyor ve çoğu zaman BarkodNo
  // içermiyor; kayıtlı gönderi doğrulaması WebSiparisKodu DataSet yüzeyiyle
  // tamamlanır (17.07.2026 canlı bulgusu).
  if (String(request.body?.orderId ?? '').trim()) {
    try {
      const registrationLookup = await callSuratWebSiparisKodu(
        config,
        webSiparisKodu,
        {
          orderId: request.body?.orderId,
          shipmentId: firstNonEmpty(
            request.body?.shipmentId,
            request.body?.packageId,
          ),
        },
      )
      if (
        registrationLookup?.rowCount > 0 &&
        registrationLookup?.referenceMatches
      ) {
        result.registrationLookup = {
          rowCount: registrationLookup.rowCount,
          KargoTakipNo: registrationLookup.KargoTakipNo || '',
          BarkodNo: registrationLookup.BarkodNo || '',
        }
        result.registrationRowFound = true
        result.KargoTakipNo = firstNonEmpty(
          result.KargoTakipNo,
          registrationLookup.KargoTakipNo,
        )
        result.BarkodNo = firstNonEmpty(
          result.BarkodNo,
          registrationLookup.BarkodNo,
        )
      }
    } catch {
      // Salt-okunur tamamlayıcı sorgu başarısızlığı takip yanıtını bozmaz.
    }
  }
  result.verificationPersistence =
    await persistSuratTrackingVerification(trackingRequestBody, result)
  response.json(result)
})

app.post('/api/labels/zpl/generate', (request, response) => {
  response.json({
    ok: true,
    source: 'local',
    message: 'ZPL frontend ZebraZplLabelProvider tarafından üretiliyor.',
    received: redact(request.body),
  })
})

app.post('/api/labels/zpl/bulk-generate', (request, response) => {
  response.json({
    ok: true,
    source: 'local',
    message: 'Toplu ZPL frontend BrowserDownloadPrintProvider tarafından üretiliyor.',
    received: redact(request.body),
  })
})

app.post('/api/printing/zebra/raw', async (request, response) => {
  const printerName = String(request.body?.printerName ?? '').trim()
  const labels = Array.isArray(request.body?.labels) ? request.body.labels : []

  if (!printerName || labels.length === 0) {
    response.status(400).json({
      ok: false,
      provider: 'windows-raw-printer',
      message: 'printerName ve en az bir ZPL etiketi gereklidir.',
    })
    return
  }

  const jobs = []
  for (const label of labels) {
    const orderNumber = String(label?.orderNumber ?? '').trim()
    const zpl = normalizeSuratRawZpl(label?.zpl)
    if (!zpl) {
      jobs.push({
        orderNumber,
        ok: false,
        errorMessage: 'Geçerli ^XA...^XZ BarcodeRaw ZPL bulunamadı.',
      })
      continue
    }

    try {
      const documentId = randomUUID()
      const result = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(serverDirectory, 'print-raw-zpl.ps1'),
          '-PrinterName',
          printerName,
          '-ZplBase64',
          Buffer.from(zpl, 'utf8').toString('base64'),
          '-DocumentName',
          `CargoFlow-${orderNumber || documentId}`,
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      )
      const printJobId = String(result.stdout ?? '').trim() || documentId
      jobs.push({ orderNumber, ok: true, printJobId })
    } catch (error) {
      jobs.push({
        orderNumber,
        ok: false,
        errorMessage:
          error instanceof Error ? error.message : 'Windows yazıcı hatası',
      })
    }
  }

  const failedJobs = jobs.filter((job) => !job.ok)
  response.status(failedJobs.length === 0 ? 200 : 500).json({
    ok: failedJobs.length === 0,
    provider: 'windows-raw-printer',
    printerName,
    printJobId:
      jobs.length === 1 ? jobs[0]?.printJobId : randomUUID(),
    jobs,
    message:
      failedJobs.length === 0
        ? `${jobs.length} ZPL etiketi Windows yazıcı kuyruğuna gönderildi.`
        : `${failedJobs.length} etiket Zebra yazıcıya gönderilemedi.`,
  })
})

// Bilinmeyen /api/* istekleri SPA fallback'e DÜŞMEZ; 404 JSON döner. Tüm
// gerçek /api route'ları yukarıda tanımlıdır; buraya yalnız eşleşmeyen API
// yolları düşer.
app.use('/api', (_request, response) => {
  response.status(404).json({ ok: false, message: 'API endpoint bulunamadı.' })
})

// Production'da (Railway) Express, Vite `dist` build çıktısını sunar:
//  - statik asset'ler dist'ten (doğru MIME + ETag/Last-Modified cache),
//  - bilinmeyen frontend GET route'ları SPA girişine (dist/index.html) düşer.
// Local geliştirmede (Vite dev server ayrı) bu blok devreye girmez.
const distPath = join(serverDirectory, '..', 'dist')
const indexHtmlPath = join(distPath, 'index.html')
if (process.env.NODE_ENV === 'production' && existsSync(indexHtmlPath)) {
  // Hash'li asset'ler ETag/Last-Modified ile doğru MIME'de sunulur (revalidate).
  app.use(express.static(distPath, { index: false }))
  // SPA fallback: yalnız GET; /api yukarıda 404 ile tüketildiğinden buraya
  // API isteği düşmez. index.html revalidate edilir (yeni build hemen görünür).
  app.use((request, response, next) => {
    if (request.method !== 'GET') {
      next()
      return
    }
    response.sendFile(indexHtmlPath, {
      headers: { 'Cache-Control': 'no-cache' },
    })
  })
}

app.use((error, _request, response, _next) => {
  response.status(500).json({
    ok: false,
    source: 'real',
    message: error instanceof Error ? error.message : 'Bilinmeyen API hatası',
  })
})

// Production başlangıç güvenlik uyarısı: zorunlu env'ler eksikse AÇIKÇA (yalnız
// isimlerle; DEĞER LOGLANMAZ) uyarır. Uygulama healthcheck için ayakta kalır;
// tenant/auth özellikleri DATABASE_URL olmadan zaten 503/legacy davranır.
function warnMissingProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return
  const required = [
    'DATABASE_URL',
    'CREDENTIAL_ENCRYPTION_KEY',
    'SHIPMENT_ENCRYPTION_KEY',
    'ORDER_DATA_ENCRYPTION_KEY',
    'PRODUCT_DATA_ENCRYPTION_KEY',
  ]
  const missing = required.filter((name) => !String(process.env[name] ?? '').trim())
  if (missing.length > 0) {
    console.warn(
      `[startup] Production için eksik zorunlu env değişkenleri: ${missing.join(', ')}. ` +
        'Bunlar ayarlanmadan çok kiracılı auth/persistence devre dışıdır (secret DEĞERLERİ loglanmaz).',
    )
  }
}
warnMissingProductionSecrets()

app.listen(port, host, () => {
  console.log(`CargoFlow API listening on http://${host}:${port}`)
})

async function createSuratShipment(request, response) {
  const order = request.body?.order
  const normalizedConfig = normalizeSuratConfig(
    request.body?.config?.surat ?? request.body?.config,
  )

  if (!order?.orderNumber) {
    await createSuratShipmentCore(request, response)
    return
  }

  const selectedConfig = resolveSuratCredentialSet(
    normalizedConfig,
    order,
  ).config
  const operation = buildSuratCreateOperationContext(request, selectedConfig)
  const inFlight = suratCreateLocks.get(operation.idempotencyKey)
  if (inFlight) {
    const result = await inFlight
    response.json(withSuratIdempotencyDebug(result, operation, {
      reusedInFlight: true,
      carrierCreateCalled: false,
    }))
    return
  }

  const operationPromise = executeIdempotentSuratCreate(
    request,
    operation,
  )
  suratCreateLocks.set(operation.idempotencyKey, operationPromise)
  try {
    response.json(await operationPromise)
  } finally {
    suratCreateLocks.delete(operation.idempotencyKey)
  }
}

async function createSuratShipmentCore(request, response) {
  const order = request.body?.order
  const fullConfig = request.body?.config ?? {}
  const baseConfig = normalizeSuratConfig(
    request.body?.config?.surat ?? request.body?.config,
  )
  const credentialSelection = resolveSuratCredentialSet(baseConfig, order)
  const config = credentialSelection.config
  const trendyolConfig = fullConfig?.trendyol

  if (!order?.orderNumber) {
    response.json({
      ok: false,
      source: 'real',
      message: 'Sürat gönderisi için sipariş bilgisi eksik.',
    })
    return
  }

  const validation =
    config.serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL'
      ? validateSuratRestCredentials(config, order)
      : config.serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP'
        ? validateSuratBarcodeOrderCredentials(config)
      : validateSuratSoapCredentials(config)

  if (validation) {
    response.json(validation)
    return
  }

  if (
    String(order.marketplace ?? 'Trendyol').toLocaleLowerCase('tr-TR') ===
      'trendyol' &&
    !String(order.cargoTrackingNumber ?? '').trim()
  ) {
    response.json({
      ok: false,
      source: 'real',
      errorSource: 'Trendyol',
      message:
        'Trendyol cargoTrackingNumber bulunamadı. Sürat pazaryeri gönderisi oluşturulamaz.',
    })
    return
  }

  const reference = makeShipmentReference(order)
  let orderForSurat = order
  let trendyolPreflight = buildTrendyolShipmentPreflight(orderForSurat)
  if (trendyolPreflight.requiresPickingUpdate) {
    const pickingUpdate = await ensureTrendyolPickingBeforeSurat(
      trendyolConfig,
      orderForSurat,
      trendyolPreflight,
    )
    if (!pickingUpdate.ok) {
      response.json(
        buildTrendyolPickingUpdateBlockedResponse({
          config,
          order: orderForSurat,
          reference,
          preflight: {
            ...trendyolPreflight,
            pickingUpdate,
          },
          pickingUpdate,
        }),
      )
      return
    }
    orderForSurat = {
      ...orderForSurat,
      marketplaceStatus: 'Picking',
      packageStatus: 'Picking',
      trendyolPickingUpdate: pickingUpdate,
    }
    trendyolPreflight = {
      ...buildTrendyolShipmentPreflight(orderForSurat),
      pickingUpdate,
      requiresPickingUpdate: false,
      pickingUpdatePerformed: true,
      reason: 'Trendyol paketi Picking statüsüne alındı; Sürat isteği başlatılabilir.',
    }
  }
  if (!trendyolPreflight.canCallSurat) {
    response.json(
      buildTrendyolPreflightBlockedResponse({
        config,
        order: orderForSurat,
        reference,
        preflight: trendyolPreflight,
      }),
    )
    return
  }

  if (config.serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP') {
    const barcodeOrderResult = await createSuratBarcodeOrderSoap(
      config,
      orderForSurat,
      reference,
    )
    response.json(barcodeOrderResult)
    return
  }

  if (config.serviceMode === 'ORTAK_BARKOD_SOAP') {
    const labelOnlyChain =
      config.serviceType === 'OrtakBarkodOlusturSoap' ||
      String(config.createShipmentPath || '').endsWith('/OrtakBarkodOlustur')
    const commonBarcodeResult = labelOnlyChain
      ? await createSuratRegisteredCommonBarcode(
          config,
          orderForSurat,
          reference,
        )
      : await createSuratCommonBarcodeSoap(
          config,
          orderForSurat,
          reference,
        )
    response.json(commonBarcodeResult)
    return
  }

  if (config.serviceMode === 'PRE_REGISTRATION_REST') {
    const legacyRestResult = await createSuratLegacyRestJson(
      config,
      orderForSurat,
      reference,
    )
    response.json(
      legacyRestResult.shipment?.verifiedShipment ||
        legacyRestResult.shipment?.lifecycleStatus ===
          'SURAT_DISPATCH_REJECTED'
        ? legacyRestResult
        : {
            ...legacyRestResult,
            ok: false,
            errorSource: 'Sürat',
            message: SURAT_INVALID_CODES_MESSAGE,
          },
    )
    return
  }

  if (config.serviceMode === 'GONDERI_YENI_SOAP') {
    const gonderiYeniResult = await createSuratGonderiyiKargoyaGonderYeniSoap(
      config,
      orderForSurat,
      reference,
    )
    response.json(gonderiYeniResult)
    return
  }

  if (config.serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL') {
    const restResult = await createSuratRestShipment(config, orderForSurat, reference)
    response.json(restResult)
    return
  }

  response.json({
    ok: false,
    source: 'real',
    errorSource: 'Frontend',
    message: `Desteklenmeyen Sürat create servis modu: ${config.serviceMode}`,
  })
}

async function createSuratLabelForRegisteredShipment(request, response) {
  const order = request.body?.order
  const fullConfig = request.body?.config ?? {}
  const baseConfig = normalizeSuratConfig(
    request.body?.config?.surat ?? request.body?.config,
  )
  const config = resolveSuratCredentialSet(baseConfig, order).config
  const validation = validateSuratSoapCredentials(config)
  if (validation) {
    response.json(validation)
    return
  }
  if (!order?.orderNumber || !order?.id || !order?.cargoTrackingNumber) {
    response.status(400).json({
      ok: false,
      source: 'real',
      errorCode: 'SURAT_LABEL_REQUEST_INCOMPLETE',
      message:
        'Etiket ikinci aşaması için sipariş kimliği, sipariş no ve OzelKargoTakipNo eksiksiz olmalıdır.',
    })
    return
  }

  const operationContext = buildSuratCreateOperationContext(
    {
      ...request,
      body: {
        ...request.body,
        config: fullConfig,
      },
    },
    config,
  )
  const createRecord = await readSuratCreateOperation(
    operationContext.idempotencyKey,
    operationContext.organizationId,
  )
  if (
    !createRecord ||
    Number(createRecord.createCallCount || 0) !== 1 ||
    createRecord.operation === 'OrtakBarkodOlustur'
  ) {
    response.json({
      ok: false,
      source: 'real',
      errorCode: 'SURAT_REGISTERED_CREATE_REQUIRED',
      message:
        'Etiket oluşturulmadı. Önce aynı sipariş için tek gerçek shipment create ve read-only kayıt teyidi gerekir.',
    })
    return
  }

  const labelLockKey = `${operationContext.idempotencyKey}:LABEL`
  if (suratCreateLocks.has(labelLockKey)) {
    response.json({
      ok: false,
      source: 'real',
      errorCode: 'SURAT_LABEL_ALREADY_IN_PROGRESS',
      message: 'Bu siparişin Sürat etiket operasyonu zaten çalışıyor.',
    })
    return
  }
  if (Number(createRecord.labelCallCount || 0) > 0) {
    response.json({
      ok: false,
      source: 'real',
      errorCode: 'SURAT_LABEL_IDEMPOTENCY_BLOCKED',
      message:
        'Bu siparişte label operation daha önce çağrıldı; mükerrer etiket çağrısı yapılmadı.',
      labelCallCount: Number(createRecord.labelCallCount || 0),
    })
    return
  }

  const labelPromise = executeRegisteredSuratLabel({
    config,
    order,
    operationContext,
    createRecord,
  })
  suratCreateLocks.set(labelLockKey, labelPromise)
  try {
    response.json(await labelPromise)
  } finally {
    suratCreateLocks.delete(labelLockKey)
  }
}

async function executeRegisteredSuratLabel({
  config,
  order,
  operationContext,
  createRecord,
}) {
  const webSiparisKodu = String(order.cargoTrackingNumber).trim()
  const registration = await callSuratWebSiparisKodu(
    config,
    webSiparisKodu,
    { orderId: order.id, shipmentId: makeShipmentReference(order) },
  )
  if (!(registration.rowCount > 0 && registration.referenceMatches)) {
    return {
      ok: false,
      source: 'real',
      errorCode: 'SURAT_SHIPMENT_NOT_REGISTERED_FOR_LABEL',
      message:
        'Sürat shipment kaydı WebSiparisKodu servisinde bulunmadı; label operation çağrılmadı.',
      shipmentRegistered: false,
      labelCallCount: Number(createRecord.labelCallCount || 0),
    }
  }

  try {
    buildSuratShipmentPayload(order, makeShipmentReference(order), {
      commonBarcode: true,
    })
  } catch (error) {
    return {
      ok: false,
      source: 'real',
      errorCode: 'SURAT_LABEL_REQUEST_INVALID',
      message:
        error instanceof Error
          ? error.message
          : 'Etiket isteği taşıyıcıya gönderilmeden geçersiz bulundu.',
      carrierLabelCalled: false,
      labelCallCount: Number(createRecord.labelCallCount || 0),
    }
  }

  const startedAt = new Date().toISOString()
  await queueSuratCreateStoreUpdate((store) => {
    const record = store.operations[operationContext.idempotencyKey]
    if (!record) return
    record.labelCallCount = 1
    record.labelOperation = 'OrtakBarkodOlustur'
    record.labelStartedAt = startedAt
    record.updatedAt = startedAt
    record.verificationStatus = 'SHIPMENT_REGISTERED_LABEL_REQUIRED'
    record.carrierTrackingNumber = registration.KargoTakipNo || ''
    record.carrierBarcodeNumber = registration.BarkodNo || ''
  })

  const result = await createSuratCommonBarcodeSoap(
    config,
    order,
    makeShipmentReference(order),
    {
      operationName: 'OrtakBarkodOlustur',
      serviceType: 'OrtakBarkodOlusturSoap',
      strictGonderiModel: true,
    },
  )
  const verified = isSerendipVerifiedCreateResult(result)
  const completedAt = new Date().toISOString()
  const labelZplReference = buildSafeZplReference(result)
  await queueSuratCreateStoreUpdate((store) => {
    const record = store.operations[operationContext.idempotencyKey]
    if (!record) return
    record.labelCompletedAt = completedAt
    record.labelVerificationStatus = verified ? 'VERIFIED' : 'UNVERIFIED'
    record.updatedAt = completedAt
    if (labelZplReference.zpl) {
      record.technicalZpl = labelZplReference.zpl
      record.technicalZplSha256 = labelZplReference.sha256
      record.technicalZplLength = labelZplReference.length
    }
    if (verified) {
      record.status = 'SUCCESS'
      record.verificationStatus = 'VERIFIED'
      record.carrierTrackingNumber = firstNonEmpty(
        result.shipment?.tNo,
        result.shipment?.trackingNumber,
      )
      record.carrierBarcodeNumber = firstNonEmpty(
        result.shipment?.barkodNo,
        result.shipment?.barcode,
      )
    }
  })
  return {
    ...result,
    labelIdempotency: {
      operation: 'OrtakBarkodOlustur',
      labelCallCount: 1,
      shipmentCreateCallCount: Number(createRecord.createCallCount || 0),
      shipmentCreateRepeated: false,
    },
  }
}

function buildSuratCreateOperationContext(request, config) {
  const order = request.body?.order ?? {}
  const fullConfig = request.body?.config ?? {}
  const desi = Number(order.desi ?? 0)
  const desiSource =
    desi > 0 &&
    ['manual', 'MANUAL_USER_CONFIRMED'].includes(
      String(order.desiSource ?? '').trim(),
    )
      ? 'MANUAL_USER_CONFIRMED'
      : String(order.desiSource ?? '').trim()
  // Auth modda idempotency SCOPE'u YALNIZ session organizationId'dir;
  // frontend tenantId/sellerId/kullaniciAdi fallback'i kullanılmaz. Legacy
  // modda mevcut anahtar davranışı aynen korunur.
  const authOrganizationId =
    isTenantAuthMode() && request.auth?.organizationId
      ? String(request.auth.organizationId)
      : null
  const tenantSeed = firstNonEmpty(
    request.body?.tenantId,
    fullConfig?.trendyol?.sellerId,
    config.kullaniciAdi,
    'local',
  )
  const tenantId = authOrganizationId
    ? `org_${authOrganizationId}`
    : `tenant_${shortHash(tenantSeed)}`
  const orderId = String(order.id ?? order.orderNumber ?? '').trim()
  const fingerprintPayload = {
    tenantId,
    orderId,
    orderNumber: String(order.orderNumber ?? ''),
    packageId: String(order.packageId ?? order.shipmentPackageId ?? ''),
    cargoTrackingNumber: String(order.cargoTrackingNumber ?? ''),
    desi,
    desiSource,
    serviceMode: config.serviceMode,
    environment: config.ortam,
  }
  return {
    tenantId,
    // Auth modda PG persistence için organization + kimlik alanları.
    organizationId: authOrganizationId,
    marketplace: String(order.marketplace ?? 'Trendyol'),
    packageId: String(order.packageId ?? order.shipmentPackageId ?? ''),
    orderNumber: String(order.orderNumber ?? ''),
    provider: 'surat',
    orderId,
    idempotencyKey: `SURAT:${tenantId}:${orderId}:CREATE`,
    requestFingerprint: createHash('sha256')
      .update(JSON.stringify(fingerprintPayload))
      .digest('hex'),
    correlationId: randomUUID(),
    environment: config.ortam,
    operation: resolveSuratCreateOperationName(config),
    maskedAccount: maskCarrierAccount(config.kullaniciAdi),
    desi,
    desiSource,
    maxCreateCalls: 1,
  }
}

function resolveSuratCreateOperationName(configOrServiceMode) {
  const config =
    typeof configOrServiceMode === 'string'
      ? { serviceMode: configOrServiceMode }
      : configOrServiceMode || {}
  const serviceMode = config.serviceMode
  if (serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP') {
    return 'KargoBarkoduSiparis'
  }
  if (serviceMode === 'ORTAK_BARKOD_SOAP') {
    if (
      config.serviceType === 'OrtakBarkodOlusturSoap' ||
      String(config.createShipmentPath || '').endsWith('/OrtakBarkodOlustur')
    ) {
      return 'OrtakBarkodOlustur'
    }
    return 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur'
  }
  if (serviceMode === 'PRE_REGISTRATION_REST') {
    return 'GonderiyiKargoyaGonder'
  }
  if (serviceMode === 'GONDERI_YENI_SOAP') {
    return 'GonderiyiKargoyaGonderYeni'
  }
  return 'GonderiOlusturV2'
}

async function executeIdempotentSuratCreate(request, operation) {
  const existing = await readSuratCreateOperation(
    operation.idempotencyKey,
    operation.organizationId,
  )
  const retryAuthorized = Boolean(
    request.body?.retryAfterConfirmedNoRecord === true &&
      request.body?.confirmedNoCarrierRecord === true,
  )

  if (existing?.status === 'SUCCESS') {
    return buildPersistedSuratCreateResponse(existing, operation)
  }
  if (existing && ['IN_PROGRESS', 'UNKNOWN'].includes(existing.status)) {
    return buildSuratIdempotencyBlockedResponse(
      existing,
      operation,
      'Önceki Sürat create çağrısının taşıyıcı sonucu kesinleşmedi. Yeni gönderi oluşturulmadı; mevcut adaylarla Serendip doğrulaması yapılmalıdır.',
    )
  }
  if (existing?.status === 'FAILED_SAFE' && !retryAuthorized) {
    return buildSuratIdempotencyBlockedResponse(
      existing,
      operation,
      'Önceki create çağrısı başarısız olarak kaydedildi. Serendipte kayıt olmadığı doğrulanmadan ve kontrollü tekrar açıkça yetkilendirilmeden yeni çağrı yapılmadı.',
    )
  }
  if (Number(existing?.createCallCount ?? 0) >= operation.maxCreateCalls) {
    return buildSuratIdempotencyBlockedResponse(
      existing,
      operation,
      'Bu sipariş için güvenli create çağrısı sınırına ulaşıldı. Otomatik deneme durduruldu.',
    )
  }

  const startedAt = new Date().toISOString()
  const inProgressRecord = {
    ...existing,
    ...operation,
    status: 'IN_PROGRESS',
    createCallCount: Number(existing?.createCallCount ?? 0) + 1,
    startedAt,
    updatedAt: startedAt,
  }
  // Auth modda IN_PROGRESS yazımı ATOMİK rezervasyondur (unique constraint +
  // insert-on-conflict): eşzamanlı/çok-süreçli iki create'te yalnız kazanan
  // taşıyıcıya gider; kaybeden blocked yanıtı alır. Legacy modda mevcut
  // dosya yazımı aynen korunur.
  if (useShipmentDbPersistence(operation.organizationId)) {
    const reservation = await reserveShipmentCreateOperation(
      operation.organizationId,
      inProgressRecord,
    )
    if (!reservation.won) {
      return buildSuratIdempotencyBlockedResponse(
        reservation.existing ?? inProgressRecord,
        operation,
        'Bu sipariş için başka bir create isteği hâlihazırda taşıyıcı sonucunu bekliyor. Yeni gönderi oluşturulmadı.',
      )
    }
  } else {
    await writeSuratCreateOperation(inProgressRecord)
  }

  let result
  try {
    result = await executeSuratCreateCoreAsValue(request)
  } catch (error) {
    const unknownRecord = {
      ...inProgressRecord,
      status: 'UNKNOWN',
      updatedAt: new Date().toISOString(),
      errorCode: 'SURAT_CREATE_TRANSPORT_UNKNOWN',
    }
    await writeSuratCreateOperation(unknownRecord)
    return buildSuratIdempotencyBlockedResponse(
      unknownRecord,
      operation,
      error instanceof Error
        ? error.message
        : 'Sürat create çağrısının sonucu kesinleşmedi.',
    )
  }

  const carrierCreateCalled = didSuratCreateReachCarrier(result)
  if (!carrierCreateCalled) {
    await deleteSuratCreateOperation(
      operation.idempotencyKey,
      operation.organizationId,
    )
    return withSuratIdempotencyDebug(result, operation, {
      carrierCreateCalled: false,
      createCallCount: Number(existing?.createCallCount ?? 0),
      persistentStatus: 'NOT_SENT',
    })
  }

  const verified = isSerendipVerifiedCreateResult(result)
  const explicitBusinessFailure = isExplicitSuratBusinessFailure(result)
  const completedAt = new Date().toISOString()
  const record = {
    ...inProgressRecord,
    status: verified
      ? 'SUCCESS'
      : explicitBusinessFailure
        ? 'FAILED_SAFE'
        : 'UNKNOWN',
    updatedAt: completedAt,
    completedAt,
    businessCode: firstNonEmpty(
      result?.suratCreateLog?.responseCode,
      result?.createDiagnostics?.code,
      result?.errorCode,
    ),
    businessMessage: String(result?.message ?? '').slice(0, 600),
    carrierTrackingNumber:
      verified || result?.shipment?.dispatchRegistrationConfirmed
        ? firstNonEmpty(result?.shipment?.tNo, result?.shipment?.trackingNumber)
        : '',
    carrierBarcodeNumber:
      verified || result?.shipment?.dispatchRegistrationConfirmed
        ? firstNonEmpty(result?.shipment?.barkodNo, result?.shipment?.barcode)
        : '',
    candidateTrackingNumber: firstNonEmpty(
      result?.shipment?.tNo,
      result?.shipment?.trackingNumber,
      result?.shipment?.codeMapping?.tNoValue,
      result?.shipment?.zplAnalysis?.acceptedTNo,
      result?.suratCreateLog?.codeMapping?.tNoValue,
      result?.suratCreateLog?.zplAnalysis?.acceptedTNo,
      result?.createDiagnostics?.codeMapping?.tNoValue,
      result?.createDiagnostics?.zplAnalysis?.acceptedTNo,
    ),
    candidateBarcodeNumber: firstNonEmpty(
      result?.shipment?.barkodNo,
      result?.shipment?.barcode,
      result?.shipment?.codeMapping?.barcodeValue,
      result?.shipment?.zplAnalysis?.acceptedFinalBarcode,
      result?.suratCreateLog?.codeMapping?.barcodeValue,
      result?.suratCreateLog?.zplAnalysis?.acceptedFinalBarcode,
      result?.createDiagnostics?.codeMapping?.barcodeValue,
      result?.createDiagnostics?.zplAnalysis?.acceptedFinalBarcode,
    ),
    candidateIdentifiers: collectSafeSuratCandidates(result),
    soapAction: `http://tempuri.org/${operation.operation}`,
    requestRoot: operation.operation,
    ozelKargoTakipNo: firstNonEmpty(
      readSuratField(result?.suratCreateLog?.rawRequest, ['OzelKargoTakipNo']),
      readSuratField(result?.shipment?.suratCreateLog?.rawRequest, [
        'OzelKargoTakipNo',
      ]),
    ),
    referansNo: firstNonEmpty(
      readSuratField(result?.suratCreateLog?.rawRequest, ['ReferansNo']),
      readSuratField(result?.shipment?.suratCreateLog?.rawRequest, [
        'ReferansNo',
      ]),
    ),
    verificationStatus: verified
      ? 'VERIFIED'
      : result?.shipment?.lifecycleStatus ===
          'SHIPMENT_REGISTERED_LABEL_REQUIRED'
        ? 'SHIPMENT_REGISTERED_LABEL_REQUIRED'
        : result?.shipment?.technicalZplReceived ||
          result?.createDiagnostics?.technicalZplReceived
        ? 'LABEL_CREATED_UNVERIFIED'
        : explicitBusinessFailure
          ? 'VERIFICATION_FAILED'
          : 'SHIPMENT_REGISTERED',
    technicalZplSha256: buildSafeZplReference(result).sha256,
    technicalZplLength: buildSafeZplReference(result).length,
    technicalZpl: buildSafeZplReference(result).zpl,
    lastCheckedAt: completedAt,
  }
  await writeSuratCreateOperation(record)

  return withSuratIdempotencyDebug(result, operation, {
    carrierCreateCalled: true,
    createCallCount: record.createCallCount,
    persistentStatus: record.status,
  })
}

async function executeSuratCreateCoreAsValue(request) {
  let payload
  await createSuratShipmentCore(request, {
    json(value) {
      payload = value
      return value
    },
  })
  return payload
}

function didSuratCreateReachCarrier(result) {
  const createLog = result?.shipment?.suratCreateLog ?? result?.suratCreateLog
  return Boolean(
    createLog &&
      createLog?.rawRequest?.skipped !== true &&
      Number(createLog?.responseStatus ?? result?.responseStatus ?? 0) > 0,
  )
}

function isSerendipVerifiedCreateResult(result) {
  return Boolean(
    result?.ok === true &&
      result?.shipment?.serdendipVerified === true &&
      result?.shipment?.verifiedShipment === true &&
      Number(result?.trackingVerification?.gonderilerLength ?? 0) === 1 &&
      isOperationalSuratTNo(
        firstNonEmpty(result?.shipment?.tNo, result?.shipment?.trackingNumber),
      ),
  )
}

function isExplicitSuratBusinessFailure(result) {
  const responseStatus = Number(
    result?.shipment?.suratCreateLog?.responseStatus ??
      result?.suratCreateLog?.responseStatus ??
      result?.responseStatus ??
      0,
  )
  return Boolean(
    responseStatus > 0 &&
      result?.ok === false &&
      ![
        'SURAT_TRACKING_CONFIRMATION_MISSING',
        'SURAT_LABEL_REQUIRED',
      ].includes(result?.errorCode),
  )
}

function collectSafeSuratCandidates(result) {
  return uniqueStrings([
    result?.candidateTrackingNumber,
    result?.candidateBarcodeNumber,
    result?.shipment?.tNo,
    result?.shipment?.trackingNumber,
    result?.shipment?.barkodNo,
    result?.shipment?.barcode,
    result?.shipment?.codeMapping?.tNoValue,
    result?.shipment?.codeMapping?.trackingValue,
    result?.shipment?.codeMapping?.barcodeValue,
    result?.shipment?.zplAnalysis?.acceptedTNo,
    result?.shipment?.zplAnalysis?.acceptedFinalBarcode,
    result?.suratCreateLog?.codeMapping?.tNoValue,
    result?.suratCreateLog?.codeMapping?.trackingValue,
    result?.suratCreateLog?.codeMapping?.barcodeValue,
    result?.suratCreateLog?.zplAnalysis?.acceptedTNo,
    result?.suratCreateLog?.zplAnalysis?.acceptedFinalBarcode,
    result?.createDiagnostics?.codeMapping?.tNoValue,
    result?.createDiagnostics?.codeMapping?.trackingValue,
    result?.createDiagnostics?.codeMapping?.barcodeValue,
    result?.createDiagnostics?.zplAnalysis?.acceptedTNo,
    result?.createDiagnostics?.zplAnalysis?.acceptedFinalBarcode,
    ...Object.values(result?.suratCreateLog?.codeCandidates ?? {}),
    ...Object.values(result?.createDiagnostics?.codeCandidates ?? {}),
  ]).slice(0, 24)
}

function withSuratIdempotencyDebug(result, operation, extra = {}) {
  return {
    ...result,
    idempotency: {
      idempotencyKey: operation.idempotencyKey,
      correlationId: operation.correlationId,
      requestFingerprint: operation.requestFingerprint,
      environment: operation.environment,
      operation: operation.operation,
      maskedAccount: operation.maskedAccount,
      reusedInFlight: false,
      ...extra,
    },
  }
}

function buildPersistedSuratCreateResponse(record, operation) {
  const operationName = firstNonEmpty(
    record?.operation,
    operation?.operation,
    'KargoBarkoduSiparis',
  )
  const serviceType =
    operationName === 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur'
      ? 'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap'
      : operationName === 'OrtakBarkodOlustur'
        ? 'OrtakBarkodOlusturSoap'
      : operationName === 'GonderiyiKargoyaGonder'
        ? 'GonderiyiKargoyaGonderRestJson'
        : operationName === 'GonderiyiKargoyaGonderYeni'
          ? 'GonderiyiKargoyaGonderYeniSoap'
        : operationName === 'GonderiOlusturV2'
          ? 'GonderiOlusturV2'
          : 'KargoBarkoduSiparisSoap'
  return withSuratIdempotencyDebug(
    {
      ok: true,
      source: 'real',
      message:
        'Bu sipariş daha önce Sürat ve Serendip tarafından doğrulandı; yeni create çağrısı yapılmadı.',
      serviceType,
      operationName,
      shipment: {
        trackingNumber: record.carrierTrackingNumber,
        kargoTakipNo: record.carrierTrackingNumber,
        tNo: record.carrierTrackingNumber,
        barcode: record.carrierBarcodeNumber,
        barkodNo: record.carrierBarcodeNumber,
        barcodeValue: record.carrierBarcodeNumber,
        finalSuratBarcode: record.carrierBarcodeNumber,
        verifiedShipment: true,
        dispatchRegistrationConfirmed: true,
        operationalBarcodeVerified: true,
        serdendipVerified: true,
        verificationStage: 'serdendip_verified',
        lifecycleStatus: 'LABEL_READY',
        labelStatus: 'READY',
        printEnabled: true,
      },
      trackingVerification: {
        gonderilerLength: 1,
        KargoTakipNo: record.carrierTrackingNumber,
        serdendipVerified: true,
        restoredFromIdempotencyStore: true,
      },
    },
    operation,
    {
      carrierCreateCalled: false,
      persistentStatus: 'SUCCESS',
      createCallCount: record.createCallCount,
      restoredFromStore: true,
    },
  )
}

// İlk create ve replay/idempotency-blocked yanıtları aynı ön-atanmış baskı
// durumunu bu ortak patch ile üretir (tek politika).
function buildSuratPreassignedShipmentPatch(tNo, barkod) {
  return {
    trackingNumber: tNo,
    kargoTakipNo: tNo,
    tNo,
    trackingSource: 'surat.create.preassignedTNo',
    barcode: barkod,
    barkodNo: barkod,
    barcodeValue: barkod,
    barcodeSource: 'surat.create.preassignedBarkod',
    finalSuratBarcode: barkod,
    candidateTNo: tNo,
    candidateBarkodNo: barkod,
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    verifiedShipment: false,
    operationalBarcodeVerified: false,
    verificationStage: 'preassigned_awaiting_acceptance',
    errorCategory: '',
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    labelStatus: 'READY',
    printEnabled: true,
    diagnosticMessage:
      'Etiket yazdırılabilir; Serendip kaydı fiziksel tesellümden sonra doğrulanacaktır.',
    noTrackingReason: 'Etiket hazır; fiziksel Sürat kabulü bekleniyor.',
    labelBlockedReason: '',
    zplDisabledReason: '',
  }
}

function buildSuratIdempotencyBlockedResponse(record, operation, message) {
  const candidateIdentifiers = uniqueStrings(record?.candidateIdentifiers ?? [])
  const operationName = firstNonEmpty(
    record?.operation,
    operation?.operation,
    'KargoBarkoduSiparis',
  )
  const serviceMode =
    [
      'OrtakBarkodOlustur',
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    ].includes(operationName)
      ? 'ORTAK_BARKOD_SOAP'
      : operationName === 'GonderiyiKargoyaGonder'
        ? 'PRE_REGISTRATION_REST'
        : operationName === 'GonderiyiKargoyaGonderYeni'
          ? 'GONDERI_YENI_SOAP'
        : 'KARGO_BARKODU_SIPARIS_SOAP'
  const serviceType =
    operationName === 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur'
      ? 'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap'
      : operationName === 'OrtakBarkodOlustur'
        ? 'OrtakBarkodOlusturSoap'
      : operationName === 'GonderiyiKargoyaGonder'
        ? 'GonderiyiKargoyaGonderRestJson'
        : operationName === 'GonderiyiKargoyaGonderYeni'
          ? 'GonderiyiKargoyaGonderYeniSoap'
        : 'KargoBarkoduSiparisSoap'
  const unverifiedTNoCandidate =
    firstNonEmpty(
      record?.candidateTrackingNumber,
      candidateIdentifiers.find(
        (value) => /^\d{12,20}$/.test(String(value ?? '').trim()),
      ),
    )
  const unverifiedBarcodeCandidate =
    firstNonEmpty(
      record?.candidateBarcodeNumber,
      candidateIdentifiers.find(
        (value) =>
          value !== unverifiedTNoCandidate &&
          isNumericSuratOperationalCode(value),
      ),
    )
  // Kanıt (17.07.2026): ön-atanmış aday kodlar tesellümde birebir korunuyor;
  // etiket üretilmiş bekleyen kayıtlar bu kodlarla yazdırılabilir.
  const preassignedPrintAllowed = Boolean(
    unverifiedTNoCandidate &&
      unverifiedBarcodeCandidate &&
      [
        'LABEL_CREATED_NOT_REGISTERED',
        'LABEL_CREATED_UNVERIFIED',
        'LABEL_CREATED_PENDING_VERIFICATION',
      ].includes(String(record?.verificationStatus ?? '')),
  )
  const labelCreatedNotRegistered =
    record?.verificationStatus === 'LABEL_CREATED_NOT_REGISTERED'
  const preassignedPatch = preassignedPrintAllowed
    ? buildSuratPreassignedShipmentPatch(
        unverifiedTNoCandidate,
        unverifiedBarcodeCandidate,
      )
    : undefined
  // İlk create yanıtındaki teknik ZPL op kaydında saklanır; replay yanıtı
  // bu ZPL'yi geri vererek yazdırılabilir durumu korur. Boş kayıt mevcut
  // istemci ZPL'sini asla ezmez (istemci merge yalnız eksikse doldurur).
  const storedTechnicalZpl = preassignedPatch
    ? normalizeSuratRawZpl(record?.technicalZpl)
    : ''
  const technicalZplPatch = storedTechnicalZpl
    ? {
        barcodeRaw: storedTechnicalZpl,
        zplAnalysis: analyzeSuratZpl(storedTechnicalZpl),
        technicalZplReceived: true,
        zplReady: true,
        zplSource: 'surat.create.replayStoredZpl',
      }
    : undefined
  const noTrackingReason = preassignedPatch
    ? preassignedPatch.noTrackingReason
    : labelCreatedNotRegistered
      ? 'Etiket olusturuldu ancak dogru WebSiparisKodu ile Serendip gonderi kaydi acilmadi. Aday kodlar yazdirilamaz.'
      : 'Surat create cevabi aday kodlar dondurdu ancak Serendip Gonderiler=1 teyidi yok. Bu kodlar yazdirilamaz.'
  const verificationStage = preassignedPatch
    ? preassignedPatch.verificationStage
    : labelCreatedNotRegistered
      ? 'label_created_not_registered'
      : 'tracking_confirmation_missing'
  const errorCategory = preassignedPatch
    ? ''
    : labelCreatedNotRegistered
      ? 'SURAT_LABEL_CREATED_NOT_REGISTERED'
      : 'SURAT_TRACKING_CONFIRMATION_MISSING'
  return withSuratIdempotencyDebug(
    {
      ok: false,
      source: 'real',
      errorCode: 'SURAT_CREATE_IDEMPOTENCY_BLOCKED',
      errorSource: 'CargoFlow',
      message,
      serviceMode,
      serviceType,
      operationName,
      shipment: {
        serviceMode,
        operationName,
        verifiedShipment: false,
        dispatchRegistrationConfirmed: false,
        operationalBarcodeVerified: false,
        verificationStage,
        errorCategory,
        codeCandidates: {
          unverifiedTNoCandidate,
          unverifiedBarcodeCandidate,
        },
        labelStatus: 'BLOCKED',
        printEnabled: false,
        lifecycleStatus: labelCreatedNotRegistered
          ? 'LABEL_CREATED_NOT_REGISTERED'
          : 'SURAT_CREATE_UNCERTAIN',
        candidateVerificationStatus: labelCreatedNotRegistered
          ? 'LABEL_CREATED_NOT_REGISTERED'
          : 'PENDING_VERIFICATION',
        noTrackingReason,
        diagnosticMessage: String(record?.businessMessage ?? '').slice(0, 600),
        ...(preassignedPatch ?? {}),
        ...(technicalZplPatch ?? {}),
        suratCreateLog: {
          serviceMode,
          serviceType,
          operationName,
          codeCandidates: {
            unverifiedTNoCandidate,
            unverifiedBarcodeCandidate,
          },
          errorCategory,
          verificationStage,
          noTrackingReason,
          verifiedShipment: false,
        },
      },
    },
    operation,
    {
      carrierCreateCalled: false,
      persistentStatus: record?.status ?? 'UNKNOWN',
      createCallCount: Number(record?.createCallCount ?? 0),
      candidateIdentifiers,
      previousOperation: record?.operation ?? '',
    },
  )
}

function shortHash(value) {
  return createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 12)
}

function maskCarrierAccount(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text.length <= 4) return '*'.repeat(text.length)
  return `${text.slice(0, 2)}${'*'.repeat(
    Math.max(2, text.length - 4),
  )}${text.slice(-2)}`
}

// Persistence adapter'ı: auth modda (organizationId varsa) organization bazlı
// PostgreSQL; legacy modda mevcut JSON dosyası (surat-create-operations.json).
// İki kaynak birden source-of-truth OLMAZ.
function useShipmentDbPersistence(organizationId) {
  return Boolean(isTenantAuthMode() && organizationId)
}

async function reserveShipmentCreateOperation(organizationId, inProgressRecord) {
  const [{ getDb }, service] = await Promise.all([
    import('./db/client.ts'),
    import('./shipments/shipmentPersistenceService.ts'),
  ])
  return service.reserveOperationRecord(getDb(), organizationId, inProgressRecord)
}

async function readSuratCreateOperation(idempotencyKey, organizationId) {
  if (useShipmentDbPersistence(organizationId)) {
    const [{ getDb }, service] = await Promise.all([
      import('./db/client.ts'),
      import('./shipments/shipmentPersistenceService.ts'),
    ])
    return service.readOperationRecord(getDb(), organizationId, idempotencyKey)
  }
  const store = await readSuratCreateOperationStore()
  return store.operations?.[idempotencyKey]
}

async function writeSuratCreateOperation(record) {
  if (useShipmentDbPersistence(record?.organizationId)) {
    const [{ getDb }, service] = await Promise.all([
      import('./db/client.ts'),
      import('./shipments/shipmentPersistenceService.ts'),
    ])
    await service.writeOperationRecord(getDb(), record.organizationId, record)
    return
  }
  await queueSuratCreateStoreUpdate((store) => {
    store.operations[record.idempotencyKey] = record
  })
}

async function deleteSuratCreateOperation(idempotencyKey, organizationId) {
  if (useShipmentDbPersistence(organizationId)) {
    const [{ getDb }, service] = await Promise.all([
      import('./db/client.ts'),
      import('./shipments/shipmentPersistenceService.ts'),
    ])
    await service.deleteOperationRecord(getDb(), organizationId, idempotencyKey)
    return
  }
  await queueSuratCreateStoreUpdate((store) => {
    delete store.operations[idempotencyKey]
  })
}

async function queueSuratCreateStoreUpdate(mutator) {
  const update = suratCreateStoreQueue.then(async () => {
    const store = await readSuratCreateOperationStore()
    mutator(store)
    await mkdir(localConfigDirectory, { recursive: true })
    const temporaryPath = `${suratCreateOperationPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(store, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, suratCreateOperationPath)
  })
  suratCreateStoreQueue = update.catch(() => {})
  return update
}

async function readSuratCreateOperationStore() {
  try {
    const parsed = JSON.parse(await readFile(suratCreateOperationPath, 'utf8'))
    return {
      version: 1,
      operations:
        parsed?.operations && typeof parsed.operations === 'object'
          ? parsed.operations
          : {},
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, operations: {} }
    throw error
  }
}

function buildSafeZplReference(result = {}) {
  const zpl = firstNonEmpty(
    result?.shipment?.barcodeRaw,
    result?.suratCreateLog?.BarcodeRaw,
    result?.suratCreateLog?.parsedResponse?.BarcodeRaw,
    result?.createDiagnostics?.officialBarcodeRaw,
  )
  return {
    sha256: zpl
      ? createHash('sha256').update(zpl).digest('hex')
      : '',
    length: zpl.length,
    // Teknik ZPL kaydın kendisinde de saklanır ki idempotency-blocked
    // replay yanıtı, ilk create yanıtı istemcide hiç persist edilmemiş
    // olsa bile yazdırılabilir etiketi geri verebilsin.
    zpl,
  }
}

async function persistSuratTrackingVerification(requestBody = {}, result = {}) {
  const orderId = String(requestBody.orderId ?? '').trim()
  if (!orderId) return undefined
  const queryReference = resolveSuratTrackingQueryReference(requestBody)
  if (!queryReference.ok) return undefined
  const webSiparisKodu = queryReference.value
  const shipmentReference = firstNonEmpty(
    requestBody.shipmentId,
    requestBody.packageId,
    requestBody.shipmentPackageId,
  )
  const checkedAt = new Date().toISOString()
  const gonderilerLength = Number(result?.gonderilerLength ?? 0)
  const trackingNumber = firstNonEmpty(
    result?.KargoTakipNo,
    result?.tracking?.KargoTakipNo,
    result?.tracking?.TakipUrlTrackingNo,
  )
  const trackedBarcode = firstNonEmpty(
    result?.BarkodNo,
    result?.tracking?.BarkodNo,
    result?.tracking?.Barkod,
  )
  let persistenceSummary
  await queueSuratCreateStoreUpdate((store) => {
    for (const record of Object.values(store.operations)) {
      if (String(record?.orderId ?? '') !== orderId) continue
      const storedOzelKargoTakipNo = String(
        record?.ozelKargoTakipNo ?? '',
      ).trim()
      if (
        storedOzelKargoTakipNo &&
        normalizeSuratCodeForComparison(storedOzelKargoTakipNo) !==
          normalizeSuratCodeForComparison(webSiparisKodu)
      ) {
        continue
      }
      record.maxCreateCalls = 1
      record.soapAction ||= `http://tempuri.org/${record.operation}`
      record.requestRoot ||= String(record.operation ?? '')
      record.ozelKargoTakipNo ||= webSiparisKodu
      record.referansNo ||= shipmentReference
      record.verificationWebSiparisKodu = webSiparisKodu
      record.verificationReferenceType = queryReference.type
      record.verificationReferenceSource = queryReference.source
      record.lastCheckedAt = checkedAt
      record.lastTrackingState = String(result?.trackingState ?? '')
      record.lastGonderilerLength = gonderilerLength
      const expectedTrackingNumber = String(
        record.candidateTrackingNumber ?? '',
      ).trim()
      const expectedBarcodeNumber = String(
        record.candidateBarcodeNumber ?? '',
      ).trim()
      const trackingNumberMatches = Boolean(
        trackingNumber &&
          (!expectedTrackingNumber ||
            normalizeSuratCodeForComparison(expectedTrackingNumber) ===
              normalizeSuratCodeForComparison(trackingNumber)),
      )
      const barcodeNumberMatches = Boolean(
        trackedBarcode &&
          (!expectedBarcodeNumber ||
            normalizeSuratCodeForComparison(expectedBarcodeNumber) ===
              normalizeSuratCodeForComparison(trackedBarcode)),
      )
      record.verificationComparison = {
        expectedTrackingNumber,
        responseTrackingNumber: trackingNumber,
        trackingNumberMatches,
        expectedBarcodeNumber,
        responseBarcodeNumber: trackedBarcode,
        barcodeNumberMatches,
      }
      if (
        (gonderilerLength > 0 || result?.registrationRowFound === true) &&
        trackingNumberMatches &&
        barcodeNumberMatches
      ) {
        record.status = 'SUCCESS'
        record.verificationStatus = 'VERIFIED'
        record.carrierTrackingNumber = trackingNumber
        record.carrierBarcodeNumber = trackedBarcode
      } else {
        const labelRegistrationState = resolveSuratLabelRegistrationState(
          record,
          checkedAt,
          requestBody?.config?.labelRegistrationGraceMs,
        )
        record.verificationStatus = labelRegistrationState
        if (labelRegistrationState === 'LABEL_CREATED_NOT_REGISTERED') {
          record.status = 'FAILED_SAFE'
          record.failureCategory = 'SURAT_LABEL_CREATED_NOT_REGISTERED'
        }
      }
      persistenceSummary = {
        idempotencyKey: record.idempotencyKey,
        verificationStatus: record.verificationStatus,
        status: record.status,
        lastCheckedAt: record.lastCheckedAt,
        lastGonderilerLength: record.lastGonderilerLength,
        verificationReferenceType: record.verificationReferenceType,
        candidateTrackingNumber: record.candidateTrackingNumber ?? '',
        candidateBarcodeNumber: record.candidateBarcodeNumber ?? '',
        carrierTrackingNumber: record.carrierTrackingNumber ?? '',
        carrierBarcodeNumber: record.carrierBarcodeNumber ?? '',
      }
    }
  })
  return persistenceSummary
}

function resolveSuratLabelRegistrationState(
  record = {},
  checkedAt = new Date().toISOString(),
  configuredGraceMs,
) {
  const graceMs = Number.isFinite(Number(configuredGraceMs))
    ? Math.max(0, Number(configuredGraceMs))
    : SURAT_LABEL_REGISTRATION_GRACE_MS
  const labelCreated = Boolean(
    String(record?.candidateTrackingNumber ?? '').trim() ||
      String(record?.candidateBarcodeNumber ?? '').trim() ||
      Number(record?.technicalZplLength ?? 0) > 0,
  )
  const correctReferenceUsed = Boolean(
    record?.verificationReferenceType === 'WEB_SIPARIS_KODU' &&
      String(record?.verificationWebSiparisKodu ?? '').trim(),
  )
  const noCarrierRecord = Number(record?.lastGonderilerLength ?? -1) === 0
  const createdAtMs = Date.parse(
    firstNonEmpty(record?.completedAt, record?.createdAt, record?.startedAt),
  )
  const checkedAtMs = Date.parse(String(checkedAt ?? ''))
  const graceExpired = Boolean(
    Number.isFinite(createdAtMs) &&
      Number.isFinite(checkedAtMs) &&
      checkedAtMs - createdAtMs >= graceMs,
  )

  return labelCreated && correctReferenceUsed && noCarrierRecord && graceExpired
    ? 'LABEL_CREATED_NOT_REGISTERED'
    : 'LABEL_CREATED_UNVERIFIED'
}

function buildTrendyolShipmentPreflight(order = {}) {
  const rawOrder = firstObjectCandidate(
    order.rawOrder,
    order.rawPackage,
    order.rawResponse,
  )
  const rawLineSource = Array.isArray(order.items)
    ? order.items.map((item) => item?.rawLine).filter(Boolean)
    : []
  const sources = [order, rawOrder, ...rawLineSource]
  const orderNumber = firstNonEmpty(
    order.orderNumber,
    readSuratField(sources, ['orderNumber']),
  )
  const packageId = firstNonEmpty(
    order.packageId,
    readSuratField(sources, ['packageId', 'id']),
  )
  const shipmentPackageId = firstNonEmpty(
    order.shipmentPackageId,
    readSuratField(sources, ['shipmentPackageId']),
    packageId,
  )
  const cargoTrackingNumber = firstNonEmpty(
    order.cargoTrackingNumber,
    readSuratField(sources, ['cargoTrackingNumber', 'existingCargoTrackingNumber']),
  )
  const cargoProviderName = firstNonEmpty(
    order.cargoProviderName,
    readSuratField(sources, [
      'cargoProviderName',
      'cargoProvider',
      'cargoCompanyName',
      'cargoSenderNumber',
    ]),
  )
  const cargoProviderId = firstNonEmpty(
    order.cargoProviderId,
    readSuratField(sources, ['cargoProviderId']),
  )
  const cargoCompanyId = firstNonEmpty(
    order.cargoCompanyId,
    readSuratField(sources, ['cargoCompanyId', 'cargoProviderId']),
  )
  const marketplaceStatus = firstNonEmpty(
    order.marketplaceStatus,
    readSuratField(sources, ['marketplaceStatus', 'status']),
  )
  const packageStatus = firstNonEmpty(
    order.packageStatus,
    readSuratField(sources, ['packageStatus', 'status']),
  )
  const orderLineItemStatusName = firstNonEmpty(
    readSuratField(sources, ['orderLineItemStatusName', 'lineStatusName']),
    packageStatus,
  )
  const cargoTrackingLink = firstNonEmpty(
    order.cargoTrackingLink,
    readSuratField(sources, ['cargoTrackingLink', 'trackingUrl']),
  )
  const existingCargoTrackingNumber = firstNonEmpty(
    readSuratField(sources, ['existingCargoTrackingNumber']),
    cargoTrackingNumber,
  )
  const shipmentStatus = firstNonEmpty(
    order.shipmentStatusName,
    readSuratField(sources, ['shipmentStatus', 'shipmentStatusName']),
  )
  const isReadyToShip = readOptionalBoolean(
    firstNonEmpty(order.isReadyToShip, readSuratField(sources, ['isReadyToShip'])),
  )
  const statusText = [
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    shipmentStatus,
  ]
    .join(' ')
    .toLocaleLowerCase('tr-TR')
  const isCancelled =
    ['Cancelled', 'Returned', 'UnDelivered', 'UnSupplied'].includes(
      marketplaceStatus,
    ) || /cancel|iptal|return|iade|refund|un.?supplied/i.test(statusText)
  const isDelivered =
    marketplaceStatus === 'Delivered' || /delivered|teslim/i.test(statusText)
  const isShipped =
    ['Shipped', 'AtCollectionPoint'].includes(marketplaceStatus) ||
    /shipped|kargoda|ta[sş][iı]mada|at.?collection/i.test(statusText)
  const hasCargoTrackingNumber = Boolean(cargoTrackingNumber)
  const normalizedCargoProviderName = normalizeSearchText(cargoProviderName)
  const suratAssigned = cargoProviderName
    ? isSuratCargoProviderName(cargoProviderName)
    : null
  const existingShipmentDetected = Boolean(
    cargoTrackingLink &&
      (isShipped || isDelivered || /kargo.?takip|tracking/i.test(cargoTrackingLink)),
  )
  const requiresPickingUpdate = isTrendyolCreatedPackageStatus({
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    shipmentStatus,
  })
  const diagnostics = []
  if (requiresPickingUpdate) diagnostics.push('Trendyol paketi Yeni/Created statüsünde; Sürat öncesi Picking/İşleme Al yapılmalı.')
  if (!hasCargoTrackingNumber) diagnostics.push('Trendyol cargoTrackingNumber bulunamadı.')
  if (isCancelled) diagnostics.push('Trendyol paketi iptal/iade statüsünde.')
  if (isDelivered) diagnostics.push('Trendyol paketi teslim edilmiş görünüyor.')
  if (isShipped) diagnostics.push('Trendyol paketi kargoda/teslim sürecinde görünüyor.')
  if (isReadyToShip === false) diagnostics.push('Trendyol isReadyToShip=false döndü.')
  if (suratAssigned === false) diagnostics.push('Sipariş Sürat Kargo’ya atanmış görünmüyor.')
  if (existingShipmentDetected) diagnostics.push('Mevcut cargoTrackingLink/gönderi izi var.')
  const canCallGonderiyiKargoyaGonder = Boolean(
    hasCargoTrackingNumber &&
      !requiresPickingUpdate &&
      !isCancelled &&
      !isDelivered &&
      !isShipped &&
      isReadyToShip !== false &&
      suratAssigned !== false,
  )

  return {
    ok: canCallGonderiyiKargoyaGonder,
    canCallSurat: canCallGonderiyiKargoyaGonder,
    reason: canCallGonderiyiKargoyaGonder
      ? 'Trendyol preflight engeli bulunmadı.'
      : diagnostics[0] ||
        'Bu sipariş Trendyol tarafında kargo oluşturma için uygun statüde değil.',
    orderNumber,
    packageId,
    shipmentPackageId,
    cargoTrackingNumber,
    cargoProviderName,
    normalizedCargoProviderName,
    cargoProviderId,
    cargoCompanyId,
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    cargoTrackingLink,
    existingCargoTrackingNumber,
    shipmentStatus,
    isCancelled,
    isDelivered,
    isShipped,
    isReadyToShip,
    suratAssigned,
    hasCargoTrackingNumber,
    existingShipmentDetected,
    canCallGonderiyiKargoyaGonder,
    requiresPickingUpdate,
    pickingUpdatePerformed: Boolean(order.trendyolPickingUpdate?.ok),
    pickingUpdate: order.trendyolPickingUpdate,
    diagnostics,
  }
}

function buildSuratCommonBarcodeLoopDiagnostic({
  order = {},
  config = {},
  lastResponse,
} = {}) {
  const steps = []
  const add = (step) => steps.push(step)
  const orderNumber = String(order.orderNumber ?? '').trim()
  const cargoTrackingNumber = String(order.cargoTrackingNumber ?? '').trim()
  const reference = order?.orderNumber ? makeShipmentReference(order) : ''
  const serviceModeOk = config.serviceMode === 'ORTAK_BARKOD_SOAP'

  add({
    id: 'research-source',
    title: 'Resmi servis kaynağı',
    status: 'PASS',
    message:
      'Sürat WSDL içindeki GonderiyiKargoyaGonderYeniSiparisBarkodOlustur operasyonu GonderiModel alır ve senkron barkod/ZPL döndürür.',
    evidence: {
      endpoint: `${SURAT_SOAP_URL}#GonderiyiKargoyaGonderYeniSiparisBarkodOlustur`,
      soapAction:
        'http://tempuri.org/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      requestParams: ['KullaniciAdi', 'Sifre', 'Gonderi (GonderiModel)'],
      requiredSuccessFields: [
        'Barcode/ZPL içindeki numeric T.No',
        'Barcode/ZPL içindeki numeric Code128',
        'KargoTakipHareketDetayi Gonderiler=1',
      ],
    },
  })

  add({
    id: 'service-mode',
    title: 'Servis modu',
    status: serviceModeOk ? 'PASS' : 'BLOCKED',
    message: serviceModeOk
      ? 'CargoFlow resmî yeni sipariş barkod SOAP modunda.'
      : 'Sürat ortak barkod için Yeni Sipariş Barkod SOAP modu seçilmeli.',
    evidence: {
      serviceMode: config.serviceMode,
      serviceType: config.serviceType,
      createShipmentPath: config.createShipmentPath,
    },
    nextAction: serviceModeOk
      ? undefined
      : 'Entegrasyonlar / Ayarlar ekranında Yeni Sipariş Barkod SOAP modunu seç.',
  })

  add({
    id: 'credentials',
    title: 'Sürat kimlik bilgileri',
    status: config.kullaniciAdi && config.sifre ? 'PASS' : 'BLOCKED',
    message:
      config.kullaniciAdi && config.sifre
        ? 'Sürat gönderi kullanıcı adı ve şifresi mevcut.'
        : 'Yeni sipariş barkod operasyonu için Sürat kullanıcı adı ve gönderi şifresi zorunlu.',
    evidence: {
      shipmentUserConfigured: Boolean(config.kullaniciAdi),
      shipmentPasswordConfigured: Boolean(config.sifre),
      webPasswordRequired: false,
    },
    nextAction:
      config.kullaniciAdi && config.sifre
        ? undefined
        : 'Sürat gönderi kullanıcı adı ve şifresini CargoFlow ayarlarına gir.',
  })

  const preflight = buildTrendyolShipmentPreflight(order)
  add({
    id: 'trendyol-preflight',
    title: 'Trendyol paket uygunluğu',
    status: preflight.canCallSurat ? 'PASS' : 'BLOCKED',
    message: preflight.reason,
    evidence: {
      orderNumber: preflight.orderNumber,
      packageId: preflight.packageId,
      shipmentPackageId: preflight.shipmentPackageId,
      cargoTrackingNumber: preflight.cargoTrackingNumber,
      cargoProviderName: preflight.cargoProviderName,
      marketplaceStatus: preflight.marketplaceStatus,
      packageStatus: preflight.packageStatus,
      requiresPickingUpdate: preflight.requiresPickingUpdate,
      suratAssigned: preflight.suratAssigned,
      diagnostics: preflight.diagnostics,
    },
    nextAction: preflight.canCallSurat
      ? undefined
      : preflight.requiresPickingUpdate
        ? 'Paket önce Trendyol tarafında Picking / İşleme Al statüsüne geçirilmeli.'
        : 'Trendyol statüsü, kargo firması ve cargoTrackingNumber alanlarını kontrol et.',
  })

  let payload = null
  let payloadError = ''
  try {
    payload = buildSuratShipmentPayload(order, reference, {
      commonBarcode: true,
    })
  } catch (error) {
    payloadError =
      error instanceof Error
        ? error.message
        : 'Sürat payload oluşturulamadı.'
  }
  const mappingOk = Boolean(
    payload &&
      cargoTrackingNumber &&
      payload.ReferansNo ===
        String(order.packageId ?? order.shipmentPackageId ?? reference) &&
      payload.OzelKargoTakipNo === cargoTrackingNumber,
  )
  const requestXml = payload
    ? buildSuratGonderiXml(payload, {
        commonBarcode: true,
        strictGonderiModel: true,
      })
    : ''
  const schemaOk = Boolean(
    requestXml &&
      !/<(?:WebSiparisKodu|SatisKodu|MarketplaceIntegrationCode)>/.test(
        requestXml,
      ) &&
      /<OdemeTipi>/.test(requestXml) &&
      /<SevkAdresi>/.test(requestXml),
  )
  add({
    id: 'request-mapping',
    title: 'Sürat request mapping',
    status:
      payloadError ? 'BLOCKED' : mappingOk && schemaOk ? 'PASS' : 'WARN',
    message: payloadError
      ? payloadError
      : mappingOk && schemaOk
        ? 'Paket kimliği ReferansNo, 727 kodu OzelKargoTakipNo alanında; XML resmî GonderiModel şemasına uygun.'
        : 'Referans/OzelKargoTakipNo eşlemesi veya GonderiModel XML şeması kontrol edilmeli.',
    evidence: payload
      ? {
          orderNumber,
          packageId: order.packageId,
          shipmentPackageId: order.shipmentPackageId,
          cargoTrackingNumber,
          ReferansNo: payload.ReferansNo,
          OzelKargoTakipNo: payload.OzelKargoTakipNo,
          WebSiparisKodu: payload.WebSiparisKodu,
          SatisKodu: payload.SatisKodu,
          EntegrasyonFirmasi: payload.EntegrasyonFirmasi,
          Pazaryerimi: payload.Pazaryerimi,
          Odemetipi: payload.Odemetipi,
          WhoPays: payload.WhoPays,
          BirimDesi: payload.BirimDesi,
          BirimKg: payload.BirimKg,
          strictGonderiModel: schemaOk,
          forbiddenFieldsPresent:
            /<(?:WebSiparisKodu|SatisKodu|MarketplaceIntegrationCode)>/.test(
              requestXml,
            ),
        }
      : { payloadError },
    nextAction:
      payloadError || (mappingOk && schemaOk)
        ? undefined
        : 'ReferansNo paket kimliği, OzelKargoTakipNo cargoTrackingNumber olmalı ve XML’de WSDL dışı alan bulunmamalı.',
  })

  const parsedLast = lastResponse
    ? mapSuratCreateResponse(lastResponse, reference)
    : null
  const parsedOutcome = lastResponse
    ? classifySuratCreateResponse(
        lastResponse,
        parsedLast,
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
        {
          ...config,
          marketplaceIntegrationCode: cargoTrackingNumber,
        },
      )
    : null
  const serdendipVerified = Boolean(
    lastResponse?.shipment?.serdendipVerified === true ||
      lastResponse?.trackingVerification?.serdendipVerified === true ||
      Number(lastResponse?.trackingVerification?.gonderilerLength ?? 0) === 1,
  )
  if (lastResponse) {
    const success = Boolean(
      parsedOutcome?.operationalBarcodeVerified && serdendipVerified,
    )
    add({
      id: 'response-parse',
      title: 'Sürat response parse',
      status: success ? 'PASS' : 'BLOCKED',
      message: success
        ? 'Sürat ZPL içindeki T.No ve ana barkod Serendip Gonderiler=1 ile doğrulandı.'
        : parsedOutcome?.operationalBarcodeVerified
          ? 'Sürat barkod/ZPL döndürdü ancak Serendip Gonderiler=1 teyidi yok.'
          : parsedOutcome?.noTrackingReason ||
            'Sürat response içinde yazdırılabilir T.No ve ana barkod yok.',
      evidence: {
        KargoTakipNo: parsedOutcome?.officialTrackingNumber ?? '',
        BarkodNo: parsedOutcome?.officialBarcode ?? '',
        hasBarcodeRaw: Boolean(parsedOutcome?.officialBarcodeRaw),
        serdendipVerified,
        responseCategory: parsedOutcome?.responseCategory,
        message: parsedOutcome?.message,
      },
      nextAction: success
        ? undefined
        : parsedOutcome?.operationalBarcodeVerified
          ? 'Aynı OzelKargoTakipNo ile KargoTakipHareketDetayi sorgusunu sürdür; Gonderiler=1 olmadan yazdırmayı açma.'
          : 'Ham Sürat cevabındaki Message/Barcode alanını Sürat destek ile paylaş.',
    })
  } else {
    add({
      id: 'response-parse',
      title: 'Sürat response parse',
      status: 'SKIPPED',
      message:
        'Henüz canlı yeni sipariş barkod response yok; önce bloklu adımlar temizlenmeli.',
    })
  }

  const blocking = steps.find((step) => step.status === 'BLOCKED')
  const readyForLiveAttempt = !blocking && serviceModeOk
  return {
    ok: true,
    diagnosticType: 'SURAT_COMMON_BARCODE_LOOP',
    targetOperation:
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    canAttemptLiveSuratCall: readyForLiveAttempt,
    canPrintLabel:
      parsedOutcome?.operationalBarcodeVerified && serdendipVerified,
    terminalBlocker: blocking
      ? {
          stepId: blocking.id,
          message: blocking.message,
          nextAction: blocking.nextAction,
        }
      : undefined,
    loop: [
      '1) Araştır: WSDL ve Trendyol dokümanı ile doğru servis/alanları doğrula.',
      '2) Preflight: gönderi kimliği, Trendyol statüsü, Sürat ataması, desi ve GonderiModel XML kontrol et.',
      '3) Deney: yalnız temiz ve geçmişsiz siparişte tek canlı yeni sipariş barkod çağrısı yap.',
      '4) Kanıt: ZPL içindeki T.No + numeric Code128 ve Serendip Gonderiler=1 birlikte yoksa yazdırmayı açma.',
      '5) Düzelt: Message/errorCategory üzerinden tek değişkeni düzelt; sonucu belirsiz create çağrısını tekrarlama.',
    ],
    steps,
  }
}

function isTrendyolMarketplaceSuratOrder(order = {}) {
  const marketplace = normalizeSearchText(order.marketplace || 'Trendyol')
  const cargoTrackingNumber = String(order.cargoTrackingNumber ?? '').trim()
  const cargoProviderName = normalizeSearchText(order.cargoProviderName)
  return Boolean(
    marketplace.includes('trendyol') &&
      cargoTrackingNumber &&
      isSuratCargoProviderName(order.cargoProviderName) &&
      cargoProviderName.includes('marketplace'),
  )
}

function isSuratCargoProviderName(value = '') {
  const normalized = normalizeSearchText(value)
  const compact = normalized.replace(/[^a-z0-9]/g, '')
  return Boolean(
    compact.includes('surat') ||
      compact.includes('srat') ||
      compact.includes('ratkargo') ||
      /s.?rat/.test(normalized),
  )
}

function buildTrendyolMarketplaceSuratShipmentResponse(order = {}) {
  const cargoTrackingNumber = String(order.cargoTrackingNumber ?? '').trim()
  const orderNumber = String(order.orderNumber ?? '').trim()
  const reference = makeShipmentReference(order)
  const packageId = String(order.packageId || order.shipmentPackageId || reference)
  const createdAt = new Date().toISOString()
  const desi = normalizeNumeric(order.desi ?? order.weightKg ?? null)
  const shipment = {
    id: `ty-marketplace-${packageId}`,
    provider: 'surat-kargo',
    trackingNumber: cargoTrackingNumber,
    trackingUrl: '',
    shipmentCode: packageId,
    satisKodu: orderNumber,
    webSiparisKodu: orderNumber,
    ozelKargoTakipNo: cargoTrackingNumber,
    barcodeValue: cargoTrackingNumber,
    barcodeSource: 'trendyol.cargoTrackingNumber',
    serviceMode: 'TRENDYOL_MARKETPLACE',
    operationName: 'TrendyolMarketplaceCargoTrackingNumber',
    kargoTakipNo: cargoTrackingNumber,
    tNo: cargoTrackingNumber,
    barcode: cargoTrackingNumber,
    barkodNo: cargoTrackingNumber,
    finalSuratBarcode: cargoTrackingNumber,
    technicalZplReceived: true,
    operationalBarcodeVerified: true,
    verificationStage: 'operational_barcode_verified',
    barcodeRaw: '',
    zplSource: 'generated',
    trackingSource: 'trendyol.cargoTrackingNumber',
    desi,
    desiSource: order.desiSource ?? (desi == null ? null : 'manual'),
    weightKg: normalizeNumeric(order.weightKg ?? desi),
    packageCount: normalizePackageCount(order.packageCount),
    apiRequestDesi: desi,
    apiResponseDesi: desi,
    dispatchRegistrationConfirmed: true,
    dispatchRegistration: {
      ok: true,
      source: 'trendyol',
      duplicateShipment: false,
      providerRegistrationConfirmed: true,
      responseMessage:
        'Trendyol anlaşmalı Sürat gönderisi; cargoTrackingNumber resmi barkod olarak kullanıldı.',
    },
    labelStatus: 'READY',
    shipmentStatus: 'VERIFIED',
    suratVerificationStatus: 'VERIFIED',
    zplReady: true,
    printEnabled: true,
    matchStatus: true,
    statusComputedFrom: 'TRENDYOL_MARKETPLACE',
    previousStatus: order.operationStatus,
    newStatus: 'LABEL_READY',
    previousErrorCleared: Boolean(order.error || order.errorMessage),
    tabBucket: 'ETIKET_BASILACAKLAR',
    noTrackingReason: undefined,
    labelBlockedReason: undefined,
    zplDisabledReason: undefined,
    shipmentReference: reference,
    status: 'created',
    lifecycleStatus: 'LABEL_READY',
    source: 'real',
    rawResponse: {
      source: 'trendyol.order.cargoTrackingNumber',
      orderNumber,
      packageId,
      cargoTrackingNumber,
      cargoProviderName: order.cargoProviderName,
      marketplaceStatus: order.marketplaceStatus,
    },
    suratCreateLog: {
      ok: true,
      source: 'real',
      operationType: 'CREATE_SHIPMENT',
      endpoint: 'trendyol.order.cargoTrackingNumber',
      serviceType: 'TrendyolMarketplaceCargoTrackingNumber',
      serviceMode: 'TRENDYOL_MARKETPLACE',
      operationName: 'TrendyolMarketplaceCargoTrackingNumber',
      payloadFormat: 'ORDER_PAYLOAD',
      responseStatus: 200,
      status: 200,
      orderId: order.id,
      shipmentId: packageId,
      responseCode: 'TRENDYOL_MARKETPLACE',
      responseMessage:
        'Sürat Marketplace siparişinde Trendyol cargoTrackingNumber resmi Code128 barkodudur.',
      barcodeResponseCodeDetected: true,
      hasBarcode: true,
      hasTrackingNumber: true,
      KargoTakipNo: cargoTrackingNumber,
      Barcode: cargoTrackingNumber,
      BarcodeRaw: '',
      barcodeSource: 'trendyol.cargoTrackingNumber',
      trackingSource: 'trendyol.cargoTrackingNumber',
      verifiedShipment: true,
      codeMapping: {
        barcodeField: 'trendyol.cargoTrackingNumber',
        tNoField: 'trendyol.cargoTrackingNumber',
        barcodeValue: cargoTrackingNumber,
        tNoValue: cargoTrackingNumber,
      },
      requestFieldMapping: {
        orderNumber,
        packageId,
        WebSiparisKodu: orderNumber,
        SatisKodu: orderNumber,
        ReferansNo: packageId,
        OzelKargoTakipNo: cargoTrackingNumber,
        MarketplaceIntegrationCode: cargoTrackingNumber,
        marketplaceIntegrationCodeSource: 'trendyol.cargoTrackingNumber',
        carrierContractType: 'marketplace',
      },
      requestValidation: {
        ok: true,
        items: [
          {
            field: 'cargoTrackingNumber',
            status: 'OK',
            message: 'Trendyol anlaşmalı Sürat barkodu sipariş payload içinde mevcut.',
          },
          {
            field: 'suratApiCall',
            status: 'SKIPPED',
            message: 'Marketplace akışında Sürat GonderiyiKargoyaGonder çağrılmadı.',
          },
        ],
      },
      trendyolPreflight: {
        orderNumber,
        packageId,
        shipmentPackageId: order.shipmentPackageId,
        cargoTrackingNumber,
        cargoProviderName: order.cargoProviderName,
        marketplaceStatus: order.marketplaceStatus,
        packageStatus: order.packageStatus ?? order.marketplaceStatus,
        hasCargoTrackingNumber: true,
        suratAssigned: true,
        carrierContractType: 'marketplace',
        canCallSurat: false,
        canPrintMarketplaceLabel: true,
        reason:
          'Trendyol anlaşmalı Sürat gönderisi: cargoTrackingNumber Code128 olarak basılır.',
      },
      verificationStage: 'operational_barcode_verified',
      technicalZplReceived: true,
      operationalBarcodeVerified: true,
      createdAt,
    },
    verifiedShipment: true,
    verificationMatchReason:
      'Trendyol anlaşmalı Sürat cargoTrackingNumber barkodu doğrulandı.',
    trendyolCargoTrackingNumber: cargoTrackingNumber,
    suratKargoTakipNo: cargoTrackingNumber,
    diagnosticMessage:
      'Sürat API çağrılmadı; Trendyol cargoTrackingNumber resmi barkod olarak kullanıldı.',
    createdAt,
  }

  return {
    ok: true,
    source: 'real',
    message:
      'Trendyol anlaşmalı Sürat etiketi hazır. cargoTrackingNumber resmi barkod olarak kullanılacak.',
    operationType: 'CREATE_SHIPMENT',
    buttonName: 'Sürat Gönderisi Oluştur',
    providerMethod: 'SuratKargoProvider.createShipment',
    endpoint: 'trendyol.order.cargoTrackingNumber',
    serviceType: 'TrendyolMarketplaceCargoTrackingNumber',
    serviceMode: 'TRENDYOL_MARKETPLACE',
    operationName: 'TrendyolMarketplaceCargoTrackingNumber',
    payloadFormat: 'ORDER_PAYLOAD',
    statusCode: 200,
    responseStatus: 200,
    requestFieldMapping: shipment.suratCreateLog.requestFieldMapping,
    shipment,
  }
}

function normalizePackageCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? count : 1
}

function normalizeNumeric(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('tr-TR')
}

function buildTrendyolPreflightBlockedResponse({
  config,
  order,
  reference,
  preflight,
}) {
  const shipmentPayload = buildSuratShipmentPayload(order, reference)
  const requestValidation = validateSuratRequestMapping(order, shipmentPayload)
  const addressNormalization = buildAddressNormalizationDebug(order)
  const serviceType =
    config.serviceMode === 'ORTAK_BARKOD_SOAP'
      ? 'GonderiyiKargoyaGonderRestJson'
      : config.serviceType
  const serviceMode = resolveSuratServiceMode(serviceType)
  const endpoint = 'preflight:Trendyol'
  const message =
    'Bu sipariş Trendyol tarafında kargo oluşturma için uygun statüde değil. Sürat’e istek gönderilmedi.'
  const createLog = buildSuratCreateLog({
    rawRequest: {
      skipped: true,
      reason: preflight.reason,
      intendedPayload: shipmentPayload,
    },
    rawResponse: message,
    responseStatus: 0,
    contentType: 'application/json',
    parsedResponse: { message },
    orderId: order.id ?? '',
    shipmentId: reference,
    serviceType,
    serviceMode,
    operationName: 'TrendyolPreflight',
    endpoint,
    payloadFormat: 'JSON',
    outcome: {
      code: 'PREFLIGHT',
      message,
      verificationStage: 'dispatch_rejected',
      errorCategory: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
      hardError: true,
      verifiedShipment: false,
      hasTrackingNumber: false,
      hasBarcode: false,
      noTrackingReason: preflight.reason,
      technicalZplReceived: false,
      operationalBarcodeVerified: false,
    },
    requestReference: reference,
    requestValidation,
    addressNormalization,
    trendyolPreflight: preflight,
  })

  return buildSuratDispatchRejectedFailure({
    message,
    errorCode: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
    errorSource: 'Trendyol',
    endpoint,
    statusCode: 0,
    contentType: 'application/json',
    rawRequest: createLog.rawRequest,
    rawResponse: message,
    parsedResponse: { message },
    createLog,
    serviceType,
    payloadFormat: 'JSON',
    reference,
    marketplaceIntegrationCode: shipmentPayload.MarketplaceIntegrationCode,
    requestValidation,
    addressNormalization,
    trendyolPreflight: preflight,
    requestSent: false,
  })
}

function isTrendyolCreatedPackageStatus({
  marketplaceStatus = '',
  packageStatus = '',
  orderLineItemStatusName = '',
  shipmentStatus = '',
} = {}) {
  const values = [
    marketplaceStatus,
    packageStatus,
    orderLineItemStatusName,
    shipmentStatus,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  if (values.some((value) => value === 'Picking' || value === 'Invoiced')) {
    return false
  }
  const text = values.join(' ').toLocaleLowerCase('tr-TR')
  return Boolean(
    values.includes('Created') ||
      /\bcreated\b/i.test(text) ||
      /\byeni\b/i.test(text),
  )
}

async function ensureTrendyolPickingBeforeSurat(
  credentials,
  order,
  preflight,
) {
  const validation = validateTrendyol(credentials)
  if (validation) {
    return {
      ok: false,
      source: 'real',
      operation: 'TrendyolUpdatePackageStatus',
      status: 'Picking',
      message: `Paket Trendyol'da işleme alınamadı. ${validation.message}`,
      preflight,
    }
  }

  return callTrendyolUpdatePackageStatus(credentials, order, {
    packageId: preflight.packageId || preflight.shipmentPackageId,
    status: 'Picking',
  })
}

async function callTrendyolUpdatePackageStatus(
  credentials,
  order,
  { packageId, status },
) {
  const lines = buildTrendyolPackageStatusLines(order)
  if (lines.length === 0) {
    return {
      ok: false,
      source: 'real',
      operation: 'TrendyolUpdatePackageStatus',
      status,
      packageId,
      message:
        "Paket Trendyol'da işleme alınamadı. Trendyol satır lineId bilgisi bulunamadı.",
      requestBody: { lines: [], params: {}, status },
    }
  }

  const requestBody = {
    lines,
    params: {},
    status,
  }
  const url = `${getTrendyolBaseUrl(credentials)}/integration/order/sellers/${encodeURIComponent(
    credentials.sellerId,
  )}/shipment-packages/${encodeURIComponent(packageId)}`
  const result = await fetchTrendyolJson(url, credentials, {
    method: 'PUT',
    body: requestBody,
  })

  return {
    ...result,
    operation: 'TrendyolUpdatePackageStatus',
    status,
    packageId,
    requestBody,
    endpoint: `/integration/order/sellers/${credentials.sellerId}/shipment-packages/${packageId}`,
    message: result.ok
      ? 'Trendyol paketi Picking statüsüne alındı.'
      : `Paket Trendyol'da işleme alınamadı. ${result.message}`,
  }
}

function buildTrendyolPackageStatusLines(order = {}) {
  const rawPackageLines = Array.isArray(order.rawPackage?.lines)
    ? order.rawPackage.lines
    : []
  const rawOrderLines = Array.isArray(order.rawOrder?.lines)
    ? order.rawOrder.lines
    : []
  const itemLines = Array.isArray(order.items)
    ? order.items
        .map((item) => item?.rawLine ?? item)
        .filter(Boolean)
    : []
  const sourceLines = [...rawPackageLines, ...rawOrderLines, ...itemLines]
  const uniqueLines = new Map()

  for (const line of sourceLines) {
    const lineId = extractTrendyolLineId(line)
    if (!lineId || uniqueLines.has(lineId)) continue
    uniqueLines.set(lineId, {
      lineId,
      quantity: Number(line?.quantity ?? 1) || 1,
    })
  }

  return Array.from(uniqueLines.values())
}

function extractTrendyolLineId(line = {}) {
  const direct = firstNonEmpty(
    line.lineId,
    line.orderLineId,
    line.id,
    line.shipmentPackageItemId,
  )
  if (direct && !String(direct).startsWith('ty_line_')) return direct
  const raw = line.rawLine
  if (raw) {
    return firstNonEmpty(
      raw.lineId,
      raw.orderLineId,
      raw.id,
      raw.shipmentPackageItemId,
    )
  }
  return ''
}

function buildTrendyolPickingUpdateBlockedResponse({
  config,
  order,
  reference,
  preflight,
  pickingUpdate,
}) {
  const shipmentPayload = buildSuratShipmentPayload(order, reference)
  const requestValidation = validateSuratRequestMapping(order, shipmentPayload)
  const addressNormalization = buildAddressNormalizationDebug(order)
  const serviceType =
    config.serviceMode === 'ORTAK_BARKOD_SOAP'
      ? 'GonderiyiKargoyaGonderRestJson'
      : config.serviceType
  const serviceMode = resolveSuratServiceMode(serviceType)
  const endpoint = 'preflight:TrendyolPicking'
  const message =
    "Paket Trendyol'da işleme alınamadı. Sürat'e istek gönderilmedi."
  const createLog = buildSuratCreateLog({
    rawRequest: {
      skipped: true,
      reason: pickingUpdate.message,
      intendedPayload: shipmentPayload,
      trendyolPickingRequest: pickingUpdate.requestBody,
      trendyolPickingEndpoint: pickingUpdate.endpoint,
    },
    rawResponse: pickingUpdate.rawResponse ?? pickingUpdate.data ?? pickingUpdate.message,
    responseStatus: Number(pickingUpdate.statusCode ?? 0),
    contentType: 'application/json',
    parsedResponse: pickingUpdate.data ?? { message: pickingUpdate.message },
    orderId: order.id ?? '',
    shipmentId: reference,
    serviceType,
    serviceMode,
    operationName: 'TrendyolPickingPreflight',
    endpoint,
    payloadFormat: 'JSON',
    outcome: {
      code: 'TRENDYOL_PICKING_UPDATE_FAILED',
      message,
      verificationStage: 'dispatch_rejected',
      errorCategory: 'TRENDYOL_PICKING_UPDATE_FAILED',
      hardError: true,
      verifiedShipment: false,
      hasTrackingNumber: false,
      hasBarcode: false,
      noTrackingReason: pickingUpdate.message,
      technicalZplReceived: false,
      operationalBarcodeVerified: false,
    },
    requestReference: reference,
    requestValidation,
    addressNormalization,
    trendyolPreflight: preflight,
  })

  return buildSuratDispatchRejectedFailure({
    message,
    errorCode: 'TRENDYOL_PICKING_UPDATE_FAILED',
    errorCategory: 'TRENDYOL_PICKING_UPDATE_FAILED',
    errorSource: 'Trendyol',
    endpoint,
    statusCode: Number(pickingUpdate.statusCode ?? 0),
    contentType: 'application/json',
    rawRequest: createLog.rawRequest,
    rawResponse: pickingUpdate.rawResponse ?? pickingUpdate.data ?? pickingUpdate.message,
    parsedResponse: pickingUpdate.data ?? { message: pickingUpdate.message },
    createLog,
    serviceType,
    payloadFormat: 'JSON',
    reference,
    marketplaceIntegrationCode: shipmentPayload.MarketplaceIntegrationCode,
    requestValidation,
    addressNormalization,
    trendyolPreflight: preflight,
    requestSent: false,
  })
}

async function createSuratRegisteredCommonBarcode(config, order, reference) {
  const dispatchRegistration = await createSuratLegacyRestJson(
    config,
    order,
    reference,
  )
  const registrationLog =
    dispatchRegistration.shipment?.suratCreateLog ??
    dispatchRegistration.suratCreateLog
  const registrationPayload = buildSuratShipmentPayload(order, reference)
  const marketplaceRegistration = resolveSuratMarketplaceRegistration(
    dispatchRegistration,
    registrationPayload,
  )
  const lifecycleEvidence =
    dispatchRegistration.shipment?.lifecycleEvidence ?? {}
  const registrationAccepted = Boolean(
    lifecycleEvidence.createAccepted ||
      dispatchRegistration.shipment?.lifecycleMilestones?.includes(
        'CREATE_ACCEPTED',
      ),
  )
  const shipmentRegistered = Boolean(
    lifecycleEvidence.shipmentRegistered ||
      dispatchRegistration.shipment?.lifecycleMilestones?.includes(
        'SHIPMENT_REGISTERED',
      ),
  )

  if (!registrationAccepted) {
    const dispatchRejected =
      dispatchRegistration.shipment?.lifecycleStatus ===
        'SURAT_DISPATCH_REJECTED' ||
      dispatchRegistration.shipment?.errorCategory ===
        'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
    return {
      ...dispatchRegistration,
      message: dispatchRejected
        ? dispatchRegistration.message
        : `Sürat gönderisi oluşturulamadı. API response: ${summarizeSuratApiResponse(
            dispatchRegistration,
          )}`,
      dispatchRegistration: {
        ok: false,
        endpoint: dispatchRegistration.endpoint,
        serviceType: dispatchRegistration.serviceType,
        responseStatus:
          dispatchRegistration.responseStatus ??
          dispatchRegistration.statusCode,
        responseCode:
          registrationLog?.responseCode ??
          dispatchRegistration.createDiagnostics?.code,
        responseMessage:
          registrationLog?.responseMessage ??
          dispatchRegistration.createDiagnostics?.message,
        rawRequest: registrationLog?.rawRequest,
        rawResponse: registrationLog?.rawResponse,
      },
    }
  }

  if (!shipmentRegistered) {
    return {
      ...dispatchRegistration,
      ok: false,
      message:
        'Sürat create isteği kabul edildi ancak read-only sorguda gönderi kaydı henüz bulunamadı. Etiket operasyonu çağrılmadı.',
      dispatchRegistration: {
        ok: false,
        createAccepted: true,
        shipmentRegistered: false,
        endpoint: dispatchRegistration.endpoint,
        serviceType: dispatchRegistration.serviceType,
        responseStatus:
          dispatchRegistration.responseStatus ??
          dispatchRegistration.statusCode,
        responseCode:
          registrationLog?.responseCode ??
          dispatchRegistration.createDiagnostics?.responseCategory,
        responseMessage:
          registrationLog?.responseMessage ??
          dispatchRegistration.createDiagnostics?.message,
        rawRequest: registrationLog?.rawRequest,
        rawResponse: registrationLog?.rawResponse,
      },
      barcodeCreation: {
        ok: false,
        skipped: true,
        reason: 'SHIPMENT_NOT_REGISTERED',
      },
    }
  }

  const commonBarcodeResult = await createSuratCommonBarcodeSoap(
    config,
    order,
    reference,
    {
      operationName: 'OrtakBarkodOlustur',
      serviceType: 'OrtakBarkodOlusturSoap',
      strictGonderiModel: true,
    },
  )
  const barcodeLog =
    commonBarcodeResult.shipment?.suratCreateLog ??
    commonBarcodeResult.suratCreateLog
  const dispatchRegistrationSummary = {
    ok: shipmentRegistered,
    createAccepted: registrationAccepted,
    shipmentRegistered,
    providerRegistrationConfirmed: shipmentRegistered,
    serdendipVerified: Boolean(
      dispatchRegistration.shipment?.verifiedShipment,
    ),
    endpoint: dispatchRegistration.endpoint,
    serviceType: dispatchRegistration.serviceType,
    responseStatus:
      dispatchRegistration.responseStatus ??
      dispatchRegistration.statusCode,
    responseCode:
      registrationLog?.responseCode ??
      dispatchRegistration.createDiagnostics?.code,
    responseMessage:
      registrationLog?.responseMessage ??
      dispatchRegistration.createDiagnostics?.message,
    duplicateShipment: Boolean(
      registrationLog?.duplicateShipment ??
        dispatchRegistration.createDiagnostics?.duplicateShipment ??
        marketplaceRegistration.accepted,
    ),
    marketplaceRegistration,
    responseCategory:
      registrationLog?.responseCategory ??
      dispatchRegistration.createDiagnostics?.responseCategory,
    rawRequest: registrationLog?.rawRequest,
    rawResponse: registrationLog?.rawResponse,
  }

  if (!commonBarcodeResult.ok) {
    return {
      ...commonBarcodeResult,
      message: `${SURAT_INVALID_CODES_MESSAGE} API response: ${summarizeSuratApiResponse(
        commonBarcodeResult,
      )}`,
      dispatchRegistration: dispatchRegistrationSummary,
      barcodeCreation: {
        ok: false,
        endpoint: commonBarcodeResult.endpoint,
        serviceType: commonBarcodeResult.serviceType,
        responseStatus:
          commonBarcodeResult.responseStatus ??
          commonBarcodeResult.statusCode,
        rawRequest: barcodeLog?.rawRequest,
        rawResponse: barcodeLog?.rawResponse,
      },
      shipment: commonBarcodeResult.shipment
        ? {
            ...commonBarcodeResult.shipment,
            dispatchRegistrationConfirmed: true,
            providerRegistrationConfirmed: true,
            dispatchRegistration: dispatchRegistrationSummary,
          }
        : commonBarcodeResult.shipment,
    }
  }

  let resolvedCommonBarcodeResult = commonBarcodeResult
  if (
    commonBarcodeResult.shipment?.technicalZplReceived &&
    !commonBarcodeResult.shipment?.operationalBarcodeVerified
  ) {
    const operationalBarcodeResolution =
      await resolveSuratOperationalBarcode(config, order, {
        shipmentId:
          commonBarcodeResult.shipment?.shipmentCode ?? reference,
        internalWebBarcode:
          commonBarcodeResult.shipment?.internalWebBarcode,
        zplAnalysis:
          commonBarcodeResult.shipment?.zplAnalysis,
      })
    if (operationalBarcodeResolution.operationalBarcodeVerified) {
      resolvedCommonBarcodeResult = {
        ...commonBarcodeResult,
        operationalBarcodeResolution,
        shipment: {
          ...commonBarcodeResult.shipment,
          suratOperationalBarcodeLog: operationalBarcodeResolution,
          operationalBarcodeVerified: true,
          verifiedShipment: true,
          verificationStage: 'operational_barcode_verified',
          finalSuratBarcode: operationalBarcodeResolution.BarkodNo,
          barcode: operationalBarcodeResolution.BarkodNo,
          barcodeValue: operationalBarcodeResolution.BarkodNo,
          barcodeSource: 'surat.KargoBarkodu.BarkodNo',
          tNo: operationalBarcodeResolution.KargoTakipNo,
          trackingNumber: operationalBarcodeResolution.KargoTakipNo,
          kargoTakipNo: operationalBarcodeResolution.KargoTakipNo,
          trackingSource: 'surat.KargoBarkodu.KargoTakipNo',
          lifecycleStatus: 'LABEL_READY',
          labelStatus: 'READY',
          printEnabled: true,
          zplReady: true,
        },
      }
    }
  }

  if (
    resolvedCommonBarcodeResult.shipment?.technicalZplReceived &&
    !resolvedCommonBarcodeResult.shipment?.operationalBarcodeVerified
  ) {
    const automaticTrackingVerification =
      await runAutomaticSuratTrackingVerification(config, order, {
        shipmentId:
          resolvedCommonBarcodeResult.shipment?.shipmentCode ?? reference,
        internalWebBarcode:
          resolvedCommonBarcodeResult.shipment?.internalWebBarcode,
        zplAnalysis:
          resolvedCommonBarcodeResult.shipment?.zplAnalysis,
      })
    const trackingLog =
      automaticTrackingVerification?.suratTrackingLog
    const trackedBarcode = firstNonEmpty(
      isNumericSuratOperationalCode(trackingLog?.BarkodNo)
        ? trackingLog.BarkodNo
        : '',
      isNumericSuratOperationalCode(trackingLog?.Barkod)
        ? trackingLog.Barkod
        : '',
    )
    const trackedTNo = firstNonEmpty(
      isOperationalSuratTNo(trackingLog?.TNo)
        ? trackingLog.TNo
        : '',
      isOperationalSuratTNo(trackingLog?.TakipNo)
        ? trackingLog.TakipNo
        : '',
    )
    const operationalBarcodeVerified = Boolean(
      Number(automaticTrackingVerification?.gonderilerLength ?? 0) > 0 &&
        trackedBarcode &&
        trackedTNo,
    )
    resolvedCommonBarcodeResult = {
      ...resolvedCommonBarcodeResult,
      automaticTrackingVerification,
      shipment: {
        ...resolvedCommonBarcodeResult.shipment,
        suratTrackingLog: trackingLog,
        operationalBarcodeVerified,
        verifiedShipment: operationalBarcodeVerified,
        verificationStage: operationalBarcodeVerified
          ? 'operational_barcode_verified'
          : 'zpl_received_but_not_operationally_verified',
        finalSuratBarcode:
          trackedBarcode ||
          resolvedCommonBarcodeResult.shipment?.finalSuratBarcode,
        barcode:
          trackedBarcode ||
          resolvedCommonBarcodeResult.shipment?.barcode,
        barcodeValue:
          trackedBarcode ||
          resolvedCommonBarcodeResult.shipment?.barcodeValue,
        tNo:
          trackedTNo ||
          resolvedCommonBarcodeResult.shipment?.tNo,
        trackingNumber:
          trackedTNo ||
          resolvedCommonBarcodeResult.shipment?.trackingNumber,
        kargoTakipNo:
          trackedTNo ||
          resolvedCommonBarcodeResult.shipment?.kargoTakipNo,
        lifecycleStatus: operationalBarcodeVerified
          ? 'LABEL_READY'
          : 'SURAT_TRACKING_MISSING',
        labelStatus: operationalBarcodeVerified ? 'READY' : 'BLOCKED',
        printEnabled: operationalBarcodeVerified,
        zplReady: true,
      },
    }
  }

  return {
    ...resolvedCommonBarcodeResult,
    message: resolvedCommonBarcodeResult.shipment?.operationalBarcodeVerified
      ? 'Sürat gönderi kaydı kabul edildi; numeric ana barkod ve T.No operasyonel olarak doğrulandı.'
      : 'Sürat gönderi kaydı kabul edildi ve teknik ZPL alındı; ancak numeric ana barkod/T.No operasyonel olarak doğrulanamadı. Etiket yazdırma engellendi.',
    dispatchRegistration: dispatchRegistrationSummary,
    barcodeCreation: {
      ok: true,
      endpoint: commonBarcodeResult.endpoint,
      serviceType: commonBarcodeResult.serviceType,
      responseStatus:
        commonBarcodeResult.responseStatus ??
        commonBarcodeResult.statusCode,
      KargoTakipNo:
        barcodeLog?.KargoTakipNo ??
        commonBarcodeResult.shipment?.kargoTakipNo,
      Barcode:
        barcodeLog?.Barcode ??
        commonBarcodeResult.shipment?.barcode,
      TNo:
        barcodeLog?.codeMapping?.tNoValue ??
        commonBarcodeResult.shipment?.tNo,
      codeCandidates: barcodeLog?.codeCandidates,
      codeMapping: barcodeLog?.codeMapping,
      isError: false,
      technicalZplReceived:
        resolvedCommonBarcodeResult.shipment?.technicalZplReceived,
      operationalBarcodeVerified:
        resolvedCommonBarcodeResult.shipment?.operationalBarcodeVerified,
      verificationStage:
        resolvedCommonBarcodeResult.shipment?.verificationStage,
      zplAnalysis:
        resolvedCommonBarcodeResult.shipment?.zplAnalysis,
      rawRequest: barcodeLog?.rawRequest,
      rawResponse: barcodeLog?.rawResponse,
    },
    shipment: {
      ...resolvedCommonBarcodeResult.shipment,
      dispatchRegistrationConfirmed: shipmentRegistered,
      providerRegistrationConfirmed: shipmentRegistered,
      dispatchRegistration: dispatchRegistrationSummary,
    },
  }
}

async function runAutomaticSuratTrackingVerification(
  config,
  order,
  { shipmentId, internalWebBarcode, zplAnalysis } = {},
) {
  void internalWebBarcode
  void zplAnalysis
  const queryReference = buildSuratQueryReference(
    order?.cargoTrackingNumber,
    'WEB_SIPARIS_KODU',
    'order.cargoTrackingNumber -> createRequest.OzelKargoTakipNo',
  )
  if (!queryReference.ok) return undefined
  const requestBody = {
    orderId: order?.id,
    shipmentId,
    webSiparisKodu: queryReference.value,
    queryReference,
  }
  const result =
    config.trackingServiceType === 'KargoTakipHareketDetayiRest'
      ? await trackShipmentRest(config, queryReference.value, requestBody)
      : await trackShipmentSoap(config, queryReference.value, requestBody)
  result.trackingReference = queryReference.value
  result.trackingReferenceType = queryReference.type
  result.trackingReferenceSource = queryReference.source
  result.trackingAttempts = [
    buildTrackingAttemptDebug(queryReference.value, result, queryReference),
  ]
  return result
}

async function resolveSuratOperationalBarcode(
  config,
  order,
  { shipmentId, internalWebBarcode, zplAnalysis } = {},
) {
  void internalWebBarcode
  void zplAnalysis
  const ozelKargoTakipNo = String(order?.cargoTrackingNumber ?? '').trim()
  if (!ozelKargoTakipNo) {
    return {
      ok: false,
      source: 'real',
      operationType: 'RESOLVE_OPERATIONAL_BARCODE',
      endpoint: 'KargoBarkodu',
      serviceType: 'KargoBarkoduSoap',
      attempts: [],
      operationalBarcodeVerified: false,
      KargoTakipNo: '',
      BarkodNo: '',
      queryReferenceType: 'OZEL_KARGO_TAKIP_NO',
      queryReferenceSource:
        'order.cargoTrackingNumber -> createRequest.OzelKargoTakipNo',
      message:
        'KargoBarkodu sorgusu için createRequest.OzelKargoTakipNo bulunamadı.',
    }
  }
  const attempts = []
  const registeredShipment = await callSuratWebSiparisKodu(
    config,
    ozelKargoTakipNo,
    {
      orderId: order?.id,
      shipmentId,
    },
  )
  const registeredShipmentAttempt = {
    ...registeredShipment,
    queryReferenceType: 'WEB_SIPARIS_KODU',
    queryReferenceSource:
      'order.cargoTrackingNumber -> createRequest.OzelKargoTakipNo',
  }
  attempts.push(registeredShipmentAttempt)
  if (registeredShipment.operationalBarcodeVerified) {
    return {
      ...registeredShipmentAttempt,
      attempts,
    }
  }

  const webPasswordInfo = resolveSuratWebPassword(config)
  if (!webPasswordInfo.value || webPasswordInfo.matchesShipmentPassword) {
    return {
      ok: false,
      source: 'real',
      operationType: 'RESOLVE_OPERATIONAL_BARCODE',
      endpoint: 'WebSiparisKodu',
      serviceType: 'WebSiparisKoduSoap',
      attempts,
      operationalBarcodeVerified: false,
      KargoTakipNo: '',
      BarkodNo: '',
      queryReferenceType: 'WEB_SIPARIS_KODU',
      queryReferenceSource:
        'order.cargoTrackingNumber -> createRequest.OzelKargoTakipNo',
      message:
        'WebSiparisKodu servisi kayitli T.No/Barkod dondurmedi. Ayrica ayri e-Surat WebPassword tanimli olmadigi icin KargoBarkodu yedek sorgusu calistirilmadi.',
    }
  }

  const result = await callSuratKargoBarkodu(config, ozelKargoTakipNo, {
    orderId: order?.id,
    shipmentId,
  })
  const attempt = {
    ...result,
    queryReferenceType: 'OZEL_KARGO_TAKIP_NO',
    queryReferenceSource:
      'order.cargoTrackingNumber -> createRequest.OzelKargoTakipNo',
  }
  attempts.push(attempt)
  if (result.operationalBarcodeVerified) {
    return {
      ...attempt,
      attempts,
    }
  }
  return {
    ok: false,
    source: 'real',
    operationType: 'RESOLVE_OPERATIONAL_BARCODE',
    endpoint: 'KargoBarkodu',
    serviceType: 'KargoBarkoduSoap',
    attempts,
    operationalBarcodeVerified: false,
    KargoTakipNo: '',
    BarkodNo: '',
    queryReferenceType: 'OZEL_KARGO_TAKIP_NO',
    queryReferenceSource:
      'order.cargoTrackingNumber -> createRequest.OzelKargoTakipNo',
    message:
      'KargoBarkodu servisi createRequest.OzelKargoTakipNo ile numeric final barkod/T.No döndürmedi.',
  }
}

async function callSuratWebSiparisKodu(
  config,
  webSiparisKodu,
  { orderId = '', shipmentId = '' } = {},
) {
  const soap = await callSuratSoap(
    'WebSiparisKodu',
    `
      <GonderenCariKodu>${xmlEscape(config.kullaniciAdi)}</GonderenCariKodu>
      <Sifre>${xmlEscape(config.sifre)}</Sifre>
      <WebSiparisKodu>${xmlEscape(webSiparisKodu)}</WebSiparisKodu>
    `,
  )
  const parsed = parseSuratWebSiparisKoduResult(soap.text)
  const referenceMatches = Boolean(
    parsed.WebSiparisKodu &&
      normalizeSuratCodeForComparison(parsed.WebSiparisKodu) ===
        normalizeSuratCodeForComparison(webSiparisKodu),
  )
  const operationalBarcodeVerified = Boolean(
    soap.ok &&
      parsed.rowCount > 0 &&
      referenceMatches &&
      isOperationalSuratTNo(parsed.KargoTakipNo) &&
      isNumericSuratOperationalCode(parsed.BarkodNo),
  )

  return {
    ok: soap.ok,
    source: 'real',
    operationType: 'RESOLVE_OPERATIONAL_BARCODE',
    operationName: 'WebSiparisKodu',
    endpoint: 'WebSiparisKodu',
    serviceType: 'WebSiparisKoduSoap',
    payloadFormat: 'SOAP/XML',
    statusCode: soap.statusCode,
    responseStatus: soap.statusCode,
    contentType: soap.contentType,
    orderId,
    shipmentId,
    queryValue: webSiparisKodu,
    WebSiparisKodu: parsed.WebSiparisKodu,
    KargoTakipNo: parsed.KargoTakipNo,
    BarkodNo: parsed.BarkodNo,
    rowCount: parsed.rowCount,
    referenceMatches,
    operationalBarcodeVerified,
    trackingSource: 'surat.WebSiparisKodu.TakipNo',
    barcodeSource: 'surat.WebSiparisKodu.Barkod',
    rawRequest: redactSuratRawRequest(soap.body),
    rawResponse: soap.text,
    parsedResponse: parsed,
    message: operationalBarcodeVerified
      ? 'WebSiparisKodu servisi ayni musteri referansi icin T.No ve ana barkodu dondurdu.'
      : parsed.rowCount > 0
        ? 'WebSiparisKodu kaydi bulundu ancak referans/T.No/Barkod dogrulamasi gecmedi.'
        : 'WebSiparisKodu servisi bu musteri referansi icin kayit dondurmedi.',
  }
}

function parseSuratWebSiparisKoduResult(responseXml = '') {
  const text = decodeXml(String(responseXml ?? ''))
  const rows = Array.from(
    text.matchAll(
      /<(?:[^:>]+:)?Table(?:\s[^>]*)?>([\s\S]*?)<\/(?:[^:>]+:)?Table>/gi,
    ),
    (match) => match[1],
  )
  const rowCount = rows.length
  const firstRow = rows[0] || ''
  return {
    rowCount,
    WebSiparisKodu:
      rowCount > 0
        ? decodeXml(extractTag(firstRow, 'WebSiparisKodu')).trim()
        : '',
    KargoTakipNo:
      rowCount > 0
        ? firstNonEmpty(
            decodeXml(extractTag(firstRow, 'TakipNo')).trim(),
            decodeXml(extractTag(firstRow, 'KargoTakipNo')).trim(),
          )
        : '',
    BarkodNo:
      rowCount > 0
        ? firstNonEmpty(
            decodeXml(extractTag(firstRow, 'Barkod')).trim(),
            decodeXml(extractTag(firstRow, 'BarkodNo')).trim(),
          )
        : '',
    Durum:
      rowCount > 0 ? decodeXml(extractTag(firstRow, 'Durum')).trim() : '',
  }
}

async function createSuratBarcodeOrderSoap(config, order, reference) {
  const serviceType = 'KargoBarkoduSiparisSoap'
  const serviceMode = 'KARGO_BARKODU_SIPARIS_SOAP'
  const endpoint = `${SURAT_SOAP_URL}#KargoBarkoduSiparis`
  let payload
  try {
    payload = buildSuratShipmentPayload(order, reference, {
      commonBarcode: true,
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'KargoBarkoduSiparis iÃ§in gÃ¶nderi payload oluÅŸturulamadÄ±.'
    return buildSuratCreateFailure({
      message,
      errorCode: 'SURAT_PAYLOAD_INVALID',
      errorSource: 'CargoFlow',
      endpoint,
      statusCode: 0,
      contentType: 'application/json',
      rawRequest: { skipped: true, reason: message, orderNumber: order?.orderNumber },
      rawResponse: message,
      parsedResponse: { message },
      createLog: undefined,
      serviceType,
      payloadFormat: 'SOAP/XML',
      reference,
      operationName: 'KargoBarkoduSiparis',
      failedBarcodeValidation: true,
      marketplaceIntegrationCode: order?.cargoTrackingNumber,
    })
  }

  const requestValidation = validateSuratRequestMapping(order, payload)
  const addressNormalization = buildAddressNormalizationDebug(order)
  enrichKargoBarkoduSiparisPayload(payload, config, order)
  const webPasswordInfo = resolveSuratWebPassword(config)
  if (!webPasswordInfo.value) {
    const message =
      'SÃ¼rat KargoBarkoduSiparis iÃ§in WebPassword eksik. e-SÃ¼rat panelindeki kargo sorgulama/web ÅŸifresi girilmeden SÃ¼rat PDF barkod alÄ±namaz.'
    const createLog = buildSuratCreateLog({
      rawRequest: {
        skipped: true,
        reason: message,
        intendedOperation: 'KargoBarkoduSiparis',
        intendedPayload: payload,
        webPasswordProvided: false,
      },
      rawResponse: message,
      responseStatus: 0,
      contentType: 'application/json',
      parsedResponse: { message, webPasswordProvided: false },
      orderId: order?.id ?? '',
      shipmentId: reference,
      serviceType,
      serviceMode,
      operationName: 'KargoBarkoduSiparis',
      endpoint,
      payloadFormat: 'SOAP/XML',
      outcome: {
        code: 'WEB_PASSWORD_MISSING',
        message,
        verificationStage: 'failed',
        errorCategory: 'SURAT_WEB_PASSWORD_MISSING',
        hardError: true,
        verifiedShipment: false,
        hasTrackingNumber: false,
        hasBarcode: false,
        noTrackingReason: message,
        technicalZplReceived: false,
        operationalBarcodeVerified: false,
      },
      requestReference: reference,
      requestValidation,
      addressNormalization,
    })
    return buildSuratCreateFailure({
      message,
      errorCode: 'SURAT_WEB_PASSWORD_MISSING',
      errorSource: 'SÃ¼rat',
      endpoint,
      statusCode: 0,
      contentType: 'application/json',
      rawRequest: createLog.rawRequest,
      rawResponse: message,
      parsedResponse: { message },
      createLog,
      serviceType,
      payloadFormat: 'SOAP/XML',
      reference,
      operationName: 'KargoBarkoduSiparis',
      failedBarcodeValidation: true,
      marketplaceIntegrationCode: payload.MarketplaceIntegrationCode,
    })
  }

  const innerXml = `
      <cariKodu>${xmlEscape(config.kullaniciAdi)}</cariKodu>
      <WebPassword>${xmlEscape(webPasswordInfo.value)}</WebPassword>
      ${buildSuratGonderiEntityXml(payload)}
  `
  const soap = await callSuratSoap('KargoBarkoduSiparis', innerXml)
  const resultXml =
    extractTag(soap.text, 'KargoBarkoduSiparisResult') || soap.text
  const parsed = parseKargoBarkoduSiparisResult(resultXml, {
    fallbackReference: payload.OzelKargoTakipNo || payload.ReferansNo,
  })
  const operationalBarcodeVerified = Boolean(
    isOperationalSuratTNo(parsed.KargoTakipNo) &&
      isNumericSuratOperationalCode(parsed.BarkodNo),
  )
  const objectReferenceFailure = /object reference/i.test(parsed.Aciklama || '')
  const integrationContractConfigured =
    Number(payload.EntegrasyonSozlesme ?? 0) > 0
  const failureCode = objectReferenceFailure
    ? integrationContractConfigured
      ? 'SURAT_WEB_PASSWORD_INVALID_OR_PERMISSION_MISSING'
      : 'SURAT_BARCODE_SERVICE_ACCOUNT_SETUP_OR_CONTRACT_MISSING'
    : 'SURAT_KARGO_BARKODU_SIPARIS_NO_CODES'
  const noTrackingReason = operationalBarcodeVerified
    ? ''
    : buildKargoBarkoduSiparisNoTrackingReason(parsed, webPasswordInfo)
  const outcome = {
    code: operationalBarcodeVerified ? 'KARGO_BARKODU_SIPARIS_OK' : 'KARGO_BARKODU_SIPARIS_NO_CODES',
    responseCategory: operationalBarcodeVerified ? 'BARCODE_SUCCESS' : 'ERROR',
    responseDescription: operationalBarcodeVerified
      ? 'KargoBarkoduSiparis KargoTakipNo, BarkodNo ve PDF barkod dÃ¶ndÃ¼.'
      : 'KargoBarkoduSiparis operasyonel T.No/BarkodNo dÃ¶ndÃ¼rmedi.',
    responseDocumented: true,
    message:
      parsed.Aciklama ||
      (operationalBarcodeVerified
        ? 'SÃ¼rat KargoBarkoduSiparis baÅŸarÄ±lÄ±. T.No, ana barkod ve PDF etiket alÄ±ndÄ±.'
        : noTrackingReason),
    barcodeResponseCodeDetected: operationalBarcodeVerified,
    officialTrackingNumber: parsed.KargoTakipNo,
    officialBarcode: parsed.BarkodNo,
    officialBarcodeRaw: '',
    codeCandidates: {
      kargoTakipNo: parsed.KargoTakipNo,
      barkodNo: parsed.BarkodNo,
      ozelKargoTakipNo: parsed.OzelKargoTakipNo,
    },
    codeMapping: {
      trackingField: 'KargoTakipNo',
      barcodeField: 'BarkodNo',
      tNoField: 'KargoTakipNo',
      trackingValue: parsed.KargoTakipNo,
      barcodeValue: parsed.BarkodNo,
      tNoValue: parsed.KargoTakipNo,
    },
    technicalZplReceived: false,
    operationalBarcodeVerified,
    verificationStage: operationalBarcodeVerified
      ? 'operational_barcode_verified'
      : 'failed',
    errorCategory: operationalBarcodeVerified
      ? ''
      : failureCode,
    hasTrackingNumber: Boolean(parsed.KargoTakipNo),
    hasBarcode: Boolean(parsed.BarkodNo),
    verifiedShipment: operationalBarcodeVerified,
    noTrackingReason,
    hardError: !operationalBarcodeVerified,
    retryable: false,
    preRegistrationOnly: false,
    pdfBarkodAvailable: parsed.hasPdfBarkod,
    pdfBarkodLength: parsed.PdfBarkod.length,
  }
  const createLog = buildSuratCreateLog({
    rawRequest: soap.body,
    rawResponse: soap.text,
    responseStatus: soap.statusCode,
    contentType: soap.contentType,
    parsedResponse: {
      ...parsed,
      PdfBarkod: parsed.PdfBarkod
        ? `[base64:${parsed.PdfBarkod.length} chars]`
        : '',
    },
    orderId: order?.id ?? '',
    shipmentId: reference,
    serviceType,
    serviceMode,
    operationName: 'KargoBarkoduSiparis',
    endpoint,
    payloadFormat: 'SOAP/XML',
    outcome,
    requestReference: reference,
    requestValidation,
    addressNormalization,
    trendyolPreflight: buildTrendyolShipmentPreflight(order),
  })
  createLog.webPasswordProvided = true
  createLog.webPasswordSource = webPasswordInfo.source
  createLog.webPasswordFallbackUsed = webPasswordInfo.fallbackUsed
  createLog.credentialSelection = {
    name: config.selectedCredentialSet || 'seller_pays',
    maskedAccount: config.selectedCredentialMaskedAccount ||
      maskCarrierAccount(config.kullaniciAdi),
    cashOnDelivery: config.cashOnDelivery === true,
  }
  createLog.PdfBarkodAvailable = parsed.hasPdfBarkod
  createLog.PdfBarkodLength = parsed.PdfBarkod.length
  createLog.BarkodNoList = parsed.BarkodNoList
  createLog.suratBarcodeOrderDetail = parsed.Detay
  createLog.noTrackingDiagnosis = noTrackingReason

  if (operationalBarcodeVerified) {
    const success = buildSuratCreateSuccess({
      serviceType,
      endpoint,
      payloadFormat: 'SOAP/XML',
      statusCode: soap.statusCode,
      rawResponse: soap.text,
      parsedResponse: {
        ...parsed,
        PdfBarkod: parsed.PdfBarkod
          ? `[base64:${parsed.PdfBarkod.length} chars]`
          : '',
      },
      createLog,
      outcome,
      reference,
      marketplaceIntegrationCode: payload.MarketplaceIntegrationCode,
    })
    const createResult = {
      ...success,
      message: 'SÃ¼rat KargoBarkoduSiparis baÅŸarÄ±lÄ±: T.No, ana barkod ve PDF etiket alÄ±ndÄ±.',
      shipment: {
        ...success.shipment,
        tNo: parsed.KargoTakipNo,
        barkodNo: parsed.BarkodNo,
        barcode: parsed.BarkodNo,
        barcodeValue: parsed.BarkodNo,
        finalSuratBarcode: parsed.BarkodNo,
        barcodeSource: 'surat.KargoBarkoduSiparis.BarkodNo',
        trackingSource: 'surat.KargoBarkoduSiparis.KargoTakipNo',
        labelPdfBase64: parsed.PdfBarkod,
        pdfBarkodBase64: parsed.PdfBarkod,
        pdfLabelSource: 'surat.KargoBarkoduSiparis.PdfBarkod',
        hasPdfBarkod: parsed.hasPdfBarkod,
        pdfReady: parsed.hasPdfBarkod,
        dispatchRegistrationConfirmed: true,
        suratOperationalBarcodeLog: {
          ...createLog,
          KargoTakipNo: parsed.KargoTakipNo,
          BarkodNo: parsed.BarkodNo,
          BarkodNoList: parsed.BarkodNoList,
          operationalBarcodeVerified: true,
          endpoint: 'KargoBarkoduSiparis',
          serviceType,
        },
        zplReady: false,
        zplSource: parsed.hasPdfBarkod
          ? 'surat.KargoBarkoduSiparis.PdfBarkod'
          : 'generated',
        printEnabled: true,
        labelStatus: 'READY',
      },
      download: parsed.hasPdfBarkod
        ? {
            format: 'pdf',
            fileName: `surat-etiket-${order?.orderNumber || reference}.pdf`,
            base64: parsed.PdfBarkod,
          }
        : undefined,
    }
    return verifySuratCreateResultWithTracking({
      config,
      order,
      reference,
      createResult,
      shipmentPayload: payload,
      createLog,
      outcome,
    })
  }

  const message = `${SURAT_INVALID_CODES_MESSAGE} ${noTrackingReason}`.trim()
  return buildSuratCreateFailure({
    message,
    errorCode: failureCode,
    errorSource: 'SÃ¼rat',
    endpoint,
    statusCode: soap.statusCode,
    contentType: soap.contentType,
    rawRequest: soap.body,
    rawResponse: soap.text,
    parsedResponse: {
      ...parsed,
      PdfBarkod: parsed.PdfBarkod
        ? `[base64:${parsed.PdfBarkod.length} chars]`
        : '',
    },
    createLog,
    serviceType,
    payloadFormat: 'SOAP/XML',
    reference,
    operationName: 'KargoBarkoduSiparis',
    failedBarcodeValidation: true,
    marketplaceIntegrationCode: payload.MarketplaceIntegrationCode,
  })
}

async function callSuratKargoBarkodu(
  config,
  ozelKargoTakipNo,
  { orderId = '', shipmentId = '' } = {},
) {
  const webPasswordInfo = resolveSuratWebPassword(config)
  if (!webPasswordInfo.value) {
    return {
      ok: false,
      source: 'real',
      operationType: 'RESOLVE_OPERATIONAL_BARCODE',
      endpoint: 'KargoBarkodu',
      serviceType: 'KargoBarkoduSoap',
      payloadFormat: 'SOAP/XML',
      statusCode: 0,
      responseStatus: 0,
      contentType: 'application/json',
      orderId,
      shipmentId,
      queryValue: ozelKargoTakipNo,
      KargoTakipNo: '',
      BarkodNo: '',
      BarkodNoList: [],
      OzelKargoTakipNo: ozelKargoTakipNo,
      Aciklama:
        'KargoBarkodu sorgusu için WebPassword / Sorgulama Şifresi eksik.',
      hasPdfBarkod: false,
      operationalBarcodeVerified: false,
      rawRequest: {
        skipped: true,
        reason:
          'KargoBarkodu sorgusu için WebPassword / Sorgulama Şifresi eksik.',
        operationName: 'KargoBarkodu',
      },
      rawResponse: '',
      parsedResponse: {
        OzelKargoTakipNo: ozelKargoTakipNo,
        KargoTakipNo: '',
        Aciklama:
          'KargoBarkodu sorgusu için WebPassword / Sorgulama Şifresi eksik.',
        BarkodNoList: [],
        BarkodNo: '',
      },
      message:
        'KargoBarkodu sorgusu için WebPassword / Sorgulama Şifresi eksik.',
    }
  }
  const soap = await callSuratSoap(
    'KargoBarkodu',
    `
      <cariKodu>${xmlEscape(config.kullaniciAdi)}</cariKodu>
      <WebPassword>${xmlEscape(webPasswordInfo.value)}</WebPassword>
      <ozelKargoTakipNo>${xmlEscape(ozelKargoTakipNo)}</ozelKargoTakipNo>
    `,
  )
  const resultXml =
    extractTag(soap.text, 'KargoBarkoduResult') || soap.text
  const parsed = parseKargoBarkoduResult(resultXml, ozelKargoTakipNo)
  const operationalBarcodeVerified = Boolean(
    isOperationalSuratTNo(parsed.KargoTakipNo) &&
      isNumericSuratOperationalCode(parsed.BarkodNo),
  )
  return {
    ok: soap.ok,
    source: 'real',
    operationType: 'RESOLVE_OPERATIONAL_BARCODE',
    endpoint: 'KargoBarkodu',
    serviceType: 'KargoBarkoduSoap',
    payloadFormat: 'SOAP/XML',
    statusCode: soap.statusCode,
    responseStatus: soap.statusCode,
    contentType: soap.contentType,
    orderId,
    shipmentId,
    queryValue: ozelKargoTakipNo,
    KargoTakipNo: parsed.KargoTakipNo,
    BarkodNo: parsed.BarkodNo,
    BarkodNoList: parsed.BarkodNoList,
    OzelKargoTakipNo: parsed.OzelKargoTakipNo,
    Aciklama: parsed.Aciklama,
    hasPdfBarkod: parsed.hasPdfBarkod,
    operationalBarcodeVerified,
    rawRequest: redactSuratRawRequest(soap.body),
    rawResponse: soap.text,
    parsedResponse: parsed,
    message:
      parsed.Aciklama ||
      (operationalBarcodeVerified
        ? 'KargoBarkodu servisi KargoTakipNo ve numeric BarkodNo dÃ¶ndÃ¼rdÃ¼.'
        : 'KargoBarkodu servisi operasyonel T.No/numeric barkod dÃ¶ndÃ¼rmedi.'),
  }
}

function parseKargoBarkoduResult(resultXml, fallbackReference = '') {
  const text = decodeXml(String(resultXml ?? ''))
  const barkodNoList = uniqueStrings([
    ...Array.from(text.matchAll(/<BarkodNo>\s*<string>([\s\S]*?)<\/string>\s*<\/BarkodNo>/gi)).map(
      (match) => decodeXml(match[1]).trim(),
    ),
    ...Array.from(text.matchAll(/<string>([\s\S]*?)<\/string>/gi)).map(
      (match) => decodeXml(match[1]).trim(),
    ),
    extractTag(text, 'BarkodNo'),
  ]).filter(Boolean)
  return {
    OzelKargoTakipNo:
      decodeXml(extractTag(text, 'OzelKargoTakipNo')).trim() ||
      String(fallbackReference ?? ''),
    KargoTakipNo: decodeXml(extractTag(text, 'KargoTakipNo')).trim(),
    Aciklama: decodeXml(extractTag(text, 'Aciklama')).trim(),
    BarkodNoList: barkodNoList,
    BarkodNo:
      barkodNoList.find((value) => isNumericSuratOperationalCode(value)) ?? '',
    hasPdfBarkod: Boolean(decodeXml(extractTag(text, 'PdfBarkod')).trim()),
    raw: text,
  }
}

function parseKargoBarkoduSiparisResult(resultXml, { fallbackReference = '' } = {}) {
  const text = decodeXml(String(resultXml ?? ''))
  const barkodNoList = uniqueStrings([
    ...extractAllTagValues(text, 'BarkodNo')
      .flatMap((value) => [
        value,
        ...extractAllTagValues(value, 'string'),
      ]),
    ...extractAllTagValues(text, 'string'),
  ])
    .map((value) => decodeXml(value).trim())
    .filter(Boolean)
  const pdfBarkod = firstNonEmpty(
    extractTag(text, 'PdfBarkod'),
    extractTag(text, 'PDFBarkod'),
  )
  const ppdBarkod = firstNonEmpty(
    extractTag(text, 'PpdBarkod'),
    extractTag(text, 'PPDBarkod'),
  )
  return {
    OzelKargoTakipNo:
      decodeXml(extractTag(text, 'OzelKargoTakipNo')).trim() ||
      String(fallbackReference ?? ''),
    KargoTakipNo: decodeXml(extractTag(text, 'KargoTakipNo')).trim(),
    Aciklama: decodeXml(extractTag(text, 'Aciklama')).trim(),
    BarkodNoList: barkodNoList,
    BarkodNo:
      barkodNoList.find((value) => isNumericSuratOperationalCode(value)) ?? '',
    PdfBarkod: decodeXml(pdfBarkod).replace(/\s+/g, '').trim(),
    PpdBarkod: decodeXml(ppdBarkod).replace(/\s+/g, '').trim(),
    hasPdfBarkod: Boolean(decodeXml(pdfBarkod).trim()),
    Detay: parseKargoBarkoduSiparisDetail(text),
    raw: text,
  }
}

function parseDiagnosticSuratLastResponse(lastResponse) {
  if (!lastResponse) return null
  if (typeof lastResponse === 'string') {
    return parseKargoBarkoduSiparisResult(lastResponse)
  }
  const candidate =
    lastResponse.parsedResponse ??
    lastResponse.shipment?.rawResponse?.parsedResponse ??
    lastResponse.suratCreateLog?.parsedResponse ??
    lastResponse.rawResponse ??
    lastResponse
  if (typeof candidate === 'string') {
    return parseKargoBarkoduSiparisResult(candidate)
  }
  return {
    OzelKargoTakipNo: String(candidate.OzelKargoTakipNo ?? ''),
    KargoTakipNo: String(candidate.KargoTakipNo ?? candidate.tNo ?? ''),
    Aciklama: String(candidate.Aciklama ?? candidate.message ?? ''),
    BarkodNoList: Array.isArray(candidate.BarkodNoList)
      ? candidate.BarkodNoList.map((value) => String(value)).filter(Boolean)
      : Array.isArray(candidate.BarkodNo)
        ? candidate.BarkodNo.map((value) => String(value)).filter(Boolean)
        : String(candidate.BarkodNo ?? '')
          ? [String(candidate.BarkodNo)]
          : [],
    BarkodNo:
      (Array.isArray(candidate.BarkodNoList)
        ? candidate.BarkodNoList.find((value) =>
            isNumericSuratOperationalCode(String(value)),
          )
        : '') ||
      (isNumericSuratOperationalCode(String(candidate.BarkodNo ?? ''))
        ? String(candidate.BarkodNo)
        : ''),
    PdfBarkod: String(candidate.PdfBarkod ?? candidate.pdfBarkodBase64 ?? ''),
    PpdBarkod: String(candidate.PpdBarkod ?? ''),
    hasPdfBarkod: Boolean(
      candidate.hasPdfBarkod ||
        candidate.pdfReady ||
        String(candidate.PdfBarkod ?? candidate.pdfBarkodBase64 ?? '').trim(),
    ),
    Detay: candidate.Detay ?? {},
    raw: typeof candidate.raw === 'string' ? candidate.raw : '',
  }
}

function parseKargoBarkoduSiparisDetail(text = '') {
  const fields = [
    'VarisSube',
    'VarisSubeAdi',
    'CikisSube',
    'CikisSubeAdi',
    'SonAktarma',
    'SonAktarmaAdi',
    'ParcaAdedi',
    'ToplamDesi',
    'ToplamKg',
    'ToplamDesiKg',
    'OdemeTipi',
    'TeslimSekli',
    'AliciIl',
    'AliciIlce',
    'BarkodNo',
    'KargoTakipNo',
  ]
  return Object.fromEntries(
    fields
      .map((field) => [field, decodeXml(extractTag(text, field)).trim()])
      .filter(([, value]) => Boolean(value)),
  )
}

function extractAllTagValues(text = '', tagName = '') {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(
    `<(?:[^:>]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${escaped}>`,
    'gi',
  )
  return Array.from(String(text ?? '').matchAll(regex)).map(
    (match) => match[1] ?? '',
  )
}

function buildKargoBarkoduSiparisNoTrackingReason(parsed, webPasswordInfo) {
  const aciklama = String(parsed?.Aciklama ?? '').trim()
  const reasons = []
  if (!parsed?.KargoTakipNo) {
    reasons.push('KargoBarkoduSiparis response iÃ§inde KargoTakipNo/T.No yok.')
  }
  if (!parsed?.BarkodNo) {
    reasons.push('KargoBarkoduSiparis response iÃ§inde numeric BarkodNo yok.')
  }
  if (!parsed?.hasPdfBarkod) {
    reasons.push('PdfBarkod base64 etiketi dÃ¶nmedi.')
  }
  if (/object reference/i.test(aciklama)) {
    reasons.push(
      'SÃ¼rat "Object reference" dÃ¶ndÃ¼; WebPassword yanlÄ±ÅŸ/eksik olabilir veya cari bu operasyon iÃ§in yetkili olmayabilir.',
    )
  } else if (aciklama) {
    reasons.push(`SÃ¼rat aÃ§Ä±klamasÄ±: ${aciklama}`)
  }
  if (webPasswordInfo?.fallbackUsed) {
    reasons.push(
      'AyrÄ± WebPassword girilmediÄŸi iÃ§in normal SÃ¼rat ÅŸifresi WebPassword olarak denendi.',
    )
  }
  if (webPasswordInfo?.matchesShipmentPassword) {
    reasons.push(
      'Kaydedilen WebPassword normal gonderim sifresiyle ayni. KargoBarkodu servisleri icin e-Surat Web/Sorgulama sifresini ayri girin.',
    )
  }
  return reasons.join(' ')
}

function buildSuratQueryReference(value, type, source) {
  const normalizedValue = String(value ?? '').trim()
  const normalizedType = String(type ?? '').trim().toUpperCase()
  const normalizedSource = String(source ?? '').trim()
  if (!normalizedValue) {
    return {
      ok: false,
      value: '',
      type: normalizedType,
      source: normalizedSource,
      message:
        'Takip sorgusu için createRequest.OzelKargoTakipNo kaynaklı WebSiparisKodu gerekli.',
    }
  }
  if (normalizedType !== 'WEB_SIPARIS_KODU') {
    return {
      ok: false,
      value: normalizedValue,
      type: normalizedType,
      source: normalizedSource,
      message: `KargoTakipHareketDetayi yalnız WEB_SIPARIS_KODU kabul eder; ${normalizedType || 'TİPSİZ'} referans gönderilmedi.`,
    }
  }
  return {
    ok: true,
    value: normalizedValue,
    type: 'WEB_SIPARIS_KODU',
    source: normalizedSource || 'createRequest.OzelKargoTakipNo',
  }
}

function resolveSuratTrackingQueryReference(requestBody = {}) {
  const explicit =
    requestBody.queryReference && typeof requestBody.queryReference === 'object'
      ? requestBody.queryReference
      : undefined
  const reference = explicit
    ? buildSuratQueryReference(
        explicit.value,
        explicit.type,
        explicit.source,
      )
    : buildSuratQueryReference(
        requestBody.webSiparisKodu,
        requestBody.referenceType || 'WEB_SIPARIS_KODU',
        requestBody.referenceSource || 'request.webSiparisKodu (legacy typed)',
      )
  return {
    ...reference,
    ignoredLegacyFields: [
      requestBody.webSiparisKoduCandidates ? 'webSiparisKoduCandidates' : '',
      requestBody.shipmentCode ? 'shipmentCode' : '',
      requestBody.trackingNumber ? 'trackingNumber' : '',
    ].filter(Boolean),
  }
}

function buildTrackingAttemptDebug(reference, result, queryReference = {}) {
  const tracking = result?.tracking ?? result?.suratTrackingLog ?? {}
  const tNo = firstNonEmpty(
    tracking.TNo,
    tracking.KargoTakipNo,
    tracking.TakipNo,
  )
  const numericBarcode = firstNonEmpty(
    isNumericSuratOperationalCode(tracking.BarkodNo) ? tracking.BarkodNo : '',
    isNumericSuratOperationalCode(tracking.Barkod) ? tracking.Barkod : '',
  )
  return {
    queryValue: reference,
    queryType: queryReference.type || 'WEB_SIPARIS_KODU',
    querySource:
      queryReference.source || 'createRequest.OzelKargoTakipNo',
    endpoint: result?.endpoint ?? 'KargoTakipHareketDetayi',
    serviceType: result?.serviceType,
    responseStatus: result?.statusCode ?? result?.responseStatus,
    ok: result?.ok,
    message: result?.message,
    gonderilerLength: result?.gonderilerLength,
    tNoFound: isOperationalSuratTNo(tNo),
    numericBarcodeFound: Boolean(numericBarcode),
    numericBarcode,
    tNo,
    serdendipMatched: Boolean(isOperationalSuratTNo(tNo) && numericBarcode),
    trackingState: result?.trackingState,
    responsePreview: String(result?.rawResponse ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 600),
  }
}

function shouldStopTrackingCandidateSearch(result) {
  if (Number(result?.gonderilerLength ?? 0) > 0) return true
  if (result?.ok) return false

  const statusCode = Number(result?.statusCode ?? result?.responseStatus ?? 0)
  const text = `${result?.message ?? ''} ${result?.originalMessage ?? ''} ${
    typeof result?.rawResponse === 'string'
      ? result.rawResponse
      : JSON.stringify(result?.rawResponse ?? '')
  }`
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  const referenceMiss = Boolean(
    text.includes('bulunam') ||
      text.includes('kayit yok') ||
      text.includes('kayit bulun') ||
      text.includes('siparis bulun') ||
      text.includes('entegrasyon koduna ait kargo bulun'),
  )
  if (referenceMiss) return false

  return (
    statusCode === 0 ||
    statusCode === 401 ||
    statusCode === 403 ||
    isSuratAuthError(text)
  )
}

function summarizeSuratApiResponse(result) {
  const createLog = result?.shipment?.suratCreateLog ?? result?.suratCreateLog
  return String(
    createLog?.responseMessage ??
      result?.createDiagnostics?.message ??
      result?.message ??
      createLog?.rawResponse ??
      result?.rawResponse ??
      'Bilinmeyen Sürat API hatası',
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

function summarizeSuratCreateAttempt(result) {
  const createLog = result?.suratCreateLog ?? result?.shipment?.suratCreateLog
  const parsed = createLog?.parsedResponse ?? result?.parsedResponse ?? {}
  return {
    ok: Boolean(result?.ok),
    serviceType: result?.serviceType ?? createLog?.serviceType ?? '',
    serviceMode: result?.serviceMode ?? createLog?.serviceMode ?? '',
    operationName: result?.operationName ?? createLog?.operationName ?? '',
    errorCode: result?.errorCode ?? '',
    errorSource: result?.errorSource ?? '',
    message: summarizeSuratApiResponse(result),
    KargoTakipNo: parsed.KargoTakipNo ?? '',
    BarkodNo: parsed.BarkodNo ?? '',
    hasPdfBarkod: Boolean(parsed.hasPdfBarkod),
    Aciklama: parsed.Aciklama ?? '',
  }
}

async function createSuratCommonBarcodeSoap(
  config,
  order,
  reference,
  {
    operationName = 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    serviceType =
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    strictGonderiModel = true,
  } = {},
) {
  const shipmentPayload = buildSuratShipmentPayload(order, reference, {
    commonBarcode: true,
  })
  const requestValidation = validateSuratRequestMapping(order, shipmentPayload)
  const trendyolPreflight = buildTrendyolShipmentPreflight(order)
  const addressNormalization = buildAddressNormalizationDebug(order)
  const phoneWarning = shipmentPayload.TelefonCep
    ? ''
    : 'Trendyol siparişinde TelefonCep bulunamadı. Sürat ortak barkod isteği boş telefonla gönderildi.'
  const soap = await callSuratSoap(
    operationName,
    `
      <KullaniciAdi>${xmlEscape(config.kullaniciAdi)}</KullaniciAdi>
      <Sifre>${xmlEscape(config.sifre)}</Sifre>
      ${buildSuratGonderiXml(shipmentPayload, {
        commonBarcode: true,
        strictGonderiModel,
      })}
    `,
  )
  const resultText =
    decodeXml(extractTag(soap.text, `${operationName}Result`)) || soap.text
  const parsedResponse = mapSuratCreateResponse(resultText, reference)
  const classifiedOutcome = classifySuratCreateResponse(
    resultText,
    parsedResponse,
    serviceType,
    {
      ...config,
      marketplaceIntegrationCode: shipmentPayload.MarketplaceIntegrationCode,
    },
  )
  const operationCheck = inspectSuratCreateOperation(
    soap.body,
    operationName,
  )
  const isCombinedCreateOperation =
    operationName === 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur'
  const responseIsError = parseBoolean(
    readSuratField(parsedResponse, ['IsError', 'isError']),
  )
  const createAccepted = Boolean(
    isCombinedCreateOperation &&
      soap.ok &&
      responseIsError !== true &&
      !classifiedOutcome.retryable &&
      !classifiedOutcome.duplicateShipment &&
      !operationCheck.wrongServiceCalled,
  )
  const outcome = {
    ...classifiedOutcome,
    ...operationCheck,
    createAccepted,
    verificationStage: createAccepted
      ? 'create_accepted'
      : classifiedOutcome.verificationStage || 'failed',
    hardError: classifiedOutcome.hardError || operationCheck.wrongServiceCalled,
    message: operationCheck.wrongServiceCalled
      ? `Canlı ortak barkod için yanlış servis çağrıldı. Beklenen: ${operationName}.`
      : classifiedOutcome.message,
  }
  const authError = isSuratAuthError(outcome.message)
  const createLog = buildSuratCreateLog({
    rawRequest: soap.body,
    rawResponse: soap.text,
    responseStatus: soap.statusCode,
    contentType: soap.contentType,
    parsedResponse,
    orderId: order.id ?? '',
    shipmentId: reference,
    serviceType,
    serviceMode: 'ORTAK_BARKOD_SOAP',
    operationName,
    endpoint: operationName,
    payloadFormat: 'SOAP/XML',
    outcome,
    requestReference: reference,
    phoneWarning,
    requestValidation,
    trendyolPreflight,
    addressNormalization,
  })

  if (
    !soap.ok ||
    authError ||
    outcome.hardError ||
    (isCombinedCreateOperation
      ? !createAccepted
      : !outcome.technicalZplReceived)
  ) {
    const createError = mapSuratCreateError(outcome.message || resultText)
    const missingCommonBarcode = Boolean(
      !isCombinedCreateOperation &&
        (!isValidSuratCode(outcome.officialTrackingNumber) ||
          !isValidSuratCode(outcome.officialBarcode)),
    )
    return buildSuratCreateFailure({
      message:
        missingCommonBarcode
          ? SURAT_INVALID_CODES_MESSAGE
          : createError.userMessage ||
            outcome.message ||
            `Sürat OrtakBarkodOlustur başarısız. HTTP ${soap.statusCode}`,
      errorCode: createError.code || outcome.code,
      errorSource: createError.source,
      endpoint: operationName,
      statusCode: soap.statusCode,
      contentType: soap.contentType,
      rawRequest: soap.body,
      rawResponse: soap.text,
      parsedResponse,
      createLog,
      serviceType,
      payloadFormat: 'SOAP/XML',
      reference,
      operationName,
      failedBarcodeValidation: missingCommonBarcode,
      marketplaceIntegrationCode:
        shipmentPayload.MarketplaceIntegrationCode,
    })
  }

  const createResult = buildSuratCreateSuccess({
    serviceType,
    endpoint: operationName,
    payloadFormat: 'SOAP/XML',
    statusCode: soap.statusCode,
    rawResponse: soap.text,
    parsedResponse,
    createLog,
    outcome,
    reference,
    phoneWarning,
    marketplaceIntegrationCode:
      shipmentPayload.MarketplaceIntegrationCode,
  })
  return verifySuratCreateResultWithTracking({
    config,
    order,
    reference,
    createResult,
    shipmentPayload,
    createLog,
    outcome,
  })
}

async function createSuratGonderiyiKargoyaGonderYeniSoap(
  config,
  order,
  reference,
) {
  const operationName = 'GonderiyiKargoyaGonderYeni'
  const serviceType = 'GonderiyiKargoyaGonderYeniSoap'
  const shipmentPayload = buildSuratShipmentPayload(order, reference, {
    commonBarcode: true,
  })
  const requestValidation = validateSuratRequestMapping(order, shipmentPayload)
  const trendyolPreflight = buildTrendyolShipmentPreflight(order)
  const addressNormalization = buildAddressNormalizationDebug(order)
  const soap = await callSuratSoap(
    operationName,
    `
      <KullaniciAdi>${xmlEscape(config.kullaniciAdi)}</KullaniciAdi>
      <Sifre>${xmlEscape(config.sifre)}</Sifre>
      ${buildSuratGonderiXml(shipmentPayload, {
        commonBarcode: true,
        strictGonderiModel: true,
      })}
    `,
  )
  const resultText =
    decodeXml(extractTag(soap.text, `${operationName}Result`)) || soap.text
  const parsedResponse = parseSuratStringCreateResponse(
    operationName,
    resultText,
    reference,
  )
  const classifiedOutcome = classifySuratCreateResponse(
    resultText,
    parsedResponse,
    serviceType,
    {
      ...config,
      marketplaceIntegrationCode: shipmentPayload.MarketplaceIntegrationCode,
    },
  )
  const operationCheck = inspectSuratCreateOperation(soap.body, operationName)
  const createAccepted = isSuratStringCreateAccepted({
    soapOk: soap.ok,
    resultText,
    parsedResponse,
    classifiedOutcome,
  })
  const outcome = {
    ...classifiedOutcome,
    ...operationCheck,
    createAccepted,
    verificationStage: createAccepted
      ? 'create_accepted'
      : classifiedOutcome.verificationStage || 'failed',
    errorCategory: createAccepted ? '' : classifiedOutcome.errorCategory,
    hardError:
      !createAccepted ||
      classifiedOutcome.hardError ||
      operationCheck.wrongServiceCalled,
  }
  const createLog = buildSuratCreateLog({
    rawRequest: soap.body,
    rawResponse: soap.text,
    responseStatus: soap.statusCode,
    contentType: soap.contentType,
    parsedResponse,
    orderId: order.id ?? '',
    shipmentId: reference,
    serviceType,
    serviceMode: 'GONDERI_YENI_SOAP',
    operationName,
    endpoint: operationName,
    payloadFormat: 'SOAP/XML',
    outcome,
    requestReference: reference,
    requestValidation,
    trendyolPreflight,
    addressNormalization,
  })

  if (!createAccepted) {
    const createError = mapSuratCreateError(outcome.message || resultText)
    return buildSuratCreateFailure({
      message:
        createError.userMessage ||
        outcome.message ||
        `Sürat ${operationName} isteği kabul edilmedi.`,
      errorCode: createError.code || outcome.code,
      errorSource: createError.source,
      endpoint: operationName,
      statusCode: soap.statusCode,
      contentType: soap.contentType,
      rawRequest: soap.body,
      rawResponse: soap.text,
      parsedResponse,
      createLog,
      serviceType,
      payloadFormat: 'SOAP/XML',
      reference,
      operationName,
      marketplaceIntegrationCode:
        shipmentPayload.MarketplaceIntegrationCode,
    })
  }

  const createResult = buildSuratCreateSuccess({
    serviceType,
    endpoint: operationName,
    payloadFormat: 'SOAP/XML',
    statusCode: soap.statusCode,
    rawResponse: soap.text,
    parsedResponse,
    createLog,
    outcome,
    reference,
    marketplaceIntegrationCode:
      shipmentPayload.MarketplaceIntegrationCode,
  })
  return verifySuratCreateResultWithTracking({
    config,
    order,
    reference,
    createResult,
    shipmentPayload,
    createLog,
    outcome,
  })
}

function parseSuratStringCreateResponse(
  operationName,
  resultText,
  fallbackCode,
) {
  const parsed = mapSuratCreateResponse(resultText, fallbackCode)
  return {
    ...parsed,
    operationName,
    resultText: String(resultText ?? '').trim(),
  }
}

function isSuratStringCreateAccepted({
  soapOk,
  resultText,
  parsedResponse,
  classifiedOutcome,
}) {
  if (!soapOk || classifiedOutcome?.hardError) return false
  if (parseBoolean(readSuratField(parsedResponse, ['IsError', 'isError'])) === true) {
    return false
  }
  const normalized = String(resultText ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
  return Boolean(
    normalized === 'tamam' ||
      normalized.includes('kayıt başarıyla oluşturuldu') ||
      normalized.includes('kayit basariyla olusturuldu') ||
      ['BARCODE_SUCCESS', 'PARTIAL'].includes(
        classifiedOutcome?.responseCategory,
      ),
  )
}

function isSuratRestCreateAccepted({
  httpOk,
  rawResponse,
  parsedResponse,
  classifiedOutcome,
}) {
  if (
    !httpOk ||
    classifiedOutcome?.hardError ||
    classifiedOutcome?.retryable ||
    classifiedOutcome?.duplicateShipment
  ) {
    return false
  }
  if (
    parseBoolean(readSuratField(parsedResponse, ['IsError', 'isError'])) ===
    true
  ) {
    return false
  }
  const message = firstNonEmpty(
    extractSuratMessage(parsedResponse),
    extractSuratMessage(rawResponse),
    readSuratField(parsedResponse, ['Message', 'message']),
  )
  const normalized = String(message ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
  return Boolean(
    normalized === 'tamam' ||
      normalized.includes('kayıt başarıyla oluşturuldu') ||
      normalized.includes('kayit basariyla olusturuldu') ||
      normalized.includes('başarıyla oluşturuldu') ||
      normalized.includes('basariyla olusturuldu') ||
      ['BARCODE_SUCCESS', 'PARTIAL'].includes(
        classifiedOutcome?.responseCategory,
      ),
  )
}

async function createSuratLegacyRestJson(config, order, reference) {
  const shipmentPayload = buildSuratShipmentPayload(order, reference)
  const requestValidation = validateSuratRequestMapping(order, shipmentPayload)
  const trendyolPreflight = buildTrendyolShipmentPreflight(order)
  const addressNormalization = buildAddressNormalizationDebug(order)
  const payload = {
    KullaniciAdi: config.kullaniciAdi,
    Sifre: config.sifre,
    Gonderi: buildOfficialSuratRestShipment(shipmentPayload),
  }
  const baseUrl = resolveSuratRestBaseUrl(config)
  const path = '/api/GonderiyiKargoyaGonder'
  const endpoint = `${baseUrl}${path}`
  const phoneWarning = shipmentPayload.TelefonCep
    ? ''
    : 'Trendyol siparişinde TelefonCep bulunamadı. Sürat ön kayıt isteği boş telefonla gönderildi.'

  try {
    const apiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain',
      },
      body: JSON.stringify(payload),
    })
    const text = await apiResponse.text()
    const parsedBody = text ? safeJson(text) : null
    const rawResponse = parsedBody ?? text
    const parsedResponse = mapSuratCreateResponse(rawResponse, reference)
    const classifiedOutcome = classifySuratCreateResponse(
      rawResponse,
      parsedResponse,
      'GonderiyiKargoyaGonderRestJson',
      {
        ...config,
        marketplaceIntegrationCode: shipmentPayload.MarketplaceIntegrationCode,
      },
    )
    const createAccepted = isSuratRestCreateAccepted({
      httpOk: apiResponse.ok,
      rawResponse,
      parsedResponse,
      classifiedOutcome,
    })
    const outcome = {
      ...classifiedOutcome,
      createAccepted,
      verificationStage: createAccepted
        ? 'create_accepted'
        : classifiedOutcome.verificationStage || 'failed',
    }
    const contentType = apiResponse.headers.get('content-type') || ''
    const createLog = buildSuratCreateLog({
      rawRequest: payload,
      rawResponse,
      responseStatus: apiResponse.status,
      contentType,
      parsedResponse,
      orderId: order.id ?? '',
      shipmentId: reference,
      serviceType: 'GonderiyiKargoyaGonderRestJson',
      serviceMode: 'PRE_REGISTRATION_REST',
      operationName: 'GonderiyiKargoyaGonder',
      endpoint,
      payloadFormat: 'JSON',
      outcome,
      requestReference: reference,
      phoneWarning,
      requestValidation,
      trendyolPreflight,
      addressNormalization,
    })

    // A duplicate response proves only that Sürat rejected a second create.
    // It is not a usable shipment until the existing record is returned by a
    // read operation. Never advance to label generation on this response alone.
    const duplicateShipmentAccepted = false
    if (
      (!apiResponse.ok && !duplicateShipmentAccepted) ||
      (outcome.hardError && !duplicateShipmentAccepted) ||
      outcome.retryable ||
      !createAccepted
    ) {
      const createError = mapSuratCreateError(outcome.message || text)
      if (
        createError.code === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS' ||
        outcome.errorCategory === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
      ) {
        return buildSuratDispatchRejectedFailure({
          message:
            createError.userMessage ||
            outcome.message ||
            `Sürat GonderiyiKargoyaGonder HTTP ${apiResponse.status}`,
          errorCode: '1002',
          errorSource: 'Trendyol',
          endpoint,
          statusCode: apiResponse.status,
          contentType,
          rawRequest: payload,
          rawResponse,
          parsedResponse,
          createLog,
          serviceType: 'GonderiyiKargoyaGonderRestJson',
          payloadFormat: 'JSON',
          reference,
          marketplaceIntegrationCode:
            shipmentPayload.MarketplaceIntegrationCode,
          requestValidation,
          addressNormalization,
          trendyolPreflight,
          requestSent: true,
        })
      }
      const apiFailureMessage =
        createError.userMessage ||
        outcome.message ||
        `Sürat GonderiyiKargoyaGonder HTTP ${apiResponse.status}`
      const failureMessage = outcome.retryable
        ? `${outcome.message || 'Sürat geçici retry yanıtı döndürdü.'} ${SURAT_RETRY_DELAYS_SECONDS.join('-')} saniye planıyla tekrar denenebilir.`
        : createError.userMessage ||
          outcome.message ||
          `Sürat GonderiyiKargoyaGonder HTTP ${apiResponse.status}`
      const visibleFailureMessage = outcome.retryable
        ? failureMessage
        : `Sürat gönderisi oluşturulamadı. API response: ${apiFailureMessage}`
      return buildSuratCreateFailure({
        legacyMessage:
          createError.userMessage ||
          outcome.message ||
          `Sürat GonderiyiKargoyaGonder HTTP ${apiResponse.status}`,
        message: visibleFailureMessage,
        errorCode: createError.code || outcome.code,
        errorSource: createError.source,
        endpoint,
        statusCode: apiResponse.status,
        contentType,
        rawRequest: payload,
        rawResponse,
        parsedResponse,
        createLog,
        serviceType: 'GonderiyiKargoyaGonderRestJson',
        payloadFormat: 'JSON',
        reference,
        marketplaceIntegrationCode:
          shipmentPayload.MarketplaceIntegrationCode,
        retryPolicy: outcome.retryPolicy,
        failedBarcodeValidation: false,
      })
    }

    const createSuccess = buildSuratCreateSuccess({
      serviceType: 'GonderiyiKargoyaGonderRestJson',
      endpoint,
      payloadFormat: 'JSON',
      statusCode: apiResponse.status,
      rawResponse,
      parsedResponse,
      createLog,
      outcome,
      reference,
      phoneWarning,
      marketplaceIntegrationCode:
        shipmentPayload.MarketplaceIntegrationCode,
    })
    return await verifySuratCreateResultWithTracking({
      config,
      order,
      reference,
      createResult: createSuccess,
      shipmentPayload,
      createLog,
      outcome,
    })
  } catch (error) {
    return buildSuratCreateFailure({
      message:
        error instanceof Error
          ? `Sürat GonderiyiKargoyaGonder REST bağlantı hatası: ${error.message}`
          : 'Sürat GonderiyiKargoyaGonder REST bağlantı hatası.',
      errorSource: 'Sürat',
      endpoint,
      statusCode: 0,
      rawRequest: payload,
      rawResponse: error instanceof Error ? error.message : 'Bağlantı hatası',
      parsedResponse: null,
      serviceType: 'GonderiyiKargoyaGonderRestJson',
      payloadFormat: 'JSON',
      reference,
      marketplaceIntegrationCode:
        shipmentPayload.MarketplaceIntegrationCode,
    })
  }
}

function resolveSuratMarketplaceRegistration(createResult, shipmentPayload) {
  const parsed = firstObjectCandidate(
    createResult?.parsedResponse,
    createResult?.rawResponse,
    createResult?.suratCreateLog?.parsedResponse,
    createResult?.suratCreateLog?.rawResponse,
  )
  const rawText =
    typeof createResult?.rawResponse === 'string'
      ? createResult.rawResponse
      : JSON.stringify(createResult?.rawResponse ?? parsed ?? '')
  const message =
    extractSuratMessage(parsed) ||
    extractSuratMessage(rawText) ||
    String(readSuratField(parsed, ['Message']) ?? '')
  const normalizedMessage = message.toLocaleLowerCase('tr-TR')
  const isError = parseBoolean(readSuratField(parsed, ['IsError', 'isError']))
  const statusCode = Number(
    readSuratField(parsed, ['StatusCode', 'statusCode']) ??
      createResult?.statusCode ??
      createResult?.responseStatus ??
      0,
  )
  const barcode = String(
    firstNonEmpty(
      shipmentPayload?.MarketplaceIntegrationCode,
      shipmentPayload?.OzelKargoTakipNo,
    ),
  ).trim()
  const mentionsBarcode = Boolean(barcode && message.includes(barcode))
  const successMessage =
    normalizedMessage.includes('kayıt başarıyla oluşturuldu') ||
    normalizedMessage.includes('kayit basariyla olusturuldu') ||
    normalizedMessage.includes('başarıyla oluşturuldu') ||
    normalizedMessage.includes('basariyla olusturuldu')
  const duplicateShipment = Boolean(
    createResult?.createDiagnostics?.duplicateShipment ||
      isSuratDuplicateShipmentMessage(message),
  )

  return {
    accepted: Boolean(
      barcode &&
        isError === false &&
        (statusCode === 200 || createResult?.statusCode === 200) &&
        mentionsBarcode &&
        successMessage,
    ),
    barcode,
    source: 'trendyol.cargoTrackingNumber',
    message,
    statusCode,
  }
}

function resolveTrackingVerificationOffsets(config = {}) {
  const configured = Array.isArray(config.trackingVerificationDelaysMs)
    ? config.trackingVerificationDelaysMs
    : [0, 3000, 10000, 30000, 60000]
  const offsets = uniqueStrings(
    configured.map((value) => String(Math.max(0, Number(value) || 0))),
  )
    .map(Number)
    .sort((left, right) => left - right)
  return offsets.length > 0 ? offsets : [0]
}

function waitForTrackingOffset(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function verifySuratCreateResultWithTracking({
  config,
  order,
  reference,
  createResult,
  shipmentPayload,
  createLog,
  outcome,
}) {
  const webSiparisKodu = firstNonEmpty(
    shipmentPayload.OzelKargoTakipNo,
    order?.cargoTrackingNumber,
  )
  const trackingCandidates = uniqueStrings([
    webSiparisKodu,
  ])
  // Ön-atanmış canonical kodlar (ZPL analizinden) create yanıtında hazırsa,
  // tesellüm öncesi Gonderiler=0 normaldir ve etiket zaten yazdırılabilir.
  // Bu durumda uzun takip polling'ini (0/3/10/30/60 sn) beklemek gereksiz
  // gecikme yaratır; yalnız tek bir hızlı sorgu (offset 0) yapılır ve kayıt
  // varsa VERIFIED'e terfi edilir, yoksa hemen preassigned dala düşülür.
  const createZplAnalysisForPolling =
    createResult.shipment?.zplAnalysis ??
    createResult.createDiagnostics?.zplAnalysis ??
    {}
  const createCodeMappingForPolling =
    createResult.shipment?.codeMapping ??
    createResult.createDiagnostics?.codeMapping ??
    {}
  const preassignedTNoForPolling = firstNonEmpty(
    createResult.shipment?.tNo,
    createResult.shipment?.kargoTakipNo,
    createResult.shipment?.trackingNumber,
    createCodeMappingForPolling.tNoValue,
    createZplAnalysisForPolling.acceptedTNo,
  )
  const preassignedBarcodeForPolling = firstNonEmpty(
    isNumericSuratOperationalCode(createResult.shipment?.barkodNo)
      ? createResult.shipment?.barkodNo
      : '',
    isNumericSuratOperationalCode(createResult.shipment?.barcode)
      ? createResult.shipment?.barcode
      : '',
    isNumericSuratOperationalCode(createZplAnalysisForPolling.acceptedFinalBarcode)
      ? createZplAnalysisForPolling.acceptedFinalBarcode
      : '',
    isNumericSuratOperationalCode(createCodeMappingForPolling.barcodeValue)
      ? createCodeMappingForPolling.barcodeValue
      : '',
  )
  const preassignedReadyForPolling = Boolean(
    outcome.createAccepted !== false &&
      createResult.shipment?.barcodeRaw &&
      isOperationalSuratTNo(preassignedTNoForPolling) &&
      preassignedBarcodeForPolling,
  )
  let trackingVerification
  const trackingAttempts = []
  const verificationOffsets = preassignedReadyForPolling
    ? [0]
    : resolveTrackingVerificationOffsets(config)
  let previousOffset = 0
  let trackingSearchFinished = false
  for (const offsetMs of verificationOffsets) {
    await waitForTrackingOffset(offsetMs - previousOffset)
    previousOffset = offsetMs
    for (const candidate of trackingCandidates) {
      trackingVerification =
        config.trackingServiceType === 'KargoTakipHareketDetayiRest'
          ? await trackShipmentRest(config, candidate, {
              orderId: order?.id,
              shipmentId: reference,
            })
          : await trackShipmentSoap(config, candidate, {
              orderId: order?.id,
              shipmentId: reference,
            })
      trackingVerification.trackingReference = candidate
      trackingAttempts.push({
        ...buildTrackingAttemptDebug(candidate, trackingVerification),
        pollOffsetMs: offsetMs,
        pollAttempt: trackingAttempts.length + 1,
      })
      trackingVerification.trackingAttempts = trackingAttempts
      if (Number(trackingVerification?.gonderilerLength ?? 0) > 0) {
        trackingSearchFinished = true
        break
      }
      if (shouldStopTrackingCandidateSearch(trackingVerification)) {
        trackingSearchFinished = true
        break
      }
    }
    if (trackingSearchFinished) break
  }
  if (trackingVerification) trackingVerification.trackingAttempts = trackingAttempts
  const registrationLookup = webSiparisKodu
    ? await callSuratWebSiparisKodu(config, webSiparisKodu, {
        orderId: order?.id,
        shipmentId: reference,
      })
    : undefined
  const tracking = trackingVerification?.tracking ?? {}
  const gonderilerLength = Number(trackingVerification?.gonderilerLength ?? 0)
  const trackingResponseNumber = firstNonEmpty(
    tracking.KargoTakipNo,
    tracking.TakipUrlTrackingNo,
  )
  const trackingNumber = firstNonEmpty(
    trackingResponseNumber,
    registrationLookup?.KargoTakipNo,
    createResult.shipment?.trackingNumber,
  )
  const trackingBarcode = firstNonEmpty(
    isNumericSuratOperationalCode(tracking.BarkodNo)
      ? tracking.BarkodNo
      : '',
    isNumericSuratOperationalCode(tracking.Barkod) ? tracking.Barkod : '',
  )
  const registrationBarcode = firstNonEmpty(registrationLookup?.BarkodNo)
  // Ön-atanmış kodlar create yanıtının typed alanlarında olmayabilir;
  // combined operasyonda ZPL analizi (acceptedTNo/acceptedFinalBarcode)
  // canonical kaynaklardır (17.07.2026 canlı kanıtı: 11423172909).
  const createZplAnalysis =
    createResult.shipment?.zplAnalysis ??
    createResult.createDiagnostics?.zplAnalysis ??
    {}
  const createCodeMapping =
    createResult.shipment?.codeMapping ??
    createResult.createDiagnostics?.codeMapping ??
    {}
  const expectedBarcode = firstNonEmpty(
    isNumericSuratOperationalCode(createResult.shipment?.barkodNo)
      ? createResult.shipment?.barkodNo
      : '',
    isNumericSuratOperationalCode(createResult.shipment?.barcode)
      ? createResult.shipment?.barcode
      : '',
    isNumericSuratOperationalCode(createZplAnalysis.acceptedFinalBarcode)
      ? createZplAnalysis.acceptedFinalBarcode
      : '',
    isNumericSuratOperationalCode(createCodeMapping.barcodeValue)
      ? createCodeMapping.barcodeValue
      : '',
  )
  const barcode = firstNonEmpty(trackingBarcode, expectedBarcode)
  const expectedTrackingNumber = firstNonEmpty(
    createResult.shipment?.tNo,
    createResult.shipment?.kargoTakipNo,
    createResult.shipment?.trackingNumber,
    createCodeMapping.tNoValue,
    createZplAnalysis.acceptedTNo,
  )
  const trackingNumberMatchesCreate = Boolean(
    trackingNumber &&
      (!expectedTrackingNumber ||
        normalizeSuratCodeForComparison(expectedTrackingNumber) ===
          normalizeSuratCodeForComparison(trackingNumber)),
  )
  const registrationReferenceMatches = Boolean(
    registrationLookup?.rowCount > 0 && registrationLookup?.referenceMatches,
  )
  const shipmentRegistered = Boolean(
    registrationReferenceMatches || gonderilerLength > 0,
  )
  const responseWebSiparisKodu = firstNonEmpty(
    tracking.WebSiparisKodu,
    tracking.Satiskodu,
    tracking.SatisKodu,
    tracking.OzelKargoTakipNo,
  )
  const trackingReferenceMatchesCreate = Boolean(
    responseWebSiparisKodu &&
      normalizeSuratCodeForComparison(responseWebSiparisKodu) ===
        normalizeSuratCodeForComparison(webSiparisKodu),
  )
  const trackingBarcodeMatchesCreate = Boolean(
    trackingBarcode &&
      (!expectedBarcode ||
        normalizeSuratCodeForComparison(trackingBarcode) ===
          normalizeSuratCodeForComparison(expectedBarcode)),
  )
  const trackingConfirmed = Boolean(
    trackingVerification?.ok &&
      gonderilerLength > 0 &&
      isOperationalSuratTNo(trackingResponseNumber) &&
      trackingNumberMatchesCreate &&
      trackingReferenceMatchesCreate,
  )
  const labelCreated = Boolean(
    (createResult.shipment?.technicalZplReceived &&
      createResult.shipment?.barcodeRaw) ||
      (createResult.shipment?.pdfReady &&
        createResult.shipment?.labelPdfBase64),
  )
  const trackingActive = Boolean(
    trackingVerification?.ok &&
      gonderilerLength > 0 &&
      isOperationalSuratTNo(trackingResponseNumber),
  )
  const preassignedCodesPresent = Boolean(
    expectedTrackingNumber &&
      isOperationalSuratTNo(expectedTrackingNumber) &&
      expectedBarcode,
  )
  const lifecycle = deriveSuratLifecycleState({
    createAccepted: outcome.createAccepted !== false,
    shipmentRegistered,
    labelCreated,
    trackingActive,
    preassignedCodesPresent,
    serendipVerified:
      trackingConfirmed &&
      Boolean(
        trackingBarcodeMatchesCreate ||
          (registrationBarcode &&
            expectedBarcode &&
            normalizeSuratCodeForComparison(registrationBarcode) ===
              normalizeSuratCodeForComparison(expectedBarcode)),
      ),
  })
  const verificationDebug = {
    required: true,
    serviceType: trackingVerification?.serviceType,
    endpoint: trackingVerification?.endpoint,
    webSiparisKodu,
    responseWebSiparisKodu,
    trackingReferenceMatchesCreate,
    ok: Boolean(trackingVerification?.ok),
    gonderilerLength,
    KargoTakipNo: trackingNumber,
    BarkodNo: firstNonEmpty(tracking.BarkodNo, tracking.Barkod),
    expectedKargoTakipNo: expectedTrackingNumber,
    trackingNumberMatchesCreate,
    expectedBarkodNo: expectedBarcode,
    barcodeNumberMatchesCreate: trackingBarcodeMatchesCreate,
    serdendipVerified:
      trackingConfirmed && trackingBarcodeMatchesCreate,
    registrationLookup,
    shipmentRegistered,
    labelCreated,
    trackingActive,
    lifecycleStage: lifecycle.state,
    lifecycleMilestones: lifecycle.milestones,
    responseStatus: trackingVerification?.responseStatus,
    trackingState: trackingVerification?.trackingState,
    message: trackingVerification?.message,
    attempts: trackingAttempts,
    retryPolicy:
      outcome.retryable || outcome.responseCategory === 'RETRY'
        ? outcome.retryPolicy
        : undefined,
  }
  const marketplaceRegistration = resolveSuratMarketplaceRegistration(
    createResult,
    shipmentPayload,
  )
  const operationalBarcodeResolution =
    trackingConfirmed && !trackingBarcode
      ? await resolveSuratOperationalBarcode(config, order, {
          shipmentId: reference,
          internalWebBarcode: marketplaceRegistration.barcode,
          zplAnalysis: createResult.shipment?.zplAnalysis,
        })
      : undefined

  const resolvedTrackingMatches = Boolean(
    operationalBarcodeResolution?.operationalBarcodeVerified &&
      normalizeSuratCodeForComparison(
        operationalBarcodeResolution.KargoTakipNo,
      ) === normalizeSuratCodeForComparison(trackingNumber) &&
      (!expectedTrackingNumber ||
        normalizeSuratCodeForComparison(
          operationalBarcodeResolution.KargoTakipNo,
        ) === normalizeSuratCodeForComparison(expectedTrackingNumber)),
  )
  const resolvedBarcodeMatches = Boolean(
    operationalBarcodeResolution?.operationalBarcodeVerified &&
      normalizeSuratCodeForComparison(
        operationalBarcodeResolution.BarkodNo,
      ) === normalizeSuratCodeForComparison(expectedBarcode),
  )

  if (trackingConfirmed && resolvedTrackingMatches && resolvedBarcodeMatches) {
    const verifiedLifecycle = deriveSuratLifecycleState({
      createAccepted: true,
      shipmentRegistered: true,
      labelCreated: true,
      trackingActive: true,
      serendipVerified: true,
    })
    const operationalVerificationDebug = {
      ...verificationDebug,
      serviceType: operationalBarcodeResolution.serviceType,
      endpoint: operationalBarcodeResolution.endpoint,
      ok: true,
      gonderilerLength: 1,
      KargoTakipNo: operationalBarcodeResolution.KargoTakipNo,
      BarkodNo: operationalBarcodeResolution.BarkodNo,
      responseStatus: operationalBarcodeResolution.responseStatus,
      trackingState: 'TRACKING_CONFIRMED',
      message: operationalBarcodeResolution.message,
      expectedKargoTakipNo: expectedTrackingNumber,
      trackingNumberMatchesCreate: resolvedTrackingMatches,
      expectedBarkodNo: expectedBarcode,
      barcodeNumberMatchesCreate: resolvedBarcodeMatches,
      serdendipVerified: true,
      attempts: trackingAttempts,
      operationalBarcodeResolution,
      lifecycleStage: verifiedLifecycle.state,
      lifecycleMilestones: verifiedLifecycle.milestones,
    }
    return {
      ...createResult,
      ok: true,
      message: outcome.duplicateShipment
        ? 'Sürat gönderisi daha önce oluşmuş; mevcut barkod resmî Sürat sorgu servisiyle doğrulandı.'
        : 'Sürat gönderisi oluşturuldu; barkod resmî Sürat sorgu servisiyle doğrulandı.',
      trackingVerification: operationalVerificationDebug,
      operationalBarcodeResolution,
      suratCreateLog: {
        ...createResult.suratCreateLog,
        verifiedShipment: true,
        trackingVerification: operationalVerificationDebug,
      },
      createDiagnostics: {
        ...createResult.createDiagnostics,
        marketplaceRegistration,
        trackingVerification: operationalVerificationDebug,
        operationalBarcodeResolution,
      },
      shipment: createResult.shipment
        ? {
            ...createResult.shipment,
            trackingNumber: operationalBarcodeResolution.KargoTakipNo,
            kargoTakipNo: operationalBarcodeResolution.KargoTakipNo,
            tNo: operationalBarcodeResolution.KargoTakipNo,
            trackingSource:
              operationalBarcodeResolution.trackingSource ||
              'surat.KargoBarkodu.KargoTakipNo',
            barcode: operationalBarcodeResolution.BarkodNo,
            barkodNo: operationalBarcodeResolution.BarkodNo,
            barcodeValue: operationalBarcodeResolution.BarkodNo,
            barcodeSource:
              operationalBarcodeResolution.barcodeSource ||
              'surat.KargoBarkodu.BarkodNo',
            finalSuratBarcode: operationalBarcodeResolution.BarkodNo,
            trackingUrl: `https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=${encodeURIComponent(
              operationalBarcodeResolution.KargoTakipNo,
            )}`,
            suratOperationalBarcodeLog: operationalBarcodeResolution,
          verifiedShipment: true,
          dispatchRegistrationConfirmed: true,
          operationalBarcodeVerified: true,
          serdendipVerified: true,
          trackingConfirmationPending: false,
            verificationStage: 'serdendip_verified',
            lifecycleStage: verifiedLifecycle.state,
            lifecycleMilestones: verifiedLifecycle.milestones,
            lifecycleEvidence: verifiedLifecycle,
            errorCategory: '',
            lifecycleStatus: 'LABEL_READY',
            labelStatus: 'READY',
            printEnabled: true,
            zplReady: Boolean(createResult.shipment.barcodeRaw),
            diagnosticMessage: '',
            noTrackingReason: '',
            labelBlockedReason: '',
            zplDisabledReason: '',
            suratTrackingLog: trackingVerification?.suratTrackingLog,
            trackingVerification: operationalVerificationDebug,
          }
        : createResult.shipment,
    }
  }

  if (!trackingConfirmed) {
    // Kanıt (17.07.2026): create/label yanıtındaki T.No ve barkod, fiziksel
    // tesellümde birebir korunuyor (6/6 canlı eşleşme). Kayıt yüzeyleri
    // yalnız tesellümde dolduğu için kabul öncesi Gonderiler=0 normaldir;
    // ön-atanmış kodlar ve ZPL varsa etiket, pazaryeri kayıt bayrağından
    // bağımsız olarak ilk create yanıtında da yazdırılabilir.
    if (lifecycle.preassignedPrintAllowed) {
      return {
        ...createResult,
        ok: true,
        message:
          'Sürat etiketi ön-atanmış T.No/barkod ile hazır. Gönderi kaydı fiziksel kargo kabulünde (tesellüm) doğrulanacak.',
        trackingVerification: verificationDebug,
        suratCreateLog: {
          ...createResult.suratCreateLog,
          verifiedShipment: false,
          dispatchRegistrationConfirmed: shipmentRegistered,
          trackingConfirmationPending: true,
          trackingVerification: verificationDebug,
        },
        createDiagnostics: {
          ...createResult.createDiagnostics,
          marketplaceRegistration,
          trackingVerification: verificationDebug,
          operationalBarcodeResolution,
        },
        shipment: createResult.shipment
          ? {
              ...createResult.shipment,
              ...buildSuratPreassignedShipmentPatch(
                expectedTrackingNumber,
                expectedBarcode,
              ),
              trendyolCargoTrackingNumber: marketplaceRegistration.barcode,
              dispatchRegistrationConfirmed: shipmentRegistered,
              trackingConfirmationPending: true,
              lifecycleStage: lifecycle.state,
              lifecycleMilestones: lifecycle.milestones,
              lifecycleEvidence: lifecycle,
              zplReady: Boolean(createResult.shipment.barcodeRaw),
              suratOperationalBarcodeLog: operationalBarcodeResolution,
              suratTrackingLog: trackingVerification?.suratTrackingLog,
              trackingVerification: verificationDebug,
            }
          : createResult.shipment,
      }
    }
    if (marketplaceRegistration.accepted) {
      return {
        ...createResult,
        ok: false,
        legacyMessage:
          'Sürat gönderisi oluşturuldu. KargoTakipHareketDetayi henüz kayıt/hareket döndürmedi; Trendyol/Sürat cargoTrackingNumber barkodu ile etiket yazdırılabilir.',
        message:
          'Sürat gönderisi oluşturuldu ancak KargoTakipHareketDetayi henüz Sürat ana barkod/T.No döndürmedi. Trendyol cargoTrackingNumber ana barkod olarak basılamaz.',
        trackingVerification: verificationDebug,
        suratCreateLog: {
          ...createResult.suratCreateLog,
          verifiedShipment: false,
          dispatchRegistrationConfirmed: shipmentRegistered,
          trackingConfirmationPending: true,
          trackingVerification: verificationDebug,
        },
        createDiagnostics: {
          ...createResult.createDiagnostics,
          marketplaceRegistration,
          trackingVerification: verificationDebug,
          operationalBarcodeResolution,
        },
        shipment: createResult.shipment
          ? {
              ...createResult.shipment,
              trackingNumber: '',
              kargoTakipNo: '',
              tNo: '',
              trackingSource: '',
              barcode: '',
              barkodNo: '',
              barcodeValue: '',
              barcodeSource: '',
              finalSuratBarcode: '',
              candidateTNo: expectedTrackingNumber,
              candidateBarkodNo: expectedBarcode,
              candidateVerificationStatus: 'PENDING_VERIFICATION',
              trendyolCargoTrackingNumber: marketplaceRegistration.barcode,
              verifiedShipment: false,
              dispatchRegistrationConfirmed: shipmentRegistered,
              operationalBarcodeVerified: false,
              trackingConfirmationPending: true,
              verificationStage: 'tracking_confirmation_missing',
              lifecycleStage: lifecycle.state,
              lifecycleMilestones: lifecycle.milestones,
              lifecycleEvidence: lifecycle,
              errorCategory: 'SURAT_TRACKING_CONFIRMATION_MISSING',
              lifecycleStatus: shipmentRegistered
                ? labelCreated
                  ? 'SURAT_TRACKING_MISSING'
                  : 'SHIPMENT_CREATED'
                : labelCreated
                  ? 'SURAT_TRACKING_MISSING'
                  : 'SURAT_CREATED_NO_TRACKING',
              labelStatus: 'BLOCKED',
              printEnabled: false,
              zplReady: false,
              diagnosticMessage:
                'KargoTakipHareketDetayi kabul/hareket oluşana kadar kayıt döndürmeyebilir.',
              noTrackingReason:
                'Sürat ana barkod/T.No alınamadı. Trendyol cargoTrackingNumber ana barkod olarak basılamaz.',
              labelBlockedReason:
                'Sürat ana barkod/T.No alınmadan etiket yazdırılamaz.',
              zplDisabledReason:
                'Sürat Barcode/BarcodeRaw veya takip doğrulaması yok.',
              suratOperationalBarcodeLog: operationalBarcodeResolution,
              suratTrackingLog: trackingVerification?.suratTrackingLog,
              trackingVerification: verificationDebug,
            }
          : createResult.shipment,
      }
    }
    return {
      ...createResult,
      ok: false,
      message:
        outcome.duplicateShipment
          ? 'Sürat gönderisi daha önce oluşmuş görünüyor ancak KargoTakipHareketDetayi ile mevcut kayıt teyit edilemedi. Etiket basılamaz.'
          : 'Sürat gönderi kaydı KargoTakipHareketDetayi ile teyit edilemedi. Etiket basılamaz.',
      errorCode: 'SURAT_TRACKING_CONFIRMATION_MISSING',
      errorSource: 'Sürat',
      trackingVerification: verificationDebug,
      suratCreateLog: {
        ...createResult.suratCreateLog,
        trackingVerification: verificationDebug,
      },
      createDiagnostics: {
        ...createResult.createDiagnostics,
        trackingVerification: verificationDebug,
      },
      shipment: createResult.shipment
        ? {
            ...createResult.shipment,
            trackingNumber: '',
            kargoTakipNo: '',
            tNo: '',
            trackingSource: '',
            barcode: '',
            barkodNo: '',
            barcodeValue: '',
            barcodeSource: '',
            verifiedShipment: false,
            dispatchRegistrationConfirmed: shipmentRegistered,
            operationalBarcodeVerified: false,
            verificationStage: 'tracking_confirmation_missing',
            lifecycleStage: lifecycle.state,
            lifecycleMilestones: lifecycle.milestones,
            lifecycleEvidence: lifecycle,
            errorCategory: 'SURAT_TRACKING_CONFIRMATION_MISSING',
            finalSuratBarcode: '',
            candidateTNo: expectedTrackingNumber,
            candidateBarkodNo: expectedBarcode,
            candidateVerificationStatus: 'PENDING_VERIFICATION',
            lifecycleStatus: shipmentRegistered
              ? labelCreated
                ? 'SURAT_TRACKING_MISSING'
                : 'SHIPMENT_CREATED'
              : labelCreated
                ? 'SURAT_TRACKING_MISSING'
                : 'SURAT_CREATED_NO_TRACKING',
            labelStatus: 'BLOCKED',
            printEnabled: false,
            zplReady: false,
            diagnosticMessage:
              'KargoTakipHareketDetayi aynı WebSiparisKodu için kayıt döndürmedi.',
            suratTrackingLog: trackingVerification?.suratTrackingLog,
            trackingVerification: verificationDebug,
          }
        : createResult.shipment,
    }
  }

  if (!labelCreated) {
    const registeredBarcode = firstNonEmpty(
      trackingBarcode,
      registrationBarcode,
    )
    const labelRequiredLifecycle = deriveSuratLifecycleState({
      createAccepted: true,
      shipmentRegistered: true,
      labelCreated: false,
      trackingActive,
    })
    const labelRequiredVerification = {
      ...verificationDebug,
      serdendipVerified: true,
      lifecycleStage: labelRequiredLifecycle.state,
      lifecycleMilestones: labelRequiredLifecycle.milestones,
    }
    return {
      ...createResult,
      ok: false,
      errorCode: 'SURAT_LABEL_REQUIRED',
      errorSource: 'CargoFlow',
      message:
        'Sürat shipment kaydı doğrulandı; ortak barkod/ZPL için ayrı label operation gerekli.',
      trackingVerification: labelRequiredVerification,
      suratCreateLog: {
        ...createResult.suratCreateLog,
        verifiedShipment: false,
        dispatchRegistrationConfirmed: true,
        trackingVerification: labelRequiredVerification,
      },
      createDiagnostics: {
        ...createResult.createDiagnostics,
        trackingVerification: labelRequiredVerification,
      },
      shipment: createResult.shipment
        ? {
            ...createResult.shipment,
            trackingNumber,
            kargoTakipNo: trackingNumber,
            tNo: trackingNumber,
            trackingSource: registrationReferenceMatches
              ? 'surat.WebSiparisKodu.TakipNo'
              : 'surat.KargoTakipHareketDetayi.KargoTakipNo',
            barcode: registeredBarcode,
            barkodNo: registeredBarcode,
            barcodeValue: registeredBarcode,
            barcodeSource: registrationBarcode
              ? 'surat.WebSiparisKodu.Barkod'
              : 'surat.KargoTakipHareketDetayi.BarkodNo',
            finalSuratBarcode: registeredBarcode,
            verifiedShipment: false,
            dispatchRegistrationConfirmed: true,
            operationalBarcodeVerified: Boolean(registeredBarcode),
            serdendipVerified: true,
            verificationStage: 'shipment_registered_label_required',
            lifecycleStage: labelRequiredLifecycle.state,
            lifecycleMilestones: labelRequiredLifecycle.milestones,
            lifecycleEvidence: labelRequiredLifecycle,
            errorCategory: 'SURAT_LABEL_REQUIRED',
            lifecycleStatus: 'SHIPMENT_REGISTERED_LABEL_REQUIRED',
            labelStatus: 'BLOCKED',
            printEnabled: false,
            zplReady: false,
            diagnosticMessage:
              'Shipment kaydı ve canonical kodlar bulundu; ZPL henüz üretilmedi.',
            labelBlockedReason:
              'Ortak barkod/ZPL label operation tamamlanmadan yazdırılamaz.',
            suratTrackingLog: trackingVerification?.suratTrackingLog,
            trackingVerification: labelRequiredVerification,
          }
        : createResult.shipment,
    }
  }

  if (!trackingBarcode || !trackingBarcodeMatchesCreate) {
    return {
      ...createResult,
      ok: false,
      message:
        trackingBarcode
          ? 'Sürat kaydı T.No ile bulundu ancak Serendip BarkodNo, ZPL ana barkoduyla eşleşmedi. Etiket basılamaz.'
          : 'Sürat kaydı T.No ile doğrulandı ancak ana BarkodNo alınamadı. Etiket basılamaz.',
      errorCode: 'SURAT_OPERATIONAL_BARCODE_MISSING',
      errorSource: 'Sürat',
      trackingVerification: verificationDebug,
      operationalBarcodeResolution,
      suratCreateLog: {
        ...createResult.suratCreateLog,
        verifiedShipment: false,
        trackingVerification: verificationDebug,
      },
      createDiagnostics: {
        ...createResult.createDiagnostics,
        trackingVerification: verificationDebug,
        operationalBarcodeResolution,
      },
      shipment: createResult.shipment
        ? {
            ...createResult.shipment,
            trackingNumber,
            kargoTakipNo: trackingNumber,
            tNo: trackingNumber,
            trackingSource: 'surat.KargoTakipHareketDetayi.KargoTakipNo',
            barcode: '',
            barkodNo: '',
            barcodeValue: '',
            barcodeSource: '',
            finalSuratBarcode: '',
            candidateTNo: expectedTrackingNumber,
            candidateBarkodNo: expectedBarcode,
            candidateVerificationStatus: 'PENDING_VERIFICATION',
            verifiedShipment: false,
            dispatchRegistrationConfirmed: true,
            operationalBarcodeVerified: false,
            verificationStage: 'operational_barcode_missing',
            lifecycleStage: lifecycle.state,
            lifecycleMilestones: lifecycle.milestones,
            lifecycleEvidence: lifecycle,
            errorCategory: 'SURAT_OPERATIONAL_BARCODE_MISSING',
            lifecycleStatus: 'SURAT_BARCODE_FAILED',
            labelStatus: 'BLOCKED',
            printEnabled: false,
            zplReady: false,
            diagnosticMessage:
              trackingBarcode
                ? 'Serendip BarkodNo ile ZPL BarkodNo eşleşmedi.'
                : 'Serendip kaydı bulundu; KargoBarkodu servisi numeric ve ZPL ile eşleşen BarkodNo döndürmedi.',
            labelBlockedReason:
              'Sürat ana BarkodNo alınmadan etiket yazdırılamaz.',
            suratOperationalBarcodeLog: operationalBarcodeResolution,
            suratTrackingLog: trackingVerification?.suratTrackingLog,
            trackingVerification: verificationDebug,
          }
        : createResult.shipment,
    }
  }

  return {
    ...createResult,
    ok: true,
    message:
      outcome.duplicateShipment
        ? 'Sürat gönderisi daha önce oluşmuş; mevcut kayıt KargoTakipHareketDetayi ile doğrulandı.'
        : 'Sürat gönderisi oluşturuldu ve KargoTakipHareketDetayi ile doğrulandı.',
    trackingVerification: verificationDebug,
    suratCreateLog: {
      ...createResult.suratCreateLog,
      verifiedShipment: true,
      trackingVerification: verificationDebug,
    },
    createDiagnostics: {
      ...createResult.createDiagnostics,
      trackingVerification: verificationDebug,
    },
    shipment: createResult.shipment
      ? {
          ...createResult.shipment,
          trackingNumber,
          kargoTakipNo: trackingNumber,
          tNo: trackingNumber,
          trackingSource: 'surat.KargoTakipHareketDetayi.KargoTakipNo',
          barcode,
          barkodNo: barcode,
          barcodeValue: barcode,
          barcodeSource: firstNonEmpty(tracking.BarkodNo, tracking.Barkod)
            ? 'surat.KargoTakipHareketDetayi.BarkodNo'
            : createResult.shipment.barcodeSource || 'surat.create.BarkodNo',
          finalSuratBarcode: barcode,
          trackingUrl:
            tracking.TakipUrl ||
            `https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=${encodeURIComponent(
              trackingNumber,
            )}`,
          verifiedShipment: true,
          dispatchRegistrationConfirmed: true,
          operationalBarcodeVerified: true,
          serdendipVerified: true,
          verificationStage: 'serdendip_verified',
          lifecycleStage: 'VERIFIED',
          lifecycleMilestones: [
            'CREATE_ACCEPTED',
            'SHIPMENT_REGISTERED',
            'LABEL_CREATED',
            'TRACKING_ACTIVE',
            'VERIFIED',
          ],
          errorCategory: '',
          lifecycleStatus: 'LABEL_READY',
          labelStatus: 'READY',
          printEnabled: true,
          zplReady: Boolean(createResult.shipment.barcodeRaw),
          diagnosticMessage: '',
          suratTrackingLog: trackingVerification?.suratTrackingLog,
          trackingVerification: verificationDebug,
        }
      : createResult.shipment,
  }
}

async function createSuratRestShipment(config, order, reference) {
  const firstItem = order.items?.[0] ?? {}
  const recipientName = splitName(order.customerName)
  const marketplaceIntegrationCode = String(
    order.cargoTrackingNumber ?? '',
  ).trim()
  const normalizedDesi =
    toPositiveNumber(order.desi) ?? toPositiveNumber(order.weightKg) ?? 1
  const normalizedWeightKg =
    toPositiveNumber(order.weightKg) ?? normalizedDesi
  const recipientCityId = Number(
    readSuratField(
      [order.shipmentAddress, order.rawOrder, order],
      ['cityId', 'IlId', 'ilId'],
    ),
  )
  const totalQuantity = Math.max(
    1,
    (order.items ?? []).reduce(
      (total, item) => total + Number(item.quantity ?? 0),
      0,
    ),
  )
  const baseUrl =
    resolveSuratRestBaseUrl(config)
  const path = config.createShipmentPath || '/api/Gonderi/GonderiOlustur'
  const basicAuthorization = Buffer.from(
    `${config.restBasicUsername}:${config.restBasicPassword}`,
    'utf8',
  ).toString('base64')
  const payload = {
    KullaniciAdi: config.kullaniciAdi,
    Sifre: config.sifre,
    FirmaId: config.firmaId,
    Data: [
      {
        Desi: normalizedDesi,
        Kg: normalizedWeightKg,
        Adet: totalQuantity,
        KimOder: 1,
        SatisKodu: marketplaceIntegrationCode,
        Gonderen: {
          MusteriId: config.restSenderMusteriId,
          Adi: config.restSenderAdi,
          Soyadi: config.restSenderSoyadi,
          Telefon: config.restSenderTelefon,
          Email: config.restSenderEmail ?? '',
          Adres: config.restSenderAdres,
          IlId: Number(config.restSenderIlId),
          IlceAdi: config.restSenderIlceAdi,
        },
        Alici: {
          MusteriId: firstNonEmpty(
            order.customerEmail,
            marketplaceIntegrationCode,
          ),
          Adi: recipientName.firstName,
          Soyadi: recipientName.lastName,
          Telefon: order.customerPhone,
          Email: order.customerEmail ?? '',
          Adres: resolveSingleShipmentAddress(order),
          IlId: Number.isFinite(recipientCityId) ? recipientCityId : 0,
          IlceAdi: order.district,
        },
        GonderiDurumu: 1,
        Icerik: firstItem.productName ?? 'CargoFlow gönderisi',
        GonderiSekli: 0,
        IsKapidanTahsilat: false,
        KapidaTahsilatTutari: 0,
        TeslimKodu: '',
        TeslimNoktaKodu: '',
      },
    ],
  }

  try {
    const apiResponse = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${basicAuthorization}`,
      },
      body: JSON.stringify(payload),
    })
    const text = await apiResponse.text()
    const data = text ? safeJson(text) : null
    const contentType = apiResponse.headers.get('content-type') || ''
    const rawResponse = data ?? text
    const responseText =
      typeof rawResponse === 'string'
        ? rawResponse
        : JSON.stringify(rawResponse ?? '')
    const responseMessage = extractSuratMessage(rawResponse)
    const parsedResponse = mapSuratCreateResponse(rawResponse, reference)
    const outcome = classifySuratCreateResponse(
      rawResponse,
      parsedResponse,
      'GonderiOlusturV2',
      {
        ...config,
        marketplaceIntegrationCode,
      },
    )
    const createLog = buildSuratCreateLog({
      rawRequest: payload,
      rawResponse,
      responseStatus: apiResponse.status,
      contentType,
      parsedResponse,
      orderId: order.id ?? '',
      shipmentId: reference,
      serviceType: 'GonderiOlusturV2',
      serviceMode: 'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
      operationName: 'GonderiOlusturV2',
      endpoint: `${baseUrl}${path}`,
      payloadFormat: 'JSON',
      outcome,
      requestReference: reference,
    })

    if (
      !apiResponse.ok ||
      outcome.hardError ||
      !isValidSuratCode(outcome.officialTrackingNumber) ||
      !isValidSuratCode(outcome.officialBarcode)
    ) {
      const createError = mapSuratCreateError(responseMessage || responseText)
      return {
        ok: false,
        source: 'real',
        message:
          createError.userMessage ||
          (apiResponse.status === 404
            ? 'Sürat GonderiOlusturV2 / Ortak Barkod REST API dokümanı eksik veya seçili endpoint mevcut değil. Güncel endpoint ve yetki bilgisi Sürat’ten alınmalıdır.'
            : '') ||
          (!outcome.officialTrackingNumber || !outcome.officialBarcode
            ? SURAT_INVALID_CODES_MESSAGE
            : responseMessage) ||
          `Sürat REST/V2 HTTP ${apiResponse.status}: ${responseText.slice(0, 400)}`,
        originalMessage: responseText.slice(0, 2000),
        errorCode: createError.code,
        errorSource: createError.source,
        operationType: 'CREATE_SHIPMENT',
        serviceType: 'GonderiOlusturV2',
        payloadFormat: 'JSON',
        buttonName: 'Sürat Gönderisi Oluştur',
        providerMethod: 'SuratKargoProvider.createShipment',
        endpoint: `${baseUrl}${path}`,
        statusCode: apiResponse.status,
        responseStatus: apiResponse.status,
        contentType,
        rawRequest: redact(payload),
        rawResponse,
        parsedResponse,
        suratCreateLog: createLog,
        requestFieldMapping: {
          shipmentReference: reference,
          SatisKodu: marketplaceIntegrationCode,
        },
      }
    }

    const trackingNumber = outcome.officialTrackingNumber
    const barcodeValue = outcome.officialBarcode
    const shipmentCode = reference

    return {
      ok: true,
      source: 'real',
      message: 'Sürat REST/V2 gönderi oluşturma yanıtı alındı.',
      operationType: 'CREATE_SHIPMENT',
      serviceType: 'GonderiOlusturV2',
      payloadFormat: 'JSON',
      buttonName: 'Sürat Gönderisi Oluştur',
      providerMethod: 'SuratKargoProvider.createShipment',
      endpoint: `${baseUrl}${path}`,
      statusCode: apiResponse.status,
      responseStatus: apiResponse.status,
      rawResponse,
      createDiagnostics: outcome,
      requestFieldMapping: {
        shipmentReference: reference,
        SatisKodu: marketplaceIntegrationCode,
      },
      shipment: {
        provider: 'surat-kargo',
        trackingNumber,
        trackingUrl: trackingNumber
          ? `https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=${encodeURIComponent(
              trackingNumber,
            )}`
          : '',
        shipmentCode,
        satisKodu: marketplaceIntegrationCode,
        webSiparisKodu: marketplaceIntegrationCode,
        ozelKargoTakipNo: marketplaceIntegrationCode,
        barcode: barcodeValue,
        barcodeValue,
        barcodeSource: `surat.response.${outcome.codeMapping?.barcodeField || 'Barcode'}`,
        trackingSource: `surat.response.${outcome.codeMapping?.trackingField || 'KargoTakipNo'}`,
        tNo: outcome.codeMapping?.tNoValue || '',
        barkodNo: outcome.codeCandidates?.barkodNo || '',
        gonderiNo: outcome.codeCandidates?.gonderiNo || '',
        waybillNo: outcome.codeCandidates?.waybillNo || '',
        irsaliyeNo: outcome.codeCandidates?.irsaliyeNo || '',
        cargoKey: outcome.codeCandidates?.cargoKey || '',
        codeCandidates: outcome.codeCandidates,
        codeMapping: outcome.codeMapping,
        status: 'created',
        lifecycleStatus: trackingNumber
          ? 'SHIPMENT_CREATED'
          : 'SURAT_CREATED_NO_TRACKING',
        diagnosticMessage: outcome.noTrackingReason,
        rawResponse: {
          operation: 'GonderiOlusturV2',
          result: rawResponse,
          parsedResponse,
          officialTrackingNumberReceived: Boolean(trackingNumber),
          codeCandidates: outcome.codeCandidates,
          codeMapping: outcome.codeMapping,
          suratCreateLog: createLog,
        },
        suratCreateLog: createLog,
        rawSuratCreateResponse: rawResponse,
      },
    }
  } catch (error) {
    return {
      ok: false,
      source: 'real',
      message:
        error instanceof Error
          ? `Sürat REST/V2 bağlantı hatası: ${error.message}`
          : 'Sürat REST/V2 bağlantı hatası.',
      rawRequest: redact(payload),
      rawResponse: error instanceof Error ? error.message : 'Bağlantı hatası',
      parsedResponse: null,
      operationType: 'CREATE_SHIPMENT',
      serviceType: 'GonderiOlusturV2',
      payloadFormat: 'JSON',
      buttonName: 'Sürat Gönderisi Oluştur',
      providerMethod: 'SuratKargoProvider.createShipment',
      endpoint: `${baseUrl}${path}`,
      statusCode: 0,
      responseStatus: 0,
      errorSource: 'Sürat',
    }
  }
}

async function trackShipmentSoap(config, webSiparisKodu, requestBody) {
  const soap = await callSuratSoap(
    'KargoTakipHareketDetayi',
    `
      <CariKodu>${xmlEscape(config.kullaniciAdi)}</CariKodu>
      <Sifre>${xmlEscape(config.sifre)}</Sifre>
      <WebSiparisKodu>${xmlEscape(webSiparisKodu)}</WebSiparisKodu>
    `,
  )
  const resultText =
    decodeXml(extractTag(soap.text, 'KargoTakipHareketDetayiResult')) ||
    soap.text
  return buildSuratTrackingResult({
    transportOk: soap.ok,
    serviceType: 'KargoTakipHareketDetayiSoap',
    endpoint: 'KargoTakipHareketDetayi',
    payloadFormat: 'SOAP/XML',
    rawRequest: soap.body,
    rawResponse: resultText,
    statusCode: soap.statusCode,
    contentType: soap.contentType,
    webSiparisKodu,
    requestBody,
  })
}

async function trackShipmentRest(config, webSiparisKodu, requestBody) {
  const baseUrl = resolveSuratRestBaseUrl(config)
  const endpoint = `${baseUrl}${config.trackingPath}`
  const payload = {
    CariKodu: config.kullaniciAdi,
    Sifre: config.sifre,
    WebSiparisKodu: webSiparisKodu,
  }
  const params = new URLSearchParams({
    CariKodu: payload.CariKodu,
    Sifre: payload.Sifre,
    WebSiparisKodu: payload.WebSiparisKodu,
  })
  const requestUrl = `${endpoint}?${params.toString()}`

  try {
    const jsonResponse = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain',
      },
    })
    const jsonText = await jsonResponse.text()
    const jsonResult = buildSuratTrackingResult({
      transportOk: jsonResponse.ok,
      serviceType: 'KargoTakipHareketDetayiRest',
      endpoint,
      payloadFormat: 'QUERY',
      rawRequest: payload,
      rawResponse: jsonText ? safeJson(jsonText) ?? jsonText : '',
      statusCode: jsonResponse.status,
      contentType: jsonResponse.headers.get('content-type') || '',
      webSiparisKodu,
      requestBody,
      documentationWarning:
        jsonResponse.status === 404
          ? 'SÃ¼rat REST KargoTakipHareketDetayi endpoint dokÃ¼manÄ±/eriÅŸimi doÄŸrulanamadÄ±. SOAP tracking kullanÄ±n.'
          : '',
    })
    jsonResult.requestFormat = 'official-query-params'
    if (
      Number(jsonResult.gonderilerLength ?? 0) > 0 ||
      [401, 403].includes(Number(jsonResult.statusCode ?? 0)) ||
      isSuratAuthError(jsonResult.message || jsonResult.originalMessage)
    ) {
      return jsonResult
    }

    const apiResponse = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain',
      },
    })
    const text = await apiResponse.text()
    const queryResult = buildSuratTrackingResult({
      transportOk: apiResponse.ok,
      serviceType: 'KargoTakipHareketDetayiRest',
      endpoint,
      payloadFormat: 'QUERY',
      rawRequest: payload,
      rawResponse: text ? safeJson(text) ?? text : '',
      statusCode: apiResponse.status,
      contentType: apiResponse.headers.get('content-type') || '',
      webSiparisKodu,
      requestBody,
      documentationWarning:
        apiResponse.status === 404
          ? 'Sürat REST KargoTakipHareketDetayi endpoint dokümanı/erişimi doğrulanamadı. SOAP tracking kullanın.'
          : '',
    })
    queryResult.restAttempts = [
      buildTrackingAttemptDebug(webSiparisKodu, jsonResult),
      buildTrackingAttemptDebug(webSiparisKodu, queryResult),
    ]
    return queryResult
  } catch (error) {
    return buildSuratTrackingResult({
      transportOk: false,
      serviceType: 'KargoTakipHareketDetayiRest',
      endpoint,
      payloadFormat: 'QUERY',
      rawRequest: payload,
      rawResponse: error instanceof Error ? error.message : 'Bağlantı hatası',
      statusCode: 0,
      contentType: '',
      webSiparisKodu,
      requestBody,
    })
  }
}

function buildSuratTrackingResult({
  transportOk,
  serviceType,
  endpoint,
  payloadFormat,
  rawRequest,
  rawResponse,
  statusCode,
  contentType,
  webSiparisKodu,
  requestBody,
  documentationWarning = '',
}) {
  const rawText =
    typeof rawResponse === 'string'
      ? rawResponse
      : JSON.stringify(rawResponse ?? '')
  const parsedResponse =
    typeof rawResponse === 'string' ? safeJson(rawResponse) : rawResponse
  const tracking = normalizeSuratTrackingFields(
    parsedResponse,
    webSiparisKodu,
    rawText,
  )
  const message =
    extractSuratMessage(parsedResponse) ||
    extractSuratMessage(rawText) ||
    documentationWarning
  const isError = parseBoolean(
    readSuratField(parsedResponse, ['IsError', 'isError']),
  )
  const gonderilerLength = resolveGonderilerLength(
    parsedResponse,
    tracking,
  )
  const officialBarcode = firstNonEmpty(
    tracking.KargoTakipNo,
    tracking.BarkodNo,
    tracking.Barkod,
    tracking.TakipUrlTrackingNo,
  )
  const transferredButNoBarcode =
    /veri aktarımı sağlanmış olup kargo kabul bekleniyor/i.test(message) ||
    (!officialBarcode && gonderilerLength === 0 && isError !== true)
  const trackingMissing = Boolean(
    !officialBarcode &&
      gonderilerLength === 0 &&
      (isError === true || /sipariş bulunamadı/i.test(message)),
  )
  const trackingState = transferredButNoBarcode
    ? 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
    : officialBarcode
      ? 'TRACKING_CONFIRMED'
      : trackingMissing
        ? 'SURAT_TRACKING_MISSING'
        : 'SHIPMENT_CREATED'
  const authError = isSuratAuthError(message)
  const trackingError = mapSuratTrackingError(message || rawText)
  const hardError =
    !transportOk ||
    authError ||
    isError === true ||
    Boolean(documentationWarning)
  const userMessage = transferredButNoBarcode
    ? 'Sürat gönderi verisini aldı; kargo kabulü bekleniyor. Hareket servisi henüz Gonderiler kaydı döndürmedi.'
    : documentationWarning ||
      trackingError.userMessage ||
      message ||
      'Sürat takip servisi yanıt verdi.'
  const trackingLog = buildSuratTrackingLog({
    rawRequest,
    rawResponse,
    responseStatus: statusCode,
    contentType,
    parsedResponse: tracking,
    orderId: requestBody?.orderId ?? '',
    shipmentId: requestBody?.shipmentId ?? webSiparisKodu,
    serviceType,
    endpoint,
    payloadFormat,
    gonderilerLength,
    isError,
    errorMessage: message,
    trackingState,
  })
  const carrierStatus =
    gonderilerLength > 0
      ? mapSuratCarrierStatus(tracking.KargonunDurumuSayi)
      : undefined

  return {
    ok: !hardError,
    source: 'real',
    message: userMessage,
    originalMessage: message || rawText,
    errorCode: trackingError.code,
    errorSource: hardError ? trackingError.source || 'Sürat' : undefined,
    operationType: 'TRACK_SHIPMENT',
    buttonName: 'Takip Sorgula',
    providerMethod: 'SuratKargoProvider.trackShipment',
    endpoint,
    serviceType,
    payloadFormat,
    trackingState,
    gonderilerLength,
    tracking,
    carrierStatus,
    suratTrackingLog: trackingLog,
    statusCode,
    responseStatus: statusCode,
    contentType,
    rawResponse,
    rawRequest: redactSuratRawRequest(rawRequest),
    parsedResponse: tracking,
  }
}

function buildSuratShipmentPayload(
  order,
  reference,
  { commonBarcode = false } = {},
) {
  const items = Array.isArray(order.items) ? order.items : []
  // Sürat alan sözleşmesi:
  // - Adet   = KOLİ sayısı (varsayılan 1). Ürün adedi koli sayısı DEĞİLDİR;
  //            çok ürünlü sipariş tek koliyle gider.
  // - BirimDesi = koli başına toplam desi. İstemci bunu ürün satırlarından
  //            sum(adet × birim desi) olarak veya manuel "Toplam koli desisi"
  //            girişinden hesaplayıp order.desi olarak gönderir.
  // - BirimKg = koli ağırlığı; weightKg yoksa Sürat pratiğine uygun olarak
  //            desi değeri aynen kullanılır (hacimsel ağırlık >= gerçek kg).
  const parcelCount = Math.max(
    1,
    Math.round(toPositiveNumber(order.packageCount) ?? 1),
  )
  const desi = toPositiveNumber(order.desi)
  if (desi == null) {
    throw new Error(
      'Desi bilgisi eksik. Sürat gönderisi oluşturmadan önce desi girilmelidir.',
    )
  }
  const kg =
    toPositiveNumber(order.weightKg ?? order.kg) ??
    desi
  const content = items
    .map((item) => {
      const variants = [
        item.color ? `Renk: ${item.color}` : '',
        item.size ? `Beden: ${item.size}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      return `${Number(item.quantity ?? 1)}x ${item.productName || 'Ürün'}${
        variants ? ` (${variants})` : ''
      }`
    })
    .join(' | ')
    .slice(0, 250)
  const marketplaceIntegrationCode = String(
    order.cargoTrackingNumber ?? '',
  ).trim()
  const orderNumber = String(order.orderNumber ?? '').trim()
  const packageId = String(
    order.packageId ?? order.shipmentPackageId ?? reference,
  ).trim()
  const trendyolReference = packageId || orderNumber || reference

  return {
    KisiKurum: String(order.customerName ?? ''),
    SahisBirim: '',
    AliciAdresi: resolveSingleShipmentAddress(order),
    Il: String(order.city ?? ''),
    Ilce: String(order.district ?? ''),
    TelefonEv: '',
    TelefonIs: '',
    TelefonCep: String(order.customerPhone ?? ''),
    Email: String(order.customerEmail ?? ''),
    AliciKodu: '',
    KargoTuru: 3,
    OdemeTipi: 1,
    IrsaliyeSeriNo: '',
    IrsaliyeSiraNo: '',
    ReferansNo: trendyolReference,
    OzelKargoTakipNo: marketplaceIntegrationCode,
    WebSiparisKodu: orderNumber,
    SatisKodu: orderNumber,
    MarketplaceIntegrationCode: marketplaceIntegrationCode,
    Adet: parcelCount,
    BirimDesi: desi,
    BirimKg: kg,
    KargoIcerigi: content || 'CargoFlow gönderisi',
    KapidanOdemeTahsilatTipi: 0,
    KapidanOdemeTutari: 0,
    EkHizmetler: '',
    TasimaSekli: 1,
    TeslimSekli: 1,
    SevkAdresi: String(order.customerName ?? ''),
    GonderiSekli: 0,
    TeslimSubeKodu: '',
    Pazaryerimi: 1,
    EntegrasyonFirmasi: 'Trendyol',
    Iademi: false,
  }
}

function buildOfficialSuratRestShipment(payload) {
  return {
    KisiKurum: payload.KisiKurum,
    SahisBirim: payload.SahisBirim,
    AliciAdresi: payload.AliciAdresi,
    Il: payload.Il,
    Ilce: payload.Ilce,
    TelefonEv: payload.TelefonEv,
    TelefonIs: payload.TelefonIs,
    TelefonCep: payload.TelefonCep,
    Email: payload.Email,
    AliciKodu: payload.AliciKodu,
    KargoTuru: payload.KargoTuru,
    Odemetipi: payload.OdemeTipi,
    IrsaliyeSeriNo: payload.IrsaliyeSeriNo,
    IrsaliyeSiraNo: payload.IrsaliyeSiraNo,
    ReferansNo: payload.ReferansNo,
    OzelKargoTakipNo: payload.OzelKargoTakipNo,
    Adet: payload.Adet,
    BirimDesi: payload.BirimDesi,
    BirimKg: payload.BirimKg,
    KargoIcerigi: payload.KargoIcerigi,
    KapidanOdemeTahsilatTipi: payload.KapidanOdemeTahsilatTipi,
    KapidanOdemeTutari: payload.KapidanOdemeTutari,
    EkHizmetler: payload.EkHizmetler,
    TasimaSekli: payload.TasimaSekli,
    TeslimSekli: payload.TeslimSekli,
    SevkAdresi: payload.SevkAdresi,
    GonderiSekli: payload.GonderiSekli,
    TeslimSubeKodu: payload.TeslimSubeKodu,
    Pazaryerimi: payload.Pazaryerimi,
    EntegrasyonFirmasi: payload.EntegrasyonFirmasi,
    Iademi: payload.Iademi,
  }
}

function buildSuratGonderiXml(
  payload,
  { commonBarcode = false, strictGonderiModel = false } = {},
) {
  const paymentTag = commonBarcode ? 'OdemeTipi' : 'Odemetipi'
  const shipmentAddressTag = commonBarcode ? 'SevkAdresi' : 'SevkAdresiAdi'
  const optionalStringTag = (tagName, value) =>
    strictGonderiModel
      ? optionalXmlTag(tagName, value)
      : `<${tagName}>${xmlEscape(value)}</${tagName}>`
  const codAmountTag = strictGonderiModel
    ? Number(payload.KapidanOdemeTahsilatTipi ?? 0) > 0 ||
      Number(payload.KapidanOdemeTutari ?? 0) > 0
      ? optionalXmlTag('KapidanOdemeTutari', payload.KapidanOdemeTutari)
      : ''
    : `<KapidanOdemeTutari>${payload.KapidanOdemeTutari}</KapidanOdemeTutari>`
  return `
      <Gonderi>
        ${optionalStringTag('KisiKurum', payload.KisiKurum)}
        ${optionalStringTag('SahisBirim', payload.SahisBirim)}
        ${optionalStringTag('AliciAdresi', payload.AliciAdresi)}
        ${optionalStringTag('Il', payload.Il)}
        ${optionalStringTag('Ilce', payload.Ilce)}
        ${optionalStringTag('TelefonEv', payload.TelefonEv)}
        ${optionalStringTag('TelefonIs', payload.TelefonIs)}
        ${optionalStringTag('TelefonCep', payload.TelefonCep)}
        ${optionalStringTag('Email', payload.Email)}
        ${optionalStringTag('AliciKodu', payload.AliciKodu)}
        <KargoTuru>${payload.KargoTuru}</KargoTuru>
        <${paymentTag}>${payload.OdemeTipi}</${paymentTag}>
        ${optionalStringTag('IrsaliyeSeriNo', payload.IrsaliyeSeriNo)}
        ${optionalStringTag('IrsaliyeSiraNo', payload.IrsaliyeSiraNo)}
        ${strictGonderiModel ? '' : `<WebSiparisKodu>${xmlEscape(payload.WebSiparisKodu)}</WebSiparisKodu>`}
        ${strictGonderiModel ? '' : `<SatisKodu>${xmlEscape(payload.SatisKodu)}</SatisKodu>`}
        ${optionalStringTag('ReferansNo', payload.ReferansNo)}
        ${optionalStringTag('OzelKargoTakipNo', payload.OzelKargoTakipNo)}
        ${strictGonderiModel ? '' : `<MarketplaceIntegrationCode>${xmlEscape(payload.MarketplaceIntegrationCode)}</MarketplaceIntegrationCode>`}
        <Adet>${payload.Adet}</Adet>
        ${optionalStringTag('BirimDesi', payload.BirimDesi)}
        ${optionalStringTag('BirimKg', payload.BirimKg)}
        ${optionalStringTag('KargoIcerigi', payload.KargoIcerigi)}
        <KapidanOdemeTahsilatTipi>${payload.KapidanOdemeTahsilatTipi}</KapidanOdemeTahsilatTipi>
        ${codAmountTag}
        ${optionalStringTag('EkHizmetler', payload.EkHizmetler)}
        <TasimaSekli>${payload.TasimaSekli}</TasimaSekli>
        <TeslimSekli>${payload.TeslimSekli}</TeslimSekli>
        ${optionalStringTag(shipmentAddressTag, payload.SevkAdresi)}
        <GonderiSekli>${payload.GonderiSekli}</GonderiSekli>
        ${optionalStringTag('TeslimSubeKodu', payload.TeslimSubeKodu)}
        <Pazaryerimi>${payload.Pazaryerimi}</Pazaryerimi>
        ${optionalStringTag('EntegrasyonFirmasi', payload.EntegrasyonFirmasi)}
        <Iademi>${payload.Iademi}</Iademi>
      </Gonderi>
  `
}

function buildSuratGonderiEntityXml(payload) {
  return `
      <Gonderientity>
        <GonderiSekli>${toIntegerXml(payload.GonderiSekli, 0)}</GonderiSekli>
        <KisiKurum>${xmlEscape(payload.KisiKurum)}</KisiKurum>
        ${optionalXmlTag('SahisBirim', payload.SahisBirim)}
        <AliciAdresi>${xmlEscape(payload.AliciAdresi)}</AliciAdresi>
        <Il>${xmlEscape(payload.Il)}</Il>
        <Ilce>${xmlEscape(payload.Ilce)}</Ilce>
        ${optionalXmlTag('TelefonEv', payload.TelefonEv)}
        ${optionalXmlTag('TelefonIs', payload.TelefonIs)}
        ${optionalXmlTag('TelefonCep', payload.TelefonCep)}
        ${optionalXmlTag('Email', payload.Email)}
        ${optionalXmlTag('AliciKodu', payload.AliciKodu)}
        <KargoTuru>${payload.KargoTuru}</KargoTuru>
        <Odemetipi>${payload.OdemeTipi}</Odemetipi>
        ${optionalXmlTag('IrsaliyeSeriNo', payload.IrsaliyeSeriNo)}
        ${optionalXmlTag('IrsaliyeSiraNo', payload.IrsaliyeSiraNo)}
        ${optionalXmlTag('ReferansNo', payload.ReferansNo)}
        ${optionalXmlTag('OzelKargoTakipNo', payload.OzelKargoTakipNo)}
        <Adet>${payload.Adet}</Adet>
        <BirimDesi>${payload.BirimDesi}</BirimDesi>
        <BirimKg>${payload.BirimKg}</BirimKg>
        ${optionalXmlTag('KargoIcerigi', payload.KargoIcerigi)}
        <KapidanOdemeTahsilatTipi>${payload.KapidanOdemeTahsilatTipi}</KapidanOdemeTahsilatTipi>
        <KapidanOdemeTutari>${payload.KapidanOdemeTutari}</KapidanOdemeTutari>
        ${optionalXmlTag('EkHizmetler', payload.EkHizmetler)}
        ${optionalXmlTag('SevkAdresiAdi', payload.SevkAdresi)}
        <TeslimSekli>${payload.TeslimSekli}</TeslimSekli>
        <TasimaSekli>${payload.TasimaSekli}</TasimaSekli>
        ${optionalXmlTag('BayiNo', payload.BayiNo)}
        ${optionalXmlTag('EntegrasyonId', payload.EntegrasyonId)}
        ${optionalXmlTag('EntegrasyonHesaplamaTuru', payload.EntegrasyonHesaplamaTuru)}
        <VarisSubeObjId>${toIntegerXml(payload.VarisSubeObjId, 0)}</VarisSubeObjId>
        ${optionalXmlTag('VarisSubeAdi', payload.VarisSubeAdi)}
        ${optionalXmlTag('AktarmaSubeKodu', payload.AktarmaSubeKodu)}
        ${optionalXmlTag('VarisAktarma', payload.VarisAktarma)}
        ${optionalXmlTag('Barkod', payload.Barkod)}
        ${optionalXmlTag('TakipNo', payload.TakipNo)}
        ${optionalXmlTag('EvrakSeriNo', payload.EvrakSeriNo)}
        <EvrakSiraNo>${toDecimalXml(payload.EvrakSiraNo, 0)}</EvrakSiraNo>
        <SiparisObjId>${toIntegerXml(payload.SiparisObjId, 0)}</SiparisObjId>
        ${optionalXmlTag('XCoor', payload.XCoor)}
        ${optionalXmlTag('YCoor', payload.YCoor)}
        ${optionalXmlTag('TespitTipi', payload.TespitTipi)}
        ${optionalXmlTag('UniqueTextHash', payload.UniqueTextHash)}
        ${optionalXmlTag('OrtakBarkotDesi', payload.OrtakBarkotDesi)}
        ${optionalXmlTag('OrtakBarkotKg', payload.OrtakBarkotKg)}
        ${optionalXmlTag('TeslimSubeKodu', payload.TeslimSubeKodu)}
        <Pazaryerimi>${payload.Pazaryerimi}</Pazaryerimi>
        ${optionalXmlTag('WhoPays', payload.WhoPays)}
        ${optionalXmlTag('EntegrasyonMusteri', payload.EntegrasyonMusteri)}
        ${optionalXmlTag('EntegrasyonFirmasi', payload.EntegrasyonFirmasi)}
        <EntegrasyonSozlesme>${toIntegerXml(payload.EntegrasyonSozlesme, 0)}</EntegrasyonSozlesme>
        <Iademi>${payload.Iademi}</Iademi>
        <KWebGonderiGirisiKaynak>${xmlEscape(payload.KWebGonderiGirisiKaynak || 'PazaryeriOrtakBarkod')}</KWebGonderiGirisiKaynak>
        ${optionalXmlTag('KonsolidasyonTakipNumarasi', payload.KonsolidasyonTakipNumarasi)}
        ${optionalXmlTag('PaletId', payload.PaletId)}
        ${optionalXmlTag('AlimSaati', payload.AlimSaati)}
      </Gonderientity>
  `
}

function enrichKargoBarkoduSiparisPayload(payload, config = {}) {
  payload.GonderiSekli = toIntegerXml(payload.GonderiSekli, 0)
  payload.OdemeTipi = toIntegerXml(
    firstNonEmpty(config.odemeTipi, config.odemetipi, payload.OdemeTipi),
    1,
  )
  // Bunlar Sürat'in iç veritabanı kimlikleridir; Trendyol packageId veya
  // cari kodu bu alanlara yazılırsa servis geçersiz bir iç kaydı arar.
  payload.SiparisObjId = toIntegerXml(config.siparisObjId, 0)
  payload.VarisSubeObjId = toIntegerXml(config.varisSubeObjId, 0)
  payload.EvrakSiraNo = toDecimalXml(config.evrakSiraNo, 0)
  payload.EntegrasyonId = firstNonEmpty(config.entegrasyonId, config.integrationId)
  payload.EntegrasyonMusteri = firstNonEmpty(
    config.entegrasyonMusteri,
    config.integrationCustomer,
  )
  payload.EntegrasyonFirmasi = firstNonEmpty(
    config.entegrasyonFirmasi,
    config.integrationCompany,
    payload.EntegrasyonFirmasi,
    'Trendyol',
  )
  payload.EntegrasyonSozlesme = toIntegerXml(
    firstNonEmpty(
      config.entegrasyonSozlesme,
      config.integrationContract,
    ),
    0,
  )
  payload.KapidanOdemeTahsilatTipi = config.cashOnDelivery
    ? toIntegerXml(config.kapidanOdemeTahsilatTipi, 1)
    : 0
  payload.KapidanOdemeTutari = config.cashOnDelivery
    ? toDecimalXml(config.codAmount, 0)
    : 0
  payload.WhoPays = firstNonEmpty(config.whoPays, config.WhoPays)
  payload.KWebGonderiGirisiKaynak = firstNonEmpty(
    config.kWebGonderiGirisiKaynak,
    config.gonderiGirisiKaynak,
    'PazaryeriOrtakBarkod',
  )
}

function optionalXmlTag(tagName, value) {
  const text = String(value ?? '').trim()
  return text ? `<${tagName}>${xmlEscape(text)}</${tagName}>` : ''
}

function toIntegerXml(value, fallback = 0) {
  const integer = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(integer) ? String(integer) : String(fallback)
}

function toDecimalXml(value, fallback = 0) {
  const number = Number(String(value ?? '').replace(',', '.'))
  return Number.isFinite(number) ? String(number) : String(fallback)
}

function analyzeSuratZpl(value) {
  const zpl = normalizeSuratRawZpl(value)
  const fields = []
  const regex = /\^FD([\s\S]*?)\^FS/gi
  let match
  while ((match = regex.exec(zpl))) {
    const before = zpl.slice(Math.max(0, match.index - 180), match.index)
    const commands = Array.from(before.matchAll(/\^(BC|BQ|BX)[^^]*/gi))
    const command = commands.at(-1)?.[1]?.toUpperCase() ?? ''
    fields.push({
      value: decodeZplField(match[1]),
      kind:
        command === 'BC'
          ? 'code128'
          : command === 'BQ'
            ? 'qr'
            : command === 'BX'
              ? 'dataMatrix'
              : 'text',
    })
  }
  const allFdValues = uniqueStrings(fields.map((field) => field.value))
  const mainCode128Candidates = uniqueStrings(
    fields
      .filter((field) => field.kind === 'code128')
      .map((field) => cleanZplCode(field.value)),
  )
  const qrCandidates = uniqueStrings(
    fields
      .filter((field) => field.kind === 'qr')
      .map((field) => cleanZplCode(field.value)),
  )
  const dataMatrixCandidates = uniqueStrings(
    fields
      .filter((field) => field.kind === 'dataMatrix')
      .map((field) => cleanZplCode(field.value)),
  )
  const numericBarcodeCandidates = uniqueStrings(
    [...mainCode128Candidates, ...dataMatrixCandidates, ...allFdValues]
      .map(cleanZplCode)
      .filter(isNumericSuratOperationalCode),
  )
  const webBarcodeCandidates = uniqueStrings(
    [...mainCode128Candidates, ...allFdValues]
      .map(cleanZplCode)
      .filter((candidate) => /^web[0-9a-z-]+$/i.test(candidate)),
  )
  const tNoCandidates = uniqueStrings([
    ...extractZplLabelledNumeric(allFdValues, /t\.?\s*no/i),
    ...allFdValues
      .map((field) => field.match(/t\.?\s*no\s*:?\s*(\d{8,20})/i)?.[1] ?? '')
      .filter(Boolean),
    ...numericBarcodeCandidates.filter(
      (candidate) =>
        /^\d{14}$/.test(candidate) &&
        !mainCode128Candidates.includes(candidate) &&
        !qrCandidates.includes(candidate),
    ),
  ])
  const siparisNoCandidates = uniqueStrings(
    extractZplLabelledNumeric(
      allFdValues,
      /sipari[sş]|must\.?\s*irs\.?\s*no/i,
    ),
  )
  const referenceNoCandidates = uniqueStrings([
    ...extractZplLabelledNumeric(allFdValues, /ref(?:erans)?\.?\s*no/i),
    ...qrCandidates.filter(isNumericSuratOperationalCode),
  ])
  const routeTransferText = uniqueStrings(
    allFdValues.filter((field) => /aktarma|transfer|merkez/i.test(field)),
  )
  const destinationText = uniqueStrings(
    allFdValues.filter((field) => /teslim|var[ıi][sş]|il[cç]e|adres/i.test(field)),
  )
  const acceptedFinalBarcode =
    mainCode128Candidates.find(isNumericSuratOperationalCode) ??
    webBarcodeCandidates[0] ??
    ''
  const acceptedTNo =
    tNoCandidates.find(isNumericSuratOperationalCode) ?? ''
  const internalWebBarcode = webBarcodeCandidates[0] ?? ''
  const legacyRejectionReason = !zpl
    ? 'BarcodeRaw / geçerli ZPL bulunamadı.'
    : !acceptedFinalBarcode && internalWebBarcode
      ? 'Ana barkod Web formatında. Başarılı Sürat Serdendip etiketindeki numeric ana barkod bulunamadı.'
      : !acceptedFinalBarcode
        ? 'Numeric ana Sürat barkodu bulunamadı.'
        : !acceptedTNo
          ? 'Numeric T.No bulunamadı.'
          : ''
  const rejectionReason =
    !zpl || !acceptedFinalBarcode ? legacyRejectionReason : ''

  return {
    hasBarcodeRaw: Boolean(zpl),
    allFdValues,
    mainCode128Candidates,
    qrCandidates,
    dataMatrixCandidates,
    numericBarcodeCandidates,
    webBarcodeCandidates,
    tNoCandidates,
    siparisNoCandidates,
    referenceNoCandidates,
    routeTransferText,
    destinationText,
    acceptedFinalBarcode,
    acceptedTNo,
    internalWebBarcode,
    rejectionReason,
  }
}

function decodeZplField(value) {
  return decodeXml(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanZplCode(value) {
  return String(value ?? '')
    .trim()
    .replace(/^>[;:]/, '')
    .replace(/^(?:QA|LA),/i, '')
    .trim()
}

function isNumericSuratOperationalCode(value) {
  return /^\d{8,20}$/.test(String(value ?? '').trim())
}

function isOperationalSuratTNo(value) {
  const text = String(value ?? '').trim()
  return (
    isNumericSuratOperationalCode(text) ||
    /^TNO[-\s]?\d{8,20}$/i.test(text)
  )
}

function extractZplLabelledNumeric(values, label) {
  const found = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!label.test(value)) continue
    found.push(...(value.match(/\d{8,20}/g) ?? []))
    const next = cleanZplCode(values[index + 1] ?? '')
    if (isNumericSuratOperationalCode(next)) found.push(next)
  }
  return uniqueStrings(found)
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function collectSuratCodeCandidates(parsedResponse, rawText = '') {
  const candidates = {
    takipNo: firstNonEmpty(
      readSuratField(parsedResponse, ['TakipNo']),
      extractFirst(rawText, ['TakipNo']),
    ),
    kargoTakipNo: firstNonEmpty(
      readSuratField(parsedResponse, [
        'KargoTakipNo',
        'KargoTakipNumarasi',
        'KargoTakipNumarası',
      ]),
      extractFirst(rawText, [
        'KargoTakipNo',
        'KargoTakipNumarasi',
        'KargoTakipNumarası',
      ]),
    ),
    barkod: firstNonEmpty(
      readSuratField(parsedResponse, ['Barkod']),
      extractFirst(rawText, ['Barkod']),
    ),
    barkodNo: firstNonEmpty(
      readSuratField(parsedResponse, ['BarkodNo']),
      extractFirst(rawText, ['BarkodNo']),
    ),
    gonderiNo: firstNonEmpty(
      readSuratField(parsedResponse, [
        'GonderiNo',
        'GönderiNo',
        'GonderiKodu',
        'shipmentNumber',
        'shipmentCode',
      ]),
      extractFirst(rawText, [
        'GonderiNo',
        'GönderiNo',
        'GonderiKodu',
        'shipmentNumber',
        'shipmentCode',
      ]),
    ),
    waybillNo: firstNonEmpty(
      readSuratField(parsedResponse, [
        'waybillNo',
        'WaybillNo',
        'awb',
        'awbNo',
      ]),
      extractFirst(rawText, ['waybillNo', 'WaybillNo', 'awb', 'awbNo']),
    ),
    irsaliyeNo: firstNonEmpty(
      readSuratField(parsedResponse, [
        'irsaliyeNo',
        'IrsaliyeNo',
        'IrsaliyeSiraNo',
      ]),
      extractFirst(rawText, ['irsaliyeNo', 'IrsaliyeNo', 'IrsaliyeSiraNo']),
    ),
    cargoKey: firstNonEmpty(
      readSuratField(parsedResponse, [
        'cargoKey',
        'CargoKey',
        'kargoKey',
        'KargoKey',
      ]),
      extractFirst(rawText, ['cargoKey', 'CargoKey', 'kargoKey', 'KargoKey']),
    ),
    trackingNumber: firstNonEmpty(
      readSuratField(parsedResponse, ['trackingNumber', 'TrackingNumber']),
      extractFirst(rawText, ['trackingNumber', 'TrackingNumber']),
    ),
    barcode: firstNonEmpty(
      readSuratField(parsedResponse, ['barcode']),
      extractFirst(rawText, ['barcode']),
    ),
    Barcode: firstNonEmpty(
      readSuratField(parsedResponse, ['Barcode']),
      normalizeSuratBarcodeValue(extractFirst(rawText, ['Barcode'])),
    ),
    TNo: firstNonEmpty(
      readSuratField(parsedResponse, ['TNo', 'T.No', 'TNO']),
      extractFirst(rawText, ['TNo', 'T.No', 'TNO']),
    ),
  }

  collectDiscoveredSuratCodeFields(parsedResponse, candidates)
  return Object.fromEntries(
    Object.entries(candidates)
      .map(([key, value]) => [key, normalizeSuratCandidateValue(value)])
      .filter(([, value]) => Boolean(value)),
  )
}

function collectDiscoveredSuratCodeFields(value, target, path = '') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectDiscoveredSuratCodeFields(item, target, `${path}[${index}]`),
    )
    return
  }

  for (const [key, item] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key
    if (item && typeof item === 'object') {
      collectDiscoveredSuratCodeFields(item, target, nextPath)
      continue
    }
    if (
      /(takip|barkod|barcode|g[oö]nderi|waybill|irsaliye|cargo.?key|kargo.?key|tracking|awb|^t\.?no$)/i.test(
        key,
      )
    ) {
      const normalized = normalizeSuratCandidateValue(item)
      if (normalized) target[nextPath] = normalized
    }
  }
}

function normalizeSuratCandidateValue(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text.includes('^XA')) return normalizeSuratBarcodeValue(text)
  if (text.startsWith('{') || text.startsWith('[')) {
    const parsed = safeJson(text)
    const nested = readSuratField(parsed, ['anyType', 'string'])
    return nested ? normalizeSuratCandidateValue(nested) : ''
  }
  return text.slice(0, 500)
}

function resolveSuratCodeMapping(candidates, config = {}) {
  const tracking = selectSuratCandidate(
    candidates,
    config.trackingCodeField,
    ['kargoTakipNo', 'trackingNumber', 'takipNo'],
  )
  const barcode = selectSuratCandidate(
    candidates,
    config.barcodeCodeField,
    ['barkodNo', 'barcode', 'barkod', 'Barcode'],
  )
  const tNo = selectSuratCandidate(
    candidates,
    config.tNoCodeField,
    ['TNo'],
  )
  return {
    trackingField: tracking.field,
    barcodeField: barcode.field,
    tNoField: tNo.field,
    trackingValue: tracking.value,
    barcodeValue: barcode.value,
    tNoValue: tNo.value,
  }
}

function selectSuratCandidate(candidates, configuredField, defaults) {
  const requested = String(configuredField || 'auto').trim()
  const keys =
    requested && requested !== 'auto'
      ? [requested]
      : defaults
  for (const key of keys) {
    const direct = Object.entries(candidates).find(
      ([candidateKey]) =>
        candidateKey.toLocaleLowerCase('tr-TR') ===
          key.toLocaleLowerCase('tr-TR') ||
        candidateKey
          .split('.')
          .at(-1)
          ?.toLocaleLowerCase('tr-TR') === key.toLocaleLowerCase('tr-TR'),
    )
    if (direct && isValidSuratCode(direct[1])) {
      return { field: direct[0], value: direct[1] }
    }
  }
  return { field: requested === 'auto' ? '' : requested, value: '' }
}

function isValidSuratCode(value) {
  const code = String(value ?? '').trim()
  return (
    code.length >= 6 &&
    code.length <= 80 &&
    /^[A-Za-z0-9._/-]+$/.test(code)
  )
}

function parseSuratResponseId(rawText = '') {
  const text = String(rawText ?? '')
  const code =
    text.match(/\[(\d{3})\]/)?.[1] ??
    text.match(/<Message>\s*(\d{3})\s*<\/Message>/i)?.[1] ??
    ''
  const tableEntry = SURAT_RESPONSE_ID_TABLE[code]
  if (tableEntry) {
    const retryable = ['RETRY', 'TRENDYOL_PROXY'].includes(tableEntry.category)
    return {
      code,
      category: tableEntry.category,
      description: tableEntry.description,
      documented: code !== '043',
      retryable,
      retryPolicy: retryable
        ? {
            maxAttempts: SURAT_RETRY_DELAYS_SECONDS.length,
            delaysSeconds: SURAT_RETRY_DELAYS_SECONDS,
          }
        : undefined,
    }
  }
  return {
    code,
    category: code ? 'ERROR' : '',
    description: code ? 'Dokümanda bulunmayan Sürat Response ID' : '',
    documented: false,
    retryable: false,
    retryPolicy: undefined,
  }
}

function classifySuratCreateResponse(
  rawResponse,
  parsedResponse,
  serviceType,
  config = {},
) {
  const rawText =
    typeof rawResponse === 'string'
      ? rawResponse
      : JSON.stringify(rawResponse ?? '')
  const responseInfo = parseSuratResponseId(rawText)
  const envelopeCode = responseInfo.code
  const trendyolCargoNotEligibleStatus =
    /hata\s*kodu\s*:?\s*1002/i.test(rawText) ||
    (rawText.includes('1002') &&
      /kargo uygun bir stat[üu]de de[ğg]il/i.test(rawText))
  const code = envelopeCode || (trendyolCargoNotEligibleStatus ? '043' : '')
  const message =
    extractSuratMessage(parsedResponse) ||
    extractSuratMessage(rawText) ||
    rawText
  const normalized = message.toLocaleLowerCase('tr-TR')
  const barcodeResponseCodeDetected =
    responseInfo.category === 'BARCODE_SUCCESS'
  const duplicateShipment =
    responseInfo.category === 'DUPLICATE_EXISTS' ||
    isSuratDuplicateShipmentMessage(message) ||
    normalized.includes('bu gönderi daha önce oluşturulmuş') ||
    normalized.includes('bu gonderi daha once olusturulmus') ||
    normalized.includes('bu siparişe ait gönderi oluşmuştur') ||
    /bu g[oö]nderi daha [oö]nce olu[sş]turulmu[sş]/i.test(message)
  const codeCandidates = collectSuratCodeCandidates(parsedResponse, rawText)
  const officialBarcodeRaw = String(
    readSuratField(parsedResponse, ['BarcodeRaw']) ?? '',
  ).trim()
  const zplAnalysis = analyzeSuratZpl(officialBarcodeRaw)
  const initialCodeMapping = resolveSuratCodeMapping(codeCandidates, config)
  const marketplaceIntegrationCode = String(
    config.marketplaceIntegrationCode ?? '',
  ).trim()
  const isOperationalResponseCode = (value) =>
    isNumericSuratOperationalCode(value) &&
    String(value ?? '').trim() !== marketplaceIntegrationCode
  const acceptedTNo = firstNonEmpty(
    isOperationalSuratTNo(initialCodeMapping.tNoValue)
      ? initialCodeMapping.tNoValue
      : '',
    zplAnalysis.acceptedTNo,
  )
  const officialTrackingNumber = firstNonEmpty(
    isOperationalResponseCode(initialCodeMapping.trackingValue)
      ? initialCodeMapping.trackingValue
      : '',
    acceptedTNo,
  )
  // Kanıt (18.07.2026, sipariş 11424170556): 016 ZPL'inde ilk numeric ^FD
  // değeri T.No'dur; barkod ^BC sonrasındaki ^FD'dir. Bu yüzden canonical
  // barkod kaynağı zplAnalysis.acceptedFinalBarcode'dur ve T.No ile çakışan
  // hiçbir değer barkod olarak kabul edilmez.
  const collidesWithTrackingNumber = (value) => {
    const cleaned = cleanZplCode(value)
    if (!cleaned) return false
    return [
      cleanZplCode(initialCodeMapping.tNoValue),
      cleanZplCode(initialCodeMapping.trackingValue),
      cleanZplCode(zplAnalysis.acceptedTNo),
      cleanZplCode(acceptedTNo),
      cleanZplCode(officialTrackingNumber),
    ].some((trackingValue) => trackingValue && trackingValue === cleaned)
  }
  const zplBarcode = cleanZplCode(zplAnalysis.acceptedFinalBarcode)
  const rawDirectBarcode = cleanZplCode(initialCodeMapping.barcodeValue)
  const directBarcode =
    isOperationalResponseCode(rawDirectBarcode) &&
    !collidesWithTrackingNumber(rawDirectBarcode)
      ? rawDirectBarcode
      : ''
  const officialBarcode = firstNonEmpty(
    isOperationalResponseCode(zplBarcode) &&
      !collidesWithTrackingNumber(zplBarcode)
      ? zplBarcode
      : '',
    directBarcode,
  )
  const codeMapping = {
    ...initialCodeMapping,
    trackingField: officialTrackingNumber
      ? initialCodeMapping.trackingField || 'BarcodeRaw.TNo'
      : '',
    barcodeField: officialBarcode
      ? officialBarcode === directBarcode
        ? initialCodeMapping.barcodeField
        : 'BarcodeRaw.Code128'
      : '',
    tNoField: acceptedTNo
      ? initialCodeMapping.tNoField || 'BarcodeRaw.TNo'
      : '',
    trackingValue: officialTrackingNumber,
    barcodeValue: officialBarcode,
    tNoValue: acceptedTNo,
  }
  const technicalZplReceived = Boolean(
    [
      'OrtakBarkodOlusturSoap',
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    ].includes(serviceType) &&
      officialBarcodeRaw &&
      zplAnalysis.hasBarcodeRaw &&
      parseBoolean(readSuratField(parsedResponse, ['IsError', 'isError'])) !==
        true,
  )
  const operationalBarcodeVerified = Boolean(
    (technicalZplReceived &&
      isValidSuratCode(officialBarcode)) ||
      (serviceType === 'GonderiyiKargoyaGonderRestJson' &&
        responseInfo.category === 'BARCODE_SUCCESS' &&
        isValidSuratCode(officialTrackingNumber) &&
        isValidSuratCode(officialBarcode)),
  )
  const verificationStage = trendyolCargoNotEligibleStatus
    ? 'dispatch_rejected'
    : operationalBarcodeVerified
    ? 'operational_barcode_verified'
    : responseInfo.category === 'DUPLICATE_EXISTS'
      ? 'duplicate_requires_tracking_confirmation'
      : responseInfo.category === 'PARTIAL'
        ? 'partial_requires_tracking_confirmation'
        : responseInfo.category === 'RETRY' ||
            responseInfo.category === 'TRENDYOL_PROXY'
          ? 'retry_scheduled'
    : technicalZplReceived
      ? 'zpl_received_but_not_operationally_verified'
      : serviceType === 'GonderiyiKargoyaGonderRestJson'
        ? 'dispatch_registered'
        : 'failed'
  const errorCategory = trendyolCargoNotEligibleStatus
    ? 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
    : responseInfo.category === 'RETRY'
      ? 'SURAT_RETRYABLE_RESPONSE'
      : responseInfo.category === 'TRENDYOL_PROXY'
        ? 'TRENDYOL_PROXY'
        : responseInfo.category === 'PARTIAL'
          ? 'SURAT_PARTIAL_RESPONSE'
          : responseInfo.category === 'DUPLICATE_EXISTS'
            ? 'SURAT_DUPLICATE_EXISTS'
    : operationalBarcodeVerified
    ? ''
    : technicalZplReceived && zplAnalysis.internalWebBarcode
      ? 'WEB_BARCODE_NOT_FINAL'
      : technicalZplReceived && !officialBarcode
        ? 'MISSING_NUMERIC_SURAT_BARCODE'
        : technicalZplReceived && !acceptedTNo
          ? 'MISSING_TNO'
          : !officialBarcode
            ? 'MISSING_BARCODE'
            : !officialTrackingNumber
              ? 'MISSING_TRACKING_CODE'
              : 'OPERATIONAL_VERIFICATION_FAILED'
  const isError = parseBoolean(
    readSuratField(parsedResponse, ['IsError', 'isError']),
  )
  const acceptedCode = ['BARCODE_SUCCESS', 'PARTIAL', 'DUPLICATE_EXISTS'].includes(
    responseInfo.category,
  )
  const hardError =
    trendyolCargoNotEligibleStatus ||
    (responseInfo.category === 'ERROR' && Boolean(envelopeCode)) ||
    isError === true ||
    (!acceptedCode &&
      !officialTrackingNumber &&
      (normalized.includes('hata') ||
        normalized.includes('geçersiz') ||
        normalized.includes('gecersiz') ||
        normalized.includes('bulunamamıştır') ||
        normalized.includes('bulunamamistir')))
  const preRegistrationOnly =
    serviceType === 'GonderiyiKargoyaGonderRestJson'
  const noTrackingReason = officialTrackingNumber
    ? ''
    : preRegistrationOnly
      ? 'Bu servis sadece ön kayıt oluşturur, takip no hemen dönmeyebilir. GonderiyiKargoyaGonder response takip veya barkod numarası içermiyor.'
      : 'Create response KargoTakipNo/BarkodNo içermiyor. Ortak barkod yetkisi, servis tipi ve payload parametreleri kontrol edilmeli.'
  const commonBarcodeIncompleteReason =
    serviceType === 'OrtakBarkodOlusturSoap' &&
    !officialBarcode
      ? officialTrackingNumber
        ? 'OrtakBarkodOlustur response KargoTakipNo döndü ancak Barcode alanı boş. Canlı ZPL engellendi.'
        : officialBarcode
          ? 'OrtakBarkodOlustur response Barcode döndü ancak KargoTakipNo alanı boş. Canlı ZPL engellendi.'
          : 'OrtakBarkodOlustur response KargoTakipNo + Barcode içermiyor. Canlı ZPL engellendi.'
      : ''

  return {
    code,
    envelopeCode,
    responseInfo,
    responseCategory: responseInfo.category,
    responseDescription: responseInfo.description,
    responseDocumented: responseInfo.documented,
    message,
    barcodeResponseCodeDetected,
    duplicateShipment,
    officialTrackingNumber,
    officialBarcode,
    officialBarcodeRaw,
    codeCandidates,
    codeMapping,
    zplAnalysis,
    technicalZplReceived,
    operationalBarcodeVerified,
    verificationStage,
    errorCategory,
    hasTrackingNumber: Boolean(officialTrackingNumber),
    hasBarcode: Boolean(officialBarcode),
    verifiedShipment: operationalBarcodeVerified,
    preRegistrationOnly,
    noTrackingReason: trendyolCargoNotEligibleStatus
      ? 'Trendyol/Sürat bu paketin mevcut statüsünde gönderi oluşturulmasına izin vermiyor. Mapping doğru, fakat kargo uygun statüde değil.'
      : zplAnalysis.rejectionReason ||
        commonBarcodeIncompleteReason ||
        noTrackingReason,
    hardError,
    retryable: responseInfo.retryable,
    retryPolicy: responseInfo.retryPolicy,
    trendyolCargoNotEligibleStatus,
  }
}

function isSuratDuplicateShipmentMessage(value = '') {
  const ascii = String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('ş', 's')
    .replaceAll('ı', 'i')
    .replaceAll('ö', 'o')
    .replaceAll('ç', 'c')
  return (
    ascii.includes('bu gonderi daha once olusturulmus') ||
    ascii.includes('bu siparise ait gonderi olusmustur')
  )
}

function buildSuratCreateSuccess({
  serviceType,
  endpoint,
  payloadFormat,
  statusCode,
  rawResponse,
  parsedResponse,
  createLog,
  outcome,
  reference,
  phoneWarning,
  marketplaceIntegrationCode = '',
}) {
  const serviceMode = resolveSuratServiceMode(serviceType)
  const operationName =
    serviceType === 'KargoBarkoduSiparisSoap'
      ? 'KargoBarkoduSiparis'
      : serviceType === 'OrtakBarkodOlusturSoap'
        ? 'OrtakBarkodOlustur'
        : serviceType ===
            'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap'
          ? 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur'
      : serviceType === 'GonderiyiKargoyaGonderRestJson'
        ? 'GonderiyiKargoyaGonder'
        : serviceType === 'GonderiyiKargoyaGonderYeniSoap'
          ? 'GonderiyiKargoyaGonderYeni'
        : 'GonderiOlusturV2'
  const trackingNumber = outcome.officialTrackingNumber
  const barcode = outcome.officialBarcode
  const tNo = outcome.codeMapping?.tNoValue || ''
  const sentReferansNo = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['ReferansNo']),
    reference,
  )
  const sentOzelKargoTakipNo = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['OzelKargoTakipNo']),
    marketplaceIntegrationCode,
  )
  const sentMarketplaceIntegrationCode = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['MarketplaceIntegrationCode']),
  )
  const barcodeRaw = normalizeSuratRawZpl(outcome.officialBarcodeRaw)
  const verifiedShipment = Boolean(outcome.operationalBarcodeVerified)
  const technicalZplReceived = Boolean(outcome.technicalZplReceived)
  const lifecycle = deriveSuratLifecycleState({
    createAccepted: outcome.createAccepted !== false,
    labelCreated: technicalZplReceived,
  })
  const barcodeValue = barcode
  const barcodeSource = barcode
    ? `surat.response.${outcome.codeMapping?.barcodeField || 'Barcode'}`
    : ''
  const lifecycleStatus = verifiedShipment
    ? 'LABEL_READY'
    : technicalZplReceived
      ? 'SURAT_TRACKING_MISSING'
    : trackingNumber
      ? 'SHIPMENT_CREATED'
      : 'SURAT_CREATED_NO_TRACKING'
  const message = verifiedShipment
    ? 'Sürat ZPL içindeki numeric ana barkod ve T.No operasyonel olarak doğrulandı.'
    : technicalZplReceived
      ? 'Sürat ZPL döndü ancak başarılı Serdendip etiketiyle eşleşen numeric ana barkod/T.No doğrulanamadı. Web ile başlayan değer final operasyonel barkod olarak kabul edilmedi.'
    : outcome.preRegistrationOnly
      ? 'Legacy ön kayıt yapıldı, ortak barkod alınamadı. KargoTakipNo + Barcode gelmeden canlı ZPL açılamaz.'
      : outcome.noTrackingReason ||
        'Sürat create yanıtı alındı ancak KargoTakipNo + Barcode birlikte dönmedi.'

  const visibleMessage = verifiedShipment
    ? trackingNumber
      ? 'Sürat resmi ZPL etiketi alındı; ana barkod ve T.No yazdırılabilir.'
      : 'Sürat resmi ZPL etiketi alındı; ana Code128 barkod yazdırılabilir. T.No alanı Sürat yanıtında boş.'
    : technicalZplReceived
      ? 'Sürat ZPL döndü ancak ana Code128 barkod çözümlenemedi; canlı yazdırma engellendi.'
      : message

  return {
    ok: true,
    source: 'real',
    message: phoneWarning ? `${visibleMessage} ${phoneWarning}` : visibleMessage,
    operationType: 'CREATE_SHIPMENT',
    buttonName: 'Sürat Gönderisi Oluştur',
    providerMethod: 'SuratKargoProvider.createShipment',
    endpoint,
    serviceType,
    serviceMode,
    operationName,
    payloadFormat,
    statusCode,
    responseStatus: statusCode,
    rawResponse,
    parsedResponse,
    suratCreateLog: createLog,
    createDiagnostics: outcome,
    requestFieldMapping: {
      shipmentReference: reference,
      SatisKodu: '',
      WebSiparisKodu: '',
      TrackingWebSiparisKodu: sentOzelKargoTakipNo,
      OzelKargoTakipNo: sentOzelKargoTakipNo,
      ReferansNo: sentReferansNo,
      MarketplaceIntegrationCode: sentMarketplaceIntegrationCode,
      marketplaceIntegrationCode: sentMarketplaceIntegrationCode,
      marketplaceIntegrationCodeSource: 'trendyol.cargoTrackingNumber',
      mappingDescription: {
        orderNumber:
          'Pazaryeri sipariş numarası; GonderiModel WSDL içine WebSiparisKodu/SatisKodu olarak eklenmez.',
        packageId: 'ReferansNo / shipmentCode',
        cargoTrackingNumber:
          'OzelKargoTakipNo; takipte KargoTakipHareketDetayi.WebSiparisKodu',
      },
      Pazaryerimi: 1,
      EntegrasyonFirmasi: 'Trendyol',
      Iademi: 0,
      TelefonCepWarning: phoneWarning,
    },
    shipment: {
      provider: 'surat-kargo',
      serviceMode,
      operationName,
      trackingNumber,
      kargoTakipNo: trackingNumber,
      tNo,
      trackingSource: trackingNumber
        ? `surat.response.${outcome.codeMapping?.trackingField || 'KargoTakipNo'}`
        : '',
      barcode,
      barkodNo: outcome.codeCandidates?.barkodNo || barcode || '',
      gonderiNo: outcome.codeCandidates?.gonderiNo || '',
      waybillNo: outcome.codeCandidates?.waybillNo || '',
      irsaliyeNo: outcome.codeCandidates?.irsaliyeNo || '',
      cargoKey: outcome.codeCandidates?.cargoKey || '',
      codeCandidates: outcome.codeCandidates,
      codeMapping: outcome.codeMapping,
      responseCategory: outcome.responseCategory,
      responseDescription: outcome.responseDescription,
      responseDocumented: outcome.responseDocumented,
      verificationStage: outcome.verificationStage,
      lifecycleStage: lifecycle.state,
      lifecycleMilestones: lifecycle.milestones,
      lifecycleEvidence: lifecycle,
      errorCategory: outcome.errorCategory,
      dispatchRegistrationConfirmed: verifiedShipment,
      technicalZplReceived,
      operationalBarcodeVerified: verifiedShipment,
      finalSuratBarcode: verifiedShipment
        ? outcome.zplAnalysis?.acceptedFinalBarcode || barcode
        : '',
      internalWebBarcode:
        outcome.zplAnalysis?.internalWebBarcode || '',
      zplAnalysis: outcome.zplAnalysis,
      requestValidation: createLog?.requestValidation,
      trendyolPreflight: createLog?.trendyolPreflight,
      addressNormalization: createLog?.addressNormalization,
      barcodeRaw,
      trackingUrl: trackingNumber
        ? `https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=${encodeURIComponent(
            trackingNumber,
          )}`
        : '',
      shipmentCode: reference,
      shipmentReference: reference,
      satisKodu: '',
      webSiparisKodu: sentOzelKargoTakipNo,
      ozelKargoTakipNo: marketplaceIntegrationCode,
      barcodeValue,
      desi: toPositiveNumber(
        readSuratField(createLog?.rawRequest, ['BirimDesi', 'Desi']),
      ),
      desiSource: 'api',
      weightKg: toPositiveNumber(
        readSuratField(createLog?.rawRequest, ['BirimKg', 'Kg']),
      ),
      apiRequestDesi: toPositiveNumber(
        readSuratField(createLog?.rawRequest, ['BirimDesi', 'Desi']),
      ),
      apiResponseDesi: toPositiveNumber(
        readSuratField(parsedResponse, ['BirimDesi', 'Desi']),
      ),
      barcodeSource,
      zplSource: barcodeRaw
        ? 'surat.ortakBarkod.BarcodeRaw'
        : 'generated',
      status: 'created',
      lifecycleStatus,
      labelStatus: verifiedShipment
        ? 'READY'
        : technicalZplReceived
          ? 'BLOCKED'
          : undefined,
      zplReady: technicalZplReceived,
      printEnabled: verifiedShipment,
      verifiedShipment,
      diagnosticMessage: verifiedShipment ? phoneWarning : outcome.noTrackingReason || phoneWarning,
      rawResponse: {
        operation: operationName,
        serviceMode,
        result: rawResponse,
        parsedResponse,
        createDiagnostics: outcome,
        suratCreateLog: createLog,
      },
      suratCreateLog: createLog,
      rawSuratCreateResponse: rawResponse,
    },
  }
}

function buildSuratDispatchRejectedFailure({
  message,
  errorCode = 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  errorCategory = 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  errorSource = 'Trendyol',
  endpoint,
  statusCode,
  contentType = '',
  rawRequest,
  rawResponse,
  parsedResponse,
  createLog,
  serviceType,
  payloadFormat,
  reference,
  marketplaceIntegrationCode = '',
  requestValidation,
  addressNormalization,
  trendyolPreflight,
  requestSent = true,
}) {
  const serviceMode = resolveSuratServiceMode(serviceType)
  const operationName =
    serviceType === 'GonderiyiKargoyaGonderRestJson'
      ? 'GonderiyiKargoyaGonder'
      : serviceType === 'OrtakBarkodOlusturSoap'
        ? 'OrtakBarkodOlustur'
        : serviceType
  const marketplaceOrderNumber = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['WebSiparisKodu']),
    readSuratField(rawRequest, ['WebSiparisKodu']),
    readSuratField(createLog?.rawRequest, ['SatisKodu']),
  )
  const sentReferansNo = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['ReferansNo']),
    readSuratField(rawRequest, ['ReferansNo']),
    reference,
  )
  const sentOzelKargoTakipNo = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['OzelKargoTakipNo']),
    readSuratField(rawRequest, ['OzelKargoTakipNo']),
    marketplaceIntegrationCode,
  )
  const sentMarketplaceIntegrationCode = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['MarketplaceIntegrationCode']),
    readSuratField(rawRequest, ['MarketplaceIntegrationCode']),
    marketplaceIntegrationCode,
  )
  const userMessage =
    errorCode === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
      ? 'Trendyol/Sürat bu paketin mevcut statüsünde gönderi oluşturulmasına izin vermiyor. Mapping doğru, fakat kargo uygun statüde değil.'
      : message

  return {
    ok: false,
    source: 'real',
    message: userMessage,
    errorCode,
    errorCategory,
    errorSource,
    operationType: 'CREATE_SHIPMENT',
    buttonName: 'Sürat Gönderisi Oluştur',
    providerMethod: 'SuratKargoProvider.createShipment',
    endpoint,
    serviceType,
    serviceMode,
    operationName,
    payloadFormat,
    statusCode,
    responseStatus: statusCode,
    contentType,
    rawRequest: redactSuratRawRequest(rawRequest),
    rawResponse,
    parsedResponse,
    suratCreateLog: createLog,
    requestSent,
    requestFieldMapping: {
      shipmentReference: reference,
      SatisKodu: marketplaceOrderNumber,
      WebSiparisKodu: marketplaceOrderNumber,
      OzelKargoTakipNo: sentOzelKargoTakipNo,
      ReferansNo: sentReferansNo,
      MarketplaceIntegrationCode: sentMarketplaceIntegrationCode,
      marketplaceIntegrationCode: sentMarketplaceIntegrationCode,
      marketplaceIntegrationCodeSource: 'trendyol.cargoTrackingNumber',
      mappingDescription: {
        orderNumber: 'WebSiparisKodu / SatisKodu',
        packageId: 'shipmentCode / debug reference',
        cargoTrackingNumber:
          'ReferansNo / MarketplaceIntegrationCode / OzelKargoTakipNo',
      },
      Pazaryerimi: 1,
      EntegrasyonFirmasi: 'Trendyol',
    },
    shipment: {
      provider: 'surat-kargo',
      serviceMode,
      operationName,
      trackingNumber: '',
      kargoTakipNo: '',
      tNo: '',
      trackingSource: '',
      barcode: '',
      barcodeValue: '',
      barcodeSource: '',
      trackingUrl: '',
      shipmentCode: reference,
      shipmentReference: reference,
      satisKodu: marketplaceOrderNumber,
      webSiparisKodu: marketplaceOrderNumber,
      ozelKargoTakipNo: marketplaceIntegrationCode,
      codeCandidates: createLog?.codeCandidates,
      codeMapping: createLog?.codeMapping,
      verificationStage: 'dispatch_rejected',
      errorCategory,
      technicalZplReceived: false,
      operationalBarcodeVerified: false,
      finalSuratBarcode: '',
      internalWebBarcode: '',
      zplAnalysis: undefined,
      requestValidation,
      trendyolPreflight,
      addressNormalization,
      barcodeRaw: '',
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      dispatchRegistrationConfirmed: false,
      dispatchRegistration: {
        ok: false,
        endpoint,
        serviceType,
        responseStatus: statusCode,
        responseCode: errorCode,
        responseMessage: message,
        rawRequest,
        rawResponse,
      },
      status: 'failed',
      lifecycleStatus: 'SURAT_DISPATCH_REJECTED',
      labelStatus: 'BLOCKED',
      shipmentStatus: 'FAILED',
      suratVerificationStatus: 'FAILED',
      zplReady: false,
      printEnabled: false,
      verifiedShipment: false,
      matchStatus: false,
      statusComputedFrom: 'SURAT_REJECTED',
      previousStatus: undefined,
      newStatus: 'SURAT_DISPATCH_REJECTED',
      previousErrorCleared: false,
      tabBucket: 'DURUM_UYGUN_DEGIL',
      noTrackingReason: userMessage,
      labelBlockedReason: userMessage,
      zplDisabledReason: 'Sürat dispatch reddedildiği için ZPL üretilmedi.',
      diagnosticMessage: userMessage,
      source: 'real',
      rawResponse: {
        operation: operationName,
        serviceMode,
        result: rawResponse,
        parsedResponse,
        suratCreateLog: createLog,
        trendyolPreflight,
      },
      suratCreateLog: createLog,
      rawSuratCreateResponse: rawResponse,
      createdAt: new Date().toISOString(),
    },
    rejectionDiagnosis: {
      mapping: requestValidation?.ok === false ? 'CHECK' : 'OK',
      trendyolCargoTrackingNumber: marketplaceIntegrationCode ? 'OK' : 'MISSING',
      suratRequestSent: requestSent ? 'YES' : 'NO',
      suratResponse: 'REJECTED',
      errorCode,
      reason: 'Kargo uygun statüde değil',
      operationalBarcode: 'YOK',
      zpl: 'YOK',
      printable: 'HAYIR',
      possibleReasons: TRENDYOL_1002_POSSIBLE_REASONS,
      recommendedActions: TRENDYOL_1002_RECOMMENDED_ACTIONS,
    },
  }
}

function buildSuratCreateFailure({
  message,
  errorCode = '',
  errorSource = 'Sürat',
  endpoint,
  statusCode,
  contentType = '',
  rawRequest,
  rawResponse,
  parsedResponse,
  createLog,
  serviceType,
  payloadFormat,
  reference,
  operationName,
  failedBarcodeValidation = false,
  marketplaceIntegrationCode = '',
  retryPolicy,
}) {
  const serviceMode = resolveSuratServiceMode(serviceType)
  const KargoTakipNo = String(
    readSuratField(parsedResponse, ['KargoTakipNo']) ?? '',
  )
  const Barcode = firstNonEmpty(
    readSuratField(parsedResponse, ['Barcode']),
    readSuratField(parsedResponse, ['Barkod']),
    readSuratField(parsedResponse, ['BarkodNo']),
  )
  const marketplaceOrderNumber = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['WebSiparisKodu']),
    readSuratField(rawRequest, ['WebSiparisKodu']),
    readSuratField(createLog?.rawRequest, ['SatisKodu']),
  )
  const sentReferansNo = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['ReferansNo']),
    readSuratField(rawRequest, ['ReferansNo']),
    reference,
  )
  const sentOzelKargoTakipNo = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['OzelKargoTakipNo']),
    readSuratField(rawRequest, ['OzelKargoTakipNo']),
    marketplaceIntegrationCode,
  )
  const sentMarketplaceIntegrationCode = firstNonEmpty(
    readSuratField(createLog?.rawRequest, ['MarketplaceIntegrationCode']),
    readSuratField(rawRequest, ['MarketplaceIntegrationCode']),
    marketplaceIntegrationCode,
  )
  return {
    ok: false,
    source: 'real',
    message,
    errorCode,
    errorSource,
    operationType: 'CREATE_SHIPMENT',
    buttonName: 'Sürat Gönderisi Oluştur',
    providerMethod: 'SuratKargoProvider.createShipment',
    endpoint,
    serviceType,
    serviceMode,
    operationName: operationName || endpoint,
    payloadFormat,
    statusCode,
    responseStatus: statusCode,
    contentType,
    rawRequest: redactSuratRawRequest(rawRequest),
    rawResponse,
    parsedResponse,
    suratCreateLog: createLog,
    retryPolicy,
    requestFieldMapping: {
      shipmentReference: reference,
      SatisKodu: marketplaceOrderNumber,
      WebSiparisKodu: marketplaceOrderNumber,
      OzelKargoTakipNo: sentOzelKargoTakipNo,
      ReferansNo: sentReferansNo,
      MarketplaceIntegrationCode: sentMarketplaceIntegrationCode,
      marketplaceIntegrationCode: sentMarketplaceIntegrationCode,
      marketplaceIntegrationCodeSource: 'trendyol.cargoTrackingNumber',
      mappingDescription: {
        orderNumber: 'WebSiparisKodu / SatisKodu',
        packageId: 'shipmentCode / debug reference',
        cargoTrackingNumber:
          'ReferansNo / MarketplaceIntegrationCode / OzelKargoTakipNo',
      },
    },
    shipment: failedBarcodeValidation
      ? {
          provider: 'surat-kargo',
          serviceMode,
          operationName: operationName || endpoint,
          trackingNumber: KargoTakipNo,
          kargoTakipNo: KargoTakipNo,
          tNo: createLog?.codeMapping?.tNoValue || '',
          trackingSource: KargoTakipNo
            ? `surat.response.${createLog?.codeMapping?.trackingField || 'KargoTakipNo'}`
            : '',
          barcode: Barcode,
          barkodNo: createLog?.codeCandidates?.barkodNo || '',
          gonderiNo: createLog?.codeCandidates?.gonderiNo || '',
          waybillNo: createLog?.codeCandidates?.waybillNo || '',
          irsaliyeNo: createLog?.codeCandidates?.irsaliyeNo || '',
          cargoKey: createLog?.codeCandidates?.cargoKey || '',
          codeCandidates: createLog?.codeCandidates,
          codeMapping: createLog?.codeMapping,
          trackingUrl: '',
          shipmentCode: reference,
          shipmentReference: reference,
          satisKodu: marketplaceOrderNumber,
          webSiparisKodu: marketplaceOrderNumber,
          ozelKargoTakipNo: marketplaceIntegrationCode,
          barcodeValue: Barcode,
          barcodeSource: Barcode
            ? 'surat.ortakBarkod.Barcode'
            : '',
          status: 'failed',
          lifecycleStatus: 'SURAT_BARCODE_FAILED',
          labelStatus: 'BLOCKED',
          verifiedShipment: false,
          dispatchRegistrationConfirmed: false,
          operationalBarcodeVerified: false,
          printEnabled: false,
          zplReady: false,
          diagnosticMessage: SURAT_INVALID_CODES_MESSAGE,
          rawResponse: {
            operation: operationName || endpoint,
            serviceMode,
            result: rawResponse,
            parsedResponse,
            suratCreateLog: createLog,
          },
          suratCreateLog: createLog,
          rawSuratCreateResponse: rawResponse,
        }
      : undefined,
  }
}

function resolveSuratRestBaseUrl(config) {
  return config.ortam === 'live'
    ? SURAT_REST_LIVE_BASE_URL
    : SURAT_REST_TEST_BASE_URL
}

function resolveGonderilerLength(value, tracking) {
  const gonderiler = findSuratArray(value, ['Gonderiler', 'Gönderiler'])
  if (gonderiler) return gonderiler.length
  return firstNonEmpty(
    tracking.KargoTakipNo,
    tracking.BarkodNo,
    tracking.Barkod,
    tracking.TakipUrlTrackingNo,
  )
    ? 1
    : 0
}

function normalizeSuratCodeForComparison(value) {
  return String(value ?? '')
    .trim()
    .replace(/^TNO[-\s]?/i, '')
    .replace(/\s+/g, '')
}

function findSuratArray(value, keys) {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSuratArray(item, keys)
      if (found) return found
    }
    return undefined
  }
  const normalizedKeys = keys.map((key) =>
    String(key).toLocaleLowerCase('tr-TR'),
  )
  for (const [key, item] of Object.entries(value)) {
    if (
      normalizedKeys.includes(String(key).toLocaleLowerCase('tr-TR')) &&
      Array.isArray(item)
    ) {
      return item
    }
    const nested = findSuratArray(item, keys)
    if (nested) return nested
  }
  return undefined
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return undefined
}

async function callSuratSoap(operation, innerXml) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation} xmlns="http://tempuri.org/">
      ${innerXml}
    </${operation}>
  </soap:Body>
</soap:Envelope>`

  try {
    const apiResponse = await fetch(SURAT_SOAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"http://tempuri.org/${operation}"`,
      },
      body,
    })
    const text = await apiResponse.text()
    return {
      ok: apiResponse.ok,
      statusCode: apiResponse.status,
      contentType: apiResponse.headers.get('content-type') || '',
      body,
      text,
    }
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      contentType: '',
      body,
      text:
        error instanceof Error
          ? `Sürat SOAP bağlantı hatası: ${error.message}`
          : 'Sürat SOAP bağlantı hatası.',
    }
  }
}

async function callTrendyolOrdersByStatuses(credentials, query = {}) {
  const statuses = normalizeTrendyolStatusQuery(query)
  const filteredResult = await callTrendyolOrdersByStatusesFiltered(
    credentials,
    query,
  )
  if (!filteredResult.ok) return filteredResult
  const discoveryStatuses = statuses.filter((status) =>
    ACTIVE_TRENDYOL_ORDER_STATUSES.includes(status),
  )
  const unfilteredQuery = clampTrendyolRecentDiscoveryWindow(
    query,
    discoveryStatuses,
  )
  const unfilteredResult =
    discoveryStatuses.length > 0
      ? await callTrendyolOrdersAllPages(credentials, {
          ...unfilteredQuery,
          status: undefined,
          statuses: undefined,
          page: undefined,
        })
      : {
          ok: true,
          source: 'real',
          statusCode: 200,
          message: 'Unfiltered active-order discovery was not required.',
          data: { content: [] },
          debug: {},
        }
  const filteredContent = filteredResult.ok
    ? getTrendyolOrderPackagesArray(filteredResult.data)
    : []
  const unfilteredContent = unfilteredResult.ok
    ? getTrendyolOrderPackagesArray(unfilteredResult.data)
    : []
  const matchingUnfilteredContent = unfilteredContent.filter(
    (item) =>
      isTrendyolPackageInStatuses(item, discoveryStatuses) ||
      isUnknownTrendyolPackageStatus(item),
  )

  if (!filteredResult.ok && !unfilteredResult.ok) return filteredResult
  if (filteredContent.length === 0 && !unfilteredResult.ok) {
    return {
      ...unfilteredResult,
      ok: false,
      source: 'real',
      message:
        'Trendyol status requests were empty and the unfiltered recent-order verification failed.',
      debug: {
        ...(filteredResult.debug ?? {}),
        unfilteredFallback: summarizeTrendyolUnfilteredFallback(
          unfilteredResult,
          0,
          0,
        ),
      },
    }
  }

  const combinedContent = mergeTrendyolPackageCollections(
    filteredContent,
    matchingUnfilteredContent,
  )
  const addedCount = Math.max(0, combinedContent.length - filteredContent.length)
  const baseResult = filteredResult.ok ? filteredResult : unfilteredResult
  return {
    ...baseResult,
    ok: true,
    source: 'real',
    message: `${baseResult.message} Unfiltered discovery added ${addedCount} package(s).`,
    data: {
      ...(baseResult.data ?? {}),
      content: combinedContent,
      totalElements: combinedContent.length,
      totalPages: 1,
    },
    debug: {
      ...(filteredResult.debug ?? {}),
      syncStatus: 'COMPLETE',
      unfilteredFallback: summarizeTrendyolUnfilteredFallback(
        unfilteredResult,
        unfilteredContent.length,
        matchingUnfilteredContent.length,
        addedCount,
      ),
    },
  }
}

async function callTrendyolOrdersByStatusesFiltered(credentials, query = {}) {
  const statuses = normalizeTrendyolStatusQuery(query)

  if (statuses.length <= 1) {
    return callTrendyolOrdersForStatus(credentials, query, statuses[0])
  }

  const results = []
  for (const status of statuses) {
    const result = await callTrendyolOrdersForStatus(credentials, query, status)
    results.push({ status, result })
  }

  const successes = results.filter((entry) => entry.result.ok)
  const failures = results.filter((entry) => !entry.result.ok)

  if (successes.length === 0) {
    const firstFailure = failures[0]?.result ?? {
      ok: false,
      source: 'real',
      message: 'Trendyol siparişleri çekilemedi.',
    }

    return {
      ...firstFailure,
      message: `Trendyol aktif statü istekleri başarısız: ${firstFailure.message}`,
      debug: {
        statusRequests: results.map((entry) => ({
          status: entry.status,
          ok: entry.result.ok,
          statusCode: entry.result.statusCode,
          message: entry.result.message,
          requestUrl: entry.result.debug?.requestUrl,
          pageRequests: entry.result.debug?.pageRequests,
          rawResponsePreview: entry.result.debug?.rawResponsePreview,
          parsedError: entry.result.debug?.parsedError,
        })),
      },
    }
  }

  const combinedContent = mergeTrendyolPackageCollections(
    ...successes.map((entry) =>
      getTrendyolOrderPackagesArray(entry.result.data),
    ),
  )
  const firstData = successes[0]?.result.data ?? {}

  if (failures.length > 0) {
    return {
      ok: false,
      source: 'real',
      statusCode: failures[0]?.result.statusCode ?? 502,
      message: `Trendyol sipariş senkronu kısmi kaldı. Başarılı statüler: ${successes
        .map((entry) => entry.status)
        .join(', ')}. Hatalı statüler: ${failures
        .map((entry) => entry.status)
        .join(', ')}. Mevcut tam liste korunmalıdır.`,
      data: {
        content: [],
        totalElements: 0,
        totalPages: 0,
      },
      debug: {
        syncStatus: 'PARTIAL',
        partialRecordCount: combinedContent.length,
        statusRequests: results.map((entry) => ({
          status: entry.status,
          ok: entry.result.ok,
          statusCode: entry.result.statusCode,
          message: entry.result.message,
          requestUrl: entry.result.debug?.requestUrl,
          pageRequests: entry.result.debug?.pageRequests,
          rawResponsePreview: entry.result.debug?.rawResponsePreview,
          parsedError: entry.result.debug?.parsedError,
        })),
      },
    }
  }

  return {
    ok: true,
    source: 'real',
    statusCode: successes[0]?.result.statusCode ?? 200,
    message: `Trendyol siparişleri statü bazlı alındı: ${statuses.join(', ')}.`,
    data: {
      ...firstData,
      content: combinedContent,
      totalElements: combinedContent.length,
      totalPages: 1,
    },
    debug: {
      syncStatus: 'COMPLETE',
      statusRequests: results.map((entry) => ({
        status: entry.status,
        ok: entry.result.ok,
        statusCode: entry.result.statusCode,
        message: entry.result.message,
        requestUrl: entry.result.debug?.requestUrl,
        pageRequests: entry.result.debug?.pageRequests,
        rawResponsePreview: entry.result.debug?.rawResponsePreview,
        parsedError: entry.result.debug?.parsedError,
      })),
    },
  }
}

function clampTrendyolRecentDiscoveryWindow(query, statuses) {
  if (!statuses.some((status) => ACTIVE_TRENDYOL_ORDER_STATUSES.includes(status))) {
    return query
  }
  const endDate = Number(query.endDate ?? Date.now())
  const requestedStartDate = Number(
    query.startDate ?? endDate - TRENDYOL_ACTIVE_STATUS_WINDOW_MS,
  )
  return {
    ...query,
    startDate: Math.max(
      requestedStartDate,
      endDate - TRENDYOL_ACTIVE_STATUS_WINDOW_MS,
    ),
    endDate,
  }
}

async function callTrendyolOrdersForStatus(credentials, query, status) {
  if (
    !ACTIVE_TRENDYOL_ORDER_STATUSES.includes(status) ||
    query.orderNumber
  ) {
    return callTrendyolOrdersAllPages(credentials, {
      ...query,
      status,
      statuses: undefined,
      page: undefined,
    })
  }

  const endDate = Number(query.endDate ?? Date.now())
  const startDate = Number(
    query.startDate ?? endDate - TRENDYOL_ACTIVE_STATUS_WINDOW_MS,
  )
  if (
    !Number.isFinite(startDate) ||
    !Number.isFinite(endDate) ||
    endDate - startDate <= TRENDYOL_ACTIVE_STATUS_WINDOW_MS
  ) {
    return callTrendyolOrdersAllPages(credentials, {
      ...query,
      status,
      statuses: undefined,
      page: undefined,
    })
  }

  const windowResults = []
  let cursor = startDate
  while (cursor <= endDate) {
    const windowEnd = Math.min(endDate, cursor + TRENDYOL_ACTIVE_STATUS_WINDOW_MS)
    const result = await callTrendyolOrdersAllPages(credentials, {
      ...query,
      startDate: cursor,
      endDate: windowEnd,
      status,
      statuses: undefined,
      page: undefined,
    })
    windowResults.push({ startDate: cursor, endDate: windowEnd, result })
    if (!result.ok) {
      return {
        ...result,
        debug: {
          ...(result.debug ?? {}),
          statusWindows: windowResults.map(summarizeTrendyolStatusWindow),
        },
      }
    }
    if (windowEnd === endDate) break
    cursor = windowEnd + 1
  }

  const content = mergeTrendyolPackageCollections(
    ...windowResults.map((entry) =>
      getTrendyolOrderPackagesArray(entry.result.data),
    ),
  )
  const firstResult = windowResults[0]?.result ?? {
    ok: true,
    source: 'real',
    statusCode: 200,
    message: 'Trendyol status window returned no data.',
    data: {},
  }
  return {
    ...firstResult,
    data: {
      ...(firstResult.data ?? {}),
      content,
      totalElements: content.length,
      totalPages: 1,
    },
    debug: {
      ...(firstResult.debug ?? {}),
      pageRequests: windowResults.flatMap(
        (entry) => entry.result.debug?.pageRequests ?? [],
      ),
      statusWindows: windowResults.map(summarizeTrendyolStatusWindow),
    },
  }
}

function summarizeTrendyolStatusWindow(entry) {
  return {
    startDate: entry.startDate,
    endDate: entry.endDate,
    ok: entry.result.ok,
    statusCode: entry.result.statusCode,
    contentCount: getTrendyolOrderPackagesArray(entry.result.data).length,
  }
}

async function callTrendyolOrdersAllPages(credentials, query = {}) {
  const firstPage = Number.isFinite(Number(query.page)) ? Number(query.page) : 0
  const firstResult = await callTrendyolOrders(credentials, {
    ...query,
    page: firstPage,
    statuses: undefined,
  })

  if (!firstResult.ok) return firstResult

  const firstContent = getTrendyolOrderPackagesArray(firstResult.data)
  const rawTotalPages = Number(firstResult.data?.totalPages ?? 1)
  const totalPages =
    Number.isFinite(rawTotalPages) && rawTotalPages > 0
      ? Math.ceil(rawTotalPages)
      : 1
  const maxPages = Math.min(totalPages, Number(query.maxPages ?? 100))
  const pageRequests = [
    {
      page: firstPage,
      ok: firstResult.ok,
      statusCode: firstResult.statusCode,
      contentCount: firstContent.length,
      requestUrl: firstResult.debug?.requestUrl,
    },
  ]
  const combinedContent = [...firstContent]

  for (let page = firstPage + 1; page < maxPages; page += 1) {
    const pageResult = await callTrendyolOrders(credentials, {
      ...query,
      page,
      statuses: undefined,
    })
    const pageContent = getTrendyolOrderPackagesArray(pageResult.data)
    pageRequests.push({
      page,
      ok: pageResult.ok,
      statusCode: pageResult.statusCode,
      contentCount: pageContent.length,
      requestUrl: pageResult.debug?.requestUrl,
      message: pageResult.message,
    })

    if (!pageResult.ok) {
      return {
        ...pageResult,
        ok: false,
        message: `Trendyol sayfalı sipariş çekimi eksik kaldı. ${page}. sayfa alınamadı: ${pageResult.message}`,
        debug: {
          ...pageResult.debug,
          pageRequests,
        },
      }
    }

    combinedContent.push(...pageContent)
  }

  return {
    ...firstResult,
    message:
      totalPages > 1
        ? `Trendyol siparişleri ${maxPages} sayfadan alındı.`
        : firstResult.message,
    data: {
      ...firstResult.data,
      content: combinedContent,
      totalElements: combinedContent.length,
      totalPages: 1,
      fetchedPages: maxPages,
      originalTotalPages: totalPages,
    },
    debug: {
      ...firstResult.debug,
      pageRequests,
      fetchedPages: maxPages,
      originalTotalPages: totalPages,
      combinedContentCount: combinedContent.length,
    },
  }
}

function normalizeTrendyolStatusQuery(query = {}) {
  const requestedStatuses = []
  if (Array.isArray(query.statuses)) requestedStatuses.push(...query.statuses)
  if (typeof query.status === 'string' && query.status.trim()) {
    requestedStatuses.push(query.status.trim())
  }

  const statuses =
    requestedStatuses.length > 0
      ? requestedStatuses
      : ALL_TRENDYOL_ORDER_STATUSES

  const normalized = Array.from(
    new Set(
      statuses
        .map((status) => String(status ?? '').trim())
        .filter((status) => ALL_TRENDYOL_ORDER_STATUSES.includes(status)),
    ),
  )

  return normalized.length > 0 ? normalized : ALL_TRENDYOL_ORDER_STATUSES
}

async function callTrendyolOrders(credentials, query) {
  const validation = validateTrendyol(credentials)
  if (validation) return validation

  const now = Date.now()
  const startDate = Number(query.startDate ?? now - 1000 * 60 * 60 * 24 * 7)
  const endDate = Number(query.endDate ?? now)
  const maxRangeMs = 1000 * 60 * 60 * 24 * 30

  if (endDate < startDate) {
    return {
      ok: false,
      source: 'real',
      message:
        'Trendyol tarih aralığı hatalı: endDate startDate değerinden küçük olamaz.',
    }
  }

  if (endDate - startDate > maxRangeMs) {
    return {
      ok: false,
      source: 'real',
    message: 'Trendyol tarih aralığı maksimum 30 gün olmalıdır.',
    }
  }

  const params = new URLSearchParams({
    startDate: String(startDate),
    endDate: String(endDate),
    page: String(query.page ?? 0),
    size: String(Math.min(Number(query.size ?? 20), 200)),
  })

  if (query.includeSortParams !== false) {
    params.set('orderByField', 'PackageLastModifiedDate')
    params.set('orderByDirection', 'DESC')
  }

  if (query.status) params.set('status', query.status)
  if (query.orderNumber) params.set('orderNumber', query.orderNumber)

  return fetchTrendyolJson(
    `${getTrendyolBaseUrl(credentials)}/integration/order/sellers/${credentials.sellerId}/orders?${params}`,
    credentials,
  )
}

// Trendyol getClaims: GET /integration/order/sellers/{sellerId}/claims
// (doğrulanan sözleşme; startDate/endDate epoch ms, page, size<=200,
// claimItemStatus enum). Tek pencere için tüm sayfaları çeker; 429/rate
// limitte artan beklemeyle tekrar dener.
async function fetchTrendyolClaimsWindow(credentials, startDate, endDate, wait) {
  const size = 200
  const maxPages = 500
  const claims = []
  let expectedPages = 1
  for (let page = 0; page < expectedPages && page < maxPages; page += 1) {
    const params = new URLSearchParams({
      startDate: String(startDate),
      endDate: String(endDate),
      page: String(page),
      size: String(size),
    })
    const url = `${getTrendyolBaseUrl(credentials)}/integration/order/sellers/${credentials.sellerId}/claims?${params}`
    let result
    for (let attempt = 0; attempt <= 6; attempt += 1) {
      if (attempt > 0) {
        const rateLimited =
          Number(result?.statusCode) === 429 ||
          /rate limit/i.test(String(result?.message ?? ''))
        await wait(rateLimited ? 15000 : 1500 * attempt)
      }
      result = await fetchTrendyolJson(url, credentials)
      if (result.ok) break
    }
    if (!result.ok) {
      return {
        ok: false,
        statusCode: result.statusCode,
        message: result.message,
      }
    }
    const content = getTrendyolOrderPackagesArray(result.data)
    claims.push(...content)
    if (page === 0) {
      const totalPages = Number(result.data?.totalPages ?? 0)
      expectedPages =
        totalPages > 0
          ? Math.min(totalPages, maxPages)
          : content.length >= size
            ? maxPages
            : 1
      if (content[0]) logTrendyolClaimShape(content[0])
    }
    // totalPages bilgisi yoksa boş sayfada dur; aksi halde for koşulu
    // (page < expectedPages) sayfa sayısını yönetir.
    if (content.length === 0) break
    await wait(300)
  }
  return { ok: true, claims }
}

// PII'siz canlı sözleşme doğrulaması: yalnız alan adlarını ve JS tiplerini
// (değer YOK) loglar. CARGOFLOW_CLAIMS_DEBUG set edilmeden çalışmaz.
function logTrendyolClaimShape(sample) {
  if (!process.env.CARGOFLOW_CLAIMS_DEBUG) return
  console.info(
    '[claims] CLAIM_SHAPE_SAMPLE',
    JSON.stringify(describeShapePiiFree(sample, 0)),
  )
}

function describeShapePiiFree(value, depth) {
  if (depth > 5) return typeof value
  if (Array.isArray(value)) {
    return value.length ? [describeShapePiiFree(value[0], depth + 1)] : []
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      out[key] = describeShapePiiFree(value[key], depth + 1)
    }
    return out
  }
  return typeof value
}

async function callTrendyolProducts(credentials) {
  const validation = validateTrendyol(credentials)
  if (validation) return validation

  const allProducts = []
  const pageDebug = []
  const pageMetrics = []
  const failedPages = []
  const size = 200
  const maxPages = 500
  const maxRetries = 2
  let expectedPages = 1
  let expectedTotal = 0
  let responsePageSize = size

  for (let page = 0; page < expectedPages && page < maxPages; page += 1) {
    const params = new URLSearchParams({
      page: String(page),
      size: String(size),
    })
    const pageUrl = `${getTrendyolBaseUrl(credentials)}/integration/product/sellers/${credentials.sellerId}/products?${params}`
    let result = await fetchTrendyolJson(pageUrl, credentials)
    let retryCount = 0
    while (!result.ok && retryCount < maxRetries) {
      retryCount += 1
      await new Promise((resolve) => setTimeout(resolve, 600 * retryCount))
      result = await fetchTrendyolJson(pageUrl, credentials)
    }
    pageDebug.push(result.debug)
    if (!result.ok) {
      failedPages.push(page)
      const metric = {
        page,
        requestedPageSize: size,
        responseItemCount: 0,
        totalPages: expectedPages,
        totalElements: expectedTotal,
        retryCount,
        httpStatus: Number(result.statusCode ?? result.debug?.status ?? 0),
        rateLimitRemaining: result.debug?.rateLimitRemaining,
      }
      pageMetrics.push(metric)
      console.info('[products] PRODUCT_SYNC_PAGE', metric)
      if (page === 0) {
        return {
          ...result,
          debug: {
            ...result.debug,
            status: 'FAILED',
            expectedTotal: 0,
            fetchedCount: 0,
            rawApiRecordsCount: 0,
            fetchedPages: 0,
            expectedPages: 0,
            failedPages,
            requestedPageSize: size,
            responsePageSize: size,
            completenessRatio: 0,
            pages: pageMetrics,
            pageResponses: pageDebug,
          },
        }
      }
      continue
    }

    const products = getTrendyolProductsArray(result.data)
    allProducts.push(...products)
    const totalPages = Number(result.data?.totalPages ?? 0)
    const totalElements = Number(result.data?.totalElements ?? 0)
    if (page === 0) {
      expectedPages = totalPages > 0
        ? Math.min(totalPages, maxPages)
        : products.length === size
          ? maxPages
          : 1
      expectedTotal = totalElements > 0 ? totalElements : products.length
      responsePageSize = Number(result.data?.size ?? size)
    } else if (totalPages > expectedPages) {
      expectedPages = Math.min(totalPages, maxPages)
    }
    const metric = {
      page,
      requestedPageSize: size,
      responseItemCount: products.length,
      totalPages: totalPages || expectedPages,
      totalElements: totalElements || expectedTotal,
      retryCount,
      httpStatus: Number(result.statusCode ?? result.debug?.status ?? 200),
      rateLimitRemaining: result.debug?.rateLimitRemaining,
    }
    pageMetrics.push(metric)
    console.info('[products] PRODUCT_SYNC_PAGE', metric)
    if (totalPages <= 0 && products.length < size) {
      expectedPages = page + 1
      expectedTotal = allProducts.length
    }
  }

  const fetchedPages = pageMetrics.filter(
    (entry) => entry.responseItemCount > 0 || entry.httpStatus === 200,
  ).length
  const rawCompletenessRatio =
    expectedTotal > 0
      ? allProducts.length / expectedTotal
      : allProducts.length === 0
        ? 1
        : 0
  const status =
    failedPages.length === 0 &&
    fetchedPages === expectedPages &&
    rawCompletenessRatio >= 0.999
      ? 'COMPLETE'
      : 'PARTIAL'

  return {
    ok: true,
    source: 'real',
    statusCode: 200,
    message: status === 'PARTIAL'
      ? `${allProducts.length}/${expectedTotal} Trendyol ürün kaydı alındı. Kısmi katalog ana cache olarak kaydedilmedi.`
      : `${allProducts.length} Trendyol ürün/listing kaydı alındı.`,
    data: { content: allProducts },
    debug: {
      expectedTotal,
      fetchedCount: allProducts.length,
      rawApiRecordsCount: allProducts.length,
      fetchedPages,
      expectedPages,
      failedPages,
      requestedPageSize: size,
      responsePageSize,
      completenessRatio: Math.min(rawCompletenessRatio, 1),
      status,
      pages: pageMetrics,
      pageResponses: pageDebug,
      normalizedProductCandidates: allProducts.length,
      uniqueBarcodeCount: countUniqueRawProductField(allProducts, ['barcode']),
      uniqueProductContentIdCount: countUniqueRawProductField(allProducts, [
        'productContentId',
        'contentId',
        'productId',
      ]),
      uniqueProductMainIdCount: countUniqueRawProductField(allProducts, [
        'productMainId',
      ]),
      uniqueExternalVariantIdCount: countUniqueRawProductField(allProducts, [
        'platformListingId',
        'id',
      ]),
      uniqueVariantCount: countUniqueRawProductVariants(allProducts),
      targetTraces: traceProductCatalogTargets('raw-api', allProducts),
    },
  }
}

function validateTrendyol(credentials) {
  const missing = ['sellerId', 'apiKey', 'apiSecret'].filter(
    (key) => !credentials?.[key],
  )
  if (missing.length === 0) return null

  return {
    ok: false,
    source: 'real',
    message: `Eksik Trendyol alanları: ${missing.join(', ')}`,
  }
}

function getTrendyolBaseUrl(credentials) {
  return credentials.environment === 'stage'
    ? TRENDYOL_STAGE_BASE_URL
    : TRENDYOL_PROD_BASE_URL
}

async function fetchTrendyolJson(url, credentials, options = {}) {
  const userAgent = buildTrendyolUserAgent(credentials)
  const method = options.method ?? 'GET'
  const body = options.body == null ? undefined : JSON.stringify(options.body)
  const headers = {
    Authorization: `Basic ${Buffer.from(
      `${credentials.apiKey}:${credentials.apiSecret}`,
    ).toString('base64')}`,
    'User-Agent': userAgent,
    Accept: 'application/json',
  }
  if (body) headers['Content-Type'] = 'application/json'
  if (credentials.storeFrontCode) {
    headers.storeFrontCode = String(credentials.storeFrontCode)
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
    })
    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const rawResponsePreview = text.slice(0, 2000)
    const parsed = parseTrendyolResponse(text, contentType)
    const debug = {
      requestUrl: url,
      status: response.status,
      contentType,
      rawResponsePreview,
      parsedError: parsed.error,
      method,
      rateLimitRemaining:
        response.headers.get('x-ratelimit-remaining') ??
        response.headers.get('x-rate-limit-remaining') ??
        undefined,
    }

    if (response.ok && !text.trim()) {
      return {
        ok: true,
        source: 'real',
        statusCode: response.status,
        message: 'Gerçek API başarılı.',
        data: null,
        rawResponse: text,
        request: { url, userAgent, method, body: options.body },
        debug,
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        source: 'real',
        statusCode: response.status,
        message: mapTrendyolError(response.status, parsed.data, parsed.error, text),
        data: parsed.data,
        rawResponse: text,
        request: { url, userAgent, method, body: options.body },
        debug,
      }
    }

    if (parsed.error || !parsed.isJson) {
      return {
        ok: false,
        source: 'real',
        statusCode: response.status,
        message:
          parsed.error ||
          'Trendyol JSON olmayan bir yanıt döndürdü. Detaylarda ham yanıtı görebilirsin.',
        data: parsed.data,
        rawResponse: text,
        request: { url, userAgent, method, body: options.body },
        debug,
      }
    }

    return {
      ok: true,
      source: 'real',
      statusCode: response.status,
      message: 'Gerçek API başarılı.',
      data: parsed.data,
      rawResponse: text,
      request: { url, userAgent, method, body: options.body },
      debug,
    }
  } catch (error) {
    return {
      ok: false,
      source: 'real',
      message: error instanceof Error ? error.message : 'Ağ hatası',
      request: { url, userAgent, method, body: options.body },
      debug: {
        requestUrl: url,
        status: 0,
        contentType: '',
        rawResponsePreview: '',
        parsedError: error instanceof Error ? error.message : 'Ağ hatası',
      },
    }
  }
}

function buildTrendyolUserAgent(credentials) {
  const sellerId = String(credentials?.sellerId ?? '').trim()
  return `${sellerId || 'CargoFlow'} - CargoFlow`
}

function parseTrendyolResponse(text, contentType) {
  const lowerContentType = String(contentType ?? '').toLowerCase()
  const isJson = lowerContentType.includes('application/json')

  if (!text) {
    return {
      isJson,
      data: null,
      error: isJson ? null : 'Trendyol boş veya JSON olmayan yanıt döndürdü.',
    }
  }

  if (!isJson) {
    return {
      isJson,
      data: null,
      error: `Trendyol response content-type JSON değil: ${contentType || 'boş'}.`,
    }
  }

  try {
    return {
      isJson,
      data: JSON.parse(text),
      error: null,
    }
  } catch (error) {
    return {
      isJson,
      data: null,
      error:
        error instanceof Error
          ? `Trendyol JSON parse edilemedi: ${error.message}`
          : 'Trendyol JSON parse edilemedi.',
    }
  }
}

function validateSuratSoapCredentials(config) {
  const missing = []
  if (!config.kullaniciAdi) missing.push('Cari Kodu / Kullanıcı Adı')
  if (!config.sifre) missing.push('Şifre')

  if (missing.length === 0) return null

  return {
    provider: 'surat-kargo',
    ok: false,
    source: 'real',
    message: `Eksik Sürat alanları: ${missing.join(', ')}`,
    checkedAt: new Date().toISOString(),
  }
}

function validateSuratBarcodeOrderCredentials(config) {
  const missing = []
  if (!config.kullaniciAdi) missing.push('Cari Kodu / Kullanici Adi')
  if (!resolveSuratWebPassword(config).value) {
    missing.push('WebPassword / Sorgulama Sifresi')
  }
  if (missing.length === 0) return null

  return {
    provider: 'surat-kargo',
    ok: false,
    source: 'real',
    message: `Eksik Surat KargoBarkoduSiparis alanlari: ${missing.join(', ')}`,
    errorCode: 'SURAT_WEB_PASSWORD_MISSING',
    errorSource: 'CargoFlow',
    serviceType: 'KargoBarkoduSiparisSoap',
    serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
    operationName: 'KargoBarkoduSiparis',
    endpoint: `${SURAT_SOAP_URL}#KargoBarkoduSiparis`,
    statusCode: 0,
    rawRequest: {
      skipped: true,
      reason: `Eksik Surat KargoBarkoduSiparis alanlari: ${missing.join(', ')}`,
    },
    rawResponse: '',
    checkedAt: new Date().toISOString(),
  }
}

function resolveSuratCredentialSet(config = {}, order = {}) {
  const rawOrder = firstObjectCandidate(
    order.rawOrder,
    order.rawPackage,
    order.rawResponse,
  )
  const sources = [order, rawOrder]
  const paymentText = String(
    firstNonEmpty(
      order.paymentType,
      order.paymentMode,
      readSuratField(sources, [
        'paymentType',
        'paymentMode',
        'paymentMethod',
        'collectionType',
      ]),
    ),
  ).toLocaleLowerCase('tr-TR')
  const codAmount = toPositiveNumber(
    firstNonEmpty(
      order.cashOnDeliveryAmount,
      order.codAmount,
      readSuratField(sources, [
        'cashOnDeliveryAmount',
        'codAmount',
        'collectionAmount',
      ]),
    ),
  )
  const cashOnDelivery = Boolean(
    order.isCashOnDelivery === true ||
      codAmount != null ||
      /kapıda|kapida|cash[ _-]?on[ _-]?delivery|\bcod\b/.test(paymentText),
  )
  const selected = cashOnDelivery
    ? {
        name: 'cash_on_delivery',
        kullaniciAdi: config.codKullaniciAdi,
        sifre: config.codSifre,
        webPassword: config.codWebPassword,
      }
    : {
        name: 'seller_pays',
        kullaniciAdi:
          config.sellerPaysKullaniciAdi || config.kullaniciAdi,
        sifre: config.sellerPaysSifre || config.sifre,
        webPassword: config.sellerPaysWebPassword || config.webPassword,
      }

  return {
    name: selected.name,
    cashOnDelivery,
    codAmount: cashOnDelivery ? codAmount : null,
    config: {
      ...config,
      kullaniciAdi: String(selected.kullaniciAdi ?? '').trim(),
      sifre: String(selected.sifre ?? '').trim(),
      webPassword: String(selected.webPassword ?? '').trim(),
      selectedCredentialSet: selected.name,
      selectedCredentialMaskedAccount: maskCarrierAccount(
        selected.kullaniciAdi,
      ),
      cashOnDelivery,
      codAmount: cashOnDelivery ? codAmount : null,
    },
  }
}

function validateSuratRestCredentials(config, order = {}) {
  const soapValidation = validateSuratSoapCredentials(config)
  if (soapValidation) return soapValidation
  const missing = []
  if (!config.firmaId) missing.push('FirmaId')
  if (!config.restBasicUsername) missing.push('REST Basic Auth kullanici adi')
  if (!config.restBasicPassword) missing.push('REST Basic Auth sifresi')
  if (!config.restSenderMusteriId) missing.push('Gonderen.MusteriId')
  if (!config.restSenderAdi) missing.push('Gonderen.Adi')
  if (!config.restSenderSoyadi) missing.push('Gonderen.Soyadi')
  if (!config.restSenderTelefon) missing.push('Gonderen.Telefon')
  if (!config.restSenderAdres) missing.push('Gonderen.Adres')
  if (!(Number(config.restSenderIlId) > 0)) missing.push('Gonderen.IlId')
  if (!config.restSenderIlceAdi) missing.push('Gonderen.IlceAdi')
  const recipientCityId = Number(
    readSuratField(
      [order.shipmentAddress, order.rawOrder, order],
      ['cityId', 'IlId', 'ilId'],
    ),
  )
  const recipientName = splitName(order.customerName)
  if (!firstNonEmpty(order.customerEmail, order.cargoTrackingNumber)) {
    missing.push('Alici.MusteriId')
  }
  if (!recipientName.firstName) missing.push('Alici.Adi')
  if (!recipientName.lastName) missing.push('Alici.Soyadi')
  if (!String(order.customerPhone || '').trim()) missing.push('Alici.Telefon')
  if (!resolveSingleShipmentAddress(order)) missing.push('Alici.Adres')
  if (!(recipientCityId > 0)) missing.push('Alici.IlId')
  if (!String(order.district || '').trim()) missing.push('Alici.IlceAdi')
  if (missing.length === 0) return null

  return {
    provider: 'surat-kargo',
    ok: false,
    source: 'real',
    errorCode: 'SURAT_GONDERI_V2_CONTRACT_INCOMPLETE',
    message: `REST/V2 resmi request sozlesmesi icin eksik alanlar: ${missing.join(', ')}. Tasiyiciya istek gonderilmedi.`,
    checkedAt: new Date().toISOString(),
  }
}

function resolveSuratWebPassword(config = {}) {
  const value = firstNonEmpty(
    config.webPassword,
    config.webSifre,
    config.sorguSifresi,
    config.suratWebPassword,
  )
  return {
    value,
    source: value ? 'webPassword' : 'missing',
    fallbackUsed: false,
    matchesShipmentPassword: Boolean(
      value &&
        config.sifre &&
        String(value).trim() === String(config.sifre).trim(),
    ),
  }
}

function normalizeLocalIntegrationConfig(value = {}) {
  return {
    ...value,
    trendyol: {
      ...(value.trendyol ?? {}),
    },
    surat: normalizeSuratConfig(value.surat ?? {}),
  }
}

function normalizeSuratConfig(value = {}) {
  const allowPreRegistrationRest =
    value.allowPreRegistrationRest === true ||
    process.env.CARGOFLOW_ALLOW_SURAT_PRE_REGISTRATION_REST === '1'
  const serviceMode =
    value.serviceMode === 'ORTAK_BARKOD_SOAP'
      ? 'ORTAK_BARKOD_SOAP'
      : value.serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP'
        ? 'KARGO_BARKODU_SIPARIS_SOAP'
        : value.serviceMode === 'GONDERI_YENI_SOAP' ||
            value.serviceType === 'GonderiyiKargoyaGonderYeniSoap'
          ? 'GONDERI_YENI_SOAP'
        : allowPreRegistrationRest &&
            (value.serviceMode === 'PRE_REGISTRATION_REST' ||
              value.serviceType === 'GonderiyiKargoyaGonderRestJson')
          ? 'PRE_REGISTRATION_REST'
        : value.serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL'
          ? 'GONDERI_OLUSTUR_V2_EXPERIMENTAL'
          : 'ORTAK_BARKOD_SOAP'
  const ortam =
    SURAT_ENV ||
    (value.ortam === 'live' ? 'live' : 'test')
  const envPrefix = ortam === 'live' ? 'SURAT_LIVE' : 'SURAT_TEST'
  const envKullaniciAdi =
    process.env[`${envPrefix}_KULLANICI_ADI`] ||
    process.env[`${envPrefix}_CARI_KODU`] ||
    ''
  const envSifre = process.env[`${envPrefix}_SIFRE`] || ''
  const envWebPassword =
    process.env[`${envPrefix}_WEB_PASSWORD`] ||
    process.env[`${envPrefix}_WEBPASSWORD`] ||
    process.env[`${envPrefix}_WEB_SIFRE`] ||
    process.env[`${envPrefix}_SORGULAMA_SIFRESI`] ||
    ''
  const envFirmaId = process.env[`${envPrefix}_FIRMA_ID`] || ''
  const scopedKullaniciAdi =
    ortam === 'live' ? value.liveKullaniciAdi : value.testKullaniciAdi
  const scopedSifre = ortam === 'live' ? value.liveSifre : value.testSifre
  const scopedWebPassword =
    ortam === 'live' ? value.liveWebPassword : value.testWebPassword
  const scopedFirmaId = ortam === 'live' ? value.liveFirmaId : value.testFirmaId
  const createRoute = resolveSuratCreateRoute(serviceMode, value)
  return {
    kullaniciAdi: String(
      envKullaniciAdi ||
        scopedKullaniciAdi ||
        value.kullaniciAdi ||
        value.cariKodu ||
        '',
    ).trim(),
    sifre: String(
      envSifre || scopedSifre || value.sifre || value.password || '',
    ).trim(),
    webPassword: String(
      envWebPassword ||
        scopedWebPassword ||
        value.webPassword ||
        value.webSifre ||
        value.sorguSifresi ||
        value.suratWebPassword ||
        '',
    ).trim(),
    sellerPaysKullaniciAdi: String(
      value.sellerPaysKullaniciAdi ?? value.sellerPaysCariKodu ?? '',
    ).trim(),
    sellerPaysSifre: String(value.sellerPaysSifre ?? '').trim(),
    sellerPaysWebPassword: String(
      value.sellerPaysWebPassword ?? '',
    ).trim(),
    codKullaniciAdi: String(
      value.codKullaniciAdi ?? value.cashOnDeliveryCariKodu ?? '',
    ).trim(),
    codSifre: String(
      value.codSifre ?? value.cashOnDeliverySifre ?? '',
    ).trim(),
    codWebPassword: String(
      value.codWebPassword ?? value.cashOnDeliveryWebPassword ?? '',
    ).trim(),
    firmaId: String(envFirmaId || scopedFirmaId || value.firmaId || '').trim(),
    restBasicUsername: String(
      process.env.SURAT_REST_BASIC_USERNAME ||
        value.restBasicUsername ||
        '',
    ).trim(),
    restBasicPassword: String(
      process.env.SURAT_REST_BASIC_PASSWORD ||
        value.restBasicPassword ||
        '',
    ).trim(),
    restSenderMusteriId: String(
      process.env.SURAT_REST_SENDER_MUSTERI_ID ||
        value.restSenderMusteriId ||
        '',
    ).trim(),
    restSenderAdi: String(
      process.env.SURAT_REST_SENDER_ADI || value.restSenderAdi || '',
    ).trim(),
    restSenderSoyadi: String(
      process.env.SURAT_REST_SENDER_SOYADI || value.restSenderSoyadi || '',
    ).trim(),
    restSenderTelefon: String(
      process.env.SURAT_REST_SENDER_TELEFON ||
        value.restSenderTelefon ||
        '',
    ).trim(),
    restSenderEmail: String(
      process.env.SURAT_REST_SENDER_EMAIL || value.restSenderEmail || '',
    ).trim(),
    restSenderAdres: String(
      process.env.SURAT_REST_SENDER_ADRES || value.restSenderAdres || '',
    ).trim(),
    restSenderIlId: Number(
      process.env.SURAT_REST_SENDER_IL_ID || value.restSenderIlId || 0,
    ),
    restSenderIlceAdi: String(
      process.env.SURAT_REST_SENDER_ILCE_ADI ||
        value.restSenderIlceAdi ||
        '',
    ).trim(),
    testKullaniciAdi: String(value.testKullaniciAdi ?? '').trim(),
    testSifre: String(value.testSifre ?? '').trim(),
    testWebPassword: String(value.testWebPassword ?? '').trim(),
    testFirmaId: String(value.testFirmaId ?? '').trim(),
    liveKullaniciAdi: String(value.liveKullaniciAdi ?? '').trim(),
    liveSifre: String(value.liveSifre ?? '').trim(),
    liveWebPassword: String(value.liveWebPassword ?? '').trim(),
    liveFirmaId: String(value.liveFirmaId ?? '').trim(),
    entegrasyonSozlesme: String(
      value.entegrasyonSozlesme ?? value.integrationContract ?? '',
    ).trim(),
    entegrasyonMusteri: String(
      value.entegrasyonMusteri ?? value.integrationCustomer ?? '',
    ).trim(),
    entegrasyonFirmasi: String(
      value.entegrasyonFirmasi ?? value.integrationCompany ?? 'Trendyol',
    ).trim(),
    whoPays: String(value.whoPays ?? value.WhoPays ?? '').trim(),
    odemeTipi: String(value.odemeTipi ?? value.odemetipi ?? '1').trim(),
    kWebGonderiGirisiKaynak: String(
      value.kWebGonderiGirisiKaynak ??
        value.gonderiGirisiKaynak ??
        'PazaryeriOrtakBarkod',
    ).trim(),
    ortam,
    allowPreRegistrationRest,
    serviceMode,
    ...createRoute,
    trackingServiceType:
      value.trackingServiceType === 'KargoTakipHareketDetayiRest'
        ? 'KargoTakipHareketDetayiRest'
        : 'KargoTakipHareketDetayiSoap',
    trackingPath: value.trackingPath || '/api/KargoTakipHareketDetayi',
    trackingCodeField: String(value.trackingCodeField || 'auto'),
    barcodeCodeField: String(value.barcodeCodeField || 'auto'),
    tNoCodeField: String(value.tNoCodeField || 'auto'),
    trackingVerificationDelaysMs: Array.isArray(
      value.trackingVerificationDelaysMs,
    )
      ? value.trackingVerificationDelaysMs
          .map((delay) => Math.max(0, Number(delay) || 0))
          .slice(0, 5)
      : [0, 3000, 10000, 30000, 60000],
    labelRegistrationGraceMs: Number.isFinite(
      Number(value.labelRegistrationGraceMs),
    )
      ? Math.max(0, Number(value.labelRegistrationGraceMs))
      : SURAT_LABEL_REGISTRATION_GRACE_MS,
  }
}

function resolveSuratServiceMode(serviceType) {
  if (serviceType === 'KargoBarkoduSiparisSoap') {
    return 'KARGO_BARKODU_SIPARIS_SOAP'
  }
  if (
    [
      'OrtakBarkodOlusturSoap',
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    ].includes(serviceType)
  ) {
    return 'ORTAK_BARKOD_SOAP'
  }
  if (serviceType === 'GonderiyiKargoyaGonderRestJson') {
    return 'PRE_REGISTRATION_REST'
  }
  if (serviceType === 'GonderiyiKargoyaGonderYeniSoap') {
    return 'GONDERI_YENI_SOAP'
  }
  return 'GONDERI_OLUSTUR_V2_EXPERIMENTAL'
}

function resolveSuratCreateRoute(serviceMode, value = {}) {
  if (serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP') {
    return {
      serviceType: 'KargoBarkoduSiparisSoap',
      createShipmentPath: '/api/KargoBarkoduSiparis',
    }
  }
  if (serviceMode === 'PRE_REGISTRATION_REST') {
    return {
      serviceType: 'GonderiyiKargoyaGonderRestJson',
      createShipmentPath: '/api/GonderiyiKargoyaGonder',
    }
  }
  if (serviceMode === 'GONDERI_YENI_SOAP') {
    return {
      serviceType: 'GonderiyiKargoyaGonderYeniSoap',
      createShipmentPath: '/api/GonderiyiKargoyaGonderYeni',
    }
  }
  if (serviceMode === 'GONDERI_OLUSTUR_V2_EXPERIMENTAL') {
    return {
      serviceType: 'GonderiOlusturV2',
      createShipmentPath: '/api/Gonderi/GonderiOlustur',
    }
  }
  if (
    value.serviceType === 'OrtakBarkodOlusturSoap' ||
    String(value.createShipmentPath || '').endsWith('/OrtakBarkodOlustur')
  ) {
    return {
      serviceType: 'OrtakBarkodOlusturSoap',
      createShipmentPath: '/api/OrtakBarkodOlustur',
    }
  }
  return {
    serviceType:
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    createShipmentPath:
      '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  }
}

function inspectSuratCreateOperation(rawRequest, expectedOperation) {
  const text = String(rawRequest ?? '')
  const rawRequestContainsExpectedOperation = new RegExp(
    `<(?:[^:>]+:)?${expectedOperation}\\b`,
    'i',
  ).test(text)
  const rawRequestContainsLegacyOperation =
    /<(?:[^:>]+:)?GonderiyiKargoyaGonder\b/i.test(text)
  return {
    rawRequestContainsExpectedOperation,
    rawRequestContainsLegacyOperation,
    wrongServiceCalled:
      !rawRequestContainsExpectedOperation || rawRequestContainsLegacyOperation,
  }
}

function toIntegrationTestResult(provider, result) {
  return {
    provider,
    ok: result.ok,
    source: result.source ?? 'real',
    message: result.ok
      ? 'Bağlantı başarılı. Gerçek API yanıt verdi.'
      : `Bağlantı doğrulanamadı: ${result.message}`,
    checkedAt: new Date().toISOString(),
    statusCode: result.statusCode,
    rawPreview: preview(
      result.debug ?? {
        data: result.data,
        request: result.request,
      },
    ),
  }
}

function mapTrendyolError(status, data, parseError, text) {
  if (status === 401) {
    return 'Trendyol API Key / API Secret / SellerId hatalı olabilir.'
  }
  if (status === 403) {
    return 'User-Agent eksik/hatalı veya erişim yetkisi problemi olabilir.'
  }
  if (status === 429) {
    return 'Rate limit aşıldı.'
  }

  const parsedMessage = extractTrendyolErrorMessage(data)
  if (parsedMessage) return `HTTP ${status}: ${parsedMessage}`
  if (parseError) return `HTTP ${status}: ${parseError}`
  return `HTTP ${status}: ${String(text ?? '').slice(0, 240)}`
}

function extractTrendyolErrorMessage(data) {
  if (!data || typeof data !== 'object') return ''

  if (typeof data.message === 'string' && data.message) return data.message
  if (typeof data.exception === 'string' && data.exception) return data.exception
  if (Array.isArray(data.errors)) {
    const error = data.errors.find((item) => item && typeof item === 'object')
    if (error?.message) return String(error.message)
    if (error?.key) return String(error.key)
    if (error?.errorCode) return String(error.errorCode)
  }

  return ''
}

function buildSuratCreateLog({
  rawRequest,
  rawResponse,
  responseStatus,
  contentType,
  parsedResponse,
  orderId,
  shipmentId,
  serviceType,
  serviceMode,
  operationName,
  endpoint,
  payloadFormat,
  outcome,
  requestReference,
  phoneWarning,
  requestValidation,
  trendyolPreflight,
  addressNormalization,
}) {
  const resolvedServiceMode =
    serviceMode || resolveSuratServiceMode(serviceType)
  const KargoTakipNo = String(outcome?.officialTrackingNumber ?? '')
  const Barcode = String(outcome?.officialBarcode ?? '')
  const BarcodeRaw = normalizeSuratRawZpl(
    readSuratField(parsedResponse, ['BarcodeRaw']),
  )
  const barcodeSource = Barcode
    ? `surat.response.${outcome?.codeMapping?.barcodeField || 'Barcode'}`
    : ''
  const trackingSource = KargoTakipNo
    ? `surat.response.${outcome?.codeMapping?.trackingField || 'KargoTakipNo'}`
    : ''

  return {
    rawRequest: redactSuratRawRequest(rawRequest),
    rawResponse,
    responseStatus: Number(responseStatus ?? 0),
    status: Number(responseStatus ?? 0),
    contentType: String(contentType ?? ''),
    parsedResponse,
    createdAt: new Date().toISOString(),
    orderId: String(orderId ?? ''),
    shipmentId: String(shipmentId ?? ''),
    serviceType: String(serviceType ?? ''),
    serviceMode: resolvedServiceMode,
    operationName: String(operationName ?? endpoint ?? serviceType ?? ''),
    endpoint: String(endpoint ?? ''),
    payloadFormat,
    responseCode: String(outcome?.code ?? ''),
    responseCategory: String(outcome?.responseCategory ?? ''),
    responseDescription: String(outcome?.responseDescription ?? ''),
    responseDocumented: outcome?.responseDocumented,
    retryable: Boolean(outcome?.retryable),
    retryPolicy: outcome?.retryPolicy,
    responseMessage: String(outcome?.message ?? ''),
    barcodeResponseCodeDetected: Boolean(
      outcome?.barcodeResponseCodeDetected,
    ),
    hasTrackingNumber: Boolean(outcome?.hasTrackingNumber),
    hasBarcode: Boolean(outcome?.hasBarcode),
    verifiedShipment: Boolean(outcome?.verifiedShipment),
    KargoTakipNo,
    Barcode,
    BarcodeRaw,
    barcodeSource,
    trackingSource,
    codeCandidates: outcome?.codeCandidates,
    codeMapping: outcome?.codeMapping,
    verificationStage: outcome?.verificationStage,
    errorCategory: outcome?.errorCategory,
    zplAnalysis: outcome?.zplAnalysis,
    rawRequestIncludesOrtakBarkodOlustur: Boolean(
      outcome?.rawRequestContainsExpectedOperation,
    ),
    rawRequestIncludesGonderiyiKargoyaGonder: Boolean(
      outcome?.rawRequestContainsLegacyOperation,
    ),
    rawRequestContainsExpectedOperation: Boolean(
      outcome?.rawRequestContainsExpectedOperation,
    ),
    rawRequestContainsLegacyOperation: Boolean(
      outcome?.rawRequestContainsLegacyOperation,
    ),
    wrongServiceCalled: Boolean(outcome?.wrongServiceCalled),
    preRegistrationOnly: Boolean(outcome?.preRegistrationOnly),
    duplicateShipment: Boolean(outcome?.duplicateShipment),
    noTrackingReason: String(outcome?.noTrackingReason ?? ''),
    requestReference: String(requestReference ?? shipmentId ?? ''),
    phoneWarning: String(phoneWarning ?? ''),
    requestValidation,
    trendyolPreflight,
    addressNormalization,
  }
}

function buildSuratTrackingLog({
  rawRequest,
  rawResponse,
  responseStatus,
  contentType,
  parsedResponse,
  orderId,
  shipmentId,
  serviceType,
  endpoint,
  payloadFormat,
  gonderilerLength,
  isError,
  errorMessage,
  trackingState,
}) {
  const normalized = normalizeSuratTrackingFields(parsedResponse, shipmentId)
  const carrierStatus =
    Number(gonderilerLength ?? 0) > 0
      ? mapSuratCarrierStatus(normalized.KargonunDurumuSayi)
      : undefined

  return {
    rawRequest: redactSuratRawRequest(rawRequest),
    rawResponse,
    rawSuratResponse: rawResponse,
    parsedResponse,
    KargoTakipNo: normalized.KargoTakipNo,
    TakipNo: normalized.TakipNo,
    TNo: normalized.TNo,
    BarkodNo: normalized.BarkodNo,
    Barkod: normalized.Barkod,
    GonderiNo: normalized.GonderiNo,
    WaybillNo: normalized.WaybillNo,
    IrsaliyeNo: normalized.IrsaliyeNo,
    CargoKey: normalized.CargoKey,
    TakipUrl: normalized.TakipUrl,
    TakipUrlTrackingNo: normalized.TakipUrlTrackingNo,
    TakipUrlTrackingSource: normalized.TakipUrlTrackingSource,
    extractedKargoTakipNo: normalized.TakipUrlTrackingNo,
    KargonunDurumu: normalized.KargonunDurumu,
    KargonunBulunduguYer: normalized.KargonunBulunduguYer,
    SonHareketTarihi: normalized.SonHareketTarihi,
    TeslimatSubesi: normalized.TeslimatSubesi,
    TeslimatSubeTel: normalized.TeslimatSubeTel,
    IadeDurum: normalized.IadeDurum,
    DevirDurum: normalized.DevirDurum,
    Satiskodu: normalized.Satiskodu,
    SatisKodu: normalized.SatisKodu,
    WebSiparisKodu: normalized.WebSiparisKodu,
    OzelKargoTakipNo: normalized.OzelKargoTakipNo,
    KargoObjId: normalized.KargoObjId,
    SeriNo: normalized.SeriNo,
    SiraNo: normalized.SiraNo,
    Hareketler: normalized.Hareketler,
    KargonunDurumuSayi: normalized.KargonunDurumuSayi,
    carrierStatusKey: carrierStatus?.key,
    carrierStatusLabel: carrierStatus?.label,
    Gonderiler: normalized.Gonderiler,
    responseStatus: Number(responseStatus ?? 0),
    status: Number(responseStatus ?? 0),
    contentType: String(contentType ?? ''),
    createdAt: new Date().toISOString(),
    orderId: String(orderId ?? ''),
    shipmentId: String(shipmentId ?? ''),
    serviceType: String(serviceType ?? ''),
    endpoint: String(endpoint ?? ''),
    payloadFormat,
    gonderilerLength: Number(gonderilerLength ?? 0),
    isError,
    errorMessage: String(errorMessage ?? ''),
    trackingState,
  }
}

function mapSuratCarrierStatus(value) {
  const statuses = {
    1: {
      key: 'PREPARING',
      label: 'Gönderi Hazırlanıyor',
      operationStatus: 'SHIPMENT_CREATED',
    },
    2: {
      key: 'TRANSFER_CENTER',
      label: 'Transfer Merkezinde',
      operationStatus: 'SHIPPED',
    },
    3: {
      key: 'IN_TRANSIT',
      label: 'Gönderi Yolda',
      operationStatus: 'SHIPPED',
    },
    4: {
      key: 'DELIVERY_BRANCH',
      label: 'Teslimat Şubesinde',
      operationStatus: 'SHIPPED',
    },
    5: {
      key: 'OUT_FOR_DELIVERY',
      label: 'Kurye Dağıtımda',
      operationStatus: 'SHIPPED',
    },
    6: {
      key: 'DELIVERED',
      label: 'Teslim Edildi',
      operationStatus: 'DELIVERED',
    },
    7: {
      key: 'REDIRECTING',
      label: 'Yönlendirme Sürecinde',
      operationStatus: 'SHIPPED',
    },
    9: {
      key: 'RETURNING',
      label: 'İade Sürecinde',
      operationStatus: 'RETURNING',
    },
    11: {
      key: 'COLLECTION_POINT',
      label: 'Teslimat Noktasında',
      operationStatus: 'SHIPPED',
    },
    13: {
      key: 'RETURN_DELIVERED',
      label: 'Teslim Edildi (İade)',
      operationStatus: 'DELIVERED_SPECIAL',
    },
    14: {
      key: 'MGT_DELIVERED',
      label: 'Teslim Edildi (MGT)',
      operationStatus: 'DELIVERED_SPECIAL',
    },
  }
  return statuses[String(value ?? '').trim()]
}

function mapSuratCreateResponse(value, fallbackCode) {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  const sourceText =
    typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const objectSource =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  const rawBarcode =
    extractFirst(sourceText, ['anyType']) ||
    extractSuratBarcodeValue(parsed, sourceText)
  const barcode = normalizeSuratBarcodeValue(rawBarcode)

  return {
    ...objectSource,
    responseCode:
      sourceText.match(/\[(\d{3})\]/)?.[1] ??
      sourceText.match(/<Message>\s*(\d{3})\s*<\/Message>/i)?.[1] ??
      '',
    responseMessage:
      extractSuratMessage(parsed) || extractSuratMessage(sourceText),
    KargoTakipNo: readSuratField(parsed, [
      'KargoTakipNo',
      'KargoTakipNumarasi',
      'KargoTakipNumarası',
      'trackingNumber',
      'kargoTakipNo',
    ]) || extractFirst(sourceText, [
      'KargoTakipNo',
      'KargoTakipNumarasi',
      'KargoTakipNumarası',
      'trackingNumber',
      'kargoTakipNo',
    ]),
    TakipNo: readSuratField(parsed, ['TakipNo']) ||
      extractFirst(sourceText, ['TakipNo']),
    TNo: readSuratField(parsed, ['TNo', 'T.No', 'TNO']) ||
      extractFirst(sourceText, ['TNo', 'T.No', 'TNO']),
    BarkodNo: readSuratField(parsed, ['BarkodNo']) ||
      extractFirst(sourceText, ['BarkodNo']),
    Barkod: barcode,
    Barcode: barcode,
    BarcodeRaw: rawBarcode,
    GonderiNo: readSuratField(parsed, [
      'GonderiNo',
      'GönderiNo',
      'GonderiKodu',
      'shipmentNumber',
      'shipmentCode',
    ]) || extractFirst(sourceText, [
      'GonderiNo',
      'GönderiNo',
      'GonderiKodu',
      'shipmentNumber',
      'shipmentCode',
    ]),
    WaybillNo: readSuratField(parsed, [
      'waybillNo',
      'WaybillNo',
      'awb',
      'awbNo',
    ]) || extractFirst(sourceText, [
      'waybillNo',
      'WaybillNo',
      'awb',
      'awbNo',
    ]),
    IrsaliyeNo: readSuratField(parsed, [
      'irsaliyeNo',
      'IrsaliyeNo',
      'IrsaliyeSiraNo',
    ]) || extractFirst(sourceText, [
      'irsaliyeNo',
      'IrsaliyeNo',
      'IrsaliyeSiraNo',
    ]),
    CargoKey: readSuratField(parsed, [
      'cargoKey',
      'CargoKey',
      'kargoKey',
      'KargoKey',
    ]) || extractFirst(sourceText, [
      'cargoKey',
      'CargoKey',
      'kargoKey',
      'KargoKey',
    ]),
    SatisKodu: readSuratField(parsed, [
      'SatisKodu',
      'Satiskodu',
      'SatışKodu',
      'WebSiparisKodu',
      'webSiparisKodu',
    ]) || extractFirst(sourceText, [
      'SatisKodu',
      'Satiskodu',
      'SatışKodu',
      'WebSiparisKodu',
      'webSiparisKodu',
    ]),
    WebSiparisKodu: readSuratField(parsed, [
      'WebSiparisKodu',
      'webSiparisKodu',
      'SatisKodu',
      'Satiskodu',
    ]) || extractFirst(sourceText, [
      'WebSiparisKodu',
      'webSiparisKodu',
      'SatisKodu',
      'Satiskodu',
    ]),
    OzelKargoTakipNo: readSuratField(parsed, [
      'OzelKargoTakipNo',
      'ÖzelKargoTakipNo',
    ]) || extractFirst(sourceText, [
      'OzelKargoTakipNo',
      'ÖzelKargoTakipNo',
    ]),
    ReferansNo: readSuratField(parsed, ['ReferansNo']) ||
      extractFirst(sourceText, ['ReferansNo']),
    TakipUrl: readSuratField(parsed, ['TakipUrl', 'TakipURL']) ||
      extractFirst(sourceText, ['TakipUrl', 'TakipURL']),
    requestReference: String(fallbackCode ?? ''),
    raw: sourceText,
  }
}

function mapSuratTracking(resultText, fallbackCode) {
  const parsed = safeJson(resultText)
  return normalizeSuratTrackingFields(parsed, fallbackCode, resultText)
}

function normalizeSuratTrackingFields(value, fallbackCode, rawText = '') {
  const sourceText =
    rawText ||
    (typeof value === 'string' ? value : JSON.stringify(value ?? ''))
  const objectSource =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const takipUrl =
    readSuratField(value, ['TakipUrl', 'TakipURL']) ||
    extractFirst(sourceText, ['TakipUrl', 'TakipURL']) ||
    ''
  const takipUrlTracking = extractTrackingNumberFromUrl(takipUrl)

  return {
    ...objectSource,
    KargoTakipNo: readSuratField(value, ['KargoTakipNo', 'KargoTakipNumarasi', 'KargoTakipNumarası']) ||
      extractFirst(sourceText, ['KargoTakipNo', 'KargoTakipNumarasi', 'KargoTakipNumarası']) ||
      '',
    TakipNo: readSuratField(value, ['TakipNo']) ||
      extractFirst(sourceText, ['TakipNo']) ||
      '',
    TNo: readSuratField(value, ['TNo', 'T.No', 'TNO']) ||
      extractFirst(sourceText, ['TNo', 'T.No', 'TNO']) ||
      '',
    BarkodNo: readSuratField(value, ['BarkodNo']) ||
      extractFirst(sourceText, ['BarkodNo']) ||
      '',
    Barkod: readSuratField(value, ['Barkod']) ||
      extractFirst(sourceText, ['Barkod']) ||
      '',
    GonderiNo: readSuratField(value, [
      'GonderiNo',
      'GönderiNo',
      'GonderiKodu',
    ]) ||
      extractFirst(sourceText, ['GonderiNo', 'GönderiNo', 'GonderiKodu']) ||
      '',
    WaybillNo: readSuratField(value, ['waybillNo', 'WaybillNo', 'awb', 'awbNo']) ||
      extractFirst(sourceText, ['waybillNo', 'WaybillNo', 'awb', 'awbNo']) ||
      '',
    IrsaliyeNo: readSuratField(value, ['irsaliyeNo', 'IrsaliyeNo', 'IrsaliyeSiraNo']) ||
      extractFirst(sourceText, ['irsaliyeNo', 'IrsaliyeNo', 'IrsaliyeSiraNo']) ||
      '',
    CargoKey: readSuratField(value, ['cargoKey', 'CargoKey', 'kargoKey', 'KargoKey']) ||
      extractFirst(sourceText, ['cargoKey', 'CargoKey', 'kargoKey', 'KargoKey']) ||
      '',
    TakipUrl: takipUrl,
    TakipUrlTrackingNo: takipUrlTracking.value,
    TakipUrlTrackingSource: takipUrlTracking.source,
    KargonunDurumu: readSuratField(value, ['KargonunDurumu']) ||
      extractFirst(sourceText, ['KargonunDurumu']) ||
      '',
    KargonunDurumuSayi: readSuratField(value, ['KargonunDurumuSayi']) ||
      extractFirst(sourceText, ['KargonunDurumuSayi']) ||
      '',
    KargonunBulunduguYer: readSuratField(value, ['KargonunBulunduguYer']) ||
      extractFirst(sourceText, ['KargonunBulunduguYer']) ||
      '',
    SonHareketTarihi: readSuratField(value, ['SonHareketTarihi']) ||
      extractFirst(sourceText, ['SonHareketTarihi']) ||
      '',
    TeslimatSubesi: readSuratField(value, ['TeslimatSubesi']) ||
      extractFirst(sourceText, ['TeslimatSubesi']) ||
      '',
    TeslimatSubeTel: readSuratField(value, ['TeslimatSubeTel']) ||
      extractFirst(sourceText, ['TeslimatSubeTel']) ||
      '',
    IadeDurum: readSuratField(value, ['IadeDurum']) ||
      extractFirst(sourceText, ['IadeDurum']) ||
      '',
    DevirDurum: readSuratField(value, ['DevirDurum']) ||
      extractFirst(sourceText, ['DevirDurum']) ||
      '',
    Satiskodu: readSuratField(value, ['Satiskodu', 'SatisKodu', 'SatışKodu']) ||
      extractFirst(sourceText, ['Satiskodu', 'SatisKodu', 'SatışKodu']) ||
      '',
    SatisKodu: readSuratField(value, ['SatisKodu', 'Satiskodu', 'SatışKodu']) ||
      extractFirst(sourceText, ['SatisKodu', 'Satiskodu', 'SatışKodu']) ||
      '',
    WebSiparisKodu: readSuratField(value, ['WebSiparisKodu', 'webSiparisKodu']) ||
      extractFirst(sourceText, ['WebSiparisKodu', 'webSiparisKodu']) ||
      String(fallbackCode ?? ''),
    OzelKargoTakipNo: readSuratField(value, ['OzelKargoTakipNo', 'ÖzelKargoTakipNo']) ||
      extractFirst(sourceText, ['OzelKargoTakipNo', 'ÖzelKargoTakipNo']) ||
      '',
    KargoObjId: readSuratField(value, ['KargoObjId']) ||
      extractFirst(sourceText, ['KargoObjId']) ||
      '',
    SeriNo: readSuratField(value, ['SeriNo']) ||
      extractFirst(sourceText, ['SeriNo']) ||
      '',
    SiraNo: readSuratField(value, ['SiraNo', 'SıraNo']) ||
      extractFirst(sourceText, ['SiraNo', 'SıraNo']) ||
      '',
    Hareketler:
      readSuratField(value, ['Hareketler', 'Hareket']) ||
      extractFirst(sourceText, ['Hareketler', 'Hareket']) ||
      [],
    Gonderiler:
      findSuratArray(value, ['Gonderiler', 'Gönderiler']) || [],
    raw: sourceText,
  }
}

function extractTrackingNumberFromUrl(url = '') {
  const text = String(url ?? '').trim()
  if (!text) return { value: '', source: '' }

  try {
    const parsedUrl = new URL(text)
    for (const key of ['kargotakipno', 'takipno', 'tno', 'barkodno']) {
      const value = parsedUrl.searchParams.get(key)
      if (value) {
        return { value: value.trim(), source: `surat.track.TakipUrl.query.${key}` }
      }
    }
  } catch {
    // Some Sürat responses contain a partial URL or plain text; fall through.
  }

  const match = text.match(/\b\d{8,}\b/)
  return match
    ? { value: match[0], source: 'surat.track.TakipUrl.longNumericSequence' }
    : { value: '', source: '' }
}

function selectSuratBarcodeFromFields({
  trackingFields,
  createFields,
  fallbackOrderNumber,
}) {
  const trackingNo = firstNonEmpty(
    readSuratField(trackingFields, ['BarkodNo']),
    readSuratField(trackingFields, ['Barkod']),
    readSuratField(trackingFields, ['KargoTakipNo']),
    readSuratField(trackingFields, ['TakipNo']),
    readSuratField(trackingFields, ['TNo']),
  )
  if (trackingNo) {
    return {
      barcodeValue: trackingNo,
      barcodeSource: 'surat.tracking.officialBarcode',
      officialTrackingNumber: trackingNo,
      shipmentReference: firstNonEmpty(
        readSuratField(trackingFields, ['WebSiparisKodu']),
        readSuratField(createFields, ['WebSiparisKodu', 'SatisKodu', 'Satiskodu']),
      ),
    }
  }

  const createOfficial = firstNonEmpty(
    readSuratField(createFields, [
      'KargoTakipNo',
      'TakipNo',
      'KargoTakipNumarasi',
      'KargoTakipNumarası',
      'GonderiNo',
      'GönderiNo',
      'GonderiKodu',
      'KargoNo',
      'Barkod',
      'BarkodNo',
      'shipmentNumber',
    ]),
  )
  if (createOfficial) {
    return {
      barcodeValue: createOfficial,
      barcodeSource: 'surat.create.officialTrackingNumber',
      officialTrackingNumber: createOfficial,
      shipmentReference: firstNonEmpty(
        readSuratField(createFields, ['WebSiparisKodu', 'SatisKodu', 'Satiskodu']),
      ),
    }
  }

  const salesCode = firstNonEmpty(
    readSuratField(trackingFields, ['Satiskodu', 'SatisKodu', 'WebSiparisKodu']),
    readSuratField(createFields, ['Satiskodu', 'SatisKodu', 'WebSiparisKodu']),
  )
  if (salesCode) {
    return {
      barcodeValue: salesCode,
      barcodeSource: 'surat.reference.SatisKodu',
      officialTrackingNumber: '',
      shipmentReference: salesCode,
    }
  }

  return {
    barcodeValue: String(fallbackOrderNumber ?? ''),
    barcodeSource: 'order.orderNumber',
    officialTrackingNumber: '',
    shipmentReference: '',
  }
}

function normalizeTrendyolOrders(data) {
  const content = getTrendyolOrderPackagesArray(data)
  const validPackages = content.filter(isTrendyolOrderPackage)
  const uniquePackages = new Map()

  for (const item of validPackages) {
    const key = getTrendyolPackageDedupKey(item)
    if (!key) continue
    if (uniquePackages.has(key)) {
      const existing = uniquePackages.get(key)
      uniquePackages.set(key, {
        ...existing,
        ...item,
        lines: mergeTrendyolLines(existing.lines, item.lines),
      })
      continue
    }
    uniquePackages.set(key, item)
  }

  const orders = Array.from(uniquePackages.entries()).map(([dedupKey, item], index) => {
    const address = item.shipmentAddress ?? item.invoiceAddress ?? {}
    const packageId = String(item.packageId ?? item.shipmentPackageId ?? item.id ?? '')
    const shipmentPackageId = String(item.shipmentPackageId ?? item.packageId ?? item.id ?? '')
    const orderId = String(item.orderNumber ?? item.id ?? packageId ?? index)
    const orderDate = toIsoDate(item.orderDate)
    const deliveryDate = toIsoDate(
      item.deliveryDate ?? item.agreedDeliveryDate ?? item.estimatedDeliveryEndDate,
    )
    const marketplaceStatus = normalizeStatus(item.status)

    return {
      id: `ty_order_${dedupKey}`,
      marketplace: 'Trendyol',
      externalOrderId: packageId || orderId,
      packageId,
      shipmentPackageId,
      orderNumber: String(item.orderNumber ?? item.id ?? `TY-ORDER-${index + 1}`),
      customerFirstName: item.customerFirstName ?? '',
      customerLastName: item.customerLastName ?? '',
      marketplaceStatus,
      operationStatus: operationStatusFromMarketplace(marketplaceStatus),
      source: 'real_api',
      status: 'Yeni',
      customerName:
        `${item.customerFirstName ?? ''} ${item.customerLastName ?? ''}`.trim() ||
        item.customerFullName ||
        'Trendyol Müşterisi',
      customerPhone: address.phone ?? item.customerPhone ?? '',
      customerEmail: item.customerEmail ?? '',
      shipmentAddress: address,
      address: resolveSingleAddressValue(address),
      city: address.city ?? '',
      district: address.district ?? '',
      cargoProviderName: item.cargoProviderName ?? item.cargoSenderNumber ?? '',
      cargoProviderId: String(item.cargoProviderId ?? ''),
      cargoCompanyId: String(item.cargoCompanyId ?? item.cargoProviderId ?? ''),
      cargoTrackingNumber: item.cargoTrackingNumber ?? '',
      cargoTrackingLink: item.cargoTrackingLink ?? item.trackingUrl ?? '',
      packageStatus: String(item.packageStatus ?? item.status ?? ''),
      shipmentStatusName: String(
        item.shipmentStatus ??
          item.shipmentStatusName ??
          item.orderLineItemStatusName ??
          '',
      ),
      isReadyToShip:
        typeof item.isReadyToShip === 'boolean' ? item.isReadyToShip : null,
      paymentType: String(
        item.paymentType ?? item.paymentMode ?? item.paymentMethod ?? '',
      ),
      isCashOnDelivery:
        typeof item.isCashOnDelivery === 'boolean'
          ? item.isCashOnDelivery
          : false,
      cashOnDeliveryAmount:
        toPositiveNumber(
          item.cashOnDeliveryAmount ??
            item.codAmount ??
            item.collectionAmount,
        ) ?? null,
      totalAmount: Number(item.totalPrice ?? item.grossAmount ?? 0),
      totalPrice: Number(item.totalPrice ?? item.grossAmount ?? 0),
      createdAt: orderDate || new Date().toISOString(),
      orderDate,
      deliveryDate,
      rawOrder: item,
      items: normalizeTrendyolOrderLines(item.lines, orderId),
    }
  })

  const totalLineCount = orders.reduce((total, order) => total + order.items.length, 0)
  const totalQuantity = orders.reduce(
    (total, order) =>
      total + order.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0),
    0,
  )

  return {
    orders,
    debug: {
      rawOrdersCount: content.length,
      normalizedOrdersCount: orders.length,
      duplicateRemovedCount: validPackages.length - orders.length,
      totalLineCount,
      totalQuantity,
    },
  }
}

// Trendyol claim statü adları → analitik sınıflar. YALNIZ kabul edilmiş
// iadeler satıştan düşülür; Rejected/Cancelled ve bekleyen statüler düşmez.
const TRENDYOL_ACCEPTED_CLAIM_STATUSES = ['Accepted']
const TRENDYOL_REJECTED_CLAIM_STATUSES = ['Rejected', 'Cancelled']

// Ham getClaims içeriğini analitik claim kayıtlarına dönüştürür. Granülarite
// (claimId, orderLineId, statusName): aynı satırda kısmi kabul/ret ayrışır.
// Değer üretmez, salt okuma normalizasyondur.
function normalizeTrendyolClaims(rawClaims) {
  const uniqueClaims = new Map()
  for (const claim of Array.isArray(rawClaims) ? rawClaims : []) {
    const claimId = String(claim?.id ?? claim?.claimId ?? '')
    if (!claimId) continue
    if (!uniqueClaims.has(claimId)) uniqueClaims.set(claimId, claim)
  }

  const distinctStatuses = new Set()
  const amountFieldsSeen = new Set()
  const normalized = []
  const affectedPackages = new Set()
  let fallbackAmountUsed = false

  for (const [claimId, claim] of uniqueClaims) {
    // Orijinal SATIŞ paketi orderOutboundPackageId'dir; orderShipmentPackageId
    // iade (inbound) paketinin id'sidir. Sipariş eşleşmesi için outbound
    // kullanılır (canlı sözleşmede doğrulandı).
    const packageId = String(
      claim?.orderOutboundPackageId ??
        claim?.orderShipmentPackageId ??
        claim?.shipmentPackageId ??
        claim?.packageId ??
        '',
    )
    const returnPackageId = String(
      claim?.orderShipmentPackageId ?? claim?.shipmentPackageId ?? '',
    )
    const orderNumber = String(claim?.orderNumber ?? '')
    const eventBase = toIsoDate(
      claim?.claimDate ?? claim?.createdDate ?? claim?.orderDate,
    )
    const items = Array.isArray(claim?.items) ? claim.items : []
    for (const item of items) {
      const orderLine = item?.orderLine ?? {}
      const orderLineId = String(orderLine?.id ?? orderLine?.orderLineId ?? '')
      const unitPrice = Number(orderLine?.price ?? orderLine?.amount ?? 0)
      const claimItems = Array.isArray(item?.claimItems) ? item.claimItems : []
      // (statusName) bazında grupla: kısmi iade desteği (adet = claimItem sayısı).
      const byStatus = new Map()
      for (const claimItem of claimItems) {
        const statusName = String(
          claimItem?.claimItemStatus?.name ??
            claimItem?.claimItemStatus ??
            claimItem?.status ??
            '',
        )
        distinctStatuses.add(statusName)
        for (const key of Object.keys(claimItem ?? {})) {
          if (/amount|refund/i.test(key)) amountFieldsSeen.add(`item.${key}`)
        }
        const reason = String(
          claimItem?.customerClaimItemReason?.name ??
            claimItem?.trendyolClaimItemReason?.name ??
            claimItem?.claimReason ??
            '',
        )
        // Canlı sözleşmede (doğrulandı) claimItem'da güvenilir bir refund
        // tutarı YOK; yine de ileride eklenirse otomatik kullanılsın diye
        // bilinen aday alanlar toplanır.
        const claimAmount = firstFiniteNumber([
          claimItem?.refundAmount,
          claimItem?.claimAmount,
        ])
        const group = byStatus.get(statusName) ?? {
          quantity: 0,
          reason,
          claimAmount: null,
        }
        group.quantity += 1
        if (claimAmount != null) {
          group.claimAmount = (group.claimAmount ?? 0) + claimAmount
        }
        byStatus.set(statusName, group)
      }
      for (const [statusName, group] of byStatus) {
        // Event tarihi claim seviyesindeki claimDate'tir (iade olayı).
        const eventDate = eventBase
        const fallbackAmount = Number.isFinite(unitPrice)
          ? Math.round(unitPrice * group.quantity * 100) / 100
          : null
        const amount =
          group.claimAmount != null
            ? Math.round(group.claimAmount * 100) / 100
            : fallbackAmount
        const amountSource =
          group.claimAmount != null ? 'claim_amount' : 'line_price_fallback'
        if (amountSource === 'line_price_fallback') fallbackAmountUsed = true
        const isAcceptedReturn =
          TRENDYOL_ACCEPTED_CLAIM_STATUSES.includes(statusName)
        const isCancelledOrRejected =
          TRENDYOL_REJECTED_CLAIM_STATUSES.includes(statusName)
        if (isAcceptedReturn && packageId) affectedPackages.add(packageId)
        normalized.push({
          claimId,
          packageId,
          returnPackageId,
          orderNumber,
          orderLineId,
          claimStatus: statusName,
          claimType: group.reason,
          eventDate,
          quantity: group.quantity,
          amount,
          amountSource,
          isAcceptedReturn,
          isCancelledOrRejected,
        })
      }
    }
  }

  if (process.env.CARGOFLOW_CLAIMS_DEBUG) {
    console.info(
      '[claims] CLAIM_CONTRACT',
      JSON.stringify({
        uniqueClaimCount: uniqueClaims.size,
        normalizedRecords: normalized.length,
        distinctStatuses: [...distinctStatuses],
        amountFieldsSeen: [...amountFieldsSeen],
      }),
    )
  }

  return {
    claims: normalized,
    uniqueClaimCount: uniqueClaims.size,
    affectedPackageCount: affectedPackages.size,
    // Tutar tabanı: claim API refund tutarı vermediği için satır birim
    // fiyatı × iade adedi fallback'i kullanıldığında işaretlenir.
    amountBasis: fallbackAmountUsed ? 'line_price_fallback' : 'claim_amount',
  }
}

function firstFiniteNumber(candidates) {
  for (const candidate of candidates) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return null
}

function normalizeTrendyolOrderLines(lines, orderId) {
  if (!Array.isArray(lines)) return []

  return lines.map((line, index) => {
    const image = resolveTrendyolImage(line)
    const variantAttributes = normalizeVariantAttributes(line.variantAttributes)
    const color =
      line.productColor ??
      line.color ??
      findVariantAttribute(variantAttributes, ['Renk', 'Color'])
    const size =
      line.productSize ??
      line.size ??
      findVariantAttribute(variantAttributes, ['Beden', 'Size', 'Numara'])

    return {
      id: `ty_line_${line.id ?? line.orderLineId ?? line.barcode ?? index}`,
      orderId,
      productName:
        line.productName ?? line.productNameTr ?? line.name ?? 'Trendyol ürünü',
      barcode: line.barcode ?? '',
      sku: line.sku ?? line.merchantSku ?? line.stockCode ?? '',
      merchantSku: line.merchantSku ?? line.sku ?? '',
      stockCode: line.stockCode ?? line.merchantSku ?? line.sku ?? '',
      quantity: Number(line.quantity ?? 1),
      price: Number(line.price ?? line.amount ?? line.discountedPrice ?? 0),
      imageUrl: image.url,
      productImageUrl: image.url,
      imageSource: image.source,
      imageResolvedFrom: image.url ? 'orderLine' : 'none',
      imageLoadError: false,
      matchedBy: image.url ? 'orderLine' : 'none',
      color: color ? String(color) : '',
      size: size ? String(size) : '',
      variantAttributes,
      // Trendyol order lines may expose the content identity as `contentId`
      // (the live currentSync payload does this), not only as
      // `productContentId`. Keep that identity for the product-image resolver.
      productContentId: String(
        line.productContentId ?? line.contentId ?? line.productId ?? '',
      ),
      productMainId: String(
        line.productMainId ?? line.productMainCode ?? '',
      ),
      productCode: String(
        line.productCode ?? line.contentId ?? line.productId ?? '',
      ),
      desi: toPositiveNumber(
        line.dimensionalWeight ?? line.desi ?? line.volumetricWeight,
      ),
      weightKg: toPositiveNumber(line.weight ?? line.kg ?? line.weightKg),
      lengthCm: toPositiveNumber(line.length ?? line.lengthCm),
      widthCm: toPositiveNumber(line.width ?? line.widthCm),
      heightCm: toPositiveNumber(line.height ?? line.heightCm),
      rawLine: line,
    }
  })
}

function toPositiveNumber(value) {
  const number = Number(String(value ?? '').replace(',', '.'))
  return Number.isFinite(number) && number > 0 ? number : null
}

function normalizeVariantAttributes(attributes) {
  if (!Array.isArray(attributes)) return []

  return attributes
    .map((attribute) => {
      if (!attribute || typeof attribute !== 'object') return null
      const name =
        attribute.name ??
        attribute.attributeName ??
        attribute.key ??
        attribute.attributeKey ??
        attribute.propertyName
      const value =
        attribute.value ??
        attribute.attributeValue ??
        attribute.displayValue ??
        attribute.propertyValue
      if (!name || value == null || value === '') return null
      return {
        name: String(name),
        value: String(value),
      }
    })
    .filter(Boolean)
}

function findVariantAttribute(attributes, names) {
  const normalizedNames = names.map((name) =>
    String(name).toLocaleLowerCase('tr-TR'),
  )
  const found = attributes.find((attribute) =>
    normalizedNames.includes(
      String(attribute.name).toLocaleLowerCase('tr-TR'),
    ),
  )
  return found?.value ?? ''
}

function mergeTrendyolLines(existingLines = [], nextLines = []) {
  const lines = new Map()

  for (const line of [...existingLines, ...nextLines]) {
    const key = String(
      line?.id ?? line?.orderLineId ?? line?.barcode ?? line?.merchantSku ?? '',
    )
    if (!key || lines.has(key)) continue
    lines.set(key, line)
  }

  return Array.from(lines.values())
}

function isTrendyolOrderPackage(item) {
  if (!item || typeof item !== 'object') return false
  const hasPackageIdentity = Boolean(
    item.orderNumber || item.packageId || item.shipmentPackageId || item.id,
  )
  const hasCustomerOrAddress = Boolean(
    item.customerFirstName ||
      item.customerLastName ||
      item.customerFullName ||
      item.shipmentAddress,
  )
  if (!hasPackageIdentity || !hasCustomerOrAddress) return false
  if (item.shipmentAddress || Array.isArray(item.lines)) return true
  return Boolean(
    item.customerFirstName || item.customerLastName || item.customerFullName,
  )
}

function getTrendyolPackageDedupKey(item) {
  return String(
    item.packageId ?? item.shipmentPackageId ?? item.orderNumber ?? item.id ?? '',
  )
}

function isTrendyolPackageInStatuses(item, statuses) {
  const rawStatus = [
    item?.status,
    item?.packageStatus,
    item?.shipmentPackageStatus,
  ]
    .map((value) => String(value ?? '').trim())
    .find((value) => ALL_TRENDYOL_ORDER_STATUSES.includes(value))
  return Boolean(rawStatus && statuses.includes(rawStatus))
}

function isUnknownTrendyolPackageStatus(item) {
  const rawStatus = [
    item?.status,
    item?.packageStatus,
    item?.shipmentPackageStatus,
  ]
    .map((value) => String(value ?? '').trim())
    .find(Boolean)
  return Boolean(rawStatus && !ALL_TRENDYOL_ORDER_STATUSES.includes(rawStatus))
}

function mergeTrendyolPackageCollections(...collections) {
  const packages = new Map()
  for (const collection of collections) {
    for (const item of collection) {
      const key = getTrendyolPackageDedupKey(item)
      if (!key) continue
      if (!packages.has(key)) {
        packages.set(key, item)
        continue
      }
      const existing = packages.get(key)
      packages.set(key, {
        ...existing,
        ...item,
        lines: mergeTrendyolLines(existing.lines, item.lines),
      })
    }
  }
  return Array.from(packages.values())
}

function summarizeTrendyolUnfilteredFallback(
  result,
  contentCount,
  matchingCount,
  addedCount = 0,
) {
  return {
    attempted: true,
    ok: result.ok,
    statusCode: result.statusCode,
    message: result.message,
    requestUrl: result.debug?.requestUrl,
    pageRequests: result.debug?.pageRequests,
    contentCount,
    matchingCount,
    addedCount,
  }
}

function getTrendyolOrderPackagesArray(data) {
  if (Array.isArray(data?.content)) return data.content
  if (Array.isArray(data?.orders)) return data.orders
  if (Array.isArray(data?.shipmentPackages)) return data.shipmentPackages
  if (Array.isArray(data?.packages)) return data.packages
  if (Array.isArray(data)) return data
  return []
}

function normalizeTrendyolProducts(data) {
  const content = getTrendyolProductsArray(data)
  return content.filter(isTrendyolProductListing).map((item, index) => {
    const images = extractTrendyolImages(item)
    const externalVariantId = String(
      item.platformListingId ?? item.id ?? '',
    ).trim()
    const barcode = String(item.barcode ?? '').trim()
    const color = String(
      item.color ?? findTrendyolAttribute(item, 'Renk') ?? '',
    ).trim()
    const size = String(
      item.size ?? findTrendyolAttribute(item, 'Beden') ?? '',
    ).trim()
    const variantAttributes = [
      color ? { name: 'Renk', value: color } : null,
      size ? { name: 'Beden', value: size } : null,
    ].filter(Boolean)
    return {
      id: `prd_real_${externalVariantId || barcode || index}_${index}`,
      marketplace: 'Trendyol',
      externalProductId: String(
        item.id ?? item.productMainId ?? item.productCode ?? '',
      ),
      externalVariantId,
      productContentId: String(
        item.productContentId ??
          item.contentId ??
          item.productId ??
          item.id ??
          '',
      ),
      productMainId: String(item.productMainId ?? ''),
      productCode: String(
        item.productCode ?? item.contentId ?? item.productId ?? '',
      ),
      productName: item.title ?? item.productName ?? 'Trendyol ürünü',
      sku: item.merchantSku ?? item.stockCode ?? '',
      stockCode: item.stockCode ?? item.merchantSku ?? '',
      barcode,
      category: item.categoryName ?? item.category ?? '',
      brand: item.brand ?? item.brandName ?? '',
      color,
      size,
      variantAttributes,
      desi: Number(item.dimensionalWeight ?? item.desi ?? 0),
      kg: Number(item.weight ?? item.kg ?? 0),
      imageUrl: images[0] ?? '',
      productImageUrl: images[0] ?? '',
      images,
      stock: Number(item.quantity ?? item.stock ?? 0),
      price: Number(item.salePrice ?? item.listPrice ?? 0),
      productStatus: normalizeProductStatus(item),
      source: 'real',
      createdAt: item.createDate ?? item.createdDate ?? item.createdAt ?? '',
      updatedAt: new Date().toISOString(),
    }
  })
}

const PRODUCT_CATALOG_TRACE_QUERIES = [
  'kkkıasdasdasd14',
  'SCUBA-SEC0115',
  'eftal56879-2',
]

function normalizedCatalogValue(value) {
  return String(value ?? '').trim().toLocaleLowerCase('tr-TR')
}

function countUniqueProductField(products, field) {
  return new Set(
    products
      .map((product) => normalizedCatalogValue(product?.[field]))
      .filter(Boolean),
  ).size
}

function countUniqueRawProductField(products, fields) {
  return new Set(
    products
      .map((product) =>
        fields
          .map((field) => normalizedCatalogValue(product?.[field]))
          .find(Boolean),
      )
      .filter(Boolean),
  ).size
}

function productVariantIdentity(product) {
  const barcode = normalizedCatalogValue(product?.barcode)
  const externalVariantId = normalizedCatalogValue(
    product?.externalVariantId ?? product?.platformListingId ?? product?.id,
  )
  if (barcode && externalVariantId) return `bc:${barcode}|ext:${externalVariantId}`
  if (externalVariantId) return `ext:${externalVariantId}`
  if (barcode) return `bc:${barcode}`
  const productCode = normalizedCatalogValue(product?.productCode)
  const color = normalizedCatalogValue(
    product?.color ?? findTrendyolAttribute(product, 'Renk'),
  )
  const size = normalizedCatalogValue(
    product?.size ?? findTrendyolAttribute(product, 'Beden'),
  )
  return [productCode, color, size].filter(Boolean).join('|')
}

function countUniqueProductVariants(products) {
  return new Set(products.map(productVariantIdentity).filter(Boolean)).size
}

function countUniqueRawProductVariants(products) {
  return countUniqueProductVariants(products)
}

function traceProductCatalogTargets(stage, products) {
  return PRODUCT_CATALOG_TRACE_QUERIES.map((query) => {
    const normalizedQuery = normalizedCatalogValue(query)
    const matches = products.filter((product) => {
      const values = [
        product?.barcode,
        product?.productCode,
        product?.productMainId,
        product?.merchantSku,
        product?.sku,
        product?.stockCode,
        product?.title,
        product?.productName,
      ]
      return values.some((value) =>
        normalizedCatalogValue(value).includes(normalizedQuery),
      )
    })
    const product = matches[0]
    return {
      stage,
      query,
      found: matches.length > 0,
      recordCount: matches.length,
      barcode: String(product?.barcode ?? ''),
      productMainId: String(product?.productMainId ?? ''),
      productCode: String(product?.productCode ?? ''),
      color: String(
        product?.color ?? findTrendyolAttribute(product, 'Renk') ?? '',
      ),
      size: String(
        product?.size ?? findTrendyolAttribute(product, 'Beden') ?? '',
      ),
      imageCandidates: product ? extractTrendyolImages(product) : [],
    }
  })
}

function getTrendyolProductsArray(data) {
  if (Array.isArray(data?.content)) return data.content
  if (Array.isArray(data?.products)) return data.products
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data?.listings)) return data.listings
  if (Array.isArray(data)) return data
  return []
}

function isTrendyolProductListing(item) {
  if (!item || typeof item !== 'object') return false
  if (item.shipmentAddress || item.customerFirstName || item.customerLastName) {
    return false
  }
  return Boolean(
    item.productId ||
      item.id ||
      item.barcode ||
      item.stockCode ||
      item.title ||
      item.name ||
      item.productName,
  )
}

function extractTrendyolImages(item) {
  const values = [
    item?.productImageUrl,
    item?.imageUrl,
    item?.productImage,
    ...(Array.isArray(item?.images) ? item.images : []),
    ...(Array.isArray(item?.product?.images) ? item.product.images : []),
    item?.product?.image,
    item?.product?.mainImage,
    item?.productMainImage,
    item?.thumbnail,
    item?.productContentImage,
    item?.mainImage,
    item?.image,
    item?.product?.imageUrl,
    item?.product?.productImageUrl,
    ...(Array.isArray(item?.media) ? item.media : []),
    ...(Array.isArray(item?.product?.media) ? item.product.media : []),
    ...(Array.isArray(item?.pictures) ? item.pictures : []),
    ...(Array.isArray(item?.product?.pictures) ? item.product.pictures : []),
    ...(Array.isArray(item?.imageUrls) ? item.imageUrls : []),
    ...(Array.isArray(item?.productImages) ? item.productImages : []),
  ]

  return Array.from(
    new Set(
      values
        .map((image) => {
          if (typeof image === 'string') return image
          return (
            image?.url ??
            image?.imageUrl ??
            image?.productImageUrl ??
            image?.original ??
            ''
          )
        })
        .map((value) => String(value ?? '').trim())
        .map((value) => (value.startsWith('//') ? `https:${value}` : value))
        .filter((value) => /^https?:\/\//i.test(value)),
    ),
  )
}

function extractTrendyolImageUrl(item) {
  return extractTrendyolImages(item)[0] ?? ''
}

function resolveTrendyolImage(item) {
  const candidates = [
    ['productImageUrl', item?.productImageUrl],
    ['imageUrl', item?.imageUrl],
    ['productImage', item?.productImage],
    ['images[0]', item?.images?.[0]],
    ['product.images[0]', item?.product?.images?.[0]],
    ['product.image', item?.product?.image],
    ['product.mainImage', item?.product?.mainImage],
    ['product.media[0].url', item?.product?.media?.[0]],
    ['productMainImage', item?.productMainImage],
    ['thumbnail', item?.thumbnail],
    ['productContentImage', item?.productContentImage],
    ['mainImage', item?.mainImage],
    ['image', item?.image],
    ['media[0].url', item?.media?.[0]],
  ]

  for (const [source, value] of candidates) {
    const url = normalizeImageValue(value)
    if (url) return { url, source }
  }
  return { url: '', source: 'none' }
}

function normalizeImageValue(image) {
  const raw =
    typeof image === 'string'
      ? image
      : image?.url ??
        image?.imageUrl ??
        image?.productImageUrl ??
        image?.original ??
        ''
  const value = String(raw ?? '').trim()
  const normalized = value.startsWith('//') ? `https:${value}` : value
  return /^https?:\/\//i.test(normalized) ? normalized : ''
}

function normalizeProductStatus(item) {
  if (typeof item.approved === 'boolean') {
    return item.approved ? 'Onaylı' : 'Onay bekliyor'
  }
  if (typeof item.archived === 'boolean' && item.archived) return 'Arşiv'
  if (item.status) return String(item.status)
  return 'Aktif'
}

function toIsoDate(value) {
  if (!value) return ''
  if (typeof value === 'number') return new Date(value).toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function findTrendyolAttribute(item, attributeName) {
  if (!Array.isArray(item?.attributes)) return ''
  const attribute = item.attributes.find(
    (entry) => entry?.attributeName === attributeName,
  )
  return attribute?.attributeValue ?? ''
}

function normalizeStatus(value) {
  if (ALL_TRENDYOL_ORDER_STATUSES.includes(value)) return value
  return 'Unknown'
}

function operationStatusFromMarketplace(status) {
  if (status === 'Delivered') return 'DELIVERED'
  if (status === 'Shipped' || status === 'AtCollectionPoint') {
    return 'HANDED_TO_CARGO'
  }
  if (['Cancelled', 'Returned', 'UnDelivered', 'UnSupplied'].includes(status)) {
    return 'ERROR'
  }
  return 'NEW'
}

function makeShipmentReference(order) {
  return String(order.packageId || order.orderNumber)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 30)
}

function resolveSingleShipmentAddress(order = {}) {
  const shipmentAddress =
    order.shipmentAddress &&
    typeof order.shipmentAddress === 'object' &&
    !Array.isArray(order.shipmentAddress)
      ? order.shipmentAddress
      : {}
  const structuredAddress = resolveSingleAddressValue({
    ...shipmentAddress,
    district: shipmentAddress.district || order.district,
    city: shipmentAddress.city || order.city,
  })
  return structuredAddress || normalizeAddressPart(order.address)
}

function buildAddressNormalizationDebug(order = {}) {
  const originalAddress = normalizeAddressPart(order.address)
  const normalizedAddress = resolveSingleShipmentAddress(order)
  return {
    originalAddress,
    normalizedAddress,
    duplicateDetected:
      Boolean(originalAddress && normalizedAddress) &&
      normalizeComparableAddress(originalAddress) !==
        normalizeComparableAddress(normalizedAddress),
  }
}

function validateSuratRequestMapping(order, payload) {
  const items = []
  const add = (field, status, message, value) =>
    items.push({ field, status, message, value })
  const packageId = String(order.packageId ?? order.shipmentPackageId ?? '').trim()
  const cargoTrackingNumber = String(order.cargoTrackingNumber ?? '').trim()
  const orderNumber = String(order.orderNumber ?? '').trim()

  add(
    'MarketplaceIntegrationCode',
    payload.MarketplaceIntegrationCode ? 'OK' : 'ERROR',
    payload.MarketplaceIntegrationCode
      ? 'Trendyol cargoTrackingNumber kullanılıyor.'
      : 'MarketplaceIntegrationCode boş.',
    payload.MarketplaceIntegrationCode,
  )
  add(
    'cargoTrackingNumber',
    cargoTrackingNumber ? 'OK' : 'ERROR',
    cargoTrackingNumber
      ? 'Trendyol kaynak kodu mevcut.'
      : 'Trendyol cargoTrackingNumber bulunamadı.',
    cargoTrackingNumber,
  )
  add(
    'OzelKargoTakipNo',
    payload.OzelKargoTakipNo === packageId ? 'SUSPICIOUS' : 'OK',
    payload.OzelKargoTakipNo === packageId
      ? 'OzelKargoTakipNo packageId ile aynı; cargoTrackingNumber kullanılmalı.'
      : 'cargoTrackingNumber ile eşleşiyor.',
    payload.OzelKargoTakipNo,
  )
  for (const field of ['WebSiparisKodu', 'SatisKodu']) {
    add(
      field,
      payload[field] === packageId && packageId !== orderNumber
        ? 'SUSPICIOUS'
        : payload[field] === orderNumber
          ? 'OK'
          : 'ERROR',
      `${field} orderNumber ile eşleşmelidir.`,
      payload[field],
    )
  }
  add(
    'KisiKurum',
    payload.KisiKurum ? 'OK' : 'ERROR',
    payload.KisiKurum ? 'Alıcı adı mevcut.' : 'Alıcı adı boş.',
    payload.KisiKurum,
  )
  add(
    'Il/Ilce',
    payload.Il && payload.Ilce ? 'OK' : 'ERROR',
    payload.Il && payload.Ilce ? 'İl ve ilçe mevcut.' : 'İl veya ilçe boş.',
    `${payload.Il || '-'} / ${payload.Ilce || '-'}`,
  )
  add(
    'BirimDesi/BirimKg',
    Number(payload.BirimDesi) > 0 && Number(payload.BirimKg) > 0
      ? 'OK'
      : 'WARNING',
    'Desi ve kg sıfırdan büyük olmalıdır.',
    `${payload.BirimDesi}/${payload.BirimKg}`,
  )
  const addressDebug = buildAddressNormalizationDebug(order)
  add(
    'AliciAdresi',
    addressDebug.duplicateDetected ? 'WARNING' : 'OK',
    addressDebug.duplicateDetected
      ? 'Kaynak adreste tekrar algılandı; normalize adres gönderildi.'
      : 'Adres tekilleştirildi.',
    addressDebug.normalizedAddress,
  )

  return {
    ok: !items.some((item) => item.status === 'ERROR'),
    items,
  }
}

function resolveSingleAddressValue(address = {}) {
  const fullAddress = normalizeAddressPart(address.fullAddress)
  if (fullAddress) return fullAddress

  const addressLine = normalizeAddressPart(
    address.address1 || address.address2 || address.addressLine,
  )
  const district = normalizeAddressPart(address.district)
  const city = normalizeAddressPart(address.city)
  return appendUniqueAddressParts([addressLine, district, city])
}

function appendUniqueAddressParts(parts) {
  const result = []
  let normalizedResult = ''
  for (const part of parts.map(normalizeAddressPart).filter(Boolean)) {
    const normalizedPart = normalizeComparableAddress(part)
    if (!normalizedPart || normalizedResult.includes(normalizedPart)) continue
    result.push(part)
    normalizedResult = normalizeComparableAddress(result.join(' '))
  }
  return result.join(' ').trim()
}

function normalizeAddressPart(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeComparableAddress(value) {
  return normalizeAddressPart(value)
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function splitName(fullName = '') {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || fullName || 'Alici',
    lastName: parts.slice(1).join(' ') || '-',
  }
}

function formatSoapDate(date) {
  return date.toISOString().slice(0, 10)
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function decodeXml(value = '') {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractTag(text = '', tagName) {
  const escapedTagName = escapeRegExp(tagName)
  const match = String(text).match(
    new RegExp(
      `<(?:[\\w.-]+:)?${escapedTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escapedTagName}>`,
      'i',
    ),
  )
  return match ? decodeXml(match[1]).trim() : ''
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractFirst(text = '', tagNames) {
  for (const tagName of tagNames) {
    const value = extractTag(text, tagName)
    if (value) return value
  }
  return ''
}

function extractSuratBarcodeValue(parsed, sourceText = '') {
  const objectValue = readSuratField(parsed, [
    'Barcode',
    'Barkod',
    'BarkodNo',
    'anyType',
  ])
  if (
    objectValue &&
    !objectValue.startsWith('{') &&
    !objectValue.startsWith('[') &&
    !objectValue.includes('<')
  ) {
    return objectValue
  }

  const barcodeContainer = extractFirst(sourceText, ['Barcode', 'Barkod'])
  const nestedValue = extractFirst(barcodeContainer, ['anyType', 'string'])
  if (nestedValue) return nestedValue

  const directValue = String(barcodeContainer)
    .replace(/<[^>]+>/g, '')
    .trim()
  return directValue || extractFirst(sourceText, ['BarkodNo', 'anyType'])
}

function normalizeSuratBarcodeValue(value = '') {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (!text.includes('^XA')) return text

  const code128 = text.match(
    /\^BC[^^\r\n]{0,80}\^FD(?:>[;:])?([^^\r\n]+?)\^FS/i,
  )?.[1]
  if (code128) return code128.trim()

  const numericField = Array.from(
    text.matchAll(/\^FD(?:>[;:])?(\d{8,})\^FS/gi),
  ).map((match) => match[1])
  return numericField[0] ?? ''
}

function normalizeSuratRawZpl(value = '') {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const start = text.indexOf('^XA')
  const end = text.lastIndexOf('^XZ')
  return start >= 0 && end >= start ? text.slice(start, end + 3) : ''
}

function extractMessage(text = '') {
  return (
    extractFirst(text, ['Mesaj', 'Message', 'Hata', 'HataMesaji', 'Aciklama']) ||
    ''
  )
}

function extractSuratMessage(value) {
  return (
    readSuratField(value, [
      'Mesaj',
      'Message',
      'Hata',
      'HataMesaji',
      'Aciklama',
      'ErrorMessage',
    ]) || extractMessage(typeof value === 'string' ? value : '')
  )
}

function extractTrackingNumber(text = '') {
  return extractFirst(text, [
    'KargoTakipNo',
    'TakipNo',
    'KargoTakipNumarasi',
    'Barkod',
  ])
}

function readSuratField(value, keys) {
  if (!value) return ''
  if (typeof value === 'string') {
    return extractFirst(value, keys)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readSuratField(item, keys)
      if (found) return found
    }
    return ''
  }
  if (typeof value !== 'object') return ''

  const normalizedKeys = keys.map((key) =>
    String(key).toLocaleLowerCase('tr-TR'),
  )

  for (const [key, item] of Object.entries(value)) {
    if (
      normalizedKeys.includes(String(key).toLocaleLowerCase('tr-TR')) &&
      item != null
    ) {
      if (typeof item === 'object') return JSON.stringify(item)
      return String(item).trim()
    }
  }

  for (const item of Object.values(value)) {
    const nested = readSuratField(item, keys)
    if (nested) return nested
  }

  return ''
}

function firstNonEmpty(...values) {
  return values
    .map((value) => String(value ?? '').trim())
    .find(Boolean) ?? ''
}

function firstObjectCandidate(...values) {
  return values.find(
    (value) => value && typeof value === 'object' && !Array.isArray(value),
  ) ?? {}
}

function readOptionalBoolean(value) {
  if (value === '' || value == null) return null
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLocaleLowerCase('tr-TR')
  if (['true', '1', 'evet', 'yes'].includes(normalized)) return true
  if (['false', '0', 'hayır', 'hayir', 'no'].includes(normalized)) return false
  return null
}

function redactSuratRawRequest(value) {
  if (typeof value === 'string') {
    return value
      .replace(/<Sifre>[\s\S]*?<\/Sifre>/gi, '<Sifre>***</Sifre>')
      .replace(/<WebPassword>[\s\S]*?<\/WebPassword>/gi, '<WebPassword>***</WebPassword>')
      .replace(/"Sifre"\s*:\s*"[^"]*"/gi, '"Sifre":"***"')
      .replace(/"sifre"\s*:\s*"[^"]*"/gi, '"sifre":"***"')
  }

  return redact(value)
}

function isSuratAuthError(message = '') {
  const normalized = message.toLocaleLowerCase('tr-TR')
  return (
    normalized.includes('kullanıcı adı') ||
    normalized.includes('kullanici adi') ||
    normalized.includes('şifre hatalı') ||
    normalized.includes('sifre hatali') ||
    normalized.includes('yetkisiz')
  )
}

function mapSuratCreateError(value = '') {
  const text = String(value ?? '')
  const normalized = text.toLocaleLowerCase('tr-TR')
  const cargoNotEligibleStatus =
    /hata\s*kodu\s*:?\s*1002/i.test(text) ||
    (normalized.includes('1002') &&
      normalized.includes('kargo uygun bir stat'))
  if (cargoNotEligibleStatus) {
    return {
      code: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
      source: 'Trendyol',
      userMessage:
        'Trendyol/Sürat bu paketin mevcut statüsünde gönderi oluşturulmasına izin vermiyor. Mapping doğru, fakat kargo uygun statüde değil.',
    }
  }
  const marketplaceRoutingError =
    normalized.includes('trendyol tarafından dönen hata') ||
    normalized.includes('entegrasyon koduna ait kargo bulunamamıştır') ||
    (normalized.includes('hata kodu') && normalized.includes('1001'))

  if (marketplaceRoutingError) {
    return {
      code: 'SURAT_MARKETPLACE_ROUTING_ERROR',
      source: normalized.includes('trendyol') ? 'Trendyol' : 'Sürat',
      userMessage:
        'Sürat create isteği Trendyol/pazaryeri akışına yönlendirildi ancak entegrasyon koduna ait kargo bulunamadı. packageId, Pazaryerimi, EntegrasyonFirmasi ve Sürat sözleşme/yetki eşleşmesini debug panelinden kontrol edin.',
    }
  }

  return { code: '', source: 'Sürat', userMessage: '' }
}

function mapSuratTrackingError(value = '') {
  const text = String(value ?? '')
  const normalized = text.toLocaleLowerCase('tr-TR')
  const missingIntegrationCargo =
    normalized.includes('entegrasyon koduna ait kargo bulunamamıştır') ||
    (normalized.includes('hata kodu') && normalized.includes('1001'))

  if (missingIntegrationCargo) {
    return {
      code: 'SURAT_TRACKING_REFERENCE_NOT_FOUND',
      source: normalized.includes('trendyol') ? 'Trendyol' : 'Sürat',
      userMessage:
        'Bu hata mevcut kargo sorgulama sırasında döndü. Sürat gönderisi henüz oluşmamış veya gönderilen WebSiparisKodu Sürat kaydıyla eşleşmiyor olabilir.',
    }
  }

  return { code: '', source: 'Sürat', userMessage: '' }
}

function isSuratBusinessError(text = '', message = '') {
  const normalized = `${text} ${message}`.toLocaleLowerCase('tr-TR')
  if (!normalized.trim()) return false
  if (normalized.includes('başarılı') || normalized.includes('basarili')) {
    return false
  }
  return (
    normalized.includes('hata') ||
    normalized.includes('geçersiz') ||
    normalized.includes('gecersiz') ||
    normalized.includes('bulunamadı') ||
    normalized.includes('bulunamadi')
  )
}

function findFirstValue(value, keys) {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValue(item, keys)
      if (found) return found
    }
    return ''
  }

  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key) && item != null) return String(item)
    const nested = findFirstValue(item, keys)
    if (nested) return nested
  }
  return ''
}

function safeJson(text) {
  if (!text || typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 500) }
  }
}

async function resolveBuildRevision() {
  if (process.env.CARGOFLOW_BUILD_REVISION) {
    return String(process.env.CARGOFLOW_BUILD_REVISION).trim()
  }
  try {
    const result = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: join(serverDirectory, '..'),
      windowsHide: true,
    })
    return String(result.stdout ?? '').trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function loadLocalEnvFile(path) {
  try {
    if (!existsSync(path)) return
    const content = readFileSync(path, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex <= 0) continue
      const key = trimmed.slice(0, separatorIndex).trim()
      const rawValue = trimmed.slice(separatorIndex + 1).trim()
      if (!key || process.env[key] != null) continue
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // .env opsiyonel; yoksa process.env değerleri kullanılmaya devam eder.
  }
}

function preview(value) {
  if (!value) return undefined
  return truncateForPreview(value)
}

function truncateForPreview(value, maxStringLength = 2000) {
  if (typeof value === 'string') return value.slice(0, maxStringLength)
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => truncateForPreview(item, maxStringLength))
  }
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      truncateForPreview(item, maxStringLength),
    ]),
  )
}

function redact(value) {
  const clone = JSON.parse(JSON.stringify(value ?? {}))
  redactWalk(clone)
  return clone
}

function redactWalk(value) {
  if (!value || typeof value !== 'object') return
  for (const key of Object.keys(value)) {
    if (/sifre|secret|password|apikey/i.test(key)) {
      value[key] = '***'
    } else {
      redactWalk(value[key])
    }
  }
}

function isTrustedLocalConfigRequest(request) {
  const remoteAddress = String(request.socket?.remoteAddress ?? '')
  const localRemote =
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  if (!localRemote) return false

  const clientHost = String(
    request.get('x-cargoflow-client-host') ?? '',
  ).trim()
  if (clientHost) return isLoopbackHostname(clientHost)

  const origin = String(request.get('origin') ?? '').trim()
  if (origin) return isLoopbackUrl(origin)

  const referer = String(request.get('referer') ?? '').trim()
  if (referer) return isLoopbackUrl(referer)

  return isLoopbackHostname(String(request.hostname ?? ''))
}

function isLoopbackUrl(value) {
  try {
    return isLoopbackHostname(new URL(value).hostname)
  } catch {
    return false
  }
}

function isLoopbackHostname(value) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
    String(value ?? '').toLocaleLowerCase('en-US'),
  )
}

async function readEncryptedIntegrationConfig() {
  try {
    const payload = JSON.parse(
      await readFile(localIntegrationConfigPath, 'utf8'),
    )
    const key = await getLocalConfigKey()
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(payload.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ])
    return JSON.parse(decrypted.toString('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeEncryptedIntegrationConfig(config) {
  await mkdir(localConfigDirectory, { recursive: true })
  const key = await getLocalConfigKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), 'utf8'),
    cipher.final(),
  ])
  await writeFile(
    localIntegrationConfigPath,
    JSON.stringify({
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function getLocalConfigKey() {
  await mkdir(localConfigDirectory, { recursive: true })
  try {
    const key = await readFile(localConfigKeyPath)
    if (key.length === 32) return key
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const key = randomBytes(32)
  try {
    await writeFile(localConfigKeyPath, key, {
      flag: 'wx',
      mode: 0o600,
    })
    return key
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return readFile(localConfigKeyPath)
  }
}

function hasIntegrationCredentials(config) {
  return Boolean(
    config?.trendyol?.sellerId ||
      config?.trendyol?.apiKey ||
      config?.trendyol?.apiSecret ||
      config?.surat?.kullaniciAdi ||
      config?.surat?.sifre ||
      config?.surat?.webPassword ||
      config?.surat?.sellerPaysKullaniciAdi ||
      config?.surat?.sellerPaysSifre ||
      config?.surat?.sellerPaysWebPassword ||
      config?.surat?.codKullaniciAdi ||
      config?.surat?.codSifre ||
      config?.surat?.codWebPassword ||
      config?.surat?.firmaId,
  )
}
