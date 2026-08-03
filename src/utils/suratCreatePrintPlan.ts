// "Sürat Etiketi Oluştur ve Yazdır" — SAF planlayıcı (IO/DOM/servis YOK).
//
// Bu modül YENİ bir Sürat lifecycle'ı TANIMLAMAZ. Yalnız seçili siparişleri,
// mevcut canonical durum yardımcılarının çıktısına göre gruplara ayırır:
// hangisi create ister, hangisi hazır, hangisi reprint, hangisi devam ediyor,
// hangisi bloklu. Çağıran (orchestrator) her grup için MEVCUT servisleri
// kullanır.
//
// GİZLİLİK: bu modül müşteri adı/adres/telefon TAŞIMAZ; yalnız sipariş
// numarası, sayım ve sebep metni üretir.
import type { CargoOrder } from '../types/cargoflow'
import { orderPackageIdentity } from './orderCounts'

// Mevcut canonical aşamalarla hizalı; yeni statü UYDURULMAZ.
export type SuratCreatePrintStage =
  | 'PREFLIGHT_BLOCKED'
  | 'CREATE_REQUIRED'
  | 'CREATE_IN_PROGRESS'
  | 'LABEL_READY'
  | 'PRINT_READY'

export interface PlanEntry {
  orderId: string
  orderNumber: string
  identity: string
  stage: SuratCreatePrintStage
  reason?: string
}

export interface SuratCreatePrintPlan {
  /** Sürat gönderisi/etiketi oluşturulacaklar. */
  needsCreate: PlanEntry[]
  /** Etiketi hazır, henüz basılmamış. */
  readyToPrint: PlanEntry[]
  /** Daha önce basılmış — create YOK, reprint yolu. */
  reprint: PlanEntry[]
  /** Halen süren bir create/print operasyonu var. */
  inFlight: PlanEntry[]
  /** Mutasyon ÖNCESİ elenen siparişler. */
  blocked: PlanEntry[]
  /** Aynı sipariş birden fazla seçildiyse düşen kopya sayısı. */
  duplicateCount: number
  /** Tekilleştirme sonrası benzersiz sipariş sayısı. */
  uniqueCount: number
}

export interface PlanPreflightInput {
  /** Siparişin Sürat ile gönderileceği doğrulandı mı. */
  isSuratOrder: (order: CargoOrder) => boolean
  /** Etiket üretimi için efektif desi çözülebiliyor mu (mesaj döner). */
  resolveDesiBlock: (order: CargoOrder) => string | null
  /** Ürün satırları tek etikete sığıyor mu (mesaj döner). */
  resolveFitBlock: (order: CargoOrder) => string | null
  /** Adres/alıcı gibi kritik alanlar tam mı (mesaj döner). */
  resolveDataBlock: (order: CargoOrder) => string | null
  /** Kayıtlı/üretilebilir etiket var mı. */
  hasPrintableLabel: (order: CargoOrder) => boolean
  /** Sipariş daha önce basıldı mı. */
  isPrinted: (order: CargoOrder) => boolean
  /** Bu sipariş için halen süren bir operasyon var mı. */
  isInFlight: (order: CargoOrder) => boolean
}

function entryOf(order: CargoOrder, stage: SuratCreatePrintStage, reason?: string): PlanEntry {
  return {
    orderId: String(order.id ?? ''),
    orderNumber: String(order.orderNumber ?? order.id ?? ''),
    identity: orderPackageIdentity(order),
    stage,
    ...(reason ? { reason } : {}),
  }
}

