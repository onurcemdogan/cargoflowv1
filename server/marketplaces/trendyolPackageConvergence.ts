// PAKET YAKINSAMASI — webhook · stream · manuel yenileme TEK KAYITTA buluşur.
//
// ═══ KİMLİK ══════════════════════════════════════════════════════════════
//
// Paket kimliği `shipmentPackageId`/`packageId`tir. `orderNumber` DEĞİLDİR:
// bir sipariş birden çok gönderi paketine BÖLÜNEBİLİR ve iptal edilen bir
// paketin yerine YENİ `packageId` gelebilir. Sipariş numarasını kimlik
// saymak bu paketleri birbirine ezdirir.
//
// ═══ TAZELİK ═════════════════════════════════════════════════════════════
//
// Aynı paket birden çok kaynaktan, SIRASIZ gelebilir. Karar YALNIZ
// `lastModifiedDate` ile verilir: eski olay yeni veriyi EZEMEZ. Örtüşen
// mutabakat pencereleri bu sayede ZARARSIZDIR.
//
// SAF KARAR — DB YOK, AĞ YOK.

export const CONVERGENCE_DECISIONS = [
  'INSERT',
  'UPDATE',
  'SKIP_STALE',
  'SKIP_UNCHANGED',
  'REJECT_NO_IDENTITY',
] as const

export type ConvergenceDecision = (typeof CONVERGENCE_DECISIONS)[number]

export interface IncomingPackage {
  packageId?: unknown
  shipmentPackageId?: unknown
  orderNumber?: unknown
  cargoTrackingNumber?: unknown
  status?: unknown
  lastModifiedDate?: unknown
}

export interface StoredPackage {
  packageId?: unknown
  orderNumber?: unknown
  cargoTrackingNumber?: unknown
  providerStatus?: unknown
  marketplaceLastModifiedAt?: unknown
}

export interface ConvergenceResult {
  decision: ConvergenceDecision
  packageId: string
  reason: string
  incomingModifiedMs: number | null
  storedModifiedMs: number | null
}

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/** Epoch ms | ISO | Date → ms. Çözülemezse `null` (UYDURULMAZ). */
export function toModifiedMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw)
    return Number.isFinite(numeric) ? numeric : null
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/** Kanonik paket kimliği — `orderNumber` ASLA kullanılmaz. */
export function resolvePackageIdentity(incoming: IncomingPackage): string {
  return text(incoming.shipmentPackageId) || text(incoming.packageId)
}

/**
 * Tek karar noktası.
 *
 * `stored === null` → INSERT.
 * Gelen veri ESKİ ise → SKIP_STALE (yeni yerel veri KORUNUR).
 * Anlamlı alanlar aynıysa → SKIP_UNCHANGED (gereksiz yazma YOK).
 */
export function resolvePackageConvergence(params: {
  incoming: IncomingPackage
  stored: StoredPackage | null
}): ConvergenceResult {
  const packageId = resolvePackageIdentity(params.incoming)
  const incomingModifiedMs = toModifiedMs(params.incoming.lastModifiedDate)
  const storedModifiedMs = params.stored
    ? toModifiedMs(params.stored.marketplaceLastModifiedAt)
    : null

  if (!packageId) {
    return {
      decision: 'REJECT_NO_IDENTITY',
      packageId: '',
      reason: 'shipmentPackageId/packageId YOK; orderNumber kimlik DEĞİLDİR.',
      incomingModifiedMs, storedModifiedMs,
    }
  }

  if (!params.stored) {
    return {
      decision: 'INSERT', packageId,
      reason: 'Yerel kayıt yok.',
      incomingModifiedMs, storedModifiedMs,
    }
  }

  // ESKİ OLAY YENİYİ EZEMEZ. Eşitlik güncellemeye izin verir: aynı damga ile
  // gelen düzeltmeler uygulanabilir, ama GERİYE gidiş engellenir.
  if (
    incomingModifiedMs !== null && storedModifiedMs !== null
    && incomingModifiedMs < storedModifiedMs
  ) {
    return {
      decision: 'SKIP_STALE', packageId,
      reason: 'Gelen olay yerel veriden ESKİ.',
      incomingModifiedMs, storedModifiedMs,
    }
  }

  const changed =
    text(params.incoming.status) !== text(params.stored.providerStatus)
    || text(params.incoming.cargoTrackingNumber)
      !== text(params.stored.cargoTrackingNumber)
    || text(params.incoming.orderNumber) !== text(params.stored.orderNumber)
    || (incomingModifiedMs !== null && incomingModifiedMs !== storedModifiedMs)

  if (!changed) {
    return {
      decision: 'SKIP_UNCHANGED', packageId,
      reason: 'Anlamlı alan değişmedi; gereksiz yazma yapılmaz.',
      incomingModifiedMs, storedModifiedMs,
    }
  }

  return {
    decision: 'UPDATE', packageId,
    reason: 'Daha yeni ya da değişmiş pazaryeri verisi.',
    incomingModifiedMs, storedModifiedMs,
  }
}

/**
 * Bir partiyi kimliğe göre TEKİLLEŞTİRİR ve en TAZE olanı seçer.
 *
 * Örtüşen pencereler ve webhook+stream ikilemesi burada erir; aşağı akışa
 * paket başına TEK giriş gider.
 */
export function dedupeIncomingPackages(
  incoming: IncomingPackage[],
): IncomingPackage[] {
  const freshest = new Map<string, { entry: IncomingPackage; ms: number }>()
  for (const entry of incoming) {
    const packageId = resolvePackageIdentity(entry)
    if (!packageId) continue
    const ms = toModifiedMs(entry.lastModifiedDate) ?? -1
    const current = freshest.get(packageId)
    if (!current || ms >= current.ms) freshest.set(packageId, { entry, ms })
  }
  return [...freshest.values()].map((value) => value.entry)
}
