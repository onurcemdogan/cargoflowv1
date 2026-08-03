// "Sürat Etiketi Oluştur ve Yazdır" — orkestratör.
//
// YENİ create/print iş mantığı YAZMAZ. Mevcut servisleri sırayla çağırır:
//   resolveSuratCreateAndPrintPlan (saf plan)
//     → createShipments   (mevcut Sürat create, idempotency korunur)
//     → printLabels       (mevcut baskı + per-job onay sözleşmesi)
//
// BAŞARI SÖZLEŞMESİ: bir sipariş ancak mevcut printLabels'ın per-job `ok`
// sonucuyla basılmış sayılır. window.print() çağrılması, dialog açılması veya
// printCalled=true TEK BAŞINA başarı DEĞİLDİR — bu modül yeni ve daha gevşek
// bir "başarılı say" kuralı TANIMLAMAZ.
//
// GİZLİLİK: sonuçta müşteri adı/adres/telefon YOKTUR; yalnız sipariş numarası,
// aşama ve güvenli sebep.
import type { CargoOrder } from '../types/cargoflow'
import {
  resolveSuratCreateAndPrintPlan,
  type PlanPreflightInput,
  type SuratCreatePrintStage,
} from '../utils/suratCreatePrintPlan'

export const SURAT_CREATE_CONCURRENCY = 2

export interface OrchestratorProgress {
  phase: 'preflight' | 'create' | 'prepare' | 'print' | 'done'
  completed: number
  total: number
}

export interface OrderOutcome {
  orderIdentity: string
  orderNumber: string
  stage: SuratCreatePrintStage | 'PRINTED' | 'PRINT_FAILED'
  success: boolean
  reason?: string
}

export interface OrchestratorResult {
  selectedCount: number
  created: number
  existingReady: number
  reprinted: number
  printed: number
  skipped: Array<{ orderNumber: string; reason: string }>
  failed: Array<{ orderNumber: string; reason: string }>
  results: OrderOutcome[]
  /** Baskısı doğrulanan siparişlerin id'leri (seçimden çıkarmak için). */
  printedOrderIds: string[]
  orders: CargoOrder[]
}

export interface OrchestratorDeps {
  preflight: PlanPreflightInput
  /** Mevcut create servisi (idempotency ve operation kayıtları korunur). */
  createShipments: (
    orders: CargoOrder[],
    ids: string[],
  ) => Promise<{ orders: CargoOrder[]; failedIds?: string[]; reasons?: Record<string, string> }>
  /** Mevcut baskı servisi; per-job onay sözleşmesini UYGULAR. */
  printLabels: (
    orders: CargoOrder[],
    ids: string[],
  ) => Promise<{
    orders: CargoOrder[]
    printedOrderNumbers?: string[]
    skipped?: Array<{ orderNumber: string; reason: string }>
  }>
  onProgress?: (progress: OrchestratorProgress) => void
  /**
   * Create aşaması bittiğinde GÜNCEL sipariş listesi. Kullanıcı manuel
   * "Seçilenleri Yenile" yapmak zorunda kalmasın diye UI aynı run içinde
   * tazelenir. Seçim snapshot'ı BU AŞAMADA DEĞİŞTİRİLMEZ.
   */
  onOrdersUpdated?: (orders: CargoOrder[]) => void
}

// Kontrollü eşzamanlılık: en fazla `limit` iş aynı anda. Bir işin hatası
// diğerlerini DURDURMAZ (hata sonuç olarak taşınır).
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        out[index] = await worker(items[index])
      }
    },
  )
  await Promise.all(runners)
  return out
}

// PlanEntry -> OrderOutcome (identity alan adi orderIdentity'ye eslenir).
function outcomeOf(
  entry: { orderId: string; orderNumber: string; identity: string },
  stage: OrderOutcome['stage'],
  success: boolean,
  reason?: string,
): OrderOutcome {
  return {
    orderIdentity: entry.identity,
    orderNumber: entry.orderNumber,
    stage,
    success,
    ...(reason ? { reason } : {}),
  }
}

