// YENİ etiket için efektif desi çözümü (SAF).
//
// SÖZLEŞME: Kullanıcı artık sipariş sipariş desi GİRMEZ. Yeni bir gönderi
// etiketi üretilirken desi YALNIZ Ayarlar → "Varsayılan Gönderi Desisi"
// değerinden, mevcut calculateOrderDesi çarpan sözleşmesiyle hesaplanır.
// Organizasyon ayarı multiplyByItemQuantity (VARSAYILAN true) bu çarpanı
// yönetir; ayar YALNIZ aşağıdaki 2. adımı (varsayılandan hesap) etkiler:
//   çarpan AÇIK  — defaultUnitDesi=2, quantity=1 → 2 | quantity=2 → 4
//   çarpan KAPALI — defaultUnitDesi=2, quantity=1 → 2 | quantity=2 → 2
// Manuel "toplam desi" override'ı ARTIK ÜRETİLMEZ; ancak GEÇMİŞTE kaydedilmiş
// override'lar SİLİNMEZ ve hâlâ önceliklidir (eski siparişlerin/etiketlerin
// davranışı değişmesin, reprint aynı kalsın).
import type {
  CargoOrder,
  CargoProduct,
  DesiSource,
  Shipment,
  TenantDesiConfig,
} from '../types/cargoflow'
import { resolveNormalizedDesi } from './desi'
import { calculateOrderDesi } from './orderDesi'

// Ayarlarda varsayılan desi yoksa etiket üretimi BLOKLANIR ve kullanıcı
// Ayarlar'a yönlendirilir (sessiz/yanlış desi ile gönderi oluşturulmaz).
export const DEFAULT_DESI_MISSING_MESSAGE =
  'Varsayılan Gönderi Desisi tanımlı değil. Entegrasyonlar / Ayarlar → ' +
  '"Kargo ve Etiket Varsayılanları" bölümünden belirleyin.'

export interface EffectiveLabelDesi {
  desi: number | null
  desiSource: DesiSource | null
  // null değilse etiket üretilemez; kullanıcıya gösterilecek mesaj.
  blockedReason: string | null
  // Kullanıcıyı Ayarlar'a yönlendirmek gerekiyor mu (UI bağlantı gösterir).
  requiresSettings: boolean
}

export function resolveEffectiveLabelDesi(
  order: CargoOrder | undefined,
  shipment: Shipment | undefined,
  products: CargoProduct[] = [],
  desiConfig?: Partial<TenantDesiConfig> | null,
): EffectiveLabelDesi {
  // 1) Sipariş/gönderi üzerinde ZATEN kayıtlı desi (geçmiş manuel override veya
  //    daha önce hesaplanmış değer) → aynen korunur.
  const normalized = resolveNormalizedDesi(order, shipment)
  if (normalized.desi != null) {
    return {
      desi: normalized.desi,
      desiSource: normalized.desiSource,
      blockedReason: null,
      requiresSettings: false,
    }
  }

  // 2) Yoksa Ayarlar varsayılanından mevcut çarpan sözleşmesiyle hesapla.
  if (order) {
    const calculation = calculateOrderDesi(order, products, desiConfig)
    if (calculation.finalDesi != null) {
      return {
        desi: calculation.finalDesi,
        desiSource: calculation.finalDesiSource,
        blockedReason: null,
        requiresSettings: false,
      }
    }
    // Varsayılan tanımlıysa ama satır/iptal nedeniyle hesaplanamadıysa mevcut
    // açıklama korunur (Ayarlar'a yönlendirme gerekmez).
    const hasDefault = Number(desiConfig?.defaultUnitDesi) > 0
    if (hasDefault) {
      return {
        desi: null,
        desiSource: null,
        blockedReason:
          calculation.blockedReason ?? 'Desi hesaplanamadı.',
        requiresSettings: false,
      }
    }
  }

  // 3) Ayarlarda varsayılan desi yok → Ayarlar'a yönlendir.
  return {
    desi: null,
    desiSource: null,
    blockedReason: DEFAULT_DESI_MISSING_MESSAGE,
    requiresSettings: true,
  }
}