// Seçili siparişleri TEK geçişte gruplar. Sıra korunur (ekrandaki seçim
// sırası); böylece baskı belgesi deterministik olur.
export function resolveSuratCreateAndPrintPlan(
  selectedOrders: CargoOrder[],
  input: PlanPreflightInput,
): SuratCreatePrintPlan {
  const plan: SuratCreatePrintPlan = {
    needsCreate: [], readyToPrint: [], reprint: [],
    inFlight: [], blocked: [], duplicateCount: 0, uniqueCount: 0,
  }
  const seen = new Set<string>()

  for (const order of selectedOrders ?? []) {
    if (!order) continue
    const identity = orderPackageIdentity(order)
    // Aynı sipariş iki kez seçildiyse TEK fiziksel etiket üretilir.
    if (seen.has(identity)) {
      plan.duplicateCount += 1
      continue
    }
    seen.add(identity)

    // 1) Süren operasyon: ikinci istek AÇILMAZ.
    if (input.isInFlight(order)) {
      plan.inFlight.push(entryOf(order, 'CREATE_IN_PROGRESS'))
      continue
    }

    // 2) MUTASYON ÖNCESİ ön kontrol. Sırası bilinçli: taşıyıcı → veri → desi →
    //    sığdırma. Zaten etiketi olan sipariş desi/fit yüzünden create'e
    //    girmez; yalnız basılamıyorsa bloklanır.
    if (!input.isSuratOrder(order)) {
      plan.blocked.push(entryOf(order, 'PREFLIGHT_BLOCKED',
        'Sipariş Sürat Kargo ile gönderilecek olarak işaretli değil.'))
      continue
    }
    const dataBlock = input.resolveDataBlock(order)
    if (dataBlock) {
      plan.blocked.push(entryOf(order, 'PREFLIGHT_BLOCKED', dataBlock))
      continue
    }
    // Ürün sığdırma HER durumda kontrol edilir: sığmayan etiket ne basılabilir
    // ne de basılmalıdır (create yapılmışsa bile).
    const fitBlock = input.resolveFitBlock(order)
    if (fitBlock) {
      plan.blocked.push(entryOf(order, 'PREFLIGHT_BLOCKED', fitBlock))
      continue
    }

    const printed = input.isPrinted(order)
    const hasLabel = input.hasPrintableLabel(order)

    // 3) Daha önce basılmış → create ASLA, reprint yolu.
    if (printed && hasLabel) {
      plan.reprint.push(entryOf(order, 'PRINT_READY'))
      continue
    }
    // 4) Etiket hazır → create atlanır.
    if (hasLabel) {
      plan.readyToPrint.push(entryOf(order, 'LABEL_READY'))
      continue
    }
    // 5) Etiket yok → create gerekir. Desi YALNIZ burada zorunludur
    //    (mevcut sözleşme: kayıtlı etiket varsa desi istenmez).
    const desiBlock = input.resolveDesiBlock(order)
    if (desiBlock) {
      plan.blocked.push(entryOf(order, 'PREFLIGHT_BLOCKED', desiBlock))
      continue
    }
    plan.needsCreate.push(entryOf(order, 'CREATE_REQUIRED'))
  }

  plan.uniqueCount = seen.size
  return plan
}

// Kullanıcıya gösterilecek özet. Hiçbir etiket SESSİZCE atlanmaz.
export interface BatchPrintOutcome {
  processed: number
  created: number
  reusedExisting: number
  reprinted: number
  printed: number
  skipped: Array<{ orderNumber: string; reason: string }>
}

export function summarizeBatchOutcome(outcome: BatchPrintOutcome): string {
  const lines = [
    `${outcome.processed} sipariş işlendi`,
    `- ${outcome.created} yeni Sürat etiketi oluşturuldu`,
    `- ${outcome.reusedExisting} mevcut etiket kullanıldı`,
    `- ${outcome.reprinted} yeniden yazdırıldı`,
    `- ${outcome.printed} yazdırıldı`,
    `- ${outcome.skipped.length} atlandı`,
  ]
  if (outcome.skipped.length > 0) {
    lines.push('', 'Atlananlar:')
    for (const item of outcome.skipped) {
      lines.push(`- ${item.orderNumber} — ${item.reason}`)
    }
  }
  return lines.join('\n')
}
