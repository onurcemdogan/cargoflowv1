// RESMÎ ZPL ÜRÜN SATIRI İÇİN TEK METADATA GİRİŞİ — SAF (IO/DOM/ağ YOK).
//
// ENTEGRASYON GEREKÇESİ: ZPL footer'ı için AYRI bir renk/beden tahmin
// algoritması BIRAKILMAZ. HTML etiketi, önizleme ve Sipariş Detayı ile AYNI
// çözümleyici zinciri kullanılır:
//   1) sipariş satırındaki yapısal color / size
//   2) variantAttributes (Renk / Renk Seçeneği / Color / Colour —
//      Beden / Size / Numara / Ebat / Ölçü)
//   3) organizasyon + pazaryeri kapsamlı ÜRÜN KATALOĞU varyantı,
//      YALNIZ kesin kod/barkod eşleşmesiyle (fuzzy ad eşleşmesi YOK,
//      çelişkili adayda tahmin YOK)
//   4) güvenli, çapalı başlık ayrıştırması
//   5) hâlâ bulunamıyorsa "Belirtilmemiş" (sahte renk ÜRETİLMEZ)
import type { CargoOrder, CargoProduct } from '../types/cargoflow'
import { resolveLabelProductMetadata } from './labelProductMetadata.ts'
import { resolveCatalogVariantMetadata } from './labelVariantCatalog.ts'
import type { SuratProductLineItem } from './suratZplProductLine.ts'

export function resolveSuratProductLineItems(
  order: CargoOrder | undefined,
  products: CargoProduct[] = [],
): SuratProductLineItem[] {
  return (order?.items ?? []).map((item) => {
    const catalog = resolveCatalogVariantMetadata(item, products, {
      marketplace: order?.marketplace,
    })
    const resolved = resolveLabelProductMetadata(
      {
        productName: item.productName,
        color: item.color,
        size: item.size,
        sku: item.sku,
        merchantSku: item.merchantSku,
        stockCode: item.stockCode,
        productCode: item.productCode,
        variantAttributes: item.variantAttributes,
      },
      catalog,
    )
    return {
      productName: resolved.productName,
      quantity: Number(item.quantity) || 1,
      color: resolved.color,
      size: resolved.size,
      sku: resolved.sku,
    }
  })
}
