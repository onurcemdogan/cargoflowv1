// Sürat "Ortak Barkod Oluştur" iş sonucu (business result) değerlendirmesi.
//
// Kök sorun: HTTP 200 (transport başarısı) TEK BAŞINA iş başarısı DEĞİLDİR.
// Debug merkezi bugüne kadar transport (HTTP ok + labelStatus!=BLOCKED) baz alıp
// "SUCCESS" gösteriyordu; oysa aynı çağrının iş sonucu (normalize shipment'ın
// lifecycleStatus'u) başarısız/belirsiz olabiliyordu. Bu yüzden Debug "SUCCESS",
// UI "geçerli takip/barkod alınamadı" ve label-ready "doğrulanmış gönderi yok"
// ÇELİŞKİLİ görünüyordu. Bu helper, üç yüzeyin AYNI iş sonucunu göstermesi için
// tek karar noktasıdır.
//
// İş BAŞARISI kriteri: geçerli tracking/barkod tanımlayıcısı VAR + shipment
// yazdırılabilir/doğrulanmış + business-failure lifecycle DEĞİL + labelStatus
// BLOCKED değil.

const FAILED_LIFECYCLE_STATUSES = new Set([
  'SURAT_BARCODE_FAILED',
  'SURAT_DISPATCH_REJECTED',
  'SURAT_CREATE_UNCERTAIN',
  'LABEL_CREATED_NOT_REGISTERED',
  'SURAT_TRACKING_MISSING',
  'SURAT_CREATED_NO_TRACKING',
])

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

export interface SuratCreateBusinessResult {
  businessOk: boolean
  hasIdentifier: boolean
  trackingNumber: string
  barcode: string
  failedLifecycle: boolean
  blocked: boolean
  printable: boolean
}

export function resolveSuratCreateBusinessResult(
  shipment: unknown,
): SuratCreateBusinessResult {
  const s = (shipment && typeof shipment === 'object'
    ? shipment
    : {}) as Record<string, unknown>
  const trackingNumber = firstNonEmpty(s.trackingNumber, s.tNo, s.kargoTakipNo)
  const barcode = firstNonEmpty(
    s.barcode,
    s.barkodNo,
    s.barcodeValue,
    s.finalSuratBarcode,
  )
  const hasIdentifier = Boolean(trackingNumber || barcode)
  const failedLifecycle = FAILED_LIFECYCLE_STATUSES.has(
    String(s.lifecycleStatus ?? ''),
  )
  const blocked = String(s.labelStatus ?? '') === 'BLOCKED'
  const printable = Boolean(s.printEnabled || s.verifiedShipment)
  const businessOk = hasIdentifier && printable && !failedLifecycle && !blocked
  return {
    businessOk,
    hasIdentifier,
    trackingNumber,
    barcode,
    failedLifecycle,
    blocked,
    printable,
  }
}
