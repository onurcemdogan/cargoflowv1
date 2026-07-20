// Dashboard satış analitiği için iade (claim) mutabakat yardımcıları.
// Tamamen saf: yan etki yok, yalnız claim verisini sınıflar ve dönem
// bazında satış toplamlarından düşülecek net iade etkisini üretir.
// Operational store, Sürat, persistence akışlarıyla İLGİSİ yoktur.

// Backend /api/analytics/claims normalize çıktısının şekli.
export interface AnalyticsClaim {
  claimId: string
  packageId: string
  orderNumber: string
  orderLineId: string
  claimStatus: string
  claimType?: string
  eventDate: string
  quantity: number
  amount: number | null
  amountSource?: string
  isAcceptedReturn?: boolean
  isCancelledOrRejected?: boolean
}

export type ClaimDisposition =
  | 'accepted_return'
  | 'pending'
  | 'rejected'
  | 'ignored'

export interface ClassifiedClaim {
  disposition: ClaimDisposition
  effectiveDate: string
  packageId: string
  lineId: string
  quantity: number
  amount: number
  amountAvailable: boolean
}

// Trendyol getClaims canlı sözleşmesinden doğrulanan statü adları:
// Accepted / Cancelled / Rejected / Created / WaitingInAction (+ dokümandaki
// WaitingFraudCheck / Unresolved / InAnalysis). YALNIZ kabul edilmiş iadeler
// satıştan düşülür.
const ACCEPTED_CLAIM_STATUSES = new Set(['accepted'])
const REJECTED_CLAIM_STATUSES = new Set(['rejected', 'cancelled', 'canceled'])
const PENDING_CLAIM_STATUSES = new Set([
  'created',
  'waitinginaction',
  'waitingfraudcheck',
  'unresolved',
  'inanalysis',
])

// Saf helper: tek bir claim'i satış etkisine göre sınıflar. Bilinmeyen statü
// 'ignored' döner ve hiçbir metriği etkilemez (güvenli varsayılan).
export function classifyAnalyticsClaim(claim: AnalyticsClaim): ClassifiedClaim {
  const status = String(claim?.claimStatus ?? '')
    .trim()
    .toLowerCase()
  let disposition: ClaimDisposition
  if (ACCEPTED_CLAIM_STATUSES.has(status)) {
    disposition = 'accepted_return'
  } else if (REJECTED_CLAIM_STATUSES.has(status)) {
    disposition = 'rejected'
  } else if (PENDING_CLAIM_STATUSES.has(status)) {
    disposition = 'pending'
  } else {
    disposition = 'ignored'
  }
  const rawAmount = Number(claim?.amount)
  const amountAvailable = Number.isFinite(rawAmount) && rawAmount >= 0
  return {
    disposition,
    effectiveDate: String(claim?.eventDate ?? ''),
    packageId: String(claim?.packageId ?? ''),
    lineId: String(claim?.orderLineId ?? ''),
    quantity: Math.max(0, Number(claim?.quantity ?? 0)),
    amount: amountAvailable ? rawAmount : 0,
    amountAvailable,
  }
}

export interface ClaimPeriodAdjustment {
  // Tamamen iade edilen paket sayısı (packageNet'ten düşülür).
  packageDeduction: number
  // Kabul edilen iade satır sayısı (lineNet'ten düşülür).
  lineDeduction: number
  // Kabul edilen iade adedi (unitNet'ten düşülür).
  unitDeduction: number
  // Kabul edilen iade tutarı (salesNet'ten düşülür, returnCancelNet'e eklenir).
  amountDeduction: number
  // Dönemde iade edilen distinct paket sayısı (returnedPackageCount).
  returnedPackageCount: number
  // Herhangi bir claim'de tutar hesaplanamadıysa true (ör. fiyat yoksa).
  amountUnavailable: boolean
}

