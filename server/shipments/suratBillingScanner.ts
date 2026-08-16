// FATURALAMA KANITI TARAYICISI — SALT OKUNUR, SINIRLI, AĞSIZ.
//
// AMAÇ: production'da TEK komutla, kullanıcıdan hiçbir kimlik istemeden
// "hangi siparişler payer kanıtı taşıyor" sorusunu yanıtlamak.
//
// EN KRİTİK MİMARİ KISIT — TABAN ŞEMA UYUMLULUĞU:
//   Bu tarayıcı `order_filter_projection` (0008) ve `integration_sync_state`
//   yeni kolonlarına (0009) BAĞIMLI DEĞİLDİR. Production'da bu migration'lar
//   HENÜZ UYGULANMADI; tarayıcı bugünkü üretim şemasıyla çalışmak zorunda.
//   Yalnız `organizations`, `orders`, `shipments` okunur.
//
// GARANTİLER: DB yazma 0 · ağ çağrısı 0 · migration 0 · PII çıktısı 0.
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { orders, organizations, shipments } from '../db/schema.ts'
import { decryptOrderPayload } from '../orders/orderEncryption.ts'
import { decryptShipmentPayload } from './shipmentEncryption.ts'
import {
  inspectTrendyolBillingSource,
  summarizeBillingScan,
  type BillingCandidate,
  type BillingScanSummary,
} from './suratBillingParty.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const DEFAULT_SCAN_LIMIT = 100
export const MAX_SCAN_LIMIT = 500

/** Dış operasyonel gerçek: bu paket Sürat'ta whoPays=3 (TRENDYOL öder). */
export const GOLDEN_TRENDYOL_PAYS_PARCEL = '7270035725579605'

const text = (value: unknown): string => String(value ?? '').trim()

/** `****abcd` — tam kimlik BASILMAZ. */
export function maskIdentifier(value: unknown): string {
  const raw = text(value)
  return raw.length <= 4 ? '****' : `****${raw.slice(-4)}`
}

export function resolveScanLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SCAN_LIMIT
  return Math.min(Math.floor(parsed), MAX_SCAN_LIMIT)
}

export interface ResolvedOrganization {
  id: string
  name: string
  slug: string
}

/**
 * İSİMDEN TENANT ÇÖZÜMÜ — BELİRSİZLİKTE FAIL-CLOSED.
 *
 * Birden fazla aday varsa TAHMİN YAPILMAZ: yanlış tenant'ta teşhis yapmak
 * yanlış sonuç üretir. Çağıran adayları görüp kendisi seçmelidir.
 */
export async function resolveOrganizationByName(
  db: Db,
  name: string,
): Promise<
  | { status: 'ok'; organization: ResolvedOrganization }
  | { status: 'not_found'; candidates: [] }
  | { status: 'ambiguous'; candidates: ResolvedOrganization[] }
> {
  const needle = text(name).toLowerCase()
  if (!needle) return { status: 'not_found', candidates: [] }
  const rows = (await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizations)) as ResolvedOrganization[]

  const normalize = (value: unknown) =>
    text(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = normalize(needle)
  // ÖNCE tam eşleşme (isim veya slug); yalnız o yoksa içerir.
  const exact = rows.filter(
    (row) => normalize(row.name) === target || normalize(row.slug) === target,
  )
  const pool = exact.length > 0 ? exact : rows.filter(
    (row) =>
      normalize(row.name).includes(target) || normalize(row.slug).includes(target),
  )
  if (pool.length === 0) return { status: 'not_found', candidates: [] }
  if (pool.length > 1) return { status: 'ambiguous', candidates: pool }
  return { status: 'ok', organization: pool[0] }
}

export interface BillingScanCandidate extends BillingCandidate {
  /** getCargo araştırması için operasyonel paket kimliği (PII DEĞİL). */
  parcelIdentity: string | null
  isGoldenParcel: boolean
}

export interface BillingScanResult {
  organizationMasked: string
  organizationName: string
  ordersScanned: number
  summary: BillingScanSummary
  supplierCandidates: BillingScanCandidate[]
  trendyolPaysCandidates: BillingScanCandidate[]
  goldenFound: boolean
  goldenCandidate: BillingScanCandidate | null
  bestSameAccountPair: {
    groupKey: string
    supplier: BillingScanCandidate
    trendyol: BillingScanCandidate
  } | null
  /** Ölçüm: N+1 olmadığını kanıtlamak için. */
  dbQueryCount: number
}

/**
 * SINIRLI TARAMA — en fazla `limit` sipariş, sabit sayıda sorgu.
 *
 * Sipariş başına kimlik/gönderi sorgusu YAPILMAZ: gönderiler tek toplu
 * sorguyla, tenant Sürat yapılandırması ise TEK kez okunur.
 */
