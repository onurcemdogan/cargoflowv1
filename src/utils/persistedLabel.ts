import type { CargoOrder } from '../types/cargoflow'
import { buildPrintableJob } from './printableLabelJob'

// BASILABİLİR ÇIKTIYI İSTEMCİ SEÇMEZ — SUNUCU KARAR VERİR.
//
// ═══ NEDEN DEĞİŞTİ ═══════════════════════════════════════════════════════
//
// Eskiden bu çözümleyici basılacak ZPL'i şu zincirden SEÇİYORDU:
//   shipment.barcodeRaw → shipment.technicalZpl → suratCreateLog.BarcodeRaw
//
// Bu alanlar TAŞIYICI KAYNAKTIR (carrier SOURCE), BASILABİLİR ÇIKTI DEĞİL.
// Aradaki fark üretimde şuna yol açıyordu: ürün detay sayfası üretilemeyen
// bir siparişte istemci kaynağı bulup TEK SAYFA basıyor, depo ürün bilgisini
// kaybediyordu. Aynı şekilde composer'lı kalıcı paket varken istemci ESKİ
// kaynağı seçebiliyordu.
//
// Artık karar SUNUCUNUNDUR (bkz. resolvePrintableLabelForServing):
//   kalıcı tam paket > hydration > doğrulanmış taşıyıcı fallback > BLOCK
//
// İstemci yalnız sunucunun verdiği sözleşmeyi UYGULAR. Kaynak alanlar
// silinmez ve teşhis/doğrulama için yerinde kalır; sadece BASILABİLİR ÇIKTI
// olarak SEÇİLMEZ.
export interface PersistedLabelArtifact {
  hasPrintableLabel: boolean
  /**
   * HER ZAMAN null.
   *
   * İstemci basılabilir ZPL'i kaynaktan SEÇMEZ. Alan, çağıranların
   * "sunucudan getirilmeli mi?" kararını mevcut biçimde vermeye devam
   * edebilmesi için korunur.
   */
  zpl: null
  source: string
}

/**
 * İstemci tarafındaki TAŞIYICI KAYNAK alanları.
 *
 * Sunucu "basılamaz" dediğinde bu alanlar ETKİN sipariş kopyasından
 * temizlenir; aksi halde aşağıdaki tüketicilerden biri (print eligibility,
 * printable label, verification) kaynağı bulup basılabilir sanır.
 * KALICI VERİ DEĞİŞMEZ: yalnız bellekteki kopya temizlenir.
 */
const CLIENT_SOURCE_ZPL_PATHS = [
  ['barcodeRaw'],
  ['technicalZpl'],
  ['suratCreateLog', 'BarcodeRaw'],
  ['suratCreateLog', 'technicalZpl'],
  ['suratCreateResponseParsed', 'BarcodeRaw'],
] as const

/** Sunucunun basılabilirlik sözleşmesi — istemci bunu ÜRETMEZ, UYGULAR. */
export interface ServerPrintContract {
  carrierPrintReady: boolean
  printArtifactStatus: 'ready' | 'failed' | 'fallback_carrier'
  productDetailStatus: 'none' | 'ready' | 'failed'
  productDetailFailureReason?: string
  zpl: string | null
  desi: number | null
  supplementalLabels: Array<{
    page: number
    totalPages: number
    zpl: string
    sha256?: string
  }>
}

// Reprint (kayıtlı etiketi yeniden yazdırma) uygun mu? Canonical operasyon
// durumu LABEL_READY/LABEL_PRINTED VE yazdırılabilir etiket bayrağı/artifact'i
// olmalı. Fresh-create (henüz etiketi olmayan) siparişler bu kapıdan GEÇMEZ.
export function isReprintEligible(order: CargoOrder): boolean {
  const status = String(order.operationStatus ?? '').toUpperCase()
  const hasLabel =
    order.hasPrintableLabel === true || Boolean(order.shipment?.barcodeRaw)
  return (status === 'LABEL_READY' || status === 'LABEL_PRINTED') && hasLabel
}

/**
 * Siparişte KAYITLI bir etiket VAR MI sorusunu cevaplar.
 *
 * Basılabilir ZPL SEÇMEZ (`zpl` her zaman null): baskıya gidecek baytlara
 * sunucu karar verir. Kaynak alanların varlığı burada yalnız "etiket var"
 * İPUCU olarak okunur — çıktı olarak DEĞİL.
 */
export function resolvePersistedLabelArtifact(
  order: CargoOrder,
): PersistedLabelArtifact {
  const shipment = order.shipment
  const hasSourceHint = CLIENT_SOURCE_ZPL_PATHS.some((path) => {
    const value = path.reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      shipment,
    )
    return typeof value === 'string' && value.trim().length > 0
  })
  const hasPrintableLabel = order.hasPrintableLabel === true || hasSourceHint
  return {
    hasPrintableLabel,
    // BASILABİLİR ÇIKTI İSTEMCİDEN SEÇİLMEZ.
    zpl: null,
    source: hasPrintableLabel ? 'pending-fetch' : 'none',
  }
}

