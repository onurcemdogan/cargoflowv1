// GERÇEK ZPL RENDER MOTORU — CargoFlow sunucusunda, YEREL, ağ çağrısı YOK.
//
// MOTOR: zebrash (github.com/ingridhq/zebrash), Go ile yazılmış Zebra uyumlu
// ZPL yorumlayıcı; WebAssembly'ye derlenmiş hâli `zpl-renderer-js` paketiyle
// dağıtılır.
//   paket   : zpl-renderer-js@4.0.0   (package.json'da SABİT sürüm)
//   motor   : zebrash v1.38.0         (ZEBRASH_VERSION ile doğrulanır)
//   lisans  : MIT (her ikisi de)
//
// NEDEN ELLE YAZILMIŞ YORUMLAYICI DEĞİL: kendi yazdığımız kısmi ZPL
// yorumlayıcı Zebra font metriklerini, ^FT taban çizgisi davranışını ve
// barkod/matris ölçülerini YAKLAŞIK üretiyordu. Kullanıcıya "resmî Sürat
// etiketi" olarak yaklaşık bir çıktı sunulamaz. Bu servis gerçek bir Zebra
// uyumlu motoru kullanır.
//
// GİZLİLİK VE AĞ:
//   - Paketin VARSAYILAN girişi WASM'ı gömülü bayt olarak taşır; hiçbir
//     ağ isteği yapılmaz. `zpl-renderer-js/external` girişi (wasmUrl ile
//     uzaktan yükleme) KULLANILMAZ ve bu dosyada import EDİLMEZ.
//   - Müşteri ZPL'i CargoFlow sunucusundan DIŞARI ÇIKMAZ. Labelary veya
//     başka bir üçüncü taraf servise gönderilmez.
//   - Ham ZPL, adres, telefon ve barkod LOGLANMAZ.
import { createHash } from 'node:crypto'

/** Sabitlenen paket sürümü — çalışma anında da doğrulanır. */
export const ZPL_RENDERER_PACKAGE = 'zpl-renderer-js'
export const ZPL_RENDERER_PACKAGE_VERSION = '4.0.0'
/** Beklenen motor sürümü; farklıysa açık uyarı üretilir (sessiz sapma yok). */
export const EXPECTED_ZEBRASH_VERSION = 'v1.38.0'

/**
 * Zebra 203 dpi. zebrash çözünürlüğü dpmm (dot/mm) alır; 8 dpmm = 203 dpi.
 * ZPL nokta uzayı ile çıktı pikselleri BİREBİR eşlensin diye fiziksel ölçü
 * nokta sayısından türetilir: 799 dot / 8 dpmm = 99.875 mm → 799 × 799 px.
 */
export const DOTS_PER_MM = 8
export const SURAT_LABEL_DOTS = 799

export interface ZplRenderRequest {
  zpl: string
  /** Etiket genişliği (dot). Varsayılan Sürat 799. */
  widthDots?: number
  /** Etiket yüksekliği (dot). Varsayılan Sürat 799. */
  heightDots?: number
}

export interface ZplRenderResult {
  pngBase64: string
  widthPx: number
  heightPx: number
  dotsPerMm: number
  widthMm: number
  heightMm: number
  /** Render edilen PNG'nin SHA-256'sı — önizleme/baskı eşitliği bu alandan. */
  renderSha256: string
  /** Render edilen ZPL'nin SHA-256'sı (kaynak izlenebilirliği). */
  zplSha256: string
  engine: {
    package: string
    packageVersion: string
    zebrashVersion: string
  }
}

export class ZplRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZplRenderError'
  }
}

/** Kullanıcıya gösterilen GÜVENLİ mesaj (ham ZPL/PII içermez). */
export const ZPL_RENDER_FAILED_MESSAGE =
  'Resmî Sürat etiketi yerel ZPL motorunda oluşturulamadı. CargoFlow şablonuyla yazdırabilirsiniz.'

// WASM başlatma pahalıdır (~200 ms); süreç başına BİR kez yapılır.
let enginePromise: Promise<{
  zplToBase64Async: (
    zpl: string,
    widthMm?: number,
    heightMm?: number,
    dpmm?: number,
    options?: { grayscaleOutput?: boolean; enableInvertedLabels?: boolean },
  ) => Promise<string>
  zebrashVersion: string
}> | null = null

