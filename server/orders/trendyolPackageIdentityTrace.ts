// ═══ TRENDYOL PAKET KİMLİĞİ TANI ÇEKİRDEĞİ — SALT OKUNUR ══════════════════
//
// AMAÇ (TEK): Trendyol'un GÜNCEL paket kimliği ile CargoFlow'un KALICI paket
// kimliği neden uyuşmuyor, bunu kanıtlamak. Burada HİÇBİR yazma, eşleme
// düzeltmesi veya statü kararı YOKTUR — yalnız okuma + sınıflandırma.
//
// SORGU SÖZLEŞMESİ (KANITLI, TAHMİN DEĞİL):
// `server/index.mjs` → `callTrendyolOrders` yalnız şu parametreleri kurar:
//   startDate · endDate · page · size(<=200) · orderByField/orderByDirection
//   · status (opsiyonel) · orderNumber (opsiyonel)
// ve tarih aralığı EN FAZLA 30 GÜN olabilir. Bu modül AYNI sözleşmeyi
// kullanır; `shipmentPackageIds` gibi KANITLANMAMIŞ bir parametre UYDURULMAZ.
//
// Bu yüzden "exact package" sorgusu AYRI bir uç değildir: orderNumber
// sorgusunun sonucu içinde paket kimliği taranır (`orderNumber_scan`).
// Sonuç boşsa "yok" DENMEZ — `inconclusive` raporlanır (pencere dışında
// kalmış olabilir).

/** Trendyol paket kaydından PII'siz teknik kimlik alanları. */
export interface PackageIdentityFields {
  /** `normalizeTrendyolOrders` ile AYNI türetme: packageId ?? shipmentPackageId ?? id */
  packageId: string
  rawIds: {
    id: string | null
    packageId: string | null
    shipmentPackageId: string | null
  }
  orderNumber: string | null
  status: string | null
  shipmentPackageStatus: string | null
  packageStatus: string | null
  lastModifiedDate: string | number | null
  lastModifiedAtMs: number | null
  originPackageIds: unknown[] | null
}

/** İLERİ (kargoya verilmiş/kapanmış) pazaryeri statüleri — kanonik küme. */
export const FORWARD_MARKETPLACE_STATUSES = [
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
] as const

const MAX_WINDOW_MS = 1000 * 60 * 60 * 24 * 30

function text(value: unknown): string | null {
  const out = String(value ?? '').trim()
  return out === '' ? null : out
}

/**
 * Paket zaman damgası (epoch ms). `index.mjs` → `trendyolPackageModifiedAt`
 * ile AYNI semantik; çözülemezse null.
 */
export function resolvePackageModifiedAt(item: unknown): number | null {
  const record = (item ?? {}) as Record<string, unknown>
  const raw =
    record.lastModifiedDate ?? record.lastModifiedAt ?? record.packageModifiedDate
  if (raw === undefined || raw === null || raw === '') return null
  const numeric = Number(raw)
  const time = Number.isFinite(numeric) ? numeric : Date.parse(String(raw))
  return Number.isFinite(time) ? time : null
}

/**
 * YALNIZ teknik kimlik/statü alanları. Müşteri adı, adres, telefon, satır
 * içeriği ve tutar DIŞARIDA BIRAKILIR (PII YOK).
 */
export function extractPackageIdentityFields(
  item: unknown,
): PackageIdentityFields {
  const record = (item ?? {}) as Record<string, unknown>
  const origin = record.originPackageIds ?? record.originShipmentPackageIds
  return {
    // `normalizeTrendyolOrders` ile AYNI öncelik — kalıcı packageId ile
    // birebir karşılaştırılabilir olmalı.
    packageId: String(
      record.packageId ?? record.shipmentPackageId ?? record.id ?? '',
    ),
    rawIds: {
      id: text(record.id),
      packageId: text(record.packageId),
      shipmentPackageId: text(record.shipmentPackageId),
    },
    orderNumber: text(record.orderNumber),
    status: text(record.status),
    shipmentPackageStatus: text(record.shipmentPackageStatus),
    packageStatus: text(record.packageStatus),
    lastModifiedDate:
      (record.lastModifiedDate as string | number | undefined) ?? null,
    lastModifiedAtMs: resolvePackageModifiedAt(record),
    originPackageIds: Array.isArray(origin) ? origin : null,
  }
}

