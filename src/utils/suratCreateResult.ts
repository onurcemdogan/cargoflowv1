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

// Zorunlu durum modeli sonucu:
//  - LABEL_READY_AWAITING_ACCEPTANCE: etiket oluşturuldu, yazdırılabilir, T.No+
//    barkod var; fiziksel Sürat kabulü henüz doğrulanmadı (business SUCCESS).
//  - VERIFIED: operasyonel kabul doğrulandı (verified/dispatch confirmed).
//  - CREATE_FAILED: kullanılabilir ZPL/kimlik yok veya açık business hata.
export type SuratCreateBusinessResultCode =
  | 'LABEL_READY_AWAITING_ACCEPTANCE'
  | 'VERIFIED'
  | 'CREATE_FAILED'

export interface SuratCreateBusinessResult {
  // İki AYRI başarı seviyesi: etiket oluşturma vs fiziksel taşıyıcı kabulü.
  labelCreationOk: boolean
  carrierAcceptanceConfirmed: boolean
  businessOk: boolean
  businessResult: SuratCreateBusinessResultCode
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
  // Canonical eşleme: trackingNumber = Sürat T.No; barcode = Sürat Code128 barkodu.
  // OzelKargoTakipNo (Trendyol entegrasyon referansı) canonical tracking DEĞİLDİR.
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
  // Etiket oluşturma başarısı: geçerli kimlik + yazdırılabilir + başarısız
  // lifecycle DEĞİL + BLOCKED değil. verifiedShipment ŞART DEĞİLDİR.
  const labelCreationOk = hasIdentifier && printable && !failedLifecycle && !blocked
  const carrierAcceptanceConfirmed = Boolean(
    s.verifiedShipment || s.dispatchRegistrationConfirmed,
  )
  const businessResult: SuratCreateBusinessResultCode = !labelCreationOk
    ? 'CREATE_FAILED'
    : carrierAcceptanceConfirmed
      ? 'VERIFIED'
      : 'LABEL_READY_AWAITING_ACCEPTANCE'
  return {
    labelCreationOk,
    carrierAcceptanceConfirmed,
    // businessOk = etiket oluşturma başarısı (kullanıcı açısından create başarılı).
    businessOk: labelCreationOk,
    businessResult,
    hasIdentifier,
    trackingNumber,
    barcode,
    failedLifecycle,
    blocked,
    printable,
  }
}
