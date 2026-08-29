// HARİCİ SİSTEMDE İŞLENEN SİPARİŞLER — saf yardımcılar (IO/DOM YOK).
//
// Kullanıcı aynı anda başka bir entegrasyon programı kullanıyor; orada
// barkodu basılan siparişler CargoFlow'un aktif listesinde birikiyor.
// CargoFlow bunu güvenilir bir dış sinyal olmadan BİLEMEZ, bu yüzden
// OTOMATİK arşivleme YOKTUR: yalnız kullanıcının açıkça işaretlediği
// siparişler aktif görünümden çıkar ve her an geri alınabilir.
//
// Bu YEREL bir görünüm durumudur. Pazaryeri statüsü, provider durumu,
// tracking numarası, barkod, labelStatus ve printCount ETKİLENMEZ.
import type { CargoOrder } from '../types/cargoflow.ts'
import { orderPackageIdentity } from './orderCounts.ts'

/** Sunucudan gelen ham arşiv sözleşmesi. */
export interface ExternalProcessingEntry {
  processedAt?: string
  source?: string
  processedByUserId?: string | null
}
export interface ExternalProcessingState {
  entries?: Record<string, ExternalProcessingEntry>
}

/** Kullanıcıya gösterilen filtre/etiket metni (tek kaynak). */
export const EXTERNAL_PROCESSING_LABEL = 'Harici Sistemde İşlendi'
export const EXTERNAL_PROCESSING_MARK_LABEL =
  'Harici Sistemde İşlendi Olarak İşaretle'
export const EXTERNAL_PROCESSING_RESTORE_LABEL = 'Aktif Operasyona Geri Al'

export function isExternallyProcessed(order: CargoOrder): boolean {
  return order.externalProcessing?.processed === true
}

// Canonical paket kimliği — sayfalama, filtre değişimi ve farklı paketlerin
// aynı sipariş sanılması riskine karşı TEK kimlik kaynağı kullanılır.
export function externalProcessingKey(order: CargoOrder): string {
  return orderPackageIdentity(order)
}

export function externalProcessingKeys(orders: CargoOrder[]): string[] {
  return Array.from(
    new Set((orders ?? []).map((order) => externalProcessingKey(order))),
  ).filter(Boolean)
}

// Sunucu durumunu siparişlere DAMGALAR. Sipariş alanlarının hiçbiri
// değiştirilmez; yalnız `externalProcessing` eklenir/kaldırılır.
export function applyExternalProcessingState(
  orders: CargoOrder[],
  state: ExternalProcessingState | null | undefined,
): CargoOrder[] {
  const entries = state?.entries ?? {}
  const keys = new Set(
    Object.keys(entries).map((key) => key.toLocaleLowerCase('en-US')),
  )
  return (orders ?? []).map((order) => {
    const key = externalProcessingKey(order).toLocaleLowerCase('en-US')
    if (!keys.has(key)) {
      if (!order.externalProcessing) return order
      // Arşivden çıkarıldı: bayrak KALDIRILIR, diğer alanlara dokunulmaz.
      const rest = { ...order }
      delete rest.externalProcessing
      return rest
    }
    const entry = entries[key] ?? entries[externalProcessingKey(order)] ?? {}
    return {
      ...order,
      externalProcessing: {
        processed: true,
        processedAt: entry.processedAt,
        source: 'manual' as const,
      },
    }
  })
}

// Toplu işlem sonucu — kısmi başarı AYRI raporlanır.
export interface ExternalProcessingOutcome {
  requested: number
  changed: number
  unchanged: number
  failed: number
  message: string
}

export function describeExternalProcessingOutcome(
  outcome: Omit<ExternalProcessingOutcome, 'message'>,
  processed: boolean,
): string {
  const parts: string[] = []
  if (processed) {
    parts.push(`${outcome.changed} sipariş aktif operasyon listesinden kaldırıldı.`)
  } else {
    parts.push(`${outcome.changed} sipariş aktif operasyona geri alındı.`)
  }
  if (outcome.unchanged > 0) {
    parts.push(`${outcome.unchanged} sipariş zaten bu durumdaydı.`)
  }
  if (outcome.failed > 0) {
    parts.push(`${outcome.failed} sipariş işlenemedi.`)
  }
  return parts.join(' ')
}
