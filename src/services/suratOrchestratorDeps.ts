// Orkestratör bağımlılıklarını GERÇEK servislere bağlayan adaptör.
//
// Yeni create/print iş mantığı YOKTUR. Yalnız mevcut servislerin dönüş
// şekillerini orkestratörün beklediği sözleşmeye çevirir:
//   workflowService.createShipments -> { orders, result }
//   workflowService.printLabels     -> { orders, result, printResult }
//
// BAŞARI TÜREVLERİ (gevşetme YOK):
//  - create: servis failedIds DÖNDÜRMEZ. Başarı, create SONRASI siparişin
//    gerçekten basılabilir etiketi olmasından türetilir (gözlemlenebilir
//    sinyal); "çağrı hata atmadı" başarı SAYILMAZ.
//  - print: başarı YALNIZ printResult.jobs içindeki per-job `ok` alanından
//    gelir. jobs yoksa mevcut servisin kendi kuralı uygulanır (printResult.ok
//    ise hepsi, değilse hiçbiri). printCalled/dialog açılması başarı DEĞİLDİR.
import type { CargoOrder } from '../types/cargoflow'
import {
  LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE,
  NOT_IN_PRINT_DOCUMENT_MESSAGE,
} from '../utils/suratPrintFailureReasons'

export interface PrintResultLike {
  ok?: boolean
  // KOK NEDEN (canli): gercek PrintResult job'lari sebebi `errorMessage`
  // alaninda tasir; burada YALNIZ `error` okunuyordu ve her sebep generic
  // "Baski dogrulanmadi" mesajina dusuyordu. Iki alan da kabul edilir.
  jobs?: Array<{
    orderNumber?: string
    ok?: boolean
    error?: string
    errorMessage?: string
  }>
}

// printResult -> başarıyla basıldığı DOĞRULANAN sipariş numaraları.
// Mevcut orderWorkflowService.printLabels ile AYNI kural.
export function resolvePrintedOrderNumbers(
  printResult: PrintResultLike | undefined,
  attemptedOrderNumbers: string[],
): string[] {
  if (!printResult) return []
  if (Array.isArray(printResult.jobs)) {
    return printResult.jobs
      .filter((job) => job?.ok === true)
      .map((job) => String(job?.orderNumber ?? ''))
      .filter(Boolean)
  }
  return printResult.ok === true ? [...attemptedOrderNumbers] : []
}

// printResult -> başarısız işlerin güvenli sebepleri (PII yok).
export function resolvePrintSkips(
  printResult: PrintResultLike | undefined,
): Array<{ orderNumber: string; reason: string }> {
  const jobs = printResult?.jobs
  if (!Array.isArray(jobs)) return []
  return jobs
    .filter((job) => job?.ok !== true)
    .map((job) => ({
      orderNumber: String(job?.orderNumber ?? ''),
      reason: String(
        job?.errorMessage ?? job?.error ?? NOT_IN_PRINT_DOCUMENT_MESSAGE,
      ),
    }))
    .filter((item) => item.orderNumber)
}

/** Mevcut create servisinin sipariş başına özeti (orderWorkflowService). */
export interface CreateServiceDebugLike {
  failedOrderNumbers?: string[]
  skippedOrderNumbers?: string[]
  /** `${orderNumber}: ${sebep}` biçiminde. */
  skippedReasons?: string[]
}

export interface CreateAdapterInput {
  callCreate: (
    orders: CargoOrder[],
    ids: string[],
  ) => Promise<{ orders: CargoOrder[]; result?: { bulkActionDebug?: CreateServiceDebugLike } }>
  /** Create SONRASI basılabilir etiket oluştu mu (gözlemlenebilir başarı). */
  hasPrintableLabel: (order: CargoOrder) => boolean
  /**
   * Create yanıtı etiketi HENÜZ göstermiyorsa çalıştırılan SINIRLI ve
   * kontrollü doğrulama (mevcut güvenli okuma yolu). Sabit sleep ile başarı
   * VARSAYILMAZ; yalnız bir kez denenir ve provider'a ÇIKILMAZ.
   * Güncel sipariş listesini döndürür.
   */
  verifyAfterCreate?: (
    orders: CargoOrder[],
    ids: string[],
  ) => Promise<CargoOrder[]>
  /**
   * Doğrulamayı ORKESTRATÖRE bırak: etiketi yanıtta görünmeyen siparişler
   * `unverifiedIds` olarak döner ve tüm çalışma için TEK toplu kayıtlı-etiket
   * okuması yapılır (sipariş başına ayrı tur YOK).
   */
  deferVerification?: boolean
}

