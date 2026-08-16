// OTOMATİK BARKOD HAZIRLIĞI — UYGUNLUK + İŞ KUYRUĞU SINIRI.
//
// AMAÇ: yeni bir sipariş senkronla geldiğinde, kullanıcı "Kargo Etiketi Oluştur
// ve Yazdır" düğmesine basmadan ÖNCE hazırlığın arka planda başlatılabileceği
// mimariyi kurmak.
//
// BU DOSYA TAŞIYICIYA ÇIKMAZ. Canlı Sürat çağrısı YOKTUR ve canlı işçi
// VARSAYILAN OLARAK KAPALIDIR. Buradaki her şey yerel, deterministik durumdan
// türer: ağ yok, şifre çözme yok, tahmin yok.
//
// KİMLİK: iş kimliği mevcut kanonik Sürat idempotency semantiğiyle aynı
// eksende kurulur (organizasyon + pazaryeri + paket + operasyon). İkinci bir
// create kimliği ÜRETİLMEZ.

export const BARCODE_ELIGIBILITY_STATES = [
  'ELIGIBLE',
  'NOT_ELIGIBLE',
  'ALREADY_READY',
  'BLOCKED',
  'PENDING',
] as const
export type BarcodeEligibilityState = (typeof BARCODE_ELIGIBILITY_STATES)[number]

export const PREP_JOB_STATES = [
  'PENDING',
  'PROCESSING',
  'READY',
  'BLOCKED',
  'FAILED_SAFE',
] as const
export type PrepJobState = (typeof PREP_JOB_STATES)[number]

/** Kanonik etiket durumları — yazdırılabilir etiket ÜRETİLMİŞ demektir. */
const READY_OPERATION_STATES = new Set(['LABEL_READY', 'LABEL_PRINTED'])

/**
 * OPERASYONEL OLARAK KAPANMIŞ pazaryeri statüleri.
 * Bu statülerde yeni etiket hazırlığı ANLAMSIZDIR (mevcut ürün davranışı:
 * baskı yalnız operasyonel-aktif siparişte açılır).
 */
const CLOSED_MARKETPLACE_STATUSES = new Set([
  'shipped',
  'delivered',
  'cancelled',
  'returned',
  'undelivered',
  'unsupplied',
])

export interface BarcodeEligibilityInput {
  organizationId?: unknown
  marketplace?: unknown
  packageId?: unknown
  operationStatus?: unknown
  marketplaceStatus?: unknown
  archivedAt?: unknown
  /** Kalıcı yazdırılabilir etiket kanıtı (backend bayrağı). */
  hasPrintableLabel?: unknown
  /** Tenant için Sürat yapılandırılmış mı (kimlik bilgisi DEĞERİ değil). */
  suratConfigured?: unknown
  /** Bu paket için hâlihazırda kuyrukta/işlemde bir iş var mı. */
  jobState?: PrepJobState | null
}

export interface BarcodeEligibility {
  state: BarcodeEligibilityState
  reason: string
}

const text = (value: unknown): string => String(value ?? '').trim()

/**
 * UYGUNLUK DEĞERLENDİRMESİ — SAF ve DETERMİNİSTİK.
 *
 * Sıra bilinçlidir: önce "zaten hazır", sonra "kapanmış", sonra eksik kimlik,
 * sonra yapılandırma, en son mevcut iş. Böylece kullanıcıya gösterilecek sebep
 * her zaman en belirleyici olandır.
 */
export function evaluateBarcodeEligibility(
  input: BarcodeEligibilityInput,
): BarcodeEligibility {
  const operationStatus = text(input.operationStatus).toUpperCase()
  if (READY_OPERATION_STATES.has(operationStatus) || input.hasPrintableLabel === true) {
    return { state: 'ALREADY_READY', reason: 'PRINTABLE_LABEL_EXISTS' }
  }
  if (text(input.archivedAt)) {
    return { state: 'BLOCKED', reason: 'ORDER_ARCHIVED' }
  }
  const marketplaceStatus = text(input.marketplaceStatus).toLowerCase()
  if (CLOSED_MARKETPLACE_STATUSES.has(marketplaceStatus)) {
    return { state: 'BLOCKED', reason: 'MARKETPLACE_STATUS_CLOSED' }
  }
  if (!text(input.organizationId)) {
    return { state: 'NOT_ELIGIBLE', reason: 'ORGANIZATION_MISSING' }
  }
  if (!text(input.packageId)) {
    return { state: 'NOT_ELIGIBLE', reason: 'PACKAGE_ID_MISSING' }
  }
  if (!text(input.marketplace)) {
    return { state: 'NOT_ELIGIBLE', reason: 'MARKETPLACE_MISSING' }
  }
  if (input.suratConfigured !== true) {
    return { state: 'NOT_ELIGIBLE', reason: 'CARRIER_NOT_CONFIGURED' }
  }
  if (input.jobState === 'PENDING' || input.jobState === 'PROCESSING') {
    return { state: 'PENDING', reason: 'PREPARATION_ALREADY_QUEUED' }
  }
  if (input.jobState === 'BLOCKED') {
    return { state: 'BLOCKED', reason: 'PREPARATION_BLOCKED' }
  }
  return { state: 'ELIGIBLE', reason: 'READY_FOR_PREPARATION' }
}

