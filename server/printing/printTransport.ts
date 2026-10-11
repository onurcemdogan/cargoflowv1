// BASKI TAŞIMA MODELİ — SAĞLAYICI-NÖTR.
//
// Taşıma HAZIRLANMIŞ kanonik işi alır ve fiziksel/kullanıcı mekanizmasına
// verir. Taşıma katmanında pazaryeri/taşıyıcı iş kuralı YASAKTIR:
//   · `if (marketplace === 'Trendyol')` YOK
//   · `if (carrier === ...)` YOK
//   · ürün verisi çözme, pazaryeri/taşıyıcı çağrısı, gönderi oluşturma YOK
//   · ödeyen (billing-party) değiştirme YOK
//
// ═══ "LOCAL AGENT" DEĞİL ═════════════════════════════════════════════════
//
// ÖLÇÜLDÜ: ham yol, API SÜRECİNİN ÇALIŞTIĞI MAKİNEDE `powershell.exe`
// çalıştırır. Ayrı bir kullanıcı-makinesi ajanı, eşleştirme protokolü ya da
// daemon YOKTUR. Bu yüzden taşıma dürüst adıyla `SERVER_WINDOWS_RAW`tır.
// Var olmayan bir ajanı varmış gibi adlandırmak, üretimde "bağlı" görünen
// ama hiçbir şey basmayan bir yüzey üretirdi.
export const PRINT_TRANSPORTS = [
  /** Tarayıcı belgesi + window.print (istemci). */
  'BROWSER_PRINT',
  /** Dosya indirme (istemci). */
  'DOWNLOAD',
  /** API sürecinin makinesindeki Windows yazıcı kuyruğu (sunucu). */
  'SERVER_WINDOWS_RAW',
] as const
export type PrintTransport = (typeof PRINT_TRANSPORTS)[number]

/** Neden kullanılamıyor — kapalı sözlük. */
export const TRANSPORT_UNAVAILABLE_REASONS = [
  'RUNTIME_NOT_WINDOWS',
  'PRINTER_NOT_SELECTED',
  'CLIENT_ONLY_TRANSPORT',
] as const
export type TransportUnavailableReason =
  (typeof TRANSPORT_UNAVAILABLE_REASONS)[number]

export interface TransportCapability {
  readonly transport: PrintTransport
  readonly supportsZpl: boolean
  readonly supportsRaster: boolean
  readonly supportsHtml: boolean
  readonly supportsMultiPage: boolean
  readonly available: boolean
  readonly reason: TransportUnavailableReason | null
}

/**
 * SUNUCU TARAFI YETENEK GERÇEĞİ.
 *
 * ═══ SAKLANMIŞ YAZICI ADI YETENEK DEĞİLDİR ═════════════════════════════
 *
 * `printerName !== ''` olması, sürecin o yazıcıya ham veri gönderebileceğini
 * KANITLAMAZ. Ham yol Windows yazdırma API'sine (winspool) bağlıdır; süreç
 * Linux konteynerde çalışıyorsa bu yol YOKTUR. "Bağlı" demek yalan olurdu.
 *
 * Yazıcı adı da GEREKLİDİR ama YETMEZ: ikisi de sağlanmalıdır.
 */
export function describeServerRawCapability(params: {
  platform: string
  printerName?: string | null
}): TransportCapability {
  const base = {
    transport: 'SERVER_WINDOWS_RAW' as const,
    supportsZpl: true,
    supportsRaster: false,
    supportsHtml: false,
    supportsMultiPage: true,
  }
  if (params.platform !== 'win32') {
    // ÇALIŞMA ZAMANI GERÇEĞİ: Windows değilse ham yol YOKTUR.
    return { ...base, available: false, reason: 'RUNTIME_NOT_WINDOWS' }
  }
  if (String(params.printerName ?? '').trim() === '') {
    return { ...base, available: false, reason: 'PRINTER_NOT_SELECTED' }
  }
  return { ...base, available: true, reason: null }
}

/**
 * İSTEMCİ TARAFI TAŞIMALAR.
 *
 * Tarayıcı baskısı ve indirme tarayıcıda yaşar; SUNUCU onları yürütemez.
 * Sunucu bağlamında `available: false` + `CLIENT_ONLY_TRANSPORT` döner —
 * bu bir arıza DEĞİL, sorumluluk sınırının dürüst ifadesidir.
 */
export function describeClientTransport(
  transport: 'BROWSER_PRINT' | 'DOWNLOAD',
  context: 'browser' | 'server',
): TransportCapability {
  const html = transport === 'BROWSER_PRINT'
  return {
    transport,
    supportsZpl: !html,
    supportsRaster: html,
    supportsHtml: html,
    supportsMultiPage: true,
    available: context === 'browser',
    reason: context === 'browser' ? null : 'CLIENT_ONLY_TRANSPORT',
  }
}
