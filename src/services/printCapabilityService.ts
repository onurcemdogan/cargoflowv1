// BASKI YETENEĞİ — İSTEMCİ TARAFI GERÇEK KAYNAĞI.
//
// ═══ ÖLÇÜLEN KUSUR ═══════════════════════════════════════════════════════
//
// Sunucu `GET /api/printing/capabilities` ile DÜRÜST çalışma zamanı
// yeteneğini yayınlıyordu, ama arayüz onu TÜKETMİYORDU. Pano yazıcı
// sağlığını hâlâ şuradan türetiyordu:
//
//   printerSettings.mode !== 'download' && printerSettings.printerName
//
// Yani Linux bir API çalışma zamanında, kayıtlı bir yazıcı adı yüzünden
// "bağlı / Windows RAW baskı" GÖSTERİLEBİLİYORDU — oysa SERVER_WINDOWS_RAW
// GERÇEKTEN kullanılamaz durumdaydı.
//
// Kabul edilmiş kural: SAKLANMIŞ YAZICI ADI TEK BAŞINA "bağlı" ANLAMINA
// GELMEZ. Bu modül o kuralı arayüze taşır.
//
// ═══ SUNUCU SON SÖZÜ SÖYLER ══════════════════════════════════════════════
//
// Buradaki kapı bir KOLAYLIKTIR: kullanıcıya gönderemeyeceği bir işi vaat
// etmemek için. GERÇEK sınır sunucudadır (`/api/printing/jobs` yetenek yoksa
// 409 döner) ve istemci durumu kurcalansa bile o sınır DEĞİŞMEZ.
// UZANTILAR ZORUNLU: bu modül `dashboardSummary.ts` üzerinden ÜRETİM node
// çözücüsüne girer. Uzantısız `.ts` importu Vite'ta çalışır ama node'da
// ERR_MODULE_NOT_FOUND verir (depo bunu AL-23 ile kilitler).
import {
  authenticatedApiRequest,
  AUTH_REQUIRED_MESSAGE,
} from './authenticatedApiRequest.ts'
import type { PrinterSettings } from '../types/cargoflow.ts'

export { AUTH_REQUIRED_MESSAGE }

/** Sunucunun bildirdiği taşıma anahtarları. */
export const SERVER_RAW_TRANSPORT = 'SERVER_WINDOWS_RAW'

export interface PrintTransportCapability {
  transport: string
  supportsZpl: boolean
  supportsRaster: boolean
  supportsHtml: boolean
  supportsMultiPage: boolean
  available: boolean
  reason: string | null
}

export interface PrintCapabilitySnapshot {
  /** Sunucu yanıtı OKUNABİLDİ mi. Okunamadıysa "bağlı" DENMEZ. */
  loaded: boolean
  platform: string | null
  capabilities: PrintTransportCapability[]
}

export const UNKNOWN_CAPABILITY: PrintCapabilitySnapshot = {
  loaded: false,
  platform: null,
  capabilities: [],
}

/**
 * Yetenekleri sunucudan okur.
 *
 * Yazıcı adı SORGUYA konur çünkü "yazıcı seçilmedi" durumu da yetenek
 * gerçeğinin parçasıdır. Sır ya da kimlik TAŞINMAZ.
 */
export async function fetchPrintCapabilities(
  printerName: string,
): Promise<PrintCapabilitySnapshot> {
  const query = printerName
    ? `?printerName=${encodeURIComponent(printerName)}`
    : ''
  try {
    const response = await authenticatedApiRequest(
      `/api/printing/capabilities${query}`,
      { method: 'GET' },
    )
    if (!response.ok) return UNKNOWN_CAPABILITY
    const data = (await response.json()) as {
      ok?: boolean
      runtime?: { platform?: string }
      capabilities?: PrintTransportCapability[]
    }
    if (!data?.ok || !Array.isArray(data.capabilities)) return UNKNOWN_CAPABILITY
    return {
      loaded: true,
      platform: data.runtime?.platform ?? null,
      capabilities: data.capabilities,
    }
  } catch {
    // OKUNAMADI: "bilmiyorum" ASLA "bağlı" sayılmaz.
    return UNKNOWN_CAPABILITY
  }
}

