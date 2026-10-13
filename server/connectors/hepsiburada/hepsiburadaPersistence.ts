// HEPSIBURADA → KANONİK SİPARİŞ KALICILAŞTIRMA (orderPersistenceService).
//
// KİMLİK KURALLARI (resmî ayrımlar KORUNUR):
//   · Kanonik paket kimliği = `packageNumber`. Paketi olmayan kayıt
//     YAZILMAZ — `orderNumber`a DÜŞÜLMEZ (sipariş ≠ paket).
//   · `orderNumber` ayrı alanda kalır; `barcode` takip numarası DEĞİLDİR ve
//     takip alanlarına yazılmaz (ham yükte korunur).
//   · Sipariş tarihi okunamıyorsa kayıt YAZILMAZ: kanonik eşleyici boş
//     tarihi 1970'e çevirirdi — uydurma tarih üretilmez.
//
// KAPSAM: `marketplaceAccountId` ZORUNLU (NULL hesaplı gölge satır YOK) ve
// `complete:false` — okuma tam veri kümesi olduğunu KANITLAYAMAZ, bu yüzden
// mevcut siparişler ASLA arşivlenmez.
import { persistSyncResult } from '../../orders/orderPersistenceService.ts'
import type { NormalizedHepsiburadaOrder } from '../../marketplaces/hepsiburada/hepsiburadaOrderSource.ts'
import { HEPSIBURADA_ORDER_MARKETPLACE } from './hepsiburadaConfig.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type HepsiburadaSkipReason = 'NO_PACKAGE_NUMBER' | 'NO_ORDER_DATE'

/** Normalize HB kaydı → kanonik eşleyicinin beklediği şekil (yazılamazsa sebep). */
export function toCanonicalHepsiburadaOrder(
  order: NormalizedHepsiburadaOrder,
): { ok: true; order: Record<string, unknown> } | { ok: false; reason: HepsiburadaSkipReason } {
  const packageId = String(order.packageId ?? '').trim()
  if (packageId === '') return { ok: false, reason: 'NO_PACKAGE_NUMBER' }
  if (!order.orderDate || !Number.isFinite(Date.parse(order.orderDate))) {
    return { ok: false, reason: 'NO_ORDER_DATE' }
  }
  return {
    ok: true,
    order: {
      marketplace: HEPSIBURADA_ORDER_MARKETPLACE,
      packageId,
      orderNumber: order.orderNumber,
      externalOrderId: order.externalOrderId || null,
      marketplaceStatus: order.marketplaceStatus,
      customerFirstName: order.customerName,
      shipmentAddress: order.shipmentAddress,
      city: order.city,
      district: order.district,
      // Taşıyıcı adı HAM korunur; kanonik anahtar yalnız eşleşme kanıtlıysa
      // ham yükte vardır. Bilinmeyen taşıyıcı UYDURULMAZ.
      cargoProviderName: order.rawCarrierName || null,
      cargoTrackingNumber: order.marketplaceTrackingNumber || null,
      cargoTrackingLink: order.marketplaceTrackingUrl || null,
      orderDate: order.orderDate,
      items: order.items.map((item) => ({
        // Kanonik satır anahtarı `id`den okunur; normalizasyon kararlı
        // (sağlayıcı ya da deterministik türetilmiş) kimlik verir.
        id: item.externalLineId,
        merchantSku: item.merchantSku,
        sku: item.sku,
        productName: item.productName,
        quantity: item.quantity,
      })),
      rawOrder: order.rawOrder,
    },
  }
}

export interface HepsiburadaPersistResult {
  persisted: number
  inserted: number
  updated: number
  failed: number
  skipped: Record<HepsiburadaSkipReason, number>
}

/**
 * Hesap kapsamlı kanonik yazım. Hesap kimliği yoksa yazmaz, HATA verir
 * (sessiz NULL kapsamı YOK).
 */
export async function persistHepsiburadaOrders(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    orders: NormalizedHepsiburadaOrder[]
  },
): Promise<HepsiburadaPersistResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('hepsiburada_account_scope_required')
  }
  const skipped: Record<HepsiburadaSkipReason, number> = { NO_PACKAGE_NUMBER: 0, NO_ORDER_DATE: 0 }
  const canonical: Record<string, unknown>[] = []
  for (const order of params.orders) {
    const mapped = toCanonicalHepsiburadaOrder(order)
    if (mapped.ok) canonical.push(mapped.order)
    else skipped[mapped.reason] += 1
  }
  if (canonical.length === 0) {
    return { persisted: 0, inserted: 0, updated: 0, failed: 0, skipped }
  }
  const result = await persistSyncResult(db, organizationId, canonical, {
    complete: false,
    fetchedCount: canonical.length,
    marketplaceAccountId,
    requireMarketplaceAccount: true,
  })
  return {
    persisted: result.persistedCount,
    inserted: result.insertedCount,
    updated: result.updatedCount,
    failed: result.failedCount,
    skipped,
  }
}