export async function runSuratCreateAndPrint(
  selectedOrders: CargoOrder[],
  allOrders: CargoOrder[],
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const report = (progress: OrchestratorProgress) => deps.onProgress?.(progress)

  // A/B/C — seçim snapshot'ı + preflight + plan (MUTASYONDAN ÖNCE).
  const plan = resolveSuratCreateAndPrintPlan(selectedOrders, deps.preflight)
  report({ phase: 'preflight', completed: plan.uniqueCount, total: plan.uniqueCount })

  const results: OrderOutcome[] = []
  const skipped: Array<{ orderNumber: string; reason: string }> = []
  const failed: Array<{ orderNumber: string; reason: string }> = []

  for (const entry of plan.blocked) {
    const reason = entry.reason ?? 'Ön kontrol başarısız.'
    skipped.push({ orderNumber: entry.orderNumber, reason })
    results.push(outcomeOf(entry, 'PREFLIGHT_BLOCKED', false, reason))
  }
  for (const entry of plan.inFlight) {
    const reason = 'Bu sipariş için süren bir işlem var; ikinci istek açılmadı.'
    skipped.push({ orderNumber: entry.orderNumber, reason })
    results.push(outcomeOf(entry, 'CREATE_IN_PROGRESS', false, reason))
  }

  // D — YALNIZ needsCreate grubunda create. En fazla 2 eşzamanlı mutasyon.
  let workingOrders = allOrders
  let created = 0
  const createdIds: string[] = []
  if (plan.needsCreate.length > 0) {
    let done = 0
    report({ phase: 'create', completed: 0, total: plan.needsCreate.length })
    const batches = await mapWithLimit(
      plan.needsCreate,
      SURAT_CREATE_CONCURRENCY,
      async (entry) => {
        try {
          const outcome = await deps.createShipments(workingOrders, [entry.orderId])
          workingOrders = outcome.orders ?? workingOrders
          const failedId = (outcome.failedIds ?? []).includes(entry.orderId)
          return {
            entry,
            ok: !failedId,
            reason: failedId
              ? outcome.reasons?.[entry.orderId] ?? 'Sürat gönderisi oluşturulamadı.'
              : undefined,
          }
        } catch (error) {
          // Bir create hatası DİĞER siparişleri durdurmaz.
          return {
            entry,
            ok: false,
            reason: error instanceof Error ? error.message : 'Sürat çağrısı başarısız.',
          }
        } finally {
          done += 1
          report({ phase: 'create', completed: done, total: plan.needsCreate.length })
        }
      },
    )
    for (const item of batches) {
      if (item.ok) {
        created += 1
        createdIds.push(item.entry.orderId)
        results.push(outcomeOf(item.entry, 'LABEL_READY', true))
      } else {
        const reason = item.reason ?? 'Sürat gönderisi oluşturulamadı.'
        failed.push({ orderNumber: item.entry.orderNumber, reason })
        results.push(outcomeOf(item.entry, 'CREATE_REQUIRED', false, reason))
      }
    }
  }

  // Create bitti: UI aynı run içinde canonical duruma (Etiket Hazır, T.No)
  // taşınır. Seçim ve sonuç paneli baskı kesinleşene kadar DEĞİŞMEZ.
  if (plan.needsCreate.length > 0) deps.onOrdersUpdated?.(workingOrders)

  // E — basılabilir küme: yeni oluşturulanlar + hazır + reprint.
  const printableIds = [
    ...createdIds,
    ...plan.readyToPrint.map((e) => e.orderId),
    ...plan.reprint.map((e) => e.orderId),
  ]
  report({ phase: 'prepare', completed: printableIds.length, total: printableIds.length })

  // Hiç basılabilir sipariş yoksa baskı dialogu AÇILMAZ.
  if (printableIds.length === 0) {
    report({ phase: 'done', completed: 0, total: 0 })
    return {
      selectedCount: plan.uniqueCount,
      created,
      existingReady: plan.readyToPrint.length,
      reprinted: 0,
      printed: 0,
      skipped, failed, results,
      printedOrderIds: [],
      orders: workingOrders,
    }
  }

  // F/G — mevcut baskı servisi (per-order render izolasyonu + per-job onay).
  report({ phase: 'print', completed: 0, total: printableIds.length })
  const printOutcome = await deps.printLabels(workingOrders, printableIds)
  workingOrders = printOutcome.orders ?? workingOrders

  const printedNumbers = new Set(printOutcome.printedOrderNumbers ?? [])
  for (const item of printOutcome.skipped ?? []) {
    skipped.push(item)
  }

  // H — sipariş bazında sonuç birleştirme.
  const identityByOrderId = new Map(
    [...plan.readyToPrint, ...plan.reprint, ...plan.needsCreate]
      .map((entry) => [entry.orderId, entry]),
  )
  const printedOrderIds: string[] = []
  let printed = 0
  let reprinted = 0
  for (const orderId of printableIds) {
    const entry = identityByOrderId.get(orderId)
    if (!entry) continue
    const isReprint = plan.reprint.some((r) => r.orderId === orderId)
    // BAŞARI YALNIZ mevcut per-job onayından gelir.
    if (printedNumbers.has(entry.orderNumber)) {
      printed += 1
      if (isReprint) reprinted += 1
      printedOrderIds.push(orderId)
      results.push(outcomeOf(entry, 'PRINTED', true))
    } else {
      const reason =
        (printOutcome.skipped ?? []).find(
          (s) => s.orderNumber === entry.orderNumber,
        )?.reason ?? 'Baskı doğrulanmadı; durum değiştirilmedi.'
      results.push(outcomeOf(entry, 'PRINT_FAILED', false, reason))
      if (!skipped.some((s) => s.orderNumber === entry.orderNumber)) {
        failed.push({ orderNumber: entry.orderNumber, reason })
      }
    }
  }

  report({ phase: 'done', completed: printed, total: printableIds.length })
  return {
    selectedCount: plan.uniqueCount,
    created,
    existingReady: plan.readyToPrint.length,
    reprinted,
    printed,
    skipped, failed, results,
    printedOrderIds,
    orders: workingOrders,
  }
}
