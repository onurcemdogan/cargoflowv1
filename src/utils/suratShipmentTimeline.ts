import type { CargoOrder } from '../types/cargoflow'
import { formatDisplayDate } from './formatters'
import { verifySuratShipment } from './suratVerification'
import {
  isPreassignedAwaitingAcceptance,
  resolveSuratPrintEligibility,
} from './suratPrintEligibility'
import {
  describeShippingEvidence,
  resolveOrderShippingEvidence,
} from './orderShippingEvidence'

// Salt-okunur zaman çizelgesi modeli: yalnız mevcut order/shipment verisinden
// üretilir. API çağrısı, create veya Serendip doğrulaması TETİKLEMEZ.
export type SuratTimelineStepStatus =
  | 'completed'
  | 'active'
  | 'pending'
  | 'error'
  /**
   * KAYIT YOK — adım ne tamamlandı ne bekliyor: CargoFlow'da bu adıma ait
   * KANIT bulunmuyor. Sipariş harici bir sistemde hazırlanıp kargoya
   * verilmiş olabilir. Sahte "tamamlandı" YAZMAK YERİNE bilinmezlik açıkça
   * gösterilir (doğrusal olmayan kanıt).
   */
  | 'unknown'

export interface SuratTimelineStep {
  key:
    | 'orderReceived'
    | 'labelCreated'
    | 'awaitingAcceptance'
    | 'trackingActive'
    | 'delivered'
  label: string
  status: SuratTimelineStepStatus
  timestamp?: string
  description: string
}

