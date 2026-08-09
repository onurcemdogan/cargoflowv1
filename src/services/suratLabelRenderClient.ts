// RESMÎ SÜRAT ETİKETİ — İSTEMCİ RENDER SERVİSİ.
//
// Tek kaynak: POST /api/labels/render/surat. İstemci YALNIZ canonical sipariş
// kimliği gönderir; ham ZPL NE GÖNDERİR NE ALIR. Yanıt yalnız güvenli PNG
// artefaktı ve doğrulama alanlarını taşır.
//
// ÖNİZLEME VE BASKI AYNI ARTEFAKTI KULLANIR: sonuç sipariş bazında
// önbelleklenir, böylece önizlemede gösterilen PNG ile Chrome'a giden PNG
// BİREBİR aynı baytlardır (aynı renderSha256 / printZplSha256).
//
// AUTH: istek ortak CargoFlow authenticated API sözleşmesinden geçer
// (`authenticatedApiRequest`). Organization YALNIZ sunucuda session'dan
// çözülür; istemci hiçbir kimlik/kapsam alanı göndermez.
import {
  authenticatedApiRequest,
  AUTH_REQUIRED_MESSAGE,
  isAuthFailureStatus,
} from './authenticatedApiRequest'

export { AUTH_REQUIRED_MESSAGE }

export interface SuratRenderArtifact {
  mimeType: string
  imageBase64: string
  widthPx: number
  heightPx: number
  widthMm: number
  heightMm: number
  printZplSha256: string
  renderSha256: string
  renderEngine: string
  renderEngineVersion: string
  zebrashVersion: string
  /** success | overflow | unsupported_template | unavailable */
  augmentationStatus: string
  /** Ürün satırı eklenemediyse GÜVENLİ uyarı (PII/ZPL içermez). */
  warning?: string
  /**
   * CANONICAL SÖZLEŞME — sıralı fiziksel sayfalar (4A).
   * Taşıyıcı HER ZAMAN ilk; ürün detayları izler. Sıra SUNUCUDA
   * doğrulanmıştır ve istemci tarafından DEĞİŞTİRİLMEZ.
   *
   * Eski yanıt biçiminde alan yoktur; o durumda tek taşıyıcı sayfadan
   * oluşan bir liste türetilir (geriye uyumluluk).
   */
  pages: SuratRenderArtifactPage[]
  /** Render edilemeyen sayfalar — sessizce düşürülmez. */
  missingPages: SuratRenderMissingPage[]
  productDetailStatus: 'none' | 'ready' | 'failed'
  printArtifactStatus: 'ready' | 'fallback_carrier'
}

export interface SuratRenderArtifactPage {
  kind: 'carrier' | 'product_detail'
  page: number
  totalPages: number
  imageBase64: string
  mimeType: string
}

export interface SuratRenderMissingPage {
  kind: 'carrier' | 'product_detail'
  page: number
  totalPages: number
  reason: string
}

/**
 * Sunucunun sıralı sayfalarını okur.
 *
 * ESKİ YANIT BİÇİMİ (pages[] yok): tek taşıyıcı sayfadan oluşan liste
 * türetilir — mevcut tek sayfalık baskı davranışı BİREBİR korunur.
 * Sıra veya eksik sayfa BURADA TAMAMLANMAZ; istemci sunucunun verdiğini
 * olduğu gibi kullanır.
 */
function readRenderPages(
  payload: Record<string, unknown>,
): SuratRenderArtifactPage[] {
  const mimeType = String(payload.mimeType ?? 'image/png')
  const raw = Array.isArray(payload.pages) ? payload.pages : []
  const pages = (raw as Array<Record<string, unknown>>)
    .map((entry) => ({
      kind: entry?.kind === 'product_detail' ? 'product_detail' : 'carrier',
      page: Number(entry?.page ?? 0),
      totalPages: Number(entry?.totalPages ?? 0),
      imageBase64: typeof entry?.imageBase64 === 'string' ? entry.imageBase64 : '',
      mimeType: String(entry?.mimeType ?? mimeType),
    }))
    .filter((entry) => entry.imageBase64.length > 0) as SuratRenderArtifactPage[]
  if (pages.length > 0) return pages
  const carrier = String(payload.imageBase64 ?? '')
  if (!carrier) return []
  return [
    { kind: 'carrier', page: 1, totalPages: 1, imageBase64: carrier, mimeType },
  ]
}

