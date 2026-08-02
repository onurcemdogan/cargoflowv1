// Durusoft ↔ CargoFlow sipariş/paket sayısı mutabakatı — SAF model (IO YOK).
//
// AMAÇ: "Durusoft 35 paket, CargoFlow 25" farkının hangi katmandan geldiğini
// KANITA bağlamak. Provider çağrısı, DB write ve UI değişikliği YOKTUR.
//
// GİZLİLİK: müşteri adı, adres, telefon, ham order/package ID veya payload
// DIŞARI ÇIKMAZ. Kayıt düzeyinde tek bilgi SHA-256'nın ilk 12 karakteri +
// marketplace status + operation status + exclusion bucket'tır.
import { createHash } from 'node:crypto'

export type ReconcileConclusion =
  | 'FILTER_SEMANTICS_MISMATCH'
  | 'LOCAL_DATA_MISSING'
  | 'UI_FILTER_BUG'
  | 'ACCOUNT_SCOPE_BUG'
  | 'PROVIDER_FETCH_INCOMPLETE'
  | 'COUNT_DEFINITION_MISMATCH'

// Provider paketinin CargoFlow UI'ye inerken düştüğü aşama.
export type ExclusionStage =
  | 'outside_date_range'
  | 'marketplace_status_excluded'
  | 'operation_status_excluded'
  | 'label_ready_separated'
  | 'shipped_or_delivered_excluded'
  | 'cancelled_or_returned_excluded'
  | 'archived'
  | 'account_scope_mismatch'
  | 'missing_local_order'
  | 'missing_lines'
  | 'duplicate_package_id'
  | 'pagination_or_fetch_incomplete'
  | 'unknown'

export const EXCLUSION_STAGES: ExclusionStage[] = [
  'outside_date_range',
  'marketplace_status_excluded',
  'operation_status_excluded',
  'label_ready_separated',
  'shipped_or_delivered_excluded',
  'cancelled_or_returned_excluded',
  'archived',
  'account_scope_mismatch',
  'missing_local_order',
  'missing_lines',
  'duplicate_package_id',
  'pagination_or_fetch_incomplete',
  'unknown',
]

export function safeFingerprint(value: string): string {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
}

export interface PackageFacts {
  packageId: string
  orderNumber?: string
  marketplaceStatus?: string
  operationStatus?: string
  archived?: boolean
  marketplaceAccountId?: string | null
  lineCount?: number
  quantityTotal?: number
  orderDate?: string
  marketplaceLastModifiedAt?: string
}

export interface CountModel {
  distinctPackageCount: number
  distinctOrderCount: number
  lineCount: number
  quantityTotal: number
  statusBuckets: Record<string, number>
}

export function summarizePackages(rows: PackageFacts[]): CountModel {
  const packages = new Set<string>()
  const orderNumbers = new Set<string>()
  const statusBuckets: Record<string, number> = {}
  let lineCount = 0
  let quantityTotal = 0
  for (const row of rows) {
    if (row.packageId) packages.add(row.packageId)
    if (row.orderNumber) orderNumbers.add(row.orderNumber)
    lineCount += Number(row.lineCount ?? 0)
    quantityTotal += Number(row.quantityTotal ?? 0)
    const key = String(row.marketplaceStatus ?? 'unknown') || 'unknown'
    statusBuckets[key] = (statusBuckets[key] ?? 0) + 1
  }
  return {
    distinctPackageCount: packages.size,
    distinctOrderCount: orderNumbers.size,
    lineCount,
    quantityTotal,
    statusBuckets,
  }
}

// İKİ TARİH EKSENİ AYRI. Tek rakamda karıştırılmaz.
export interface DualDateBasisCounts {
  orderDateCohort: number
  modifiedAtActivity: number
}

export function countByDateBasis(
  rows: PackageFacts[],
  startIso: string,
  endIso: string,
): DualDateBasisCounts {
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  const inRange = (value?: string): boolean => {
    if (!value) return false
    const ms = Date.parse(value)
    return Number.isFinite(ms) && ms >= start && ms < end
  }
  const cohort = new Set<string>()
  const activity = new Set<string>()
  for (const row of rows) {
    if (inRange(row.orderDate)) cohort.add(row.packageId)
    if (inRange(row.marketplaceLastModifiedAt)) activity.add(row.packageId)
  }
  return { orderDateCohort: cohort.size, modifiedAtActivity: activity.size }
}

export interface ExclusionTally {
  buckets: Record<ExclusionStage, number>
  samples: Array<{
    fingerprint: string
    marketplaceStatus: string
    operationStatus: string
    stage: ExclusionStage
  }>
}

const MAX_SAMPLES_PER_STAGE = 3

export function emptyExclusionTally(): ExclusionTally {
  const buckets = {} as Record<ExclusionStage, number>
  for (const stage of EXCLUSION_STAGES) buckets[stage] = 0
  return { buckets, samples: [] }
}

// Bir paketi TEK bir bucket'a yazar (çift sayım yok).
export function tallyExclusion(
  tally: ExclusionTally,
  row: PackageFacts,
  stage: ExclusionStage,
): void {
  tally.buckets[stage] += 1
  const taken = tally.samples.filter((s) => s.stage === stage).length
  if (taken < MAX_SAMPLES_PER_STAGE) {
    tally.samples.push({
      fingerprint: safeFingerprint(row.packageId),
      marketplaceStatus: String(row.marketplaceStatus ?? ''),
      operationStatus: String(row.operationStatus ?? ''),
      stage,
    })
  }
}

