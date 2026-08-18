// FAZ D — Canlı Debug için Trace V2 istemci deposu.
//
// TEK KAYNAK: bir create denemesinin doğrusu, Faz C'de gerçek create yoluna
// bağlanan Trace V2 kaydıdır. Bu depo YALNIZ onu tutar; eski v1 debug
// kayıtlarını, shipment_operations satırlarını veya geçmiş payload'ları
// birleştirerek "şimdiki deneme" ÜRETMEZ.

/** Faz C ile aynı saklama sınırı — ikinci bir mekanizma kurulmaz. */
export const TRACE_RETENTION_DAYS = 7
export const TRACE_RETENTION_MAX_PER_TENANT = 200
export const TRACE_SCHEMA_VERSION = 2

/** Eski, ARTIK OKUNMAYAN debug anahtarı. */
export const LEGACY_DEBUG_STORAGE_KEY = 'cargoflow.apiDebugLogs.v1'
export const TRACE_STORAGE_KEY = 'cargoflow.suratTraces.v2'

export interface StoredTrace {
  traceId: string
  schemaVersion: number
  createdAt: string
  stages: Array<{ stage: string; at: string; section: string | null; data: unknown }>
}

const isTrace = (value: unknown): value is StoredTrace => {
  if (!value || typeof value !== 'object') return false
  const trace = value as Partial<StoredTrace>
  return typeof trace.traceId === 'string'
    && trace.traceId.length > 0
    // v1 kayıtlarının şema sürümü yoktur; buradan ELENİRLER.
    && trace.schemaVersion === TRACE_SCHEMA_VERSION
    && Array.isArray(trace.stages)
}

/** Yalnız geçerli v2 izleri; v1/bozuk kayıtlar SESSİZCE ELENİR. */
export function selectValidTraces(values: unknown): StoredTrace[] {
  return Array.isArray(values) ? values.filter(isTrace) : []
}

/** En yeni önce; eşitlikte ekleme sırası korunur. */
export function sortTracesNewestFirst(traces: StoredTrace[]): StoredTrace[] {
  return [...traces].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
}

/** Yaş ve sayı sınırı — hangisi önce dolarsa. */
export function applyRetention(
  traces: StoredTrace[], now: number = Date.now(),
): StoredTrace[] {
  const cutoff = now - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return sortTracesNewestFirst(traces)
    .filter((trace) => Date.parse(trace.createdAt) >= cutoff)
    .slice(0, TRACE_RETENTION_MAX_PER_TENANT)
}

/**
 * "Son Deneme" = EN YENİ GEÇERLİ v2 izi. Eski v1 kaydın zaman damgası
 * daha yeni olsa bile onu SEÇEMEZ — çünkü hiç aday değildir.
 */
export function selectCurrentTrace(values: unknown): StoredTrace | null {
  return sortTracesNewestFirst(selectValidTraces(values))[0] ?? null
}

/** Yeni denemeyi başa ekler ve saklama sınırını uygular. */
export function appendTrace(
  existing: unknown, incoming: unknown, now: number = Date.now(),
): StoredTrace[] {
  const trace = isTrace(incoming) ? [incoming as StoredTrace] : []
  return applyRetention([...trace, ...selectValidTraces(existing)], now)
}