function readMissingPages(
  payload: Record<string, unknown>,
): SuratRenderMissingPage[] {
  const raw = Array.isArray(payload.missingPages) ? payload.missingPages : []
  return (raw as Array<Record<string, unknown>>).map((entry) => ({
    kind: entry?.kind === 'carrier' ? 'carrier' : 'product_detail',
    page: Number(entry?.page ?? 0),
    totalPages: Number(entry?.totalPages ?? 0),
    reason: String(entry?.reason ?? 'render_failed'),
  }))
}

/** Motor hatasında gösterilecek GÜVENLİ mesaj — yaklaşık SVG'ye DÜŞÜLMEZ. */
export const SURAT_RENDER_UNAVAILABLE_MESSAGE =
  'Resmî Sürat etiketi yerel ZPL motorunda oluşturulamadı. CargoFlow şablonuyla yazdırabilirsiniz.'

export const SURAT_RENDER_ENDPOINT = '/api/labels/render/surat'

// Sipariş bazında artefakt önbelleği: önizleme + baskı + tekrar baskı AYNI
// PNG'yi kullanır. Anahtar sipariş kimliğidir; ham ZPL SAKLANMAZ.
//
// GÜVENLİ ÖNBELLEK SÖZLEŞMESİ:
//  - YALNIZ başarılı ve geçerli artefakt yazılır; hata veya boş yanıt ASLA
//    önbelleğe girmez (başarısız bir giriş sonraki baskıda "etiket yok"
//    sonucunu doğuramaz).
//  - Giriş, kendi canonical sipariş kimliğini ve render SHA'sını taşır;
//    okurken ikisi de doğrulanır. Eşleşmeyen giriş ATILIR ve yeniden render
//    edilir — başka bir siparişin PNG'si ASLA kullanılmaz.
interface CachedArtifact {
  orderId: string
  renderSha256: string
  artifact: SuratRenderArtifact
}
const artifactCache = new Map<string, CachedArtifact>()

/** Test/oturum temizliği. */
export function clearSuratRenderCache(): void {
  artifactCache.clear()
}

/** Anahtar + giriş içeriği tutarlıysa artefaktı verir; değilse girişi ATAR. */
function readCachedArtifact(key: string): SuratRenderArtifact | undefined {
  const entry = artifactCache.get(key)
  if (!entry) return undefined
  const valid =
    entry.orderId === key &&
    Boolean(entry.renderSha256) &&
    entry.renderSha256 === entry.artifact.renderSha256 &&
    Boolean(entry.artifact.imageBase64)
  if (!valid) {
    artifactCache.delete(key)
    return undefined
  }
  return entry.artifact
}

export function peekSuratRenderArtifact(
  orderId: string,
): SuratRenderArtifact | undefined {
  return readCachedArtifact(String(orderId))
}

export class SuratRenderRequestError extends Error {
  code: string
  status: number
  /**
   * Sunucunun teknik mesajı — YALNIZ güvenli tanı kaydı için. Kullanıcıya
   * `message` gösterilir. Ham ZPL, imageBase64 veya PII İÇERMEZ (uç bunları
   * zaten döndürmez).
   */
  debugMessage?: string
  constructor(
    message: string,
    code: string,
    status: number,
    debugMessage?: string,
  ) {
    super(message)
    this.name = 'SuratRenderRequestError'
    this.code = code
    this.status = status
    if (debugMessage) this.debugMessage = debugMessage
  }
}

function isSafeArtifact(value: unknown): value is SuratRenderArtifact {
  const dto = value as Record<string, unknown> | null
  return Boolean(
    dto &&
      typeof dto.imageBase64 === 'string' &&
      dto.imageBase64.length > 0 &&
      typeof dto.printZplSha256 === 'string' &&
      typeof dto.renderSha256 === 'string',
  )
}

/**
 * Sipariş için resmî Sürat PNG artefaktını getirir.
 * `force` verilmedikçe önbellekten döner — böylece önizleme ile baskı AYNI
 * baytları paylaşır ve ikinci bir render çalıştırılmaz.
 */
