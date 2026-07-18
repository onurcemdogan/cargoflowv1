import type {
  CargoOrder,
  DesiDebug,
  DesiSource,
  Shipment,
} from '../types/cargoflow'

export interface NormalizedDesi {
  desi: number | null
  desiSource: DesiSource | null
  weightKg: number | null
  packageCount: number
  productDesi: number | null
  calculatedDesi: number | null
  manualDesi: number | null
  apiRequestDesi: number | null
  apiResponseDesi: number | null
}

export function resolveNormalizedDesi(
  order?: CargoOrder,
  shipment: Shipment | undefined = order?.shipment,
): NormalizedDesi {
  const source = order?.desiSource ?? shipment?.desiSource ?? null
  const orderDesi = positiveNumber(order?.desi)
  const shipmentDesi = positiveNumber(shipment?.desi)
  // Manuel giriş = TOPLAM koli desisi (quantity ile tekrar çarpılmaz).
  const manualDesi =
    source === 'manual' ||
    source === 'manual_total' ||
    (!source && orderDesi != null)
      ? orderDesi ?? shipmentDesi
      : null
  // Ürün bazlı desi = sum(quantity × satır birim desisi). Eski davranış
  // (ilk ürünün desisini tüm siparişe yazmak) çok ürünlü siparişlerde
  // yanlıştı; herhangi bir satırın birim desisi yoksa toplam HESAPLANMAZ.
  const productDesi = firstNumber(
    source === 'product' || source === 'product_lines'
      ? orderDesi ?? shipmentDesi
      : null,
    sumOrderLineDesi(order?.items),
  )
  const weightKg = firstNumber(
    positiveNumber(order?.weightKg),
    positiveNumber(shipment?.weightKg),
    positiveNumber(readRecordNumber(order, 'kg')),
    ...((order?.items ?? []).map((item) => positiveNumber(item.weightKg))),
  )
  const calculatedDesi = firstNumber(
    source === 'calculated' ? orderDesi : null,
    calculatePackageDesi(order, weightKg),
  )
  const apiRequestDesi = firstNumber(
    positiveNumber(shipment?.apiRequestDesi),
    positiveNumber(
      readNested(shipment?.suratCreateLog?.rawRequest, ['BirimDesi']),
    ),
    positiveNumber(
      readNested(shipment?.suratCreateLog?.rawRequest, ['Desi']),
    ),
  )
  const apiResponseDesi = firstNumber(
    positiveNumber(shipment?.apiResponseDesi),
    positiveNumber(
      readNested(shipment?.suratCreateLog?.parsedResponse, ['BirimDesi']),
    ),
    positiveNumber(
      readNested(shipment?.suratCreateLog?.parsedResponse, ['Desi']),
    ),
    positiveNumber(readNested(shipment?.rawResponse, ['BirimDesi'])),
    positiveNumber(readNested(shipment?.rawResponse, ['Desi'])),
  )
  const apiDesi = firstNumber(
    source === 'api' ? orderDesi ?? shipmentDesi : null,
    apiResponseDesi,
    apiRequestDesi,
  )

  if (manualDesi != null) {
    return result(
      manualDesi,
      source === 'manual_total' ? 'manual_total' : 'manual',
    )
  }
  if (productDesi != null) {
    return result(
      productDesi,
      source === 'product' ? 'product' : 'product_lines',
    )
  }
  if (calculatedDesi != null) {
    return result(calculatedDesi, 'calculated')
  }
  if (apiDesi != null) {
    return result(apiDesi, 'api')
  }
  return result(null, null)

  function result(
    desi: number | null,
    desiSource: DesiSource | null,
  ): NormalizedDesi {
    return {
      desi,
      desiSource,
      weightKg,
      packageCount: Math.max(
        1,
        Math.round(positiveNumber(order?.packageCount) ?? 1),
      ),
      productDesi,
      calculatedDesi,
      manualDesi,
      apiRequestDesi,
      apiResponseDesi,
    }
  }
}

