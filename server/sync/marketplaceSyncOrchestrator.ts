// PAZARYERİ SENKRON ORKESTRASYONU — TENANT KAPSAMLI, TEK UÇUŞLU.
//
// AMAÇ: "Şimdi Yenile" isteği sağlayıcı senkronunun BİTMESİNİ beklemesin.
// İstek yalnız KABUL EDİLİR; asıl tur arka planda ilerler ve kullanıcı yerel
// veriyi görmeye devam eder.
//
// BU MODÜL SAĞLAYICIYI TANIMAZ: Trendyol istemcisi çağıran tarafından `run`
// olarak verilir. İkinci bir pazaryeri implementasyonu YOKTUR.
//
// SÖZLEŞMELER
//   TENANT KAPSAMLI  — anahtar (organizationId, marketplaceAccountId).
//   TEK UÇUŞ         — aynı anahtar için aynı anda YALNIZ bir sağlayıcı turu.
//   BİRLEŞTİRME      — koşarken gelen istekler yeni tur AÇMAZ; en fazla BİR
//                      bekleyen niyet tutulur (sınırsız kuyruk YOK).
//   TENANTLAR AYRI   — global kilit YOKTUR; A'nın turu B'yi bloklamaz.
//   HATA YUTMAZ      — tur çöküşü kaydedilir, ama isteği DÜŞÜRMEZ.
//
// GİZLİLİK: kayıt yalnız kimlik/durum/zaman tutar. Kimlik bilgisi, ham istek,
// sağlayıcı yanıtı veya müşteri verisi ASLA saklanmaz.

export const SYNC_REASONS = [
  'MANUAL_REFRESH',
  'SCHEDULED',
  'STARTUP_RECOVERY',
] as const
export type SyncReason = (typeof SYNC_REASONS)[number]

export const SYNC_RUN_STATES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const
export type SyncRunState = (typeof SYNC_RUN_STATES)[number]

/** Yeniden denemeye DEĞER mi — 401/403 ve sözleşme hataları için HAYIR. */
export const SYNC_ERROR_CATEGORIES = [
  'TRANSIENT',
  'AUTH',
  'CONTRACT',
  'PERSISTENCE',
  'UNKNOWN',
] as const
export type SyncErrorCategory = (typeof SYNC_ERROR_CATEGORIES)[number]

export interface SyncRun {
  syncRunId: string
  organizationId: string
  marketplaceAccountId: string | null
  reason: SyncReason
  state: SyncRunState
  startedAt: string
  finishedAt: string | null
  errorCategory: SyncErrorCategory | null
  /** Bu turun birleştirdiği ek istek sayısı (gözlemlenebilirlik). */
  coalescedRequests: number
}

export interface SyncRequestResult {
  accepted: boolean
  state: 'RUNNING' | 'COALESCED'
  syncRunId: string
  reason: SyncReason
}

export interface SyncKeyStatus {
  organizationId: string
  marketplaceAccountId: string | null
  active: SyncRun | null
  last: SyncRun | null
  lastSuccessfulAt: string | null
  pendingFollowUp: boolean
}

interface KeyState {
  organizationId: string
  marketplaceAccountId: string | null
  active: SyncRun | null
  last: SyncRun | null
  lastSuccessfulAt: string | null
  /** En fazla BİR bekleyen niyet — geri basınç. */
  pending: { reason: SyncReason; run: () => Promise<unknown> } | null
}

const states = new Map<string, KeyState>()
let runCounter = 0

export function syncKey(
  organizationId: string,
  marketplaceAccountId: string | null | undefined,
): string {
  return `${String(organizationId)}::${marketplaceAccountId ?? 'null'}`
}