export async function fetchSuratRenderArtifact(
  orderId: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<SuratRenderArtifact> {
  const key = String(orderId)
  if (!key) {
    throw new SuratRenderRequestError(
      SURAT_RENDER_UNAVAILABLE_MESSAGE,
      'missing_order_id',
      0,
    )
  }
  if (!options.force) {
    const cached = readCachedArtifact(key)
    if (cached) return cached
  }
  // Bu sipariş için elde kalan (varsa bozuk) giriş, yeni render sonucuyla
  // değiştirilir; hata durumunda ise HİÇ giriş bırakılmaz.
  artifactCache.delete(key)
  let response: Response
  try {
    // ORTAK AUTHENTICATED API SÖZLEŞMESİ (çıplak fetch YOK): oturum
    // `cargoflow_session` cookie'siyle aynı origin üzerinden taşınır.
    // Gövde YALNIZ canonical kimliktir; organizationId, marketplaceAccountId,
    // ham ZPL, müşteri verisi veya takip numarası GÖNDERİLMEZ.
    response = await authenticatedApiRequest(SURAT_RENDER_ENDPOINT, {
      method: 'POST',
      json: { orderId: key },
      signal: options.signal,
    })
  } catch {
    throw new SuratRenderRequestError(
      SURAT_RENDER_UNAVAILABLE_MESSAGE,
      'network_error',
      0,
    )
  }
  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  if (!response.ok || !payload?.ok) {
    const serverMessage =
      typeof payload?.message === 'string' && payload.message
        ? payload.message
        : ''
    // OTURUM REDDİ: kullanıcıya teknik metin değil, GÜVENLİ yeniden-oturum
    // mesajı gösterilir. Sunucunun gerçek mesajı tanı için `debugMessage`
    // alanında taşınır (PII, ham ZPL veya imageBase64 İÇERMEZ).
    if (isAuthFailureStatus(response.status)) {
      throw new SuratRenderRequestError(
        AUTH_REQUIRED_MESSAGE,
        'auth_required',
        response.status,
        serverMessage,
      )
    }
    throw new SuratRenderRequestError(
      serverMessage || SURAT_RENDER_UNAVAILABLE_MESSAGE,
      typeof payload?.code === 'string' ? payload.code : 'render_failed',
      response.status,
    )
  }
  if (!isSafeArtifact(payload)) {
    throw new SuratRenderRequestError(
      SURAT_RENDER_UNAVAILABLE_MESSAGE,
      'invalid_artifact',
      response.status,
    )
  }
  const artifact: SuratRenderArtifact = {
    mimeType: String(payload.mimeType ?? 'image/png'),
    imageBase64: String(payload.imageBase64),
    widthPx: Number(payload.widthPx) || 0,
    heightPx: Number(payload.heightPx) || 0,
    widthMm: Number(payload.widthMm) || 0,
    heightMm: Number(payload.heightMm) || 0,
    printZplSha256: String(payload.printZplSha256),
    renderSha256: String(payload.renderSha256),
    renderEngine: String(payload.renderEngine ?? ''),
    renderEngineVersion: String(payload.renderEngineVersion ?? ''),
    zebrashVersion: String(payload.zebrashVersion ?? ''),
    augmentationStatus: String(payload.augmentationStatus ?? 'unavailable'),
    ...(typeof payload.warning === 'string' && payload.warning
      ? { warning: payload.warning }
      : {}),
    // SIRA SUNUCUDAN GELİR: istemci yeniden sıralamaz, tamamlamaz.
    pages: readRenderPages(payload),
    missingPages: readMissingPages(payload),
    productDetailStatus:
      payload.productDetailStatus === 'ready' ||
      payload.productDetailStatus === 'failed'
        ? payload.productDetailStatus
        : 'none',
    printArtifactStatus:
      payload.printArtifactStatus === 'fallback_carrier'
        ? 'fallback_carrier'
        : 'ready',
  }
  artifactCache.set(key, {
    orderId: key,
    renderSha256: artifact.renderSha256,
    artifact,
  })
  return artifact
}
