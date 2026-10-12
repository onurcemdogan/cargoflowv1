// "Sürat Etiketi Oluştur ve Yazdır" — orkestratör.
//
// YENİ create/print iş mantığı YAZMAZ. Mevcut servisleri sırayla çağırır:
//   resolveSuratCreateAndPrintPlan (saf plan)
//     → lookupLabels      (gönderi izi olan siparişin KAYITLI etiketini ara)
//     → createShipments   (mevcut Sürat create, idempotency korunur)
//     → printLabels       (mevcut baskı + per-job onay sözleşmesi)
//
// BAŞARI SÖZLEŞMESİ: bir sipariş ancak mevcut printLabels'ın per-job `ok`
// sonucuyla basılmış sayılır. window.print() çağrılması, dialog açılması veya
// printCalled=true TEK BAŞINA başarı DEĞİLDİR — bu modül yeni ve daha gevşek
// bir "başarılı say" kuralı TANIMLAMAZ.
//
// ═══ PAYLAŞILAN DURUM YOK (üretimde ölçülen yarış) ═══════════════════════
// Eskiden her eşzamanlı create `createShipments(workingOrders, [id])`
// çağırıp sonucu ORTAK `workingOrders`'a yazıyordu. İki create aynı eski
// listeden başlayınca SONRA biten, ÖNCE bitenin güncellemesini EZİYORDU:
// oluşturulan etiket baskı listesinde görünmüyor, sipariş "basılamadı"
// sayılıyordu. Artık her create YALNIZ kendi siparişini döndürür; sonuçlar
// sipariş kimliğiyle BİRLEŞTİRİLİR ve liste tek seferde kurulur.
//
// ═══ SESSİZ "BAŞARISIZ" YOK ══════════════════════════════════════════════
// Kargoya verilmiş / gönderi izi olan sipariş create'e GİRMEZ: kayıtlı
// etiketi aranır, bulunursa basılır, bulunamazsa AÇIK sebeple atlanır.
// Create servisinin kendi atlama/ret gerekçesi kaybolmaz.
//
// GİZLİLİK: sonuçta müşteri adı/adres/telefon YOKTUR; yalnız sipariş numarası,
// aşama ve güvenli sebep.
import type { CargoOrder } from '../types/cargoflow'
import {
  EVIDENCE_NO_LABEL_MESSAGE,
  POST_CREATE_NO_LABEL_MESSAGE,
  resolveSuratCreateAndPrintPlan,
  type PlanEntry,
  type PlanPreflightInput,
  type SuratCreatePrintStage,
} from '../utils/suratCreatePrintPlan'
import { LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE } from '../utils/suratPrintFailureReasons'

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

/**
 * Bir toplu çalışmanın GÜVENLİ özeti — yalnız sayılar ve süreler (PII yok).
 * Yavaşlığın Sürat mi, hidrasyon mu, render/baskı mı olduğu buradan okunur.
 */
export interface OrchestratorRunSummary {
  selected: number
  blocked: number
  inFlight: number
  labelLookup: number
  needsCreate: number
  ready: number
  reprint: number
  createSuccess: number
  createFail: number
  createSkipped: number
  createCalls: number
  printSuccess: number
  printFail: number
  durationMs: number
  preflightMs: number
  lookupMs: number
  createMs: number
  hydrateMs: number
  /** Baskı servisinin toplam süresi (render + yazıcıya gönderim). */
  printMs: number
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
  summary: OrchestratorRunSummary
}

export interface CreateShipmentsOutcome {
  orders: CargoOrder[]
  /** Taşıyıcı/servis create'i REDDETTİ veya hata verdi. */
  failedIds?: string[]
  /** Servis create'i AĞA ÇIKMADAN atladı (ör. sipariş artık uygun değil). */
  skippedIds?: string[]
  /**
   * Create tamamlandı ama etiket yanıtta henüz görünmüyor: orkestratör TEK
   * toplu kayıtlı-etiket doğrulaması yapar (sipariş başına ayrı tur YOK).
   */
  unverifiedIds?: string[]
  reasons?: Record<string, string>
}

