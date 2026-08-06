// RESMÎ SÜRAT ETİKETİ — İSTEMCİ RENDER SERVİSİ.
//
// Tek kaynak: POST /api/labels/render/surat. İstemci YALNIZ canonical sipariş
// kimliği gönderir; ham ZPL NE GÖNDERİR NE ALIR. Yanıt yalnız güvenli PNG
// artefaktı ve doğrulama alanlarını taşır.
//
// ÖNİZLEME VE BASKI AYNI ARTEFAKTI KULLANIR: sonuç sipariş bazında
// önbelleklenir, böylece önizlemede gösterilen PNG ile Chrome'a giden PNG
// BİREBİR aynı baytlardır (aynı renderSha256 / printZplSha256).

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
}

/** Motor hatasında gösterilecek GÜVENLİ mesaj — yaklaşık SVG'ye DÜŞÜLMEZ. */
export const SURAT_RENDER_UNAVAILABLE_MESSAGE =
  'Resmî Sürat etiketi yerel ZPL motorunda oluşturulamadı. CargoFlow şablonuyla yazdırabilirsiniz.'

export const SURAT_RENDER_ENDPOINT = '/api/labels/render/surat'

// Sipariş bazında artefakt önbelleği: önizleme + baskı + tekrar baskı AYNI
// PNG'yi kullanır. Anahtar sipariş kimliğidir; ham ZPL SAKLANMAZ.
const artifactCache = new Map<string, SuratRenderArtifact>()

/** Test/oturum temizliği. */
export function clearSuratRenderCache(): void {
  artifactCache.clear()
}

export function peekSuratRenderArtifact(
  orderId: string,
): SuratRenderArtifact | undefined {
  return artifactCache.get(String(orderId))
}

export class SuratRenderRequestError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'SuratRenderRequestError'
    this.code = code
    this.status = status
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
  if (!options.force) {
    const cached = artifactCache.get(key)
    if (cached) return cached
  }
  let response: Response
  try {
    response = await fetch(SURAT_RENDER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      // YALNIZ canonical kimlik. Ham ZPL alanı GÖNDERİLMEZ.
      body: JSON.stringify({ orderId: key }),
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
    const message =
      typeof payload?.message === 'string' && payload.message
        ? payload.message
        : SURAT_RENDER_UNAVAILABLE_MESSAGE
    throw new SuratRenderRequestError(
      message,
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
  }
  artifactCache.set(key, artifact)
  return artifact
}