/** Paketin ETKİN statüsü: status → shipmentPackageStatus → packageStatus. */
export function effectiveStatusOf(fields: PackageIdentityFields): string | null {
  return fields.status ?? fields.shipmentPackageStatus ?? fields.packageStatus
}

export function isForwardStatus(status: string | null): boolean {
  if (!status) return false
  return (FORWARD_MARKETPLACE_STATUSES as readonly string[]).includes(status)
}

// ═══ SORGU PENCERESİ ══════════════════════════════════════════════════════

export interface TraceWindow {
  startDate: number
  endDate: number
  /** Pencerenin nasıl seçildiği — raporda görünür, sessiz sihir YOK. */
  basis: 'explicit' | 'orderDate' | 'now'
  clampedTo30Days: boolean
}

/**
 * Trendyol 30 GÜN sınırını AŞMAYAN bir pencere üretir.
 *   - explicit start/end verilirse o kullanılır (30 günü aşarsa KIRPILIR),
 *   - yoksa sipariş tarihine çapalanır (orderDate - 1 gün),
 *   - sipariş tarihi de yoksa şimdiden geriye windowDays.
 * `endDate` gelecekte olamaz (now ile sınırlanır) ve DAİMA >= startDate.
 */
export function resolveTraceWindow(input: {
  nowMs: number
  orderDateMs?: number | null
  windowDays?: number
  startOverrideMs?: number | null
  endOverrideMs?: number | null
}): TraceWindow {
  const now = input.nowMs
  const days = Math.min(30, Math.max(1, Math.trunc(input.windowDays ?? 30)))

  if (
    Number.isFinite(input.startOverrideMs ?? NaN) ||
    Number.isFinite(input.endOverrideMs ?? NaN)
  ) {
    const end = Math.min(
      now,
      Number.isFinite(input.endOverrideMs ?? NaN)
        ? (input.endOverrideMs as number)
        : now,
    )
    const requestedStart = Number.isFinite(input.startOverrideMs ?? NaN)
      ? (input.startOverrideMs as number)
      : end - days * 24 * 60 * 60 * 1000
    const start = Math.max(requestedStart, end - MAX_WINDOW_MS)
    return {
      startDate: Math.min(start, end),
      endDate: end,
      basis: 'explicit',
      clampedTo30Days: start !== requestedStart,
    }
  }

  if (Number.isFinite(input.orderDateMs ?? NaN)) {
    const anchor = (input.orderDateMs as number) - 24 * 60 * 60 * 1000
    const end = Math.min(now, anchor + MAX_WINDOW_MS)
    return {
      startDate: Math.min(anchor, end),
      endDate: end,
      basis: 'orderDate',
      clampedTo30Days: anchor + MAX_WINDOW_MS > now,
    }
  }

  return {
    startDate: now - days * 24 * 60 * 60 * 1000,
    endDate: now,
    basis: 'now',
    clampedTo30Days: false,
  }
}

/**
 * `callTrendyolOrders` ile AYNI parametre kümesi. `status` GÖNDERİLMEZ:
 * amaç TÜM statüleri (ileri statüler dâhil) görmek.
 */
export function buildOrdersQueryUrl(input: {
  baseUrl: string
  sellerId: string
  orderNumber: string
  startDate: number
  endDate: number
  page?: number
  size?: number
}): string {
  const params = new URLSearchParams({
    startDate: String(input.startDate),
    endDate: String(input.endDate),
    page: String(input.page ?? 0),
    size: String(Math.min(Number(input.size ?? 200), 200)),
  })
  params.set('orderByField', 'PackageLastModifiedDate')
  params.set('orderByDirection', 'DESC')
  params.set('orderNumber', input.orderNumber)
  return `${input.baseUrl}/integration/order/sellers/${encodeURIComponent(
    input.sellerId,
  )}/orders?${params}`
}

/** Trendyol sayfalı yanıtından paket dizisi. */
export function packagesOf(payload: unknown): unknown[] {
  const record = (payload ?? {}) as Record<string, unknown>
  if (Array.isArray(record.content)) return record.content
  if (Array.isArray(payload)) return payload as unknown[]
  return []
}

// ═══ VAKA SINIFLANDIRMASI ═════════════════════════════════════════════════

