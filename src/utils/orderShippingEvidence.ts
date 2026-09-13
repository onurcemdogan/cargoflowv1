import type { CargoOrder } from '../types/cargoflow.ts'
import { resolveOrderStatus } from './shipmentStatus.ts'

// ═══ KARGOYA VERİLDİ / TESLİM — TEK CANONICAL KANIT ÇÖZÜCÜSÜ ═════════════
//
// ÖLÇÜLEN KUSUR: liste "Kargoya Verildi" derken sipariş detayındaki zaman
// çizelgesi "Henüz aktif takip yok" diyordu. Sebep, AYNI SORUYU soran İKİ
// AYRI uygulama:
//
//   classifyOrderForTabs.isHandedToCargo
//     resolveOrderStatus().shipped
//     · marketplaceStatus ∈ { Shipped, AtCollectionPoint }
//     · shipment.shippedAt | handedToCargoAt
//     · operationStatus ∈ { SHIPPED, HANDED_TO_CARGO }
//
//   buildSuratShipmentTimeline.trackingActive
//     verification.verifiedShipment | shipment.verifiedShipment
//     · operationStatus === 'HANDED_TO_CARGO'        (SHIPPED YOK)
//     · shipment.lifecycleStatus ∈ { TRACKING_ACTIVE, VERIFIED }
//     (pazaryeri Shipped ve shippedAt HİÇ okunmuyordu)
//
// Yani pazaryeri "kargoya verildi" derken CargoFlow'un kendi taşıyıcı
// doğrulaması yoksa liste ilerliyor, zaman çizelgesi yerinde sayıyordu.
//
// Bu modül o soruyu TEK YERDE yanıtlar ve KANITIN KAYNAĞINI da döndürür;
// böylece arayüz "kargoya verildi" derken YANLIŞ gerekçe (ör. "Sürat takip
// kaydı doğrulandı") yazamaz.
//
// BAĞIMLILIK: yalnız `shipmentStatus` (o da yalnız tip import eder). Üst
// katman modüllerine (orderClassification / timeline) bağlanmaz — döngü YOK.

export type ShippingEvidenceSource =
  /** Taşıyıcının kendi takip hareketi (en güçlü). */
  | 'carrierTracking'
  /** Kalıcı taşıyıcı zaman damgası (shippedAt / handedToCargoAt). */
  | 'carrierTimestamp'
  /** CargoFlow canonical operasyon durumu (SHIPPED / HANDED_TO_CARGO). */
  | 'canonicalOperation'
  /** Pazaryerinin bildirdiği paket durumu (Shipped / AtCollectionPoint). */
  | 'marketplace'

