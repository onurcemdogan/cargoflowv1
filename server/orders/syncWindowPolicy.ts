// ARTIMLI SENKRONİZASYON PENCERE POLİTİKASI (B seçeneği).
//
// Saf karar katmanı: ağ/DB'ye DOKUNMAZ. Çalışma zamanı bu kararı uygular.
//
// TEMEL RİSK: saf imleç, "başarılı" denip sessizce düşen kayıtları KALICI
// olarak atlar — eksik gönderi, eksik ciro. Bu yüzden üç mekanizma birlikte:
//   1) imleç GERİYE emniyet payı kadar kaydırılır (örtüşme kasıtlıdır),
//   2) imleç YALNIZ tam başarılı sync sonunda ilerler,
//   3) geniş pencere periyodik olarak yeniden taranır (kendini onarma).

/** Emniyet payı: sağlayıcı gecikmeli güncellemeleri kaçırmamak için. */
export const DEFAULT_SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000

/** İmleç yokken (ilk kurulum) kullanılan güvenli pencere. */
export const BOOTSTRAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Kendini onarma taraması bu aralıkta bir kez geniş pencere çeker. */
export const RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Geniş tarama penceresi — bootstrap ile aynı genişlik. */
export const RECONCILIATION_WINDOW_MS = BOOTSTRAP_WINDOW_MS

export const SYNC_WINDOW_MODES = [
  'BOOTSTRAP',
  'INCREMENTAL',
  'RECONCILIATION',
] as const

export interface SyncWindow {
  startMs: number
  endMs: number
  mode: (typeof SYNC_WINDOW_MODES)[number]
  /** Bu koşu başarıyla biterse imlecin alacağı değer (watermark). */
  candidateCheckpointMs: number
  safetyMarginMs: number
}

const positive = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Çekilecek pencereyi belirler.
 *
 * `candidateCheckpointMs` DAİMA pencerenin ÜST SINIRIDIR — sürecin bitiş
 * saati DEĞİL. Sync sürerken oluşan siparişler bir sonraki koşuda yakalanır;
 * "işlem bitiş saati" imleç yapılsaydı o aralık kalıcı olarak atlanırdı.
 */
export function resolveSyncWindow(params: {
  checkpointMs?: number | null
  nowMs: number
  safetyMarginMs?: number
  lastReconciliationAtMs?: number | null
  reconciliationIntervalMs?: number
  bootstrapWindowMs?: number
}): SyncWindow {
  const nowMs = params.nowMs
  const safetyMarginMs = positive(
    params.safetyMarginMs, DEFAULT_SAFETY_MARGIN_MS,
  )
  const bootstrapWindowMs = positive(
    params.bootstrapWindowMs, BOOTSTRAP_WINDOW_MS,
  )
  const reconciliationIntervalMs = positive(
    params.reconciliationIntervalMs, RECONCILIATION_INTERVAL_MS,
  )
  const checkpointMs =
    typeof params.checkpointMs === 'number' && Number.isFinite(params.checkpointMs)
      ? params.checkpointMs
      : null

  // İmleç yoksa (ilk kurulum) güvenli geniş pencere.
  if (checkpointMs === null) {
    return {
      startMs: nowMs - bootstrapWindowMs,
      endMs: nowMs,
      mode: 'BOOTSTRAP',
      candidateCheckpointMs: nowMs,
      safetyMarginMs,
    }
  }

  // Kendini onarma: imleçten BAĞIMSIZ, periyodik geniş tarama. Daha önce
  // sessizce düşmüş kayıtlar bu turda yeniden yakalanır.
  const lastReconciliationAtMs =
    typeof params.lastReconciliationAtMs === 'number'
      ? params.lastReconciliationAtMs
      : null
  const reconciliationDue =
    lastReconciliationAtMs === null
      ? false
      : nowMs - lastReconciliationAtMs >= reconciliationIntervalMs
  if (reconciliationDue) {
    return {
      startMs: nowMs - RECONCILIATION_WINDOW_MS,
      endMs: nowMs,
      mode: 'RECONCILIATION',
      candidateCheckpointMs: nowMs,
      safetyMarginMs,
    }
  }

  // Artımlı: imleç GERİYE emniyet payı kadar kaydırılır. Örtüşme KASITLIDIR;
  // tekrar gelen kayıtlar upsert ile aynı satıra düşer (duplicate YOK).
  const startMs = Math.min(checkpointMs - safetyMarginMs, nowMs)
  return {
    startMs,
    endMs: nowMs,
    mode: 'INCREMENTAL',
    candidateCheckpointMs: nowMs,
    safetyMarginMs,
  }
}

/**
 * İmleç YALNIZ tam başarılı koşuda ilerler.
 *
 * Kısmi sonuç, kurtarılamayan hata veya oran sınırı tükenmesi durumunda
 * mevcut imleç KORUNUR — aksi hâlde çekilemeyen aralık kalıcı olarak atlanır.
 * Ayrıca imleç GERİ de gitmez (eşzamanlı/gecikmiş koşu güvenliği).
 */
export function advanceCheckpoint(params: {
  currentCheckpointMs?: number | null
  candidateCheckpointMs: number
  complete: boolean
  rateLimited?: boolean
  errorCode?: string | null
}): { checkpointMs: number | null; advanced: boolean; reason: string } {
  const current =
    typeof params.currentCheckpointMs === 'number' ? params.currentCheckpointMs : null
  if (!params.complete) {
    return { checkpointMs: current, advanced: false, reason: 'INCOMPLETE_SYNC' }
  }
  if (params.rateLimited === true) {
    return { checkpointMs: current, advanced: false, reason: 'RATE_LIMIT_EXHAUSTED' }
  }
  if (params.errorCode) {
    return { checkpointMs: current, advanced: false, reason: 'UNRECOVERED_ERROR' }
  }
  if (current !== null && params.candidateCheckpointMs <= current) {
    return { checkpointMs: current, advanced: false, reason: 'NOT_NEWER' }
  }
  return {
    checkpointMs: params.candidateCheckpointMs,
    advanced: true,
    reason: 'COMPLETE_SYNC',
  }
}
