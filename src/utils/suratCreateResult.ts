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
// MERKEZİ BAŞARI KRİTERİ (SDP fiziksel kabul ayrı uygulamada):
//   labelCreationOk = yazdırılabilir ZPL/etiket VAR + gerçek hard-failure
//   lifecycle DEĞİL + labelStatus BLOCKED değil.
// Sürat T.No / Code128 barkod parse edilemese BİLE geçerli ZPL varsa etiket
// oluşturma BAŞARILIDIR; tracking/barkod kimliği yalnız bilgi/diagnostic'tir,
// LABEL_READY geçişini engellemez. verifiedShipment/dispatchRegistrationConfirmed
// ŞART DEĞİLDİR.
//
// FAILED set YALNIZ gerçek create hatalarını (dispatch reddi / barkod üretilemedi
// / create belirsiz) içerir. "Takip/barkod alınamadı" (SURAT_TRACKING_MISSING,
// SURAT_CREATED_NO_TRACKING) ve "kabul bekleniyor" (LABEL_READY_AWAITING_ACCEPTANCE,
// LABEL_CREATED_NOT_REGISTERED) durumları — geçerli ZPL varsa — HATA DEĞİLDİR.
const FAILED_LIFECYCLE_STATUSES = new Set([
  'SURAT_BARCODE_FAILED',
  'SURAT_DISPATCH_REJECTED',
  'SURAT_CREATE_UNCERTAIN',
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
  // hasIdentifier YALNIZ diagnostic'tir; başarı kriteri DEĞİLDİR.
  const hasIdentifier = Boolean(trackingNumber || barcode)
  const failedLifecycle = FAILED_LIFECYCLE_STATUSES.has(
    String(s.lifecycleStatus ?? ''),
  )
  const blocked = String(s.labelStatus ?? '') === 'BLOCKED'
  // Yazdırılabilir ZPL/etiket sinyali: ham ZPL, zplReady/technicalZplReceived,
  // ya da sunucunun printEnabled/verifiedShipment kararı.
  const printable = Boolean(
    s.printEnabled ||
      s.verifiedShipment ||
      s.zplReady ||
      s.technicalZplReceived ||
      s.barcodeRaw,
  )
  // MERKEZİ KURAL: yazdırılabilir ZPL VAR + hard-failure lifecycle DEĞİL +
  // BLOCKED değil → etiket oluşturma başarılı. Kimlik (T.No/barkod) ŞART DEĞİL.
  const labelCreationOk = printable && !failedLifecycle && !blocked
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
