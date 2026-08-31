// ÖNİZLEME KAYNAĞI — GERÇEK SİPARİŞ ÖNCELİKLİ, DEMO AÇIKÇA İŞARETLİ.
//
// ═══ NEDEN GERÇEK SİPARİŞ ════════════════════════════════════════════════
// Uydurma "Ahmet Yılmaz / Örnek Mah." verisiyle yapılan bir yerleşim, gerçek
// veriyle taşar: Türkçe adlar uzundur, adresler site/blok/kapı açıklamaları
// taşır, siparişler çok ürünlü olur. Düzenleyici bu yüzden KALICI bir
// siparişin kanonik etiket verisini kullanır.
//
// ═══ TAŞIYICI ÇAĞRISI YOK ════════════════════════════════════════════════
// Önizleme yalnız ZATEN KAYITLI veriyi okur. Gönderi OLUŞTURULMAZ, Sürat
// çağrılmaz, hiçbir statü/sayaç değişmez.
//
// ═══ DEMO SESSİZ DEĞİL ═══════════════════════════════════════════════════
// Uygun sipariş yoksa demo veri kullanılır ve `isDemo` ile AÇIKÇA bildirilir;
// arayüz bunu rozetle gösterir. Operatör demo yerleşimini "gerçek doğrulandı"
// sanmamalıdır.

import type { CargoOrder, CargoProduct } from '../types/cargoflow.ts'
import { buildLabelData, type LabelData } from '../utils/labelData.ts'
import {
  applyCanonicalPrintIdentity,
  buildSuratPrintPageModel,
} from '../utils/browserLabelPrint.ts'
import type { LabelRenderSource } from './labelDocumentRenderer.ts'

export interface EditorPreviewSource {
  source: LabelRenderSource
  isDemo: boolean
  /** Gerçek siparişte sipariş numarası; demoda undefined. */
  orderNumber?: string
}

/**
 * Önizleme için EN UYGUN sipariş.
 *
 * Tercih sırası: gönderisi olan (barkod/QR gerçek) → çok ürünlü → ilk kayıt.
 * Böylece operatör en zorlu durumu (uzun ürün listesi + gerçek barkod)
 * varsayılan olarak görür.
 */
export function pickPreviewOrder(orders: CargoOrder[]): CargoOrder | undefined {
  const usable = (orders ?? []).filter((order) => Boolean(order?.id))
  if (usable.length === 0) return undefined
  return (
    usable.find(
      (order) => Boolean(order.shipment) && (order.items?.length ?? 0) > 1,
    ) ??
    usable.find((order) => Boolean(order.shipment)) ??
    usable.find((order) => (order.items?.length ?? 0) > 1) ??
    usable[0]
  )
}

/**
 * DEMO SİPARİŞ.
 *
 * Etiket verisi elle YAZILMAZ: gerçek `buildLabelData` boru hattından geçer.
 * Elle yazılmış bir `LabelData`, boru hattı değiştiğinde sessizce ayrışır ve
 * demo önizleme gerçek çıktıdan farklı görünürdü.
 */
function makeDemoOrder(overrides: Partial<CargoOrder> = {}): CargoOrder {
  return {
    id: 'demo-order',
    marketplace: 'Trendyol',
    externalOrderId: 'DEMO-0000000000',
    orderNumber: 'DEMO-0000000000',
    packageId: 'DEMO-PKG',
    customerFirstName: 'Şükrü',
    customerLastName: 'Öztürkoğlu',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    source: 'mock',
    status: 'Yeni',
    customerName: 'DEMO — Şükrü Öztürkoğlu',
    customerPhone: '0500 000 00 00',
    customerEmail: '',
    address:
      'DEMO ADRES — Yeşilbahçe Mahallesi, Portakal Çiçeği Bulvarı No: 128/A, ' +
      'Papatya Sitesi B Blok Kat: 7 Daire: 21',
    city: 'ANTALYA',
    district: 'MURATPAŞA',
    cargoProviderName: 'Sürat Kargo',
    totalAmount: 0,
    createdAt: '2026-08-01T09:00:00.000Z',
    orderDate: '2026-08-01T09:00:00.000Z',
    desi: 2,
    packageCount: 1,
    items: [
      {
        productName: 'DEMO Oversize Pamuklu Sweatshirt',
        quantity: 2,
        color: 'Lacivert',
        size: 'M',
        sku: 'DEMO-SKU-1',
      },
      {
        productName: 'DEMO Yüksek Bel Kot Pantolon',
        quantity: 1,
        color: 'Siyah',
        size: '40',
        sku: 'DEMO-SKU-2',
      },
    ],
    ...overrides,
  } as CargoOrder
}