export async function scanTenantBillingCandidates(
  db: Db,
  organization: ResolvedOrganization,
  options: { limit?: number; suratConfig?: Record<string, unknown> } = {},
): Promise<BillingScanResult> {
  const limit = resolveScanLimit(options.limit)
  let dbQueryCount = 0

  // (1) Aday siparişler — TEK sorgu, SQL LIMIT ile sınırlı.
  const orderRows = (await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organization.id),
        eq(orders.marketplace, 'Trendyol'),
      ),
    )
    .orderBy(desc(orders.orderDate), desc(orders.id))
    .limit(limit)) as Record<string, unknown>[]
  dbQueryCount += 1

  const packageIds = [
    ...new Set(orderRows.map((row) => text(row.packageId)).filter(Boolean)),
  ]

  // (2) Gönderiler — TEK toplu sorgu (sipariş başına sorgu YOK).
  const shipmentRows = packageIds.length
    ? ((await db
        .select()
        .from(shipments)
        .where(
          and(
            eq(shipments.organizationId, organization.id),
            inArray(shipments.packageId, packageIds),
          ),
        )) as Record<string, unknown>[])
    : []
  if (packageIds.length) dbQueryCount += 1

  const shipmentByPackage = new Map<string, Record<string, unknown>>()
  for (const row of shipmentRows) {
    shipmentByPackage.set(text(row.packageId), row)
  }

  // Kredensiyal bağlamı tenant başına TEK kez çözülür (sipariş başına DEĞİL).
  const config = options.suratConfig ?? {}
  const serviceMode = text(config.serviceMode) || 'UNKNOWN'
  // Bugünkü üretim davranışı: açık satıcı-öder sinyali olmadıkça birincil
  // hesap. Bu tur bunu DEĞİŞTİRMEZ; yalnız raporlar.
  const credentialClass = 'PRIMARY'
  const accountFingerprint = maskIdentifier(
    config.canonicalPrimaryKullaniciAdi ??
      config.liveKullaniciAdi ??
      config.kullaniciAdi,
  )

  const candidates: BillingScanCandidate[] = orderRows.map((orderRow) => {
    let rawOrder: Record<string, unknown> = {}
    try {
      const decrypted = decryptOrderPayload(
        orderRow.rawPayloadEncrypted as string | null,
      )
      if (decrypted && typeof decrypted === 'object') {
        rawOrder = decrypted as Record<string, unknown>
      }
    } catch {
      rawOrder = {}
    }
    const inspection = inspectTrendyolBillingSource({ ...orderRow, rawOrder })

    // Paket kimliği: mevcut kanonik kaynak (Trendyol kargo numarası), yoksa
    // gönderi yükündeki `ozelKargoTakipNo`. Yeni eşleme UYDURULMAZ.
    let parcelIdentity = text(orderRow.cargoTrackingNumber)
    if (!parcelIdentity) {
      const shipmentRow = shipmentByPackage.get(text(orderRow.packageId))
      try {
        const payload = decryptShipmentPayload(
          (shipmentRow?.carrierPayloadEncrypted as string | null) ?? null,
        ) as Record<string, unknown> | null
        parcelIdentity = text(payload?.ozelKargoTakipNo)
      } catch {
        parcelIdentity = ''
      }
    }

    return {
      packageIdMasked: maskIdentifier(orderRow.packageId),
      rawSourceField: inspection.sourceField,
      rawValue: inspection.rawValue,
      expectedBillingParty: inspection.billingParty,
      credentialClass,
      accountFingerprint,
      serviceMode,
      // GERÇEK whoPays yalnız getCargo ile bilinir; burada ASLA uydurulmaz.
      actualSuratWhoPays: null,
      actualBillingParty: 'UNKNOWN',
      senderCode: null,
      parcelIdentity: parcelIdentity || null,
      isGoldenParcel: parcelIdentity === GOLDEN_TRENDYOL_PAYS_PARCEL,
    }
  })

  const summary = summarizeBillingScan(candidates)

  const supplierCandidates = candidates
    .filter((candidate) => candidate.expectedBillingParty === 'SELLER')
    .slice(0, 5)
  // KRİTİK: payer alanı YOK demek "Trendyol öder" DEMEK DEĞİLDİR. Bu liste
  // yalnız ADAY'dır; etiketi de bunu söyler.
  const trendyolPaysCandidates = candidates
    .filter(
      (candidate) =>
        candidate.rawSourceField === null && candidate.parcelIdentity !== null,
    )
    .slice(0, 5)

  const goldenCandidate = candidates.find((c) => c.isGoldenParcel) ?? null

  // AYNI hesap bağlamında supplier + (bilinen) Trendyol-pays çifti.
  let bestSameAccountPair: BillingScanResult['bestSameAccountPair'] = null
  if (goldenCandidate) {
    const match = supplierCandidates.find(
      (candidate) =>
        candidate.credentialClass === goldenCandidate.credentialClass &&
        candidate.accountFingerprint === goldenCandidate.accountFingerprint &&
        candidate.serviceMode === goldenCandidate.serviceMode,
    )
    if (match) {
      bestSameAccountPair = {
        groupKey: `${match.credentialClass}::${match.accountFingerprint}::${match.serviceMode}`,
        supplier: match,
        trendyol: goldenCandidate,
      }
    }
  }

  return {
    organizationMasked: maskIdentifier(organization.id),
    organizationName: organization.name,
    ordersScanned: orderRows.length,
    summary,
    supplierCandidates,
    trendyolPaysCandidates,
    goldenFound: goldenCandidate !== null,
    goldenCandidate,
    bestSameAccountPair,
    dbQueryCount,
  }
}