export interface ClaimPeriodOptions {
  // Dönemde ZATEN status ile iade/iptal sayılan paketler; çift düşümü önler.
  excludePackageIds?: Set<string>
  // packageId → satış toplam adedi; tam/kısmi PAKET iadesi ayrımı için.
  packageQuantityLookup?: (packageId: string) => number | undefined
  // (packageId, lineId) → satış satır adedi; tam/kısmi SATIR iadesi ayrımı
  // için. Eşleşme bulunamazsa satır tam iade kabul edilir.
  lineQuantityLookup?: (packageId: string, lineId: string) => number | undefined
}

// Verilen claim listesinden, döneme AİT kabul edilmiş iadeleri toplayıp net
// etkiyi üretir. Döneme aitlik `isClaimInPeriod` ile dışarıdan belirlenir
// (order-cohort: iade edilen siparişin ayı). claimId+lineId ile tekilleştirir
// (aynı claim iki sayfada gelse bile bir kez uygulanır).
export function summarizeAcceptedClaimsForPeriod(
  claims: AnalyticsClaim[] | undefined,
  isClaimInPeriod: (claim: AnalyticsClaim) => boolean,
  options: ClaimPeriodOptions = {},
): ClaimPeriodAdjustment {
  const empty: ClaimPeriodAdjustment = {
    packageDeduction: 0,
    lineDeduction: 0,
    unitDeduction: 0,
    amountDeduction: 0,
    returnedPackageCount: 0,
    amountUnavailable: false,
  }
  if (!Array.isArray(claims) || claims.length === 0) return empty

  const excludePackageIds = options.excludePackageIds ?? new Set<string>()
  const seenClaimLines = new Set<string>()
  // packageId → { quantity, amount, perLineQty, amountUnavailable }
  const byPackage = new Map<
    string,
    {
      quantity: number
      amount: number
      perLineQty: Map<string, number>
      amountUnavailable: boolean
    }
  >()

  for (const rawClaim of claims) {
    const classified = classifyAnalyticsClaim(rawClaim)
    if (classified.disposition !== 'accepted_return') continue
    if (!isClaimInPeriod(rawClaim)) continue
    if (excludePackageIds.has(classified.packageId)) continue
    // Aynı (claim, satır) iki kez uygulanmasın.
    const dedupeKey = `${rawClaim.claimId}::${classified.lineId}`
    if (seenClaimLines.has(dedupeKey)) continue
    seenClaimLines.add(dedupeKey)

    const bucket = byPackage.get(classified.packageId) ?? {
      quantity: 0,
      amount: 0,
      perLineQty: new Map<string, number>(),
      amountUnavailable: false,
    }
    bucket.quantity += classified.quantity
    bucket.amount += classified.amount
    if (!classified.amountAvailable) bucket.amountUnavailable = true
    if (classified.lineId) {
      bucket.perLineQty.set(
        classified.lineId,
        (bucket.perLineQty.get(classified.lineId) ?? 0) + classified.quantity,
      )
    }
    byPackage.set(classified.packageId, bucket)
  }

  const adjustment: ClaimPeriodAdjustment = { ...empty }
  for (const [packageId, bucket] of byPackage) {
    adjustment.amountDeduction += bucket.amount
    adjustment.unitDeduction += bucket.quantity
    adjustment.returnedPackageCount += 1
    if (bucket.amountUnavailable) adjustment.amountUnavailable = true
    // lineNet: yalnız TAM iade edilen satırlar düşülür. Satır satış adedi
    // biliniyor ve iade adedi ondan azsa satır kısmi iadedir, net'te kalır.
    for (const [lineId, returnedQty] of bucket.perLineQty) {
      const soldLineQty = options.lineQuantityLookup?.(packageId, lineId)
      const lineFullyReturned =
        soldLineQty == null || soldLineQty <= 0
          ? true
          : returnedQty >= soldLineQty
      if (lineFullyReturned) adjustment.lineDeduction += 1
    }
    // packageNet: paketin TÜM satış adedi iade edildiyse paket düşülür. Satış
    // kaydı yoksa (farklı dönem siparişi) tam iade kabul edilir.
    const soldQuantity = options.packageQuantityLookup?.(packageId)
    const fullReturn =
      soldQuantity == null || soldQuantity <= 0
        ? true
        : bucket.quantity >= soldQuantity
    if (fullReturn) adjustment.packageDeduction += 1
  }
  return adjustment
}