export interface ReconciliationInvariant {
  providerDistinctPackages: number
  cargoFlowVisiblePackages: number
  excludedTotal: number
  balanced: boolean
  unexplained: number
}

// İNVARYANT: provider paketleri = UI'de görünen + tüm exclusion bucket'ları.
export function checkInvariant(
  providerDistinctPackages: number,
  cargoFlowVisiblePackages: number,
  tally: ExclusionTally,
): ReconciliationInvariant {
  const excludedTotal = EXCLUSION_STAGES.reduce(
    (total, stage) => total + tally.buckets[stage],
    0,
  )
  const unexplained =
    providerDistinctPackages - cargoFlowVisiblePackages - excludedTotal
  return {
    providerDistinctPackages,
    cargoFlowVisiblePackages,
    excludedTotal,
    balanced: unexplained === 0,
    unexplained,
  }
}

export interface ConclusionInput {
  // Kapsamdaki TÜM yerel kayıtlar (sayfa sınırı UYGULANMADAN).
  localScopePackageCount: number
  // UI'nin GERÇEKTEN yüklediği kayıt sayısı (sayfa sınırı UYGULANARAK).
  uiLoadedPackageCount: number
  // Backend'in bildirdiği toplam (COUNT(*), sayfa sınırından bağımsız).
  backendReportedTotal: number
  uiPageSize: number
  uiRequestsAllPages: boolean
  providerDistinctPackages?: number
  providerComplete?: boolean
  accountScopeMismatchCount: number
  duplicatePackageCount: number
  missingLocalOrderCount: number
}

export interface ReconcileDecision {
  conclusion: ReconcileConclusion
  message: string
  evidence: string[]
}

// Karar sırası bilinçli: önce ölçülebilir MEKANİK kusurlar (fetch/scope/
// pagination), sonra veri eksikliği, en son semantik/tanım farkı. Kanıt
// olmadan "Durusoft yanlış" veya "CargoFlow eksik" DENMEZ.
export function decideReconciliation(input: ConclusionInput): ReconcileDecision {
  const evidence: string[] = []

  if (input.providerComplete === false) {
    return {
      conclusion: 'PROVIDER_FETCH_INCOMPLETE',
      message:
        'Provider tarafında eksik sayfa/statü penceresi var; sayılar ' +
        'karşılaştırılabilir değil.',
      evidence: ['providerComplete=false'],
    }
  }

  if (input.accountScopeMismatchCount > 0) {
    return {
      conclusion: 'ACCOUNT_SCOPE_BUG',
      message:
        `${input.accountScopeMismatchCount} paket beklenen marketplace ` +
        'hesabının dışında kayıtlı.',
      evidence: [`accountScopeMismatch=${input.accountScopeMismatchCount}`],
    }
  }

  // UI, kapsamdaki kayıtların yalnız bir SAYFASINI yüklüyorsa fark veri
  // eksikliğinden DEĞİL, yükleme katmanından gelir.
  const truncated =
    !input.uiRequestsAllPages &&
    input.backendReportedTotal > input.uiLoadedPackageCount
  if (truncated) {
    evidence.push(
      `backendTotal=${input.backendReportedTotal} > uiLoaded=${input.uiLoadedPackageCount}`,
      `uiPageSize=${input.uiPageSize}`,
      'uiRequestsAllPages=false',
      `uiLoaded === uiPageSize: ${input.uiLoadedPackageCount === input.uiPageSize}`,
    )
    return {
      conclusion: 'UI_FILTER_BUG',
      message:
        'Kayıtlar yerelde MEVCUT; CargoFlow sipariş listesi sayfa sınırı ' +
        `nedeniyle yalnız ilk ${input.uiPageSize} kaydı yüklüyor. Sekme ve ` +
        'özet sayıları bu kesilmiş küme üzerinden hesaplandığı için düşük ' +
        'çıkıyor. Veri kaybı YOK.',
      evidence,
    }
  }

  if (input.missingLocalOrderCount > 0) {
    return {
      conclusion: 'LOCAL_DATA_MISSING',
      message:
        `Provider'da olup yerelde bulunmayan ${input.missingLocalOrderCount} ` +
        'paket var.',
      evidence: [`missingLocalOrder=${input.missingLocalOrderCount}`],
    }
  }

  if (input.duplicatePackageCount > 0) {
    return {
      conclusion: 'COUNT_DEFINITION_MISMATCH',
      message:
        `${input.duplicatePackageCount} paket kimliği yinelenmiş; paket/kalem/` +
        'adet sayımı farklı anlamlarda toplanıyor.',
      evidence: [`duplicatePackageId=${input.duplicatePackageCount}`],
    }
  }

  return {
    conclusion: 'FILTER_SEMANTICS_MISMATCH',
    message:
      'Yerel kayıt sayısı ile provider sayısı, farklı statü/tarih tanımları ' +
      'nedeniyle ayrışıyor; mekanik bir kusur kanıtlanamadı.',
    evidence: [
      `localScope=${input.localScopePackageCount}`,
      `provider=${input.providerDistinctPackages ?? 'n/a'}`,
    ],
  }
}