/** Rapor satırları — YALNIZ operasyonel payer metadatası. */
export function formatScanReport(
  result: BillingScanResult,
  organizationName: string,
): string[] {
  const lines = [
    `ORGANIZATION            ${result.organizationMasked} (${result.organizationName})`,
    `ORDERS_SCANNED          ${result.ordersScanned}`,
    `DB_QUERIES              ${result.dbQueryCount}`,
    '',
    `RAW_WHO_PAYS_1          ${result.summary.rawWhoPays1Count}`,
    `RAW_PAYER_MISSING       ${result.summary.rawMissingCount}`,
    `RAW_OTHER               ${result.summary.rawOtherCount}`,
    '',
  ]
  for (const [cls, count] of Object.entries(result.summary.credentialClasses)) {
    lines.push(`CREDENTIAL_${cls.padEnd(12)}${count}`)
  }
  lines.push('', `GOLDEN_FOUND            ${result.goldenFound ? 'YES' : 'NO'}`)
  if (result.goldenCandidate) {
    lines.push(
      `  KNOWN_GOLDEN_TRENDYOL_PAYS  parcel=${result.goldenCandidate.parcelIdentity}` +
        `  account=${result.goldenCandidate.accountFingerprint}`,
    )
  }

  lines.push('', 'SUPPLIER_CANDIDATES (raw payer = satıcı sinyali)')
  if (result.supplierCandidates.length === 0) lines.push('  —')
  result.supplierCandidates.forEach((candidate, index) => {
    lines.push(
      `  SUPPLIER_CANDIDATE_${index + 1}  package=${candidate.packageIdMasked}` +
        `  parcel=${candidate.parcelIdentity ?? '—'}` +
        `  rawField=${candidate.rawSourceField ?? '—'}` +
        `  rawValue=${candidate.rawValue ?? '—'}` +
        `  credential=${candidate.credentialClass}` +
        `  account=${candidate.accountFingerprint}` +
        `  mode=${candidate.serviceMode}`,
    )
  })

  lines.push(
    '',
    'TRENDYOL_PAYS_CANDIDATE_UNKNOWN (payer alanı YOK — kanıt DEĞİL)',
  )
  if (result.trendyolPaysCandidates.length === 0) lines.push('  —')
  result.trendyolPaysCandidates.forEach((candidate, index) => {
    lines.push(
      `  CANDIDATE_${index + 1}  package=${candidate.packageIdMasked}` +
        `  parcel=${candidate.parcelIdentity ?? '—'}` +
        `  account=${candidate.accountFingerprint}`,
    )
  })

  lines.push('', `SAME_ACCOUNT_PAIR       ${result.bestSameAccountPair ? 'FOUND' : 'NONE'}`)
  if (result.bestSameAccountPair) {
    lines.push(`  GROUP  ${result.bestSameAccountPair.groupKey}`)
  }

  lines.push(
    '',
    `CREDENTIAL_ONLY_CAUSATION  ${result.summary.credentialOnlyCausation}`,
    '  (çürütme için GERÇEK whoPays gerekir — bu tarama ağa ÇIKMAZ)',
  )

  const supplier = result.supplierCandidates[0]
  const trendyol = result.goldenCandidate ?? result.trendyolPaysCandidates[0]
  lines.push('', 'NEXT COMMANDS')
  lines.push(
    supplier?.parcelIdentity
      ? `NEXT_SUPPLIER_INSPECT_COMMAND:\n  npm run surat:billing:inspect -- --name ${organizationName} --package ${supplier.parcelIdentity}`
      : 'NEXT_SUPPLIER_INSPECT_COMMAND:\n  (supplier adayı bulunamadı)',
  )
  lines.push(
    trendyol?.parcelIdentity
      ? `NEXT_TRENDYOL_INSPECT_COMMAND:\n  npm run surat:billing:inspect -- --name ${organizationName} --package ${trendyol.parcelIdentity}`
      : 'NEXT_TRENDYOL_INSPECT_COMMAND:\n  (Trendyol-pays adayı bulunamadı)',
  )
  return lines
}

/** Golden paketi tenant kapsamında SALT OKUNUR arar. */
export async function findGoldenParcel(
  db: Db,
  organizationId: string,
  parcel: string = GOLDEN_TRENDYOL_PAYS_PARCEL,
): Promise<{ found: boolean; packageIdMasked: string | null }> {
  const rows = (await db
    .select({ packageId: orders.packageId })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        eq(orders.cargoTrackingNumber, parcel),
      ),
    )
    .limit(1)) as { packageId: string }[]
  return rows.length > 0
    ? { found: true, packageIdMasked: maskIdentifier(rows[0].packageId) }
    : { found: false, packageIdMasked: null }
}

export { sql }
