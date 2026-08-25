// CANLI TAŞIYICI CREATE UYGUNLUĞU — TEK OTORİTE.
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
  'PREVIOUS_CREATE_ATTEMPT_EXISTS',
  'CARRIER_EVIDENCE_EXISTS',
  'LABEL_ALREADY_CREATED',
  'MARKETPLACE_STATE_NOT_ELIGIBLE',
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

/** Pazaryeri tarafında hâlâ create edilebilir durumlar. */
const ELIGIBLE_MARKETPLACE_STATUSES = new Set([
  'Created', 'Picking', 'Invoiced', 'ReadyToShip',
])

/**
 * Tek karar noktası. Kanıt EKSİKSE uygun DEĞİLDİR — "bilinmiyor" asla
 * "uygun" demek değildir.
 */
export function resolveSuratCreateEligibility(params: {
  order: Record<string, unknown>
  /** Bu paket için bilinen CargoFlow create denemesi sayısı. */
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
  } else if (
    // Roller ÇAKIŞAMAZ: takip numarası sipariş numarası olarak kullanılırsa
    // `WebSiparisKodu` yanlış olur ve doğrulama sessizce boşa çıkar.
    identity.orderNumber === identity.cargoTrackingNumber
    || identity.packageId === identity.cargoTrackingNumber
    || identity.orderNumber === identity.packageId
  ) {
    reasons.push('IDENTITY_INCONSISTENT')
  }

  // ── ÖNCEKİ DENEME ─────────────────────────────────────────────────────
  const attempts = Number(params.createAttemptCount ?? 0)
  if (!Number.isFinite(attempts) || attempts > 0) {
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

  // ── PAZARYERİ DURUMU ──────────────────────────────────────────────────
  const marketplaceStatus = text(order.marketplaceStatus)
  if (!ELIGIBLE_MARKETPLACE_STATUSES.has(marketplaceStatus)) {
    reasons.push('MARKETPLACE_STATE_NOT_ELIGIBLE')
  }

  return { eligible: reasons.length === 0, reasons, identity }
}