/* ═══ İŞ KİMLİĞİ + KUYRUK ══════════════════════════════════════════════ */

export interface PrepJobIdentity {
  organizationId: string
  marketplace: string
  packageId: string
  operation: 'CREATE'
}

/**
 * İŞ ANAHTARI — aynı paket kaç kez görünürse görünsün TEK mantıksal iş.
 *
 * Senkron çakışması, manuel yenileme, zamanlanmış tur ve yeniden başlatma
 * aynı siparişi tekrar tekrar getirebilir; anahtar bu yüzden yalnız kalıcı
 * kimlikten türer (zaman/деneme sayısı GİRMEZ).
 */
export function buildPrepJobKey(identity: PrepJobIdentity): string {
  return [
    text(identity.organizationId),
    text(identity.marketplace),
    text(identity.packageId),
    identity.operation ?? 'CREATE',
  ].join('::')
}

export interface PrepJob extends PrepJobIdentity {
  key: string
  state: PrepJobState
  enqueuedAt: string
  updatedAt: string
  /** Aynı iş için gelen tekrar istek sayısı (gözlemlenebilirlik). */
  duplicateRequests: number
  blockedReason: string | null
}

const jobs = new Map<string, PrepJob>()

export interface EnqueueResult {
  enqueued: boolean
  duplicate: boolean
  job: PrepJob | null
  eligibility: BarcodeEligibility
}

/**
 * ORDER_SYNCED → uygunluk → BARCODE_PREP_PENDING.
 *
 * İDEMPOTENT: aynı anahtar için ikinci çağrı YENİ iş üretmez, mevcut işi döner.
 * Uygun olmayan sipariş kuyruğa GİRMEZ.
 */
export function enqueueBarcodePreparation(
  identity: PrepJobIdentity,
  input: BarcodeEligibilityInput,
  now: Date = new Date(),
): EnqueueResult {
  const key = buildPrepJobKey(identity)
  const existing = jobs.get(key) ?? null
  const eligibility = evaluateBarcodeEligibility({
    ...input,
    jobState: existing?.state ?? input.jobState ?? null,
  })

  if (existing) {
    existing.duplicateRequests += 1
    existing.updatedAt = now.toISOString()
    // TEK MANTIKSAL İŞ: taşıyıcı yan etkisi tekrarlanamaz.
    return { enqueued: false, duplicate: true, job: { ...existing }, eligibility }
  }
  if (eligibility.state !== 'ELIGIBLE') {
    return { enqueued: false, duplicate: false, job: null, eligibility }
  }

  const job: PrepJob = {
    ...identity,
    operation: identity.operation ?? 'CREATE',
    key,
    state: 'PENDING',
    enqueuedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    duplicateRequests: 0,
    blockedReason: null,
  }
  jobs.set(key, job)
  return { enqueued: true, duplicate: false, job: { ...job }, eligibility }
}

/** Durum geçişi — kanonik yaşam döngüsüyle çelişen sıçrama YAPILMAZ. */
const ALLOWED_TRANSITIONS: Record<PrepJobState, PrepJobState[]> = {
  PENDING: ['PROCESSING', 'BLOCKED'],
  PROCESSING: ['READY', 'FAILED_SAFE', 'BLOCKED'],
  READY: [],
  BLOCKED: ['PENDING'],
  FAILED_SAFE: ['PENDING'],
}

export function transitionPrepJob(
  key: string,
  next: PrepJobState,
  options: { blockedReason?: string; now?: Date } = {},
): { changed: boolean; job: PrepJob | null } {
  const job = jobs.get(key)
  if (!job) return { changed: false, job: null }
  if (!ALLOWED_TRANSITIONS[job.state].includes(next)) {
    return { changed: false, job: { ...job } }
  }
  job.state = next
  job.blockedReason = next === 'BLOCKED' ? (options.blockedReason ?? 'UNSPECIFIED') : null
  job.updatedAt = (options.now ?? new Date()).toISOString()
  return { changed: true, job: { ...job } }
}

export function getPrepJob(key: string): PrepJob | null {
  const job = jobs.get(key)
  return job ? { ...job } : null
}

/** Tenant kapsamlı sayaçlar — İÇERİK loglanmaz (barkod/ZPL/kimlik YOK). */
export function getPrepQueueSnapshot(organizationId?: string): Record<PrepJobState, number> {
  const snapshot: Record<PrepJobState, number> = {
    PENDING: 0, PROCESSING: 0, READY: 0, BLOCKED: 0, FAILED_SAFE: 0,
  }
  const scope = text(organizationId)
  for (const job of jobs.values()) {
    if (scope && job.organizationId !== scope) continue
    snapshot[job.state] += 1
  }
  return snapshot
}

export function resetBarcodePrepQueue(): void {
  jobs.clear()
}

/* ═══ CANLI İŞÇİ — VARSAYILAN KAPALI ═══════════════════════════════════ */

/**
 * CANLI TAŞIYICI ÇAĞRISI KAPISI.
 *
 * Varsayılan KAPALI. Açık bir ortam değişkeni olmadan hiçbir kod yolu Sürat'a
 * çıkamaz; başlangıçta kendiliğinden etkinleşen bir davranış YOKTUR.
 */
export function isLiveBarcodeWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return String(env.LIVE_SURAT_BARCODE_WORKER ?? '').trim().toLowerCase() === 'true'
}