export interface OrchestratorDeps {
  preflight: PlanPreflightInput
  /** Mevcut create servisi (idempotency ve operation kayıtları korunur). */
  createShipments: (
    orders: CargoOrder[],
    ids: string[],
  ) => Promise<CreateShipmentsOutcome>
  /**
   * KAYITLI etiketi sunucudan arar (provider'a ÇIKMAZ). Güncellenmiş
   * siparişleri döndürür; basılabilir olup olmadığına `preflight
   * .hasPrintableLabel` karar verir. Verilmezse arama yapılmaz.
   */
  lookupLabels?: (orders: CargoOrder[], ids: string[]) => Promise<CargoOrder[]>
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
  /** Çalışma sonunda güvenli toplu özet (gözlemlenebilirlik). */
  onRunSummary?: (summary: OrchestratorRunSummary) => void
  now?: () => number
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

/** Sipariş bazlı güncellemeleri TEK geçişte birleştirir (sıra korunur). */
function mergeOrders(base: CargoOrder[], updates: Map<string, CargoOrder>): CargoOrder[] {
  if (updates.size === 0) return base
  return base.map((order) => updates.get(String(order.id)) ?? order)
}

function pickById(list: CargoOrder[] | undefined, id: string): CargoOrder | undefined {
  return (list ?? []).find((order) => String(order.id) === String(id))
}

export async function runSuratCreateAndPrint(
  selectedOrders: CargoOrder[],
  allOrders: CargoOrder[],
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()
  const report = (progress: OrchestratorProgress) => deps.onProgress?.(progress)

  // A/B/C — seçim snapshot'ı + preflight + plan (MUTASYONDAN ÖNCE).
  const plan = resolveSuratCreateAndPrintPlan(selectedOrders, deps.preflight)
  report({ phase: 'preflight', completed: plan.uniqueCount, total: plan.uniqueCount })
  const preflightMs = now() - startedAt

  const results: OrderOutcome[] = []
  const skipped: Array<{ orderNumber: string; reason: string }> = []
  const failed: Array<{ orderNumber: string; reason: string }> = []
  const skip = (entry: PlanEntry, stage: OrderOutcome['stage'], reason: string) => {
    skipped.push({ orderNumber: entry.orderNumber, reason })
    results.push(outcomeOf(entry, stage, false, reason))
  }

  for (const entry of plan.blocked) {
    skip(entry, 'PREFLIGHT_BLOCKED', entry.reason ?? 'Ön kontrol başarısız.')
  }
  for (const entry of plan.inFlight) {
    skip(entry, 'CREATE_IN_PROGRESS', 'Bu sipariş için süren bir işlem var; ikinci istek açılmadı.')
  }

  // Sipariş bazlı güncellemeler — paylaşılan liste üzerine paralel yazım YOK.
  const updates = new Map<string, CargoOrder>()
  const current = () => mergeOrders(allOrders, updates)
  const readyEntries: PlanEntry[] = [...plan.readyToPrint]
  const reprintEntries: PlanEntry[] = [...plan.reprint]

  // C2 — gönderi izi olan siparişler: KAYITLI etiket aranır, create YOK.
  const lookupStartedAt = now()
  if (plan.needsLabelLookup.length > 0) {
    let looked: CargoOrder[] = []
    if (deps.lookupLabels) {
      try {
        looked = await deps.lookupLabels(current(), plan.needsLabelLookup.map((e) => e.orderId))
      } catch {
        looked = []
      }
    }
    for (const entry of plan.needsLabelLookup) {
      const order = pickById(looked, entry.orderId)
      if (order && deps.preflight.hasPrintableLabel(order)) {
        updates.set(entry.orderId, order)
        if (deps.preflight.isPrinted(order)) reprintEntries.push(entry)
        else readyEntries.push(entry)
        continue
      }
      const lifecycle = deps.preflight.resolveLifecycle?.(order ?? findOrder(selectedOrders, entry.orderId))
      skip(entry, 'PREFLIGHT_BLOCKED', lifecycle === 'POST_CREATE'
        ? POST_CREATE_NO_LABEL_MESSAGE
        : EVIDENCE_NO_LABEL_MESSAGE)
    }
  }
  const lookupMs = now() - lookupStartedAt

  // D — YALNIZ needsCreate grubunda create. En fazla 2 eşzamanlı mutasyon.
  // Her create AYNI başlangıç listesini görür ve YALNIZ kendi siparişini
  // döndürür; sonuçlar kimlikle birleştirilir.
  const createStartedAt = now()
  let created = 0
  let createCalls = 0
  let createSkipped = 0
  const createdIds: string[] = []
  const unverified: PlanEntry[] = []
  if (plan.needsCreate.length > 0) {
    let done = 0
    const baseline = current()
    report({ phase: 'create', completed: 0, total: plan.needsCreate.length })
    const outcomes = await mapWithLimit(
      plan.needsCreate,
      SURAT_CREATE_CONCURRENCY,
      async (entry) => {
        try {
          createCalls += 1
          const outcome = await deps.createShipments(baseline, [entry.orderId])
          const own = pickById(outcome.orders, entry.orderId)
          const reason = outcome.reasons?.[entry.orderId]
          if ((outcome.skippedIds ?? []).includes(entry.orderId)) {
            return { entry, own, kind: 'skipped' as const, reason: reason ?? 'Sipariş create için uygun değil.' }
          }
          if ((outcome.failedIds ?? []).includes(entry.orderId)) {
            return { entry, own, kind: 'failed' as const, reason: reason ?? 'Sürat gönderisi oluşturulamadı.' }
          }
          if ((outcome.unverifiedIds ?? []).includes(entry.orderId)) {
            return { entry, own, kind: 'unverified' as const }
          }
          return { entry, own, kind: 'created' as const }
        } catch (error) {
          // Bir create hatası DİĞER siparişleri durdurmaz.
          return {
            entry,
            own: undefined,
            kind: 'failed' as const,
            reason: error instanceof Error ? error.message : 'Sürat çağrısı başarısız.',
          }
        } finally {
          done += 1
          report({ phase: 'create', completed: done, total: plan.needsCreate.length })
        }
      },
    )
    for (const item of outcomes) {
      if (item.own) updates.set(item.entry.orderId, item.own)
      if (item.kind === 'created') {
        created += 1
        createdIds.push(item.entry.orderId)
        results.push(outcomeOf(item.entry, 'LABEL_READY', true))
      } else if (item.kind === 'unverified') {
        unverified.push(item.entry)
      } else if (item.kind === 'skipped') {
        createSkipped += 1
        skip(item.entry, 'PREFLIGHT_BLOCKED', item.reason)
      } else {
        failed.push({ orderNumber: item.entry.orderNumber, reason: item.reason })
        results.push(outcomeOf(item.entry, 'CREATE_REQUIRED', false, item.reason))
      }
    }
  }
  const createMs = now() - createStartedAt

  // D2 — etiketi yanıtta görünmeyen create'ler için TEK toplu doğrulama.
  // Doğrulanamayan sipariş YENİDEN create EDİLMEZ (idempotency sunucuda).
  const hydrateStartedAt = now()
  if (unverified.length > 0) {
    let verified: CargoOrder[] = []
    if (deps.lookupLabels) {
      try {
        verified = await deps.lookupLabels(current(), unverified.map((e) => e.orderId))
      } catch {
        verified = []
      }
    }
    for (const entry of unverified) {
      const order = pickById(verified, entry.orderId)
      if (order && deps.preflight.hasPrintableLabel(order)) {
        updates.set(entry.orderId, order)
        created += 1
        createdIds.push(entry.orderId)
        results.push(outcomeOf(entry, 'LABEL_READY', true))
      } else {
        failed.push({ orderNumber: entry.orderNumber, reason: LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE })
        results.push(outcomeOf(entry, 'CREATE_REQUIRED', false, LABEL_NOT_VERIFIED_AFTER_CREATE_MESSAGE))
      }
    }
  }
  const hydrateMs = now() - hydrateStartedAt

  let workingOrders = current()
  // Create bitti: UI aynı run içinde canonical duruma (Etiket Hazır, T.No)
  // TEK seferde taşınır. Seçim ve sonuç paneli baskı kesinleşene kadar
  // DEĞİŞMEZ.
  if (plan.needsCreate.length > 0) deps.onOrdersUpdated?.(workingOrders)

  // E — basılabilir küme: yeni oluşturulanlar + hazır + reprint.
  const reprintIds = new Set(reprintEntries.map((e) => e.orderId))
  const printableIds = [
    ...createdIds,
    ...readyEntries.map((e) => e.orderId),
    ...reprintEntries.map((e) => e.orderId),
  ]
  report({ phase: 'prepare', completed: printableIds.length, total: printableIds.length })

  const finish = (printed: number, printFail: number, printMs: number) => {
    const summary: OrchestratorRunSummary = {
      selected: plan.uniqueCount,
      blocked: plan.blocked.length,
      inFlight: plan.inFlight.length,
      labelLookup: plan.needsLabelLookup.length,
      needsCreate: plan.needsCreate.length,
      ready: readyEntries.length,
      reprint: reprintEntries.length,
      createSuccess: created,
      createFail: plan.needsCreate.length - created - createSkipped,
      createSkipped,
      createCalls,
      printSuccess: printed,
      printFail,
      durationMs: now() - startedAt,
      preflightMs,
      lookupMs,
      createMs,
      hydrateMs,
      printMs,
    }
    deps.onRunSummary?.(summary)
    return summary
  }

  // Hiç basılabilir sipariş yoksa baskı dialogu AÇILMAZ.
  if (printableIds.length === 0) {
    report({ phase: 'done', completed: 0, total: 0 })
    return {
      selectedCount: plan.uniqueCount,
      created,
      existingReady: readyEntries.length,
      reprinted: 0,
      printed: 0,
      skipped, failed, results,
      printedOrderIds: [],
      orders: workingOrders,
      summary: finish(0, 0, 0),
    }
  }

  // F/G — mevcut baskı servisi (per-order render izolasyonu + per-job onay).
  report({ phase: 'print', completed: 0, total: printableIds.length })
  const printStartedAt = now()
  const printOutcome = await deps.printLabels(workingOrders, printableIds)
  const printMs = now() - printStartedAt
  workingOrders = printOutcome.orders ?? workingOrders

  const printedNumbers = new Set(printOutcome.printedOrderNumbers ?? [])
  for (const item of printOutcome.skipped ?? []) {
    skipped.push(item)
  }

  // H — sipariş bazında sonuç birleştirme.
  const identityByOrderId = new Map(
    [...readyEntries, ...reprintEntries, ...plan.needsCreate]
      .map((entry) => [entry.orderId, entry]),
  )
  const printedOrderIds: string[] = []
  let printed = 0
  let reprinted = 0
  let printFail = 0
  for (const orderId of printableIds) {
    const entry = identityByOrderId.get(orderId)
    if (!entry) continue
    // BAŞARI YALNIZ mevcut per-job onayından gelir.
    if (printedNumbers.has(entry.orderNumber)) {
      printed += 1
      if (reprintIds.has(orderId)) reprinted += 1
      printedOrderIds.push(orderId)
      results.push(outcomeOf(entry, 'PRINTED', true))
    } else {
      printFail += 1
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
    existingReady: readyEntries.length,
    reprinted,
    printed,
    skipped, failed, results,
    printedOrderIds,
    orders: workingOrders,
    summary: finish(printed, printFail, printMs),
  }
}

function findOrder(list: CargoOrder[], id: string): CargoOrder {
  return pickById(list, id) ?? ({ id } as CargoOrder)
}