/** Sunucu ham baskı yeteneği (yoksa `null`). */
export function findRawCapability(
  snapshot: PrintCapabilitySnapshot | undefined,
): PrintTransportCapability | null {
  if (!snapshot?.loaded) return null
  return (
    snapshot.capabilities.find(
      (capability) => capability.transport === SERVER_RAW_TRANSPORT,
    ) ?? null
  )
}

/** Kapalı sözlük sebebi → operatöre gösterilebilir KISA metin. */
export function describeCapabilityReason(reason: string | null): string {
  switch (reason) {
    case 'RUNTIME_NOT_WINDOWS':
      return 'Sunucu çalışma zamanı Windows değil; RAW yazıcı baskısı kullanılamıyor.'
    case 'PRINTER_NOT_SELECTED':
      return 'Yazıcı seçilmedi.'
    case 'CLIENT_ONLY_TRANSPORT':
      return 'Bu hedef yalnız tarayıcıda çalışır.'
    default:
      return 'Yazıcı durumu doğrulanmadı.'
  }
}

/**
 * MEVCUT pano sözlüğü KULLANILIR (`ProviderHealthStatus`). Yeni bir durum
 * adı UYDURMAK, arayüzün zaten bildiği kelimelerin yanına ikinci bir sözlük
 * koymak olurdu.
 */
export type PrinterHealthStatus = 'connected' | 'needs_check' | 'not_configured'

export interface PrinterHealthView {
  status: PrinterHealthStatus
  name: string
  detail: string
}

/**
 * PANO YAZICI SAĞLIĞI — TEK KARAR.
 *
 * `local-agent` (SERVER_WINDOWS_RAW) için "bağlı" demenin TEK koşulu
 * sunucunun `available: true` bildirmesidir. Yazıcı adının dolu olması,
 * modun seçilmiş olması ya da yanıtın okunamaması "bağlı" ÜRETMEZ.
 *
 * Tarayıcı baskısı ve indirme DEĞİŞMEDİ: onlar sunucu çalışma zamanına
 * bağlı değildir ve mevcut davranışlarını korur.
 */
export function resolvePrinterHealth(
  printerSettings: PrinterSettings,
  rawCapability: PrintTransportCapability | null,
): PrinterHealthView {
  const name = printerSettings.printerName || 'Zebra Yazıcı'

  if (printerSettings.mode === 'local-agent') {
    if (rawCapability?.available) {
      return { status: 'connected', name, detail: 'Windows RAW baskı' }
    }
    // SAKLANMIŞ AD "BAĞLI" YAPMAZ.
    const reason = rawCapability
      ? describeCapabilityReason(rawCapability.reason)
      : 'Yazıcı durumu doğrulanmadı.'
    return {
      // Yazıcı seçilmemişse "yapılandırılmadı"; çalışma zamanı desteklemiyorsa
      // operatörün BAKMASI gereken bir durum vardır.
      status:
        !rawCapability || rawCapability.reason === 'PRINTER_NOT_SELECTED'
          ? 'not_configured'
          : 'needs_check',
      name,
      detail: `Windows RAW baskı kullanılamıyor — ${reason}`,
    }
  }

  if (printerSettings.mode === 'browser-print') {
    return {
      status: printerSettings.printerName ? 'connected' : 'not_configured',
      name,
      detail: 'Chrome temiz etiket önizlemesi · 100×150 mm',
    }
  }

  return { status: 'not_configured', name, detail: 'ZPL indirme modu' }
}

/**
 * BASKI AKSİYONU KAPISI.
 *
 * Yalnız `local-agent` hedefini kapatır: tarayıcı baskısı ve indirme
 * sunucu çalışma zamanından BAĞIMSIZDIR ve ETKİLENMEZ.
 */
export interface RawPrintActionGate {
  blocked: boolean
  reason: string | null
}

export function resolveRawPrintActionGate(
  printerSettings: PrinterSettings,
  rawCapability: PrintTransportCapability | null,
): RawPrintActionGate {
  if (printerSettings.mode !== 'local-agent') {
    return { blocked: false, reason: null }
  }
  if (rawCapability?.available) return { blocked: false, reason: null }
  return {
    blocked: true,
    reason: rawCapability
      ? describeCapabilityReason(rawCapability.reason)
      : 'Yazıcı durumu doğrulanmadı.',
  }
}
