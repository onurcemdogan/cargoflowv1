// GÖNDERİ DESİSİNİN TEK ÇÖZÜCÜSÜ.
//
// ═══ KÖK NEDEN (üretimde kanıtlandı — paket 4109804198) ══════════════════
// Sürat create yolu desiyi İSTEK GÖVDESİNDEN okuyordu:
//
//   const desi = toPositiveNumber(order.desi)
//   if (desi == null) throw 'Desi bilgisi eksik...'
//
// Değeri TARAYICI hesaplıyordu: hydrate edilmiş kiracı ayarlarıyla
// `calculateOrderDesi(order, products, desiConfig)` çağırıp `order.desi`
// olarak POST ediyordu. Elle etiket bu yüzden çalışıyordu.
//
// Arka plan worker'ının tarayıcısı YOKTUR. Siparişi veritabanından kurar ve
// `orders.desi` kolonu boştur → create, taşıyıcıya HİÇ ÇIKMADAN reddedilir
// (carrierCalled = false).
//
// ═══ DÜZELTME YERİ: ORKESTRASYON SINIRI ══════════════════════════════════
// Çözüm worker'ın gövdesine desi enjekte etmek DEĞİLDİR — o, ikinci bir
// kural doğurur ve elle yol ile zamanla ayrışır. Create orkestrasyonu
// desiyi HER ÇAĞIRAN için kendisi çözebilmelidir.
//
// ═══ İKİNCİ UYGULAMA YOK ═════════════════════════════════════════════════
// Hesap `src/utils/orderDesi.ts` içindeki `calculateOrderDesi` ile yapılır —
// istemcinin kullandığı AYNI saf fonksiyon. Öncelik sırası (manuel → sipariş
// satırı → ürün → varyant → eşleme → kategori → kiracı varsayılanı) burada
// YENİDEN YAZILMAZ.
//
// ═══ SESSİZ VARSAYILAN YOK ═══════════════════════════════════════════════
// Kiracı desi ayarlamamışsa desi ÇÖZÜLEMEZ ve create AÇILMAZ. Uydurma bir
// desi, taşıyıcıya yanlış fiyatlanan GERİ ALINAMAZ bir gönderi demektir.

import { getShipmentDefaults } from '../onboarding/shipmentDefaultsRepository.ts'
import { calculateOrderDesi } from '../../src/utils/orderDesi.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type ShipmentDesiSource =
  /** İstek gövdesinde zaten çözülmüş (elle etiket yolu). */
  | 'request'
  /** Kiracı ayarları + katalog ile sunucuda çözüldü. */
  | 'tenant_settings'
  /** Çözülemedi. */
  | 'unresolved'

export interface ShipmentDesiResolution {
  readonly desi: number | null
  readonly source: ShipmentDesiSource
  /** Kiracıda `defaultUnitDesi` ayarı VAR mı (değerinden bağımsız). */
  readonly tenantSettingPresent: boolean
  readonly tenantSettingValue: number | null
  /** Satır bazlı kaynak dağılımı — teşhis için, PII içermez. */
  readonly lineSources: readonly string[]
  readonly reason: string | null
}

function positive(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

/**
 * Bir gönderi için otoriter desiyi çözer.
 *
 * Öncelik:
 *   1. `order.desi` zaten çözülmüşse AYNEN kullanılır (elle yol davranışı
 *      BİREBİR korunur; sunucu istemcinin kararını EZMEZ).
 *   2. Aksi hâlde kiracı ayarları + organizasyon kataloğu ile kanonik
 *      `calculateOrderDesi` çalıştırılır.
 *   3. Yine çözülemezse `null` döner ve çağıran create'i AÇMAZ.
 */
export async function resolveShipmentDesi(params: {
  db: Db
  organizationId: string
  order: Record<string, unknown>
  /** Katalog verilmezse organizasyonunki yüklenir. */
  products?: unknown[]
}): Promise<ShipmentDesiResolution> {
  const requestDesi = positive((params.order ?? {}).desi)

  let tenantSettingPresent = false
  let tenantSettingValue: number | null = null
  let defaults: { defaultUnitDesi: number | null; multiplyByItemQuantity: boolean } | null =
    null
  try {
    const loaded = await getShipmentDefaults(params.db, params.organizationId)
    defaults = loaded
    tenantSettingValue = positive(loaded?.defaultUnitDesi)
    tenantSettingPresent = loaded?.defaultUnitDesi != null
  } catch {
    // Ayar okunamadı: "bilinmiyor" ASLA "sıfır" değildir; çözüm denenmeye
    // devam eder ama uydurma varsayılan KULLANILMAZ.
    defaults = null
  }

  if (requestDesi != null) {
    return {
      desi: requestDesi,
      source: 'request',
      tenantSettingPresent,
      tenantSettingValue,
      lineSources: [],
      reason: null,
    }
  }

  if (!defaults) {
    return {
      desi: null,
      source: 'unresolved',
      tenantSettingPresent,
      tenantSettingValue,
      lineSources: [],
      reason: 'Kiracı gönderi varsayılanları okunamadı.',
    }
  }

  let products = params.products
  if (!Array.isArray(products)) {
    try {
      const { listProducts } = await import(
        '../products/productPersistenceService.ts'
      )
      const listed = await listProducts(params.db, params.organizationId, {
        pageSize: 1000,
      })
      products = Array.isArray(listed) ? listed : (listed?.products ?? [])
    } catch {
      // Katalog yoksa ürün/varyant geçersiz kılmaları uygulanamaz; kiracı
      // varsayılanı yine geçerlidir.
      products = []
    }
  }

  // KANONİK HESAP — istemciyle AYNI fonksiyon.
  const calculation = calculateOrderDesi(
    params.order as never,
    (products ?? []) as never,
    {
      defaultUnitDesi: defaults.defaultUnitDesi,
      multiplyByItemQuantity: defaults.multiplyByItemQuantity,
    } as never,
  )
  const resolved = positive(calculation?.calculatedTotalDesi)
  const lineSources = Array.isArray(calculation?.lines)
    ? (calculation.lines as { unitDesiSource?: unknown }[])
        .map((line) => String(line.unitDesiSource ?? 'none'))
    : []

  if (resolved == null) {
    return {
      desi: null,
      source: 'unresolved',
      tenantSettingPresent,
      tenantSettingValue,
      lineSources,
      reason: tenantSettingPresent
        ? 'Kiracı desi ayarı var ama bu sipariş için desi hesaplanamadı.'
        : 'Kiracıda varsayılan desi ayarlı değil.',
    }
  }

  return {
    desi: resolved,
    source: 'tenant_settings',
    tenantSettingPresent,
    tenantSettingValue,
    lineSources,
    reason: null,
  }
}