async function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      // VARSAYILAN giriş: WASM gömülüdür, ağ isteği YOKTUR.
      const engine = await import('zpl-renderer-js')
      const zebrashVersion = String(engine.ZEBRASH_VERSION ?? '')
      if (String(engine.ZPL_RENDERER_VERSION ?? '') !== ZPL_RENDERER_PACKAGE_VERSION) {
        throw new ZplRenderError(
          'ZPL render motoru sürümü beklenenden farklı; render yapılmadı.',
        )
      }
      return { zplToBase64Async: engine.zplToBase64Async, zebrashVersion }
    })().catch((error) => {
      // Başarısız init'i ÖNBELLEKLEME: sonraki istek yeniden denesin.
      enginePromise = null
      throw error
    })
  }
  return enginePromise
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * printZpl → PNG. Kaynak ZPL DEĞİŞTİRİLMEZ; motor ne diyorsa o basılır.
 * Deterministiktir: aynı ZPL + aynı ölçü HER ZAMAN aynı PNG'yi verir, bu
 * yüzden önizleme ile Chrome baskısı aynı renderSha256'yı taşır.
 */
export async function renderZplToPng(
  request: ZplRenderRequest,
): Promise<ZplRenderResult> {
  const zpl = String(request.zpl ?? '')
  if (!zpl.trim()) throw new ZplRenderError('Render edilecek ZPL boş.')
  const widthDots = Math.round(request.widthDots ?? SURAT_LABEL_DOTS)
  const heightDots = Math.round(request.heightDots ?? SURAT_LABEL_DOTS)
  if (
    !Number.isFinite(widthDots) ||
    !Number.isFinite(heightDots) ||
    widthDots <= 0 ||
    heightDots <= 0 ||
    widthDots > 4000 ||
    heightDots > 4000
  ) {
    throw new ZplRenderError('Geçersiz etiket ölçüsü.')
  }

  const engine = await loadEngine()
  const widthMm = widthDots / DOTS_PER_MM
  const heightMm = heightDots / DOTS_PER_MM
  const pngBase64 = await engine.zplToBase64Async(
    zpl,
    widthMm,
    heightMm,
    DOTS_PER_MM,
  )
  if (!pngBase64) throw new ZplRenderError('ZPL motoru boş çıktı döndürdü.')
  const buffer = Buffer.from(pngBase64, 'base64')
  // PNG IHDR: 16..19 genişlik, 20..23 yükseklik.
  if (buffer.length < 24 || buffer.readUInt32BE(1) !== 0x504e470d) {
    throw new ZplRenderError('ZPL motoru geçerli bir PNG üretmedi.')
  }
  const renderedWidth = buffer.readUInt32BE(16)
  const renderedHeight = buffer.readUInt32BE(20)
  if (renderedWidth !== widthDots || renderedHeight !== heightDots) {
    throw new ZplRenderError(
      `Render ölçüsü beklenenden farklı (${renderedWidth}x${renderedHeight}).`,
    )
  }

  return {
    pngBase64,
    widthPx: renderedWidth,
    heightPx: renderedHeight,
    dotsPerMm: DOTS_PER_MM,
    widthMm,
    heightMm,
    renderSha256: sha256(buffer),
    zplSha256: sha256(zpl),
    engine: {
      package: ZPL_RENDERER_PACKAGE,
      packageVersion: ZPL_RENDERER_PACKAGE_VERSION,
      zebrashVersion: engine.zebrashVersion,
    },
  }
}

/** Teşhis: motorun yüklenip yüklenemediği ve sürümü (PII içermez). */
export async function describeZplEngine(): Promise<{
  ok: boolean
  package: string
  packageVersion: string
  zebrashVersion?: string
  expectedZebrashVersion: string
  reason?: string
}> {
  try {
    const engine = await loadEngine()
    return {
      ok: true,
      package: ZPL_RENDERER_PACKAGE,
      packageVersion: ZPL_RENDERER_PACKAGE_VERSION,
      zebrashVersion: engine.zebrashVersion,
      expectedZebrashVersion: EXPECTED_ZEBRASH_VERSION,
    }
  } catch (error) {
    return {
      ok: false,
      package: ZPL_RENDERER_PACKAGE,
      packageVersion: ZPL_RENDERER_PACKAGE_VERSION,
      expectedZebrashVersion: EXPECTED_ZEBRASH_VERSION,
      reason: error instanceof Error ? error.message : 'Motor yüklenemedi.',
    }
  }
}
