// Sürat resmî ZPL teşhisi — SALT OKUNUR veri yolu.
//
// Yalnız SELECT yapar. INSERT/UPDATE/DELETE YOKTUR, Sürat API'si ÇAĞRILMAZ.
// Döndürdüğü değer teşhis için gereken minimum alan kümesidir; ham ZPL bu
// modülden dışarı ÇIKAR ama YALNIZ sınıflandırıcıya gider — çağıran (CLI)
// bunu asla loglamaz, aggregate rapora yalnız SHA-256 parmak izi girer.
import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  orders as ordersTable,
  shipmentOperations,
  shipments,
} from '../db/schema.ts'
import { decryptShipmentPayload } from '../shipments/shipmentEncryption.ts'
import { getAccountByProviderAccountId } from './marketplaceAccountRepository.ts'
import {
  extractSuratLabelArtifact,
  type SuratLabelArtifactInput,
} from './suratZplDiagnostic.ts'

export interface DiagnosticScope {
  organizationId: string
  marketplace: string
  provider: string
  providerAccountId?: string
  limit: number
}

export interface LoadedArtifacts {
  artifacts: SuratLabelArtifactInput[]
  undecryptableCount: number
  accountResolved: boolean
  scopedPackageCount: number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

function safeDecrypt(encrypted: unknown): {
  payload: Record<string, unknown> | null
  failed: boolean
} {
  if (!encrypted) return { payload: null, failed: false }
  try {
    return { payload: decryptShipmentPayload(encrypted as string), failed: false }
  } catch {
    // Anahtar rotasyonu / bozuk zarf. Hata metni payload sızdırabileceği için
    // YUTULUR; kayıt yalnız sayaçta görünür.
    return { payload: null, failed: true }
  }
}

export async function loadSuratLabelArtifacts(
  db: Db,
  scope: DiagnosticScope,
): Promise<LoadedArtifacts> {
  const { organizationId, marketplace, provider, limit } = scope
  let scopedPackageIds: string[] | null = null

  if (scope.providerAccountId) {
    const account = await getAccountByProviderAccountId(
      db,
      organizationId,
      marketplace,
      scope.providerAccountId,
    )
    if (!account) {
      return {
        artifacts: [],
        undecryptableCount: 0,
        accountResolved: false,
        scopedPackageCount: 0,
      }
    }
    // shipments tablosunda marketplaceAccountId YOKTUR; hesap kapsamı orders
    // üzerinden packageId ile çözülür. Hesap kimliği BACKEND'de doğrulanır.
    const rows = await db
      .select({ packageId: ordersTable.packageId })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.organizationId, organizationId),
          eq(ordersTable.marketplace, marketplace),
          eq(ordersTable.marketplaceAccountId, account.id),
        ),
      )
    scopedPackageIds = [
      ...new Set<string>(
        rows.map((r: { packageId: string }) => String(r.packageId)),
      ),
    ]
  }

  const artifacts: SuratLabelArtifactInput[] = []
  let undecryptableCount = 0
  const emptyScope = scopedPackageIds != null && scopedPackageIds.length === 0

  if (!emptyScope) {
    const shipmentRows = await db
      .select({
        payload: shipments.carrierPayloadEncrypted,
        trackingNumber: shipments.trackingNumber,
        barcode: shipments.barcode,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          eq(shipments.provider, provider),
          ...(scopedPackageIds
            ? [inArray(shipments.packageId, scopedPackageIds)]
            : []),
        ),
      )
      .orderBy(desc(shipments.updatedAt))
      .limit(limit)

    for (const row of shipmentRows) {
      const { payload, failed } = safeDecrypt(row.payload)
      if (failed) { undecryptableCount += 1; continue }
      const artifact = extractSuratLabelArtifact(payload)
      artifacts.push({
        ...artifact,
        // Kolon değerleri canonical kimlik kanıtı için yedek kaynaktır.
        trackingNumber: artifact.trackingNumber ?? row.trackingNumber ?? '',
        barcode: artifact.barcode ?? row.barcode ?? '',
      })
    }

    // shipments'a henüz terfi etmemiş (preassigned/failed) create yanıtları da
    // resmî ZPL kanıtı taşıyabilir.
    const remaining = Math.max(0, limit - artifacts.length)
    if (remaining > 0) {
      const opRows = await db
        .select({
          payload: shipmentOperations.responsePayloadEncrypted,
          trackingNumber: shipmentOperations.trackingNumber,
        })
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, organizationId),
            eq(shipmentOperations.provider, provider),
            ...(scopedPackageIds
              ? [inArray(shipmentOperations.packageId, scopedPackageIds)]
              : []),
          ),
        )
        .orderBy(desc(shipmentOperations.updatedAt))
        .limit(remaining)

      for (const row of opRows) {
        const { payload, failed } = safeDecrypt(row.payload)
        if (failed) { undecryptableCount += 1; continue }
        const artifact = extractSuratLabelArtifact(payload)
        artifacts.push({
          ...artifact,
          trackingNumber: artifact.trackingNumber ?? row.trackingNumber ?? '',
        })
      }
    }
  }

  return {
    artifacts,
    undecryptableCount,
    accountResolved: true,
    scopedPackageCount: scopedPackageIds?.length ?? null,
  }
}
