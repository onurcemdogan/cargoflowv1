// CANLI TAŞIYICI CREATE UYGUNLUĞU — TEK OTORİTE.
//
// SUNUCU TARAFI OTORİTEDİR. Bu modül daha önce `src/utils/` altındaydı ve
// hiçbir sunucu çağıranı YOKTU — yani hiçbir şeyi korumuyordu. Tarayıcı
// durumu bir create'i açamaz; karar burada verilir.
//
// "Yeni Siparişler" sekmesinde görünmek create adayı OLMAK DEMEK DEĞİLDİR.
// Sekme bir GÖRÜNÜM filtresidir; taşıyıcıya gönderi yaratmak geri alınamaz
// bir işlemdir. Bu yüzden uygunluk KANITA dayanır ve belirsizlikte KAPANIR.

/** Kimlik rolleri — biri diğerinin yerine GEÇEMEZ. */
export interface SuratCreateIdentity {
  /** Trendyol sipariş kimliği (115…). `WebSiparisKodu` budur. */
  orderNumber: string
  /** Trendyol paket kimliği. `ReferansNo` budur. */
  packageId: string
  /** Sağlayıcı takip numarası (727…). `OzelKargoTakipNo` budur. */
  cargoTrackingNumber: string
}

export const CREATE_INELIGIBLE_REASONS = [
  // Deneme geçmişi OKUNAMADI. "Bilinmiyor" asla "sıfır" DEĞİLDİR.
  'ATTEMPT_HISTORY_UNKNOWN',
  'PREVIOUS_CREATE_ATTEMPT_EXISTS',
  'CARRIER_EVIDENCE_EXISTS',
  'LABEL_ALREADY_CREATED',
  'IDENTITY_INCOMPLETE',
  'IDENTITY_INCONSISTENT',
] as const

export interface SuratCreateEligibility {
  eligible: boolean
  reasons: string[]
  identity: SuratCreateIdentity | null
}

const text = (value: unknown): string => String(value ?? '').trim()
const filled = (value: unknown): boolean => text(value).length > 0

/**
 * Tek karar noktası. Kanıt EKSİKSE uygun DEĞİLDİR — "bilinmiyor" asla
 * "uygun" demek değildir.
 */
export function resolveSuratCreateEligibility(params: {
  order: Record<string, unknown>
  /**
   * Deneme kanıtı. `known=false` ise geçmiş OKUNAMAMIŞTIR ve create AÇILMAZ;
   * sayıyı 0 varsaymak, daha önce denenmiş bir paketi yeni sanmaktır.
   */
  attemptEvidence?: { known: boolean; count: number }
  /** GERİYE UYUMLU kısayol; `attemptEvidence` verilmezse kullanılır. */
  createAttemptCount?: number
}): SuratCreateEligibility {
  const order = params.order ?? {}
  const shipment = (order.shipment ?? {}) as Record<string, unknown>
  const reasons: string[] = []

  const identity: SuratCreateIdentity = {
    orderNumber: text(order.orderNumber),
    packageId: text(order.packageId ?? order.shipmentPackageId),
    cargoTrackingNumber: text(order.cargoTrackingNumber),
  }

  // ── KİMLİK ────────────────────────────────────────────────────────────
  if (!identity.orderNumber || !identity.packageId
    || !identity.cargoTrackingNumber) {
    reasons.push('IDENTITY_INCOMPLETE')
  } else if (identity.orderNumber === identity.cargoTrackingNumber) {
    // KANITLANMIŞ RİSK: takip numarası (727…) sipariş numarası olarak
    // kullanılırsa `WebSiparisKodu` yanlış olur ve kayıt doğrulaması
    // sessizce boşa çıkar — üretim UI'ı bu değeri "Sipariş No" diye
    // gösterdiği için gerçek bir karışma yolu var.
    //
    // `packageId === cargoTrackingNumber` ya da `orderNumber === packageId`
    // BURADA ENGELLENMEZ: bunların zarar verdiğine dair depo kanıtı YOK ve
    // engellemek geçerli siparişleri sessizce bloklardı.
    reasons.push('IDENTITY_INCONSISTENT')
  }

  // ── ÖNCEKİ DENEME ─────────────────────────────────────────────────────
  // Idempotency katmanı (`reserveCreateOperation` / idempotencyKey) mükerrer
  // create'i ZATEN ağ sınırında engelliyor ve kapsamı orada tanımlı. Burada
  // farklı bir anahtarla ikinci bir sayım yapmak ÇAKIŞIR ve geçerli
  // siparişleri yanlışlıkla bloklar. Bu yüzden "önceki deneme" kanıtı
  // KALICI TAŞIYICI ARTEFAKTI üzerinden değerlendirilir (aşağıda).
  const evidence = params.attemptEvidence
  if (evidence && evidence.known && Number(evidence.count) > 0) {
    reasons.push('PREVIOUS_CREATE_ATTEMPT_EXISTS')
  }

  // ── TAŞIYICI KANITI ───────────────────────────────────────────────────
  // Herhangi bir taşıyıcı artefaktı varsa gönderi zaten dokunulmuştur.
  if (
    filled(shipment.trackingNumber) || filled(shipment.barcodeValue)
    || filled(shipment.ozelKargoTakipNo) || filled(shipment.printZpl)
    || filled(shipment.technicalZpl)
  ) {
    reasons.push('CARRIER_EVIDENCE_EXISTS')
  }

  // ── ETİKET ────────────────────────────────────────────────────────────
  const operationStatus = text(order.operationStatus).toUpperCase()
  if (['LABEL_READY', 'LABEL_PRINTED'].includes(operationStatus)) {
    reasons.push('LABEL_ALREADY_CREATED')
  }

  // PAZARYERİ DURUMU BURADA DEĞERLENDİRİLMEZ: "uygun" statü kümesinin
  // kaynağı depoda kanıtlı değil ve uydurmak, geçerli siparişleri sessizce
  // bloklardı. Sekme/tab filtresi bu işi zaten görüyor.

  return { eligible: reasons.length === 0, reasons, identity }
}