export type IdentityCase =
  | 'B1_package_split_or_replacement'
  | 'B2_persistence_or_matching_bug'
  | 'B3_replacement_package'
  | 'E_entity_mismatch'
  | 'INCONCLUSIVE_no_packages_in_window'

export interface IdentityCaseResult {
  case: IdentityCase
  exactFound: boolean
  exactStatus: string | null
  forwardPackageIds: string[]
  otherPackageIds: string[]
  /** Kanıt yetersizse fix yazılmaz — bu bayrak raporda görünür. */
  conclusive: boolean
  note: string
}

/**
 * SINIFLANDIRMA — kullanıcı sözleşmesindeki caseler:
 *   B1: exact paket ileri DEĞİL + başka paket İLERİ  → split/replacement
 *   B2: exact paket İLERİ, DB geride                 → persistence/matching bug
 *   B3: exact paket YOK + başka paket İLERİ          → replacement package
 *   E : exact paket ileri DEĞİL + başka paket YOK    → panel/API entity farkı
 * Hiç paket dönmezse KARAR VERİLMEZ (pencere dışında kalmış olabilir).
 */
export function classifyPackageIdentityCase(input: {
  persistedPackageId: string
  packages: PackageIdentityFields[]
}): IdentityCaseResult {
  const persisted = String(input.persistedPackageId ?? '').trim()
  const exact = input.packages.find((pkg) => pkg.packageId === persisted) ?? null
  const others = input.packages.filter((pkg) => pkg.packageId !== persisted)
  const forward = others.filter((pkg) => isForwardStatus(effectiveStatusOf(pkg)))
  const forwardPackageIds = forward.map((pkg) => pkg.packageId)
  const otherPackageIds = others.map((pkg) => pkg.packageId)
  const exactStatus = exact ? effectiveStatusOf(exact) : null

  if (input.packages.length === 0) {
    return {
      case: 'INCONCLUSIVE_no_packages_in_window',
      exactFound: false,
      exactStatus: null,
      forwardPackageIds,
      otherPackageIds,
      conclusive: false,
      note: 'Sorgu penceresinde HİÇ paket dönmedi. Bu, paketin YOK olduğunu KANITLAMAZ; pencereyi genişletip tekrar çalıştır.',
    }
  }

  if (exact && isForwardStatus(exactStatus)) {
    return {
      case: 'B2_persistence_or_matching_bug',
      exactFound: true,
      exactStatus,
      forwardPackageIds,
      otherPackageIds,
      conclusive: true,
      note: 'Trendyol bu paketi ileri statüde döndürüyor; kalıcı kayıt geride. Kalıcılık/eşleme hattı incelenmeli.',
    }
  }

  if (exact && forward.length > 0) {
    return {
      case: 'B1_package_split_or_replacement',
      exactFound: true,
      exactStatus,
      forwardPackageIds,
      otherPackageIds,
      conclusive: true,
      note: 'Aynı sipariş altında ileri statülü BAŞKA paket var. originPackageIds ilişkisi kanıtlanmadan eski paket ileri statüye ÇEKİLMEZ.',
    }
  }

  if (!exact && forward.length > 0) {
    return {
      case: 'B3_replacement_package',
      exactFound: false,
      exactStatus: null,
      forwardPackageIds,
      otherPackageIds,
      conclusive: true,
      note: 'Kalıcı paket kimliği yanıtta YOK, ileri statülü başka paket VAR. Replacement package güçlü aday; originPackageIds ile doğrula.',
    }
  }

  if (exact) {
    return {
      case: 'E_entity_mismatch',
      exactFound: true,
      exactStatus,
      forwardPackageIds,
      otherPackageIds,
      conclusive: true,
      note: 'Trendyol API bu paketi hâlâ ileri OLMAYAN statüde döndürüyor ve alternatif paket yok. Panel ile API entity/statü farkı ayrıca araştırılmalı.',
    }
  }

  return {
    case: 'INCONCLUSIVE_no_packages_in_window',
    exactFound: false,
    exactStatus: null,
    forwardPackageIds,
    otherPackageIds,
    conclusive: false,
    note: 'Kalıcı paket yanıtta yok ve ileri statülü alternatif de yok. Pencere/sipariş numarası doğrulanmadan karar verilemez.',
  }
}