export function buildSuratShipmentTimeline(
  order: CargoOrder,
): SuratTimelineStep[] {
  const shipment = order.shipment
  const verification = verifySuratShipment(order)
  const eligibility = resolveSuratPrintEligibility(order)

  // ═══ TEK CANONICAL KANIT ═══════════════════════════════════════════════
  //
  // Liste/rozet/sekme ile AYNI çözücü. Eskiden burada DAHA DAR bir kümeye
  // bakılıyordu (pazaryeri `Shipped` ve `shippedAt` HİÇ okunmuyordu), bu
  // yüzden satır "Kargoya Verildi" derken çizelge "Henüz aktif takip yok"
  // diyebiliyordu.
  const evidence = resolveOrderShippingEvidence(order)
  const delivered = evidence.delivered
  const trackingActive = Boolean(
    delivered ||
      evidence.handedToCargo ||
      verification.verifiedShipment ||
      shipment?.verifiedShipment ||
      ['TRACKING_ACTIVE', 'VERIFIED'].includes(
        String(shipment?.lifecycleStatus ?? ''),
      ),
  )
  // Safe replay: SURAT_CREATE_IDEMPOTENCY_BLOCKED + carrierCreateCalled=false
  // + LABEL_READY_AWAITING_ACCEPTANCE + canonical kodlar → HATA DEĞİLDİR.
  const awaitingAcceptance = Boolean(
    !trackingActive &&
      (isPreassignedAwaitingAcceptance(shipment) ||
        eligibility.awaitingAcceptance),
  )
  // ═══ GEÇMİŞ UYDURULMAZ ═════════════════════════════════════════════════
  //
  // "Etiket Oluşturuldu" ARTIK `trackingActive`ten TÜRETİLMEZ. Sipariş harici
  // bir sistemde hazırlanıp kargoya verilmiş olabilir; o zaman CargoFlow'da
  // etiket artefaktı YOKTUR ve adımı "tamamlandı" göstermek sahte geçmiş
  // yazmak olurdu. Adım YALNIZ gerçek CargoFlow etiket kanıtıyla tamamlanır.
  const hasLabelArtifact = Boolean(
    eligibility.canPrint ||
      awaitingAcceptance ||
      verification.verifiedShipment ||
      shipment?.barcodeRaw ||
      order.hasPrintableLabel === true,
  )
  const labelCreated = hasLabelArtifact
  // Kargoya verilmiş ama CargoFlow etiket kanıtı YOK → "kayıt yok".
  const labelHistoryUnknown = Boolean(!hasLabelArtifact && trackingActive)
  const realCreateError = Boolean(
    !labelCreated &&
      (order.operationStatus === 'ERROR' ||
        order.status === 'Hata' ||
        order.errorMessage ||
        shipment?.labelStatus === 'BLOCKED'),
  )

  const cleanDate = (value: string): string =>
    value && value !== '-' ? value : ''
  const orderTimestamp = cleanDate(
    formatDisplayDate(order.orderDate || order.createdAt),
  )
  const labelTimestamp = shipment
    ? cleanDate(
        formatDisplayDate(
          readTimestamp(shipment.suratCreateLog) ?? readTimestamp(shipment),
        ),
      )
    : ''
  const deliveredTimestamp = evidence.deliveredAt
    ? cleanDate(formatDisplayDate(evidence.deliveredAt))
    : ''

  return [
    {
      key: 'orderReceived',
      label: 'Sipariş Alındı',
      status: 'completed',
      timestamp: orderTimestamp || undefined,
      description: 'Sipariş sistemde oluşturuldu.',
    },
    {
      key: 'labelCreated',
      label: 'Etiket Oluşturuldu',
      status: labelCreated
        ? 'completed'
        : labelHistoryUnknown
          ? 'unknown'
          : realCreateError
            ? 'error'
            : shipment
              ? 'active'
              : 'pending',
      timestamp: labelCreated ? labelTimestamp || undefined : undefined,
      description: labelCreated
        ? 'T.No ve barkod üretildi.'
        : labelHistoryUnknown
          ? 'CargoFlow kaydı yok; gönderi harici bir sistemde hazırlanmış olabilir.'
          : realCreateError
            ? order.errorMessage ||
              'Sürat create hatası; kayıt incelenmeli.'
            : 'Sürat gönderisi henüz oluşturulmadı.',
    },
    {
      key: 'awaitingAcceptance',
      label: 'Etiket Hazır',
      status: labelHistoryUnknown
        ? 'unknown'
        : trackingActive
          ? 'completed'
          : awaitingAcceptance
            ? 'active'
            : 'pending',
      description: labelHistoryUnknown
        ? 'CargoFlow kaydı yok.'
        : trackingActive
          ? 'Etiket hazır; kargo süreci ilerledi.'
          : 'Etiket hazır ve yazdırılabilir.',
    },
    {
      key: 'trackingActive',
      label: 'Kargoya Verildi / Takip Aktif',
      status: delivered
        ? 'completed'
        : trackingActive
          ? 'active'
          : 'pending',
      timestamp: evidence.shippedAt
        ? cleanDate(formatDisplayDate(evidence.shippedAt)) || undefined
        : undefined,
      // GEREKÇE KANITIN KAYNAĞINDAN GELİR: taşıyıcı doğrulaması yokken
      // "Sürat takip kaydı doğrulandı" YAZILMAZ.
      description: verification.verifiedShipment
        ? 'Sürat takip kaydı doğrulandı.'
        : describeShippingEvidence(
            // Teslim edilmiş gönderide "kargoya verildi" kanıtı ayrıca
            // kaydedilmemiş olabilir; gerekçe teslim kanıtının KAYNAĞINDAN
            // gelir. (Sınıflandırma yüklemi DEĞİŞMEZ — bkz. evidence modülü.)
            evidence.handedToCargoSource ?? evidence.deliveredSource,
          ),
    },
    {
      key: 'delivered',
      label: 'Teslim Edildi',
      status: delivered ? 'completed' : 'pending',
      timestamp: delivered ? deliveredTimestamp || undefined : undefined,
      description: delivered
        ? 'Gönderi teslim edildi.'
        : 'Teslim kaydı yok.',
    },
  ]
}

function readTimestamp(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['completedAt', 'timestamp', 'createdAt', 'startedAt']) {
    const found = record[key]
    if (typeof found === 'string' && found.trim()) return found
  }
  return undefined
}