export function buildDesiDebug(
  order: CargoOrder,
  finalDesi: NormalizedDesi,
  zplPrintedDesi: number | null = finalDesi.desi,
): DesiDebug {
  return {
    orderId: order.id,
    productDesi: finalDesi.productDesi,
    calculatedDesi: finalDesi.calculatedDesi,
    manualDesi: finalDesi.manualDesi,
    apiRequestDesi: finalDesi.apiRequestDesi,
    apiResponseDesi: finalDesi.apiResponseDesi,
    finalNormalizedDesi: finalDesi.desi,
    zplPrintedDesi,
    desiSource: finalDesi.desiSource,
  }
}

export function extractZplDesi(zpl?: string): number | null {
  const value = String(zpl ?? '')
  if (!value) return null
  const labelIndex = value.toLocaleLowerCase('tr-TR').indexOf('top ds/kg')
  if (labelIndex < 0) return null
  const afterLabel = value.slice(labelIndex)
  const fields = Array.from(afterLabel.matchAll(/\^FD([^^]*?)\^FS/gi))
  for (const field of fields.slice(0, 4)) {
    const parsed = positiveNumber(field[1])
    if (parsed != null) return parsed
  }
  return null
}

export function desiValuesDiffer(
  left: number | null,
  right: number | null,
): boolean {
  return left != null && right != null && Math.abs(left - right) > 0.009
}

export function formatDesi(value: number | null): string {
  return value == null ? '-' : value.toFixed(2)
}

// Satır verisinden kayıpsız toplam: her sayılan satırın (adet>0, tekrar
// etmeyen id) kendi birim desisi olmalı; aksi halde null döner ve üst
// katman tenant konfigürasyonlu tam hesabı (calculateOrderDesi) veya
// manuel girişi bekler.
function sumOrderLineDesi(
  items: CargoOrder['items'] | undefined,
): number | null {
  const seen = new Set<string>()
  let total = 0
  let counted = 0
  for (const [index, item] of (items ?? []).entries()) {
    const lineId = String(item.id ?? `line-${index}`)
    if (seen.has(lineId)) continue
    seen.add(lineId)
    const quantity = Math.max(0, Math.round(Number(item.quantity) || 0))
    if (quantity <= 0) continue
    const unit = firstNumber(
      positiveNumber(item.desi),
      positiveNumber(readNested(item.rawLine, ['dimensionalWeight'])),
      positiveNumber(readNested(item.rawLine, ['desi'])),
    )
    if (unit == null) return null
    total += quantity * unit
    counted += 1
  }
  return counted > 0 ? roundDesi(total) : null
}

function calculatePackageDesi(
  order: CargoOrder | undefined,
  weightKg: number | null,
): number | null {
  const itemValues = (order?.items ?? []).map((item) => {
    const length = firstNumber(
      positiveNumber(item.lengthCm),
      positiveNumber(readNested(item.rawLine, ['length'])),
      positiveNumber(readNested(item.rawLine, ['lengthCm'])),
    )
    const width = firstNumber(
      positiveNumber(item.widthCm),
      positiveNumber(readNested(item.rawLine, ['width'])),
      positiveNumber(readNested(item.rawLine, ['widthCm'])),
    )
    const height = firstNumber(
      positiveNumber(item.heightCm),
      positiveNumber(readNested(item.rawLine, ['height'])),
      positiveNumber(readNested(item.rawLine, ['heightCm'])),
    )
    if (length == null || width == null || height == null) return null
    return (length * width * height * Math.max(1, item.quantity || 1)) / 3000
  })
  const volumetric = itemValues.every((value) => value == null)
    ? null
    : itemValues.reduce<number>(
        (total, value) => total + (value ?? 0),
        0,
      )
  const calculated = Math.max(volumetric ?? 0, weightKg ?? 0)
  return calculated > 0 ? roundDesi(calculated) : null
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'string') {
    value = value.trim().replace(',', '.')
  }
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? roundDesi(number) : null
}

function firstNumber(...values: Array<number | null>): number | null {
  return values.find((value) => value != null) ?? null
}

function roundDesi(value: number): number {
  return Math.round(value * 100) / 100
}

function readRecordNumber(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function readNested(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readNested(item, keys)
      if (found != null && found !== '') return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const [key, item] of Object.entries(record)) {
    if (
      keys.some(
        (candidate) =>
          candidate.toLocaleLowerCase('tr-TR') ===
          key.toLocaleLowerCase('tr-TR'),
      )
    ) {
      return item
    }
    const nested = readNested(item, keys)
    if (nested != null && nested !== '') return nested
  }
  return undefined
}