/**
 * Taşıyıcı KAYNAK alanlarını ETKİN sipariş kopyasından temizler.
 *
 * Sunucu "basılamaz" dediğinde çağrılır. Amaç tek: aşağı akıştaki hiçbir
 * tüketicinin kaynağı bulup basılabilir sanmaması. Kalıcı veri DEĞİŞMEZ.
 */
export function stripClientPrintSources(order: CargoOrder): CargoOrder {
  const shipment = { ...((order.shipment ?? {}) as Record<string, unknown>) }
  for (const [head, tail] of CLIENT_SOURCE_ZPL_PATHS) {
    if (tail === undefined) {
      delete shipment[head]
      continue
    }
    const nested = shipment[head]
    if (nested && typeof nested === 'object') {
      const copy = { ...(nested as Record<string, unknown>) }
      delete copy[tail]
      shipment[head] = copy
    }
  }
  shipment.zplReady = false
  shipment.printEnabled = false
  return { ...order, shipment } as unknown as CargoOrder
}

/**
 * SUNUCU SÖZLEŞMESİNİ UYGULAR — istemci kendi kararını üretmez.
 *
 *  - `carrierPrintReady` ve taşıyıcı baytlar varsa: baytlar enjekte edilir ve
 *    sunucunun SAYFA SIRASI (taşıyıcı önce, ek sayfalar 1..N) tek canonical
 *    kurucudan geçirilerek korunur.
 *  - Aksi halde: kaynak temizlenir. `technicalZpl` mevcut diye sunucunun
 *    "basılamaz" kararı EZİLMEZ.
 *
 * FAIL-OPEN: `productDetailStatus === 'failed'` ana etiketi ENGELLEMEZ.
 * Ürün detayının eksikliği uyarı olarak taşınır, baskı kapısı değildir.
 */
export function applyServerPrintContract(
  order: CargoOrder,
  contract: ServerPrintContract | null,
): CargoOrder {
  if (!contract || !contract.carrierPrintReady || !contract.zpl?.trim()) {
    return stripClientPrintSources(order)
  }
  // Sayfa sırası ve tamlığı TEK canonical kurucudan doğrulanır; istemci
  // kendi birleştirme mantığını YAZMAZ.
  const job = buildPrintableJob({
    carrierZpl: contract.zpl,
    supplementalLabels: contract.supplementalLabels,
  })
  if (!job.printReady) return stripClientPrintSources(order)

  const withZpl = injectPersistedZpl(order, contract.zpl, contract.desi)
  return {
    ...withZpl,
    shipment: {
      ...(withZpl.shipment ?? {}),
      // Sunucu yetkili baskı paketi — sıra KORUNUR (taşıyıcı ilk).
      printBundle: {
        pages: job.pages.map((page) => ({
          kind: page.kind,
          page: page.page,
          zpl: page.zpl,
        })),
        labelPageCount: job.labelPageCount,
        productDetailPageCount: job.productDetailPageCount,
        printArtifactStatus: contract.printArtifactStatus,
        productDetailStatus: contract.productDetailStatus,
        ...(contract.productDetailFailureReason
          ? { productDetailFailureReason: contract.productDetailFailureReason }
          : {}),
      },
    },
  } as CargoOrder
}

// Kayıtlı ham ZPL'i (ve varsa kalıcı desiyi) sipariş nesnesine enjekte eder
// (immutable kopya). Uçtan gelen ZPL, order.shipment.barcodeRaw'a yazılır; böylece
// mevcut print/eligibility zinciri taşıyıcı-ZPL (carrier_zpl) yolunu kullanır ve
// desi İSTEMEZ. Kalıcı desi de order.desi'ye yansıtılır ki reprint etiketinin
// "Top Ds/Kg" alanı orijinal değeri korusun (reload sonrası "-" olmasın). Order'da
// zaten geçerli bir desi varsa KORUNUR (overwrite yok).
export function injectPersistedZpl(
  order: CargoOrder,
  zpl: string,
  desi: number | null = null,
): CargoOrder {
  const existingDesi =
    typeof order.desi === 'number' && Number.isFinite(order.desi) && order.desi > 0
      ? order.desi
      : null
  const resolvedDesi = existingDesi ?? (desi != null && desi > 0 ? desi : null)
  return {
    ...order,
    hasPrintableLabel: true,
    ...(resolvedDesi != null ? { desi: resolvedDesi } : {}),
    shipment: {
      ...(order.shipment ?? {}),
      barcodeRaw: zpl,
      zplReady: true,
      printEnabled: true,
      ...(resolvedDesi != null ? { desi: resolvedDesi } : {}),
    },
  } as CargoOrder
}