function reasonFromSkipped(lines: string[] | undefined, orderNumber: string): string | null {
  const prefix = `${orderNumber}: `
  const line = (lines ?? []).find((item) => String(item).startsWith(prefix))
  return line ? String(line).slice(prefix.length).trim() || null : null
}

// createShipments adaptörü: başarıyı sonuçtan TÜRETİR, varsaymaz.
export function buildCreateAdapter(input: CreateAdapterInput) {
  const missing = (list: CargoOrder[], ids: string[]) =>
    ids.filter((id) => {
      const order = list.find((item) => String(item.id) === String(id))
      return !order || !input.hasPrintableLabel(order)
    })

  return async (orders: CargoOrder[], ids: string[]) => {
    const outcome = await input.callCreate(orders, ids)
    let next = outcome.orders ?? orders
    const debug = outcome.result?.bulkActionDebug
    const skippedNumbers = new Set(debug?.skippedOrderNumbers ?? [])
    const failedNumbers = new Set(debug?.failedOrderNumbers ?? [])
    const failedIds: string[] = []
    const skippedIds: string[] = []
    const reasons: Record<string, string> = {}

    // SERVİSİN KENDİ KARARI KAYBOLMAZ. Etiket oluştuysa başarı (mevcut
    // kural); servis siparişi AĞA ÇIKMADAN atladıysa "atlandı" + gerekçe;
    // create reddedildiyse "başarısız" + servis mesajı. Generic "etiket
    // doğrulanamadı" YALNIZ gerçekten belirsiz kalan create içindir.
    let pending = missing(next, ids).filter((id) => {
      const order = next.find((item) => String(item.id) === String(id))
        ?? orders.find((item) => String(item.id) === String(id))
      const orderNumber = String(order?.orderNumber ?? '')
      if (orderNumber && skippedNumbers.has(orderNumber)) {
        skippedIds.push(id)
        reasons[id] = reasonFromSkipped(debug?.skippedReasons, orderNumber)
          ?? 'Sipariş create için uygun değil; gönderi oluşturulmadı.'
        return false
      }
      if (orderNumber && failedNumbers.has(orderNumber)) {
        failedIds.push(id)
        reasons[id] = String(order?.errorMessage ?? '').trim()
          || 'Sürat gönderisi oluşturulamadı.'
        return false
      }
      return true
    })

    if (pending.length > 0 && input.deferVerification) {
      return { orders: next, failedIds, skippedIds, unverifiedIds: pending, reasons }
    }
    // Create yanıtı etiketi henüz göstermiyorsa TEK ve sınırlı doğrulama.
    // Sabit bekleme YOK; doğrulama da başarısızsa sipariş failed sayılır.
    if (pending.length > 0 && input.verifyAfterCreate) {
      try {
        next = (await input.verifyAfterCreate(next, pending)) ?? next
      } catch {
        // Doğrulama başarısızsa create başarı SAYILMAZ.
      }
      pending = missing(next, pending)
    }
    for (const id of pending) {
      failedIds.push(id)
      reasons[id] = LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE
    }
    return { orders: next, failedIds, skippedIds, reasons }
  }
}

export interface PrintAdapterInput {
  callPrint: (
    orders: CargoOrder[],
    ids: string[],
  ) => Promise<{ orders: CargoOrder[]; printResult?: PrintResultLike }>
}

// printLabels adaptörü: başarı YALNIZ per-job onaydan gelir.
export function buildPrintAdapter(input: PrintAdapterInput) {
  return async (orders: CargoOrder[], ids: string[]) => {
    const attempted = ids
      .map((id) => orders.find((item) => String(item.id) === String(id)))
      .filter(Boolean)
      .map((order) => String((order as CargoOrder).orderNumber ?? ''))
    const outcome = await input.callPrint(orders, ids)
    return {
      orders: outcome.orders ?? orders,
      printedOrderNumbers: resolvePrintedOrderNumbers(
        outcome.printResult,
        attempted,
      ),
      skipped: resolvePrintSkips(outcome.printResult),
    }
  }
}
