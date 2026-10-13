// N11 → KANONİK SİPARİŞ KALICILAŞTIRMA (orderPersistenceService).
//
// KİMLİK / ANLAM KURALLARI (resmî ayrımlar KORUNUR):
//   · Kanonik paket kimliği = yanıttaki `id`. `id` null ise (resmî: "Konuma
//     Özel Teslimat") kayıt YAZILMAZ — `orderNumber`a DÜŞÜLMEZ (sipariş ≠ paket).
//   · `cargoSenderNumber` = TAKİP numarası → kanonik `cargoTrackingNumber`.
//     `cargoTrackingNumber` = BARKOD/kampanya kodu → hiçbir kanonik kargo
//     kolonuna YAZILMAZ (şifreli ham yükte korunur). Kanonik
//     `cargoSenderNumber` kolonu Trendyol uygunluk mantığınca okunduğu için
//     n11 barkodu oraya da KONMAZ.
//   · Sipariş tarihi yalnız `packageHistories` Created kaydından; yoksa kayıt
//     YAZILMAZ (kanonik eşleyici boş tarihi 1970'e çevirirdi).
//   · Taşıyıcı adı HAM korunur; `shipmentCompanyId`den taşıyıcı TÜRETİLMEZ.
//   · `operationStatus` YAZILMAZ: n11 siparişi karşılama akışına (etiket /
//     taşıyıcı) bu bağlayıcı üzerinden GİRMEZ.
//   · Tutar alanları (totalAmount / satır fiyatı) EŞLENMEZ: para semantiği
//     pilot öncesi ayrı karardır.
//
// KAPSAM: `marketplaceAccountId` ZORUNLU, `requireMarketplaceAccount: true`,
// `complete: false` — okuma tam veri kümesi olduğunu KANITLAYAMAZ, mevcut
// siparişler ASLA arşivlenmez.
import { persistSyncResult } from '../../orders/orderPersistenceService.ts'
import type { NormalizedN11Order } from '../../marketplaces/n11/n11OrderSource.ts'
import { N11_ORDER_MARKETPLACE } from './n11Config.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type N11SkipReason = 'NO_PACKAGE_ID' | 'NO_ORDER_DATE'

/** Normalize n11 kaydı → kanonik eşleyicinin beklediği şekil (yazılamazsa sebep). Saf. */
export function toCanonicalN11Order(
  order: NormalizedN11Order,
): { ok: true; order: Record<string, unknown> } | { ok: false; reason: N11SkipReason } {
  const packageId = String(order.packageId ?? '').trim()
  if (packageId === '') return { ok: false, reason: 'NO_PACKAGE_ID' }
  if (!order.orderDate || !Number.isFinite(Date.parse(order.orderDate))) {
    return { ok: false, reason: 'NO_ORDER_DATE' }
  }
  return {
    ok: true,
    order: {
      marketplace: N11_ORDER_MARKETPLACE,
      packageId,
      orderNumber: order.orderNumber,
      externalOrderId: order.orderNumber || null,
      marketplaceStatus: order.marketplaceStatus,
      customerFirstName: order.customerName,
      shipmentAddress: order.shipmentAddress,
      city: order.city,
      district: order.district,
      cargoProviderName: order.rawCarrierName || null,
      // Resmî: cargoSenderNumber = TAKİP. Barkod (cargoTrackingNumber) BURAYA GİRMEZ.
      cargoTrackingNumber: order.marketplaceTrackingNumber || null,
      cargoTrackingLink: order.marketplaceTrackingUrl || null,
      orderDate: order.orderDate,
      lastModifiedDate: order.lastModifiedDate || null,
      items: order.items.map((item) => ({
        id: item.externalLineId,
        merchantSku: item.merchantSku,
        // Satır düzeyi ÜRÜN barkodu (kargo barkodu değil).
        barcode: item.productBarcode,
        productName: item.productName,
        quantity: item.quantity,
        variantAttributes: item.variantAttributes,
        lineStatus: item.lineStatus,
      })),
      rawOrder: order.rawOrder,
    },
  }
}

/** Yazım öncesi saf hazırlık sayımı (yayın kapısından bağımsız görünürlük). */
export function countN11Unpersistable(orders: readonly NormalizedN11Order[]): Record<N11SkipReason, number> {
  const counts: Record<N11SkipReason, number> = { NO_PACKAGE_ID: 0, NO_ORDER_DATE: 0 }
  for (const order of orders) {
    const mapped = toCanonicalN11Order(order)
    if (!mapped.ok) counts[mapped.reason] += 1
  }
  return counts
}

export interface N11PersistResult {
  persisted: number
  inserted: number
  updated: number
  failed: number
  skipped: Record<N11SkipReason, number>
}

/** Hesap kapsamlı kanonik yazım. Hesap kimliği yoksa yazmaz, HATA verir (sessiz NULL kapsamı YOK). */
export async function persistN11Orders(
  db: Db,
  params: { organizationId: string; marketplaceAccountId: string; orders: NormalizedN11Order[] },
): Promise<N11PersistResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('n11_account_scope_required')
  }
  const skipped: Record<N11SkipReason, number> = { NO_PACKAGE_ID: 0, NO_ORDER_DATE: 0 }
  const canonical: Record<string, unknown>[] = []
  for (const order of params.orders) {
    const mapped = toCanonicalN11Order(order)
    if (mapped.ok) canonical.push(mapped.order)
    else skipped[mapped.reason] += 1
  }
  if (canonical.length === 0) return { persisted: 0, inserted: 0, updated: 0, failed: 0, skipped }
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
