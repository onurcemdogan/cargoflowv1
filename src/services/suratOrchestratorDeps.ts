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

export interface PrintResultLike {
  ok?: boolean
  jobs?: Array<{ orderNumber?: string; ok?: boolean; error?: string }>
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
      reason: String(job?.error ?? 'Baskı doğrulanmadı; durum değiştirilmedi.'),
    }))
    .filter((item) => item.orderNumber)
}

export interface CreateAdapterInput {
  callCreate: (
    orders: CargoOrder[],
    ids: string[],
  ) => Promise<{ orders: CargoOrder[] }>
  /** Create SONRASI basılabilir etiket oluştu mu (gözlemlenebilir başarı). */
  hasPrintableLabel: (order: CargoOrder) => boolean
}

// createShipments adaptörü: başarıyı sonuçtan TÜRETİR, varsaymaz.
export function buildCreateAdapter(input: CreateAdapterInput) {
  return async (orders: CargoOrder[], ids: string[]) => {
    const outcome = await input.callCreate(orders, ids)
    const next = outcome.orders ?? orders
    const failedIds: string[] = []
    const reasons: Record<string, string> = {}
    for (const id of ids) {
      const order = next.find((item) => String(item.id) === String(id))
      if (!order || !input.hasPrintableLabel(order)) {
        failedIds.push(id)
        reasons[id] =
          'Sürat gönderisi oluşturuldu sayılmadı; yazdırılabilir etiket doğrulanamadı.'
      }
    }
    return { orders: next, failedIds, reasons }
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