export function buildEditorPreviewSource(
  orders: CargoOrder[],
  products: CargoProduct[] = [],
): EditorPreviewSource {
  const order = pickPreviewOrder(orders)
  if (!order) {
    const demo = makeDemoOrder()
    return {
      source: { data: buildLabelData(demo, undefined, undefined, {}, []), order: demo },
      isDemo: true,
    }
  }
  const data = buildLabelData(order, order.shipment, undefined, {}, products)
  return {
    source: { data: withCanonicalIdentity(data, order, products), order },
    isDemo: false,
    orderNumber: String(order.orderNumber ?? ''),
  }
}

/**
 * ÖNİZLEME KİMLİĞİ = BASKI KİMLİĞİ.
 *
 * ═══ NEDEN GEREKLİ ═══════════════════════════════════════════════════════
 * Baskı yolu, etiket verisinin üzerine kanonik kimlikleri (T.No, barkod, QR)
 * `buildSuratPrintPageModel` çözümünden KAPLAR. Önizleme bunu yapmasaydı
 * tuvalde barkod BOŞ görünür, kâğıda gerçek barkod basılırdı: operatörün
 * göremeyeceği bir ayrışma. Aynı kaplama fonksiyonu KULLANILIR — ikinci bir
 * çözüm yazmak, iki yolun zamanla ayrışmasının garantisi olurdu.
 *
 * Kanonik model çözülemiyorsa (ör. henüz gönderi yok) veri OLDUĞU GİBİ
 * kalır: uydurma kimlik ÜRETİLMEZ.
 */
function withCanonicalIdentity(
  data: LabelData,
  order: CargoOrder,
  products: CargoProduct[],
): LabelData {
  const { model } = buildSuratPrintPageModel(order, products)
  return model ? applyCanonicalPrintIdentity(data, model) : data
}

/** Taşma senaryolarını denemek için AŞIRI veri (gerçek üretim verisi DEĞİL). */
export function buildStressPreviewSource(): EditorPreviewSource {
  const demo = makeDemoOrder({
    customerName: 'DEMO — Ayşegül Hüsniye Çağatayoğlu Küçükşahinbeyzade',
    address:
      'DEMO ADRES — Cumhuriyet Mahallesi, Şehit Piyade Onbaşı Mehmet ' +
      'Akif Ersoy Caddesi No: 274/B, Gülbahçe Konakları A5 Blok, ' +
      'Kat: 12 Daire: 47, Kapı kodu 4821, Zil: Çağatayoğlu',
    items: Array.from({ length: 8 }, (_, index) => ({
      productName: `DEMO Uzun Ürün Adı Varyasyon ${index + 1} Pamuklu`,
      quantity: 1 + (index % 3),
      color: ['Lacivert', 'Siyah', 'Ekru', 'Bordo'][index % 4],
      size: ['S', 'M', 'L', 'XL'][index % 4],
      sku: `DEMO-SKU-${index + 1}`,
    })),
  } as Partial<CargoOrder>)
  return {
    source: {
      data: buildLabelData(demo, undefined, undefined, {}, []),
      order: demo,
    },
    isDemo: true,
  }
}