function nextRunId(): string {
  runCounter += 1
  return `sync_${runCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function keyState(
  organizationId: string,
  marketplaceAccountId: string | null,
): KeyState {
  const key = syncKey(organizationId, marketplaceAccountId)
  let state = states.get(key)
  if (!state) {
    state = {
      organizationId,
      marketplaceAccountId,
      active: null,
      last: null,
      lastSuccessfulAt: null,
      pending: null,
    }
    states.set(key, state)
  }
  return state
}

/** Sağlayıcı/DB hatasını yeniden deneme politikası için sınıflar. */
export function classifySyncFailure(error: unknown): SyncErrorCategory {
  const status = Number(
    (error as { statusCode?: unknown; status?: unknown })?.statusCode ??
      (error as { status?: unknown })?.status ??
      0,
  )
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429 || (status >= 500 && status <= 599)) return 'TRANSIENT'
  if (status >= 400 && status < 500) return 'CONTRACT'
  const message = String(
    (error as { message?: unknown })?.message ?? error ?? '',
  ).toLowerCase()
  if (/timeout|econnreset|enotfound|socket|network|fetch failed/.test(message)) {
    return 'TRANSIENT'
  }
  if (/persist|database|constraint|deadlock/.test(message)) return 'PERSISTENCE'
  return 'UNKNOWN'
}

/** Yeniden denemeye DEĞER mi (yetki/sözleşme hatasında fırtına YOK). */
export function isRetryableCategory(category: SyncErrorCategory): boolean {
  return category === 'TRANSIENT' || category === 'PERSISTENCE'
}

async function execute(state: KeyState, run: SyncRun, work: () => Promise<unknown>) {
  try {
    await work()
    run.state = 'SUCCEEDED'
    run.finishedAt = new Date().toISOString()
    // BAŞARISIZ TUR `lastSuccessfulAt`i EZMEZ (mevcut veri güvende kalır).
    state.lastSuccessfulAt = run.finishedAt
  } catch (error) {
    run.state = 'FAILED'
    run.finishedAt = new Date().toISOString()
    run.errorCategory = classifySyncFailure(error)
  } finally {
    state.last = run
    state.active = null
    const pending = state.pending
    state.pending = null
    if (pending) {
      // TEK takip turu — kuyruk büyümez.
      startRun(state, pending.reason, pending.run)
    }
  }
}

function startRun(
  state: KeyState,
  reason: SyncReason,
  work: () => Promise<unknown>,
): SyncRun {
  const run: SyncRun = {
    syncRunId: nextRunId(),
    organizationId: state.organizationId,
    marketplaceAccountId: state.marketplaceAccountId,
    reason,
    state: 'RUNNING',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errorCategory: null,
    coalescedRequests: 0,
  }
  state.active = run
  // KOPUK ÇALIŞTIRMA: istek bu turu BEKLEMEZ. Hata yutulmaz, kaydedilir.
  void execute(state, run, work)
  return run
}

/**
 * Senkron İSTEĞİ — sağlayıcı turunu BEKLEMEZ.
 *
 * Koşan tur varsa yeni tur AÇILMAZ; istek mevcut tura birleştirilir ve en
 * fazla bir takip turu niyeti tutulur.
 */
export function requestMarketplaceSync(options: {
  organizationId: string
  marketplaceAccountId: string | null
  reason: SyncReason
  run: () => Promise<unknown>
}): SyncRequestResult {
  const organizationId = String(options.organizationId ?? '').trim()
  if (!organizationId) throw new Error('SYNC_ORGANIZATION_REQUIRED')
  const state = keyState(organizationId, options.marketplaceAccountId ?? null)

  if (state.active) {
    state.active.coalescedRequests += 1
    // GERİ BASINÇ: bekleyen niyet zaten varsa İKİNCİSİ eklenmez.
    if (!state.pending) {
      state.pending = { reason: options.reason, run: options.run }
    }
    return {
      accepted: true,
      state: 'COALESCED',
      syncRunId: state.active.syncRunId,
      reason: options.reason,
    }
  }

  const run = startRun(state, options.reason, options.run)
  return {
    accepted: true,
    state: 'RUNNING',
    syncRunId: run.syncRunId,
    reason: options.reason,
  }
}

/** Salt okunur durum — gözlemlenebilirlik için (sır İÇERMEZ). */
export function getSyncStatus(
  organizationId: string,
  marketplaceAccountId: string | null,
): SyncKeyStatus {
  const state = keyState(organizationId, marketplaceAccountId ?? null)
  return {
    organizationId,
    marketplaceAccountId: marketplaceAccountId ?? null,
    active: state.active ? { ...state.active } : null,
    last: state.last ? { ...state.last } : null,
    lastSuccessfulAt: state.lastSuccessfulAt,
    pendingFollowUp: state.pending !== null,
  }
}

/**
 * BAYAT TUR KURTARMA — süreç çökmesi/askıda kalma sonrası kilit sonsuza
 * kadar tutulmasın. Yaşı sınırı aşan RUNNING tur FAILED işaretlenir ve
 * anahtar serbest bırakılır.
 */
export function recoverStaleRuns(
  maxAgeMs: number,
  now: Date = new Date(),
): { recovered: number } {
  let recovered = 0
  for (const state of states.values()) {
    const active = state.active
    if (!active) continue
    const age = now.getTime() - new Date(active.startedAt).getTime()
    if (age < maxAgeMs) continue
    active.state = 'FAILED'
    active.errorCategory = 'UNKNOWN'
    active.finishedAt = now.toISOString()
    state.last = active
    state.active = null
    state.pending = null
    recovered += 1
  }
  return { recovered }
}

/** Test yalıtımı için — üretim akışında ÇAĞRILMAZ. */
export function resetSyncOrchestrator(): void {
  states.clear()
  runCounter = 0
}
