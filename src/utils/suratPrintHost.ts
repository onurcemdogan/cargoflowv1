// BASKI HOST'U — SENKRON, HAFİF, AĞIR RENDERER'DAN AYRI.
//
// ═══ NEDEN AYRI MODÜL ════════════════════════════════════════════════════
// `prepareSuratPrintHostSynchronously()` kullanıcı jesti yığınında SENKRON
// çalışmak ZORUNDADIR (iframe/host oluşturma ilk await'ten sonra güvenilmez).
// Bu yüzden dinamik import ile ertelenemez.
//
// Ama o zorunluluk, ONUNLA AYNI DOSYADAKİ ağır render yığınını da (JsBarcode
// + qrcode-generator + ~62 kB etiket kodu) ilk yüke sokuyordu: Panoyu açan
// her kullanıcı hiç basmayacağı barkod kütüphanelerini indiriyordu.
//
// Çözüm: host YAŞAM DÖNGÜSÜ burada (küçük, senkron, statik import edilebilir);
// render yığını `browserLabelPrint` içinde kalır ve TALEP ÜZERİNE yüklenir.
//
// ═══ TEK IFRAME — DEĞİŞMEZ ═══════════════════════════════════════════════
// Kalıcı gizli iframe DEĞİŞMEZDİR ve `persistentPrintFrame` durumu BURADA
// tutulur. `browserLabelPrint` aynı tekil örneği bu modülden alır; iki ayrı
// iframe ASLA oluşmaz.

import { PRINT_HOST_UNAVAILABLE_MESSAGE } from './suratPrintFailureReasons'

let persistentPrintFrame: HTMLIFrameElement | null = null

export function suratPrintTrace(
  event: string,
  details: Record<string, unknown> = {},
): void {
  try {
    // Ayrıntılı baskı izleri YALNIZ non-production'da konsola yazılır. Bu
    // izler yalnız güvenli status/boolean/tanımlayıcı metadata taşır; ham
    // ZPL, müşteri adı/adres/telefon/e-posta veya secret HİÇBİR ortamda
    // loglanmaz.
    const isProduction =
      typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true
    if (isProduction) return
    console.info(`[surat-print] ${new Date().toISOString()} ${event}`, details)
  } catch {
    // console erişilemiyorsa akışı bozma
  }
}

export function writePrintDocument(
  targetDocument: Document,
  html: string,
): void {
  targetDocument.open()
  targetDocument.write(html)
  targetDocument.close()
}

export function ensurePersistentPrintFrame(
  executionId: string,
): HTMLIFrameElement {
  if (
    persistentPrintFrame &&
    persistentPrintFrame.isConnected !== false &&
    persistentPrintFrame.contentWindow
  ) {
    suratPrintTrace('IFRAME_REUSED', { executionId })
    return persistentPrintFrame
  }
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('data-surat-print-frame', 'persistent')
  iframe.style.position = 'fixed'
  iframe.style.left = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.visibility = 'hidden'
  document.body.appendChild(iframe)
  persistentPrintFrame = iframe
  suratPrintTrace('WINDOW_REFERENCE_CREATED', {
    executionId,
    mode: 'persistent-iframe',
  })
  return iframe
}

export interface SuratPrintHost {
  /** Host hazır mı? false ise create BAŞLATILMAMALIDIR. */
  ready: boolean
  /** Güvenli kullanıcı mesajı (PII/ZPL içermez). */
  reason?: string
  /** Baskı yapılmadan çıkılırsa host içeriğini temizler. */
  release: () => void
}

const PRINT_HOST_PLACEHOLDER =
  '<!doctype html><html lang="tr"><head><meta charset="utf-8">' +
  '<title>Etiketler hazırlanıyor…</title></head>' +
  '<body><p>Etiketler hazırlanıyor…</p></body></html>'

/**
 * PRINT HOST'U İLK CLICK STACK'İNDE HAZIRLA.
 *
 * Host'un gerçekten oluşturulabildiği, create mutasyonuna BAŞLAMADAN ÖNCE ve
 * ilk await'ten ÖNCE senkron olarak doğrulanır: host kurulamıyorsa Sürat
 * gönderisi OLUŞTURULMAZ, hiçbir statü/sayaç değişmez.
 *
 * Aynı iframe daha sonra `printCleanLabelDocument` tarafından YENİDEN
 * KULLANILIR; ikinci bir pencere/iframe AÇILMAZ.
 */
export function prepareSuratPrintHostSynchronously(): SuratPrintHost {
  const noop = () => {}
  if (typeof document === 'undefined') {
    suratPrintTrace('PRINT_HOST_UNAVAILABLE', { reason: 'no-document' })
    return { ready: false, reason: PRINT_HOST_UNAVAILABLE_MESSAGE, release: noop }
  }
  try {
    const iframe = ensurePersistentPrintFrame('host-prepare')
    const frameDocument = iframe.contentDocument
    if (!frameDocument) {
      suratPrintTrace('PRINT_HOST_UNAVAILABLE', { reason: 'no-content-document' })
      return { ready: false, reason: PRINT_HOST_UNAVAILABLE_MESSAGE, release: noop }
    }
    writePrintDocument(frameDocument, PRINT_HOST_PLACEHOLDER)
    suratPrintTrace('PRINT_HOST_READY', { mode: 'persistent-iframe' })
    return {
      ready: true,
      release: () => {
        try {
          const target = iframe.contentDocument
          if (target) writePrintDocument(target, PRINT_HOST_PLACEHOLDER)
          suratPrintTrace('PRINT_HOST_RELEASED', { printed: false })
        } catch {
          // temizlenemezse akışı bozma
        }
      },
    }
  } catch {
    suratPrintTrace('PRINT_HOST_UNAVAILABLE', { reason: 'iframe-create-failed' })
    return { ready: false, reason: PRINT_HOST_UNAVAILABLE_MESSAGE, release: noop }
  }
}

// Geriye dönük uyumluluk: popup rezervasyonu kaldırıldı. Bu fonksiyonlar
// artık pencere AÇMAZ ve KAPATMAZ; yalnız tanı logu üretir.
export function reserveCleanLabelPrintWindow(): Window | null {
  suratPrintTrace('WINDOW_RESERVED', {
    deprecated: true,
    mode: 'persistent-iframe',
    note: 'Popup rezervasyonu kaldırıldı; kalıcı iframe kullanılıyor.',
  })
  return null
}

export function cancelReservedCleanLabelPrintWindow(): void {
  suratPrintTrace('CANCEL_RESERVED_CALLED', {
    deprecated: true,
    action: 'none',
    note: 'Kapatılacak popup yok; kalıcı iframe DOM\'da bırakılır.',
  })
}