export interface OrderShippingEvidence {
  handedToCargo: boolean
  delivered: boolean
  /** En güçlü kanıtın kaynağı; kanıt yoksa null. */
  handedToCargoSource: ShippingEvidenceSource | null
  deliveredSource: ShippingEvidenceSource | null
  /** GERÇEK zaman damgası — yoksa null. ASLA türetilmez/uydurulmaz. */
  shippedAt: string | null
  deliveredAt: string | null
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function readShipmentString(order: CargoOrder, key: string): string {
  const shipment = order.shipment as Record<string, unknown> | undefined
  if (!shipment) return ''
  return text(shipment[key])
}

const MARKETPLACE_HANDED_TO_CARGO = ['Shipped', 'AtCollectionPoint']
const CANONICAL_SHIPPED = ['SHIPPED', 'HANDED_TO_CARGO']
const CANONICAL_DELIVERED = ['DELIVERED', 'DELIVERED_SPECIAL']

/**
 * Siparişin kargoya verilmiş/teslim edilmiş olduğuna dair KANIT.
 *
 * Yüklem kümesi `classifyOrderForTabs` içindeki mevcut kuralın BİREBİR
 * aynısıdır (davranış değişmez); eklenen tek şey KAYNAK ve GERÇEK zaman
 * damgasıdır.
 */
export function resolveOrderShippingEvidence(
  order: CargoOrder,
): OrderShippingEvidence {
  const resolved = resolveOrderStatus(order)
  const marketplaceStatus = text(order.marketplaceStatus)
  const operationStatus = text(order.operationStatus).toUpperCase()

  // GERÇEK taşıyıcı zaman damgaları — uydurma YOK.
  const shippedAt =
    readShipmentString(order, 'shippedAt') ||
    readShipmentString(order, 'handedToCargoAt') ||
    ''
  const deliveredAt = readShipmentString(order, 'deliveredAt')

  const carrierTracking = resolved.statusSource === 'suratTracking'

  // ── Kargoya verildi ────────────────────────────────────────────────────
  const byCarrierTracking = Boolean(resolved.shipped && carrierTracking)
  const byCarrierTimestamp = Boolean(shippedAt)
  const byCanonical = CANONICAL_SHIPPED.includes(operationStatus)
  const byMarketplace = MARKETPLACE_HANDED_TO_CARGO.includes(marketplaceStatus)
  const handedToCargoDirect = Boolean(
    resolved.shipped || byMarketplace || byCarrierTimestamp || byCanonical,
  )

  // ── Teslim ─────────────────────────────────────────────────────────────
  const deliveredByCarrierTracking = Boolean(resolved.delivered && carrierTracking)
  const deliveredByTimestamp = Boolean(deliveredAt)
  const deliveredByCanonical = CANONICAL_DELIVERED.includes(operationStatus)
  const deliveredByMarketplace = marketplaceStatus === 'Delivered'
  const delivered = Boolean(
    resolved.delivered ||
      deliveredByMarketplace ||
      deliveredByTimestamp ||
      deliveredByCanonical,
  )

  // KAYNAK GÜÇTEN ZAYIFA: taşıyıcı hareketi → taşıyıcı damgası → PAZARYERİ
  // → canonical operasyon.
  //
  // PAZARYERİ, CANONICAL'DAN ÖNCE GELİR — sezgiye aykırı ama DOĞRU: istemci
  // projeksiyonu (`withDerivedOperationStatus`) pazaryeri `Shipped` değerini
  // `HANDED_TO_CARGO`ya TÜRETİR. Canonical önce sorulsaydı kanıtın GERÇEK
  // KÖKENİ kaybolur ve arayüz "CargoFlow kaydı işaretli" derdi — oysa
  // bilgiyi bildiren pazaryeridir.
  const deliveredSource: ShippingEvidenceSource | null = !delivered
    ? null
    : deliveredByCarrierTracking
      ? 'carrierTracking'
      : deliveredByTimestamp
        ? 'carrierTimestamp'
        : deliveredByMarketplace
          ? 'marketplace'
          : deliveredByCanonical
            ? 'canonicalOperation'
            : 'canonicalOperation'

  // DİKKAT — `delivered` BURADA `handedToCargo`YA KATILMAZ.
  //
  // İlk denemede "teslim edilmiş gönderi tanım gereği kargoya verilmiştir"
  // diye eklenmişti; TEST ÇÜRÜTTÜ: teslim edilmiş sipariş o zaman HEM
  // "Kargoya Verildi" HEM "Teslim Edildi" sekmesine giriyor ve ÇİFT SAYILIYOR.
  // Sınıflandırma yüklemi mevcut davranışla BİREBİR kalır; teslim edilmiş
  // siparişin çizelge GEREKÇESİ, kaynağını `deliveredSource`tan alır
  // (bkz. suratShipmentTimeline).
  const handedToCargo = handedToCargoDirect
  const handedToCargoSource: ShippingEvidenceSource | null = !handedToCargo
    ? null
    : byCarrierTracking
      ? 'carrierTracking'
      : byCarrierTimestamp
        ? 'carrierTimestamp'
        : byMarketplace
          ? 'marketplace'
          : byCanonical
            ? 'canonicalOperation'
            : deliveredSource

  return {
    handedToCargo,
    delivered,
    handedToCargoSource,
    deliveredSource,
    shippedAt: shippedAt || null,
    deliveredAt: deliveredAt || null,
  }
}

/** Kanıt kaynağının kullanıcıya gösterilebilir, DOĞRU gerekçesi. */
export function describeShippingEvidence(
  source: ShippingEvidenceSource | null,
): string {
  switch (source) {
    case 'carrierTracking':
      return 'Taşıyıcı takip kaydı aktif.'
    case 'carrierTimestamp':
      return 'Taşıyıcı kargoya veriliş zamanı kayıtlı.'
    case 'canonicalOperation':
      return 'CargoFlow kaydı kargoya verildi olarak işaretli.'
    case 'marketplace':
      // Taşıyıcı doğrulaması YOKTUR: "Sürat takip kaydı doğrulandı" DENMEZ.
      return 'Pazaryeri gönderinin kargoya verildiğini bildiriyor.'
    default:
      return 'Henüz aktif takip yok.'
  }
}
