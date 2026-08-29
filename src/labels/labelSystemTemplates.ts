// SİSTEM ŞABLONLARI — SALT OKUNUR BAŞLANGIÇ NOKTALARI.
//
// Kiracı bunları DEĞİŞTİREMEZ; "Kopyala" ile kendi özel şablonunu üretir.
// Böylece bir kiracının düzenlemesi diğerlerinin etiketini ETKİLEYEMEZ ve
// operatör her zaman bilinen-iyi bir yerleşime geri dönebilir.
//
// Koordinatlar MİLİMETREDİR ve 100×100 mm tuvale göredir.

import type { LabelDocument, LabelElement } from './labelDocument.ts'

function element(
  id: string,
  type: LabelElement['type'],
  rect: [number, number, number, number],
  extra: Partial<LabelElement> = {},
): LabelElement {
  const [x, y, width, height] = rect
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    visible: true,
    z: 0,
    ...extra,
  }
}

const classic: LabelDocument = {
  schemaVersion: 1,
  id: 'surat-classic-100x100',
  name: 'Sürat Kargo Klasik 10×10',
  elements: [
    element('recipient', 'recipientName', [4, 4, 92, 7], {
      fontSize: 13,
      bold: true,
      z: 1,
    }),
    element('phone', 'phone', [4, 11.5, 92, 5], { fontSize: 9, z: 2 }),
    element('address', 'address', [4, 17, 92, 18], {
      fontSize: 9,
      wrap: true,
      maxLines: 4,
      lineHeight: 1.25,
      z: 3,
    }),
    element('city', 'cityDistrict', [4, 36, 92, 7], {
      fontSize: 12,
      bold: true,
      align: 'left',
      z: 4,
    }),
    element('barcode', 'barcode', [4, 45, 92, 18], {
      showHumanReadable: true,
      z: 5,
    }),
    element('tracking', 'trackingText', [4, 64, 92, 6], {
      fontSize: 10,
      align: 'center',
      z: 6,
    }),
    element('order-no', 'orderNumber', [4, 71, 70, 5], { fontSize: 8, z: 7 }),
    element('qr', 'qr', [78, 71, 18, 18], { z: 8 }),
    // 4 SATIR: iki ürünlü gerçek bir sipariş (her biri sarınca 2 satır)
    // varsayılan şablonda TAŞMAMALIDIR. Varsayılanın gerçek veriyle
    // ihlal üretmesi, muhafızı ilk günden gürültüye çevirirdi.
    element('products', 'productList', [4, 77, 70, 14], {
      fontSize: 7,
      wrap: true,
      maxLines: 4,
      lineHeight: 1.2,
      z: 9,
    }),
    element('cargo-meta', 'cargoMeta', [4, 92, 92, 5], { fontSize: 8, z: 10 }),
  ],
}

const largeBarcode: LabelDocument = {
  schemaVersion: 1,
  id: 'surat-large-barcode',
  name: 'Sürat Kargo Büyük Barkod',
  elements: [
    element('barcode', 'barcode', [4, 4, 92, 26], {
      showHumanReadable: true,
      z: 1,
    }),
    element('tracking', 'trackingText', [4, 31, 92, 7], {
      fontSize: 13,
      bold: true,
      align: 'center',
      z: 2,
    }),
    element('recipient', 'recipientName', [4, 40, 92, 7], {
      fontSize: 12,
      bold: true,
      z: 3,
    }),
    element('address', 'address', [4, 48, 92, 20], {
      fontSize: 9,
      wrap: true,
      maxLines: 5,
      lineHeight: 1.25,
      z: 4,
    }),
    element('city', 'cityDistrict', [4, 69, 74, 7], {
      fontSize: 12,
      bold: true,
      z: 5,
    }),
    element('qr', 'qr', [80, 69, 16, 16], { z: 6 }),
    element('products', 'productList', [4, 77, 72, 12], {
      fontSize: 7,
      wrap: true,
      maxLines: 4,
      z: 7,
    }),
    element('cargo-meta', 'cargoMeta', [4, 90, 92, 5], { fontSize: 8, z: 8 }),
  ],
}

const minimal: LabelDocument = {
  schemaVersion: 1,
  id: 'minimal-ecommerce',
  name: 'Minimal E-Ticaret',
  elements: [
    element('recipient', 'recipientName', [5, 6, 90, 8], {
      fontSize: 14,
      bold: true,
      z: 1,
    }),
    element('address', 'address', [5, 15, 90, 22], {
      fontSize: 10,
      wrap: true,
      maxLines: 5,
      lineHeight: 1.3,
      z: 2,
    }),
    element('city', 'cityDistrict', [5, 38, 90, 8], {
      fontSize: 13,
      bold: true,
      z: 3,
    }),
    element('barcode', 'barcode', [5, 50, 90, 22], {
      showHumanReadable: true,
      z: 4,
    }),
    element('tracking', 'trackingText', [5, 73, 90, 6], {
      fontSize: 10,
      align: 'center',
      z: 5,
    }),
    element('products', 'productList', [5, 81, 90, 13], {
      fontSize: 8,
      wrap: true,
      maxLines: 3,
      z: 6,
    }),
  ],
}

const trendyol: LabelDocument = {
  schemaVersion: 1,
  id: 'trendyol-compatible',
  name: 'Trendyol Uyumlu',
  elements: [
    element('marketplace', 'marketplace', [4, 4, 50, 6], {
      fontSize: 10,
      bold: true,
      z: 1,
    }),
    element('order-no', 'orderNumber', [56, 4, 40, 6], {
      fontSize: 9,
      align: 'right',
      z: 2,
    }),
    element('recipient', 'recipientName', [4, 12, 92, 7], {
      fontSize: 12,
      bold: true,
      z: 3,
    }),
    element('address', 'address', [4, 20, 92, 18], {
      fontSize: 9,
      wrap: true,
      maxLines: 4,
      z: 4,
    }),
    element('city', 'cityDistrict', [4, 39, 92, 7], {
      fontSize: 12,
      bold: true,
      z: 5,
    }),
    element('barcode', 'barcode', [4, 48, 92, 20], {
      showHumanReadable: true,
      z: 6,
    }),
    element('tracking', 'trackingText', [4, 69, 74, 6], {
      fontSize: 10,
      z: 7,
    }),
    element('qr', 'qr', [80, 69, 16, 16], { z: 8 }),
    element('products', 'productList', [4, 76, 72, 15], {
      fontSize: 7,
      wrap: true,
      maxLines: 4,
      z: 9,
    }),
    element('package-id', 'packageId', [4, 92, 72, 5], { fontSize: 8, z: 10 }),
  ],
}

export const SYSTEM_LABEL_TEMPLATES: readonly LabelDocument[] = [
  classic,
  largeBarcode,
  minimal,
  trendyol,
]

export const DEFAULT_SYSTEM_TEMPLATE_ID = classic.id

export function findSystemTemplate(id: string): LabelDocument | null {
  return (
    SYSTEM_LABEL_TEMPLATES.find((template) => template.id === id) ?? null
  )
}

/** Derin kopya — sistem şablonu ASLA yerinde değiştirilemez. */
export function cloneDocument(
  document: LabelDocument,
  overrides: { id?: string; name?: string; basedOn?: string } = {},
): LabelDocument {
  return {
    schemaVersion: document.schemaVersion,
    id: overrides.id ?? document.id,
    name: overrides.name ?? document.name,
    basedOn: overrides.basedOn ?? document.basedOn,
    elements: document.elements.map((element) => ({ ...element })),
  }
}
