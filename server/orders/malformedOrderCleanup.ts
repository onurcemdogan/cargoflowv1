// ═══ TEK BOZUK SİPARİŞ SATIRI GÜVENLİ TEMİZLİĞİ ═══════════════════════════
//
// ÜRETİM VAKASI (PII YOK):
//   BOZUK  : packageId "0"        · orderNumber 11496311967 · Unknown/NEW
//   GEÇERLİ: packageId 4068544739 · orderNumber 11496311967 · Created/NEW
// Trendyol API geçerli paketi doğruluyor; bozuk satır, `??` zincirinin
// `shipmentPackageId = 0` değerini kimlik sanmasından doğdu (CASE M1).
//
// BU MODÜL YALNIZ TEK BİR SATIRI SİLER ve her adımda KANIT ARAR:
//   · hedef satır GERÇEKTEN yer tutucu kimlikli olmalı,
//   · AYNI organizasyon + hesap kapsamında GEÇERLİ karşılığı BULUNMALI,
//   · hedefe bağlı taşıyıcı kaydı (shipment / shipment_operation) OLMAMALI.
// Koşullardan biri tutmazsa işlem YAPILMAZ (transaction geri alınır).
//
// KAPSAM DIŞI: başka bozuk/NULL-hesap satırı, toplu temizlik, taşıyıcı API,
// Trendyol write, migration, uygulama mantığı.
import { and, count, eq } from 'drizzle-orm'
import {
  orderLines,
  orders,
  shipmentOperations,
  shipments,
} from '../db/schema.ts'
import { isRealIdentity } from './malformedOrderAudit.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface CleanupTarget {
  /** Silinecek satırın birincil anahtarı. */
  id: string
  /** Beklenen (yer tutucu) paket kimliği — doğrulama için. */
  malformedPackageId: string
  /** Hem bozuk hem geçerli satırın taşıdığı sipariş numarası. */
  orderNumber: string
  /** KORUNACAK gerçek paket kimliği. */
  validPackageId: string
}

export type CleanupViolation =
  | 'target_not_found'
  | 'target_package_id_mismatch'
  | 'target_order_number_mismatch'
  | 'target_identity_is_valid'
  | 'valid_counterpart_missing'
  | 'valid_counterpart_scope_mismatch'
  | 'target_has_shipment'
  | 'target_has_shipment_operation'

export interface CleanupInspection {
  target: Record<string, unknown> | null
  valid: Record<string, unknown> | null
  childCounts: {
    orderLines: number
    shipments: number
    shipmentOperations: number
  }
  violations: CleanupViolation[]
  safe: boolean
}

const orderFields = {
  id: orders.id,
  organizationId: orders.organizationId,
  marketplaceAccountId: orders.marketplaceAccountId,
  marketplace: orders.marketplace,
  packageId: orders.packageId,
  orderNumber: orders.orderNumber,
  marketplaceStatus: orders.marketplaceStatus,
  operationStatus: orders.operationStatus,
  archivedAt: orders.archivedAt,
}

async function countRows(query: Promise<{ total: number }[]>): Promise<number> {
  const [row] = await query
  return Number(row?.total ?? 0)
}

/**
 * SALT OKUMA ön denetimi. Hem `--dry-run` raporu hem de transaction içindeki
 * son doğrulama AYNI yüklemi kullanır (iki farklı kural yazılmaz).
 */
export async function inspectCleanupTarget(
  db: Db,
  input: CleanupTarget,
): Promise<CleanupInspection> {
  const violations: CleanupViolation[] = []

  const [target] = await db.select(orderFields).from(orders).where(eq(orders.id, input.id))

  if (!target) {
    return {
      target: null,
      valid: null,
      childCounts: { orderLines: 0, shipments: 0, shipmentOperations: 0 },
      violations: ['target_not_found'],
      safe: false,
    }
  }

  // ── HEDEF SATIR KİMLİK DOĞRULAMASI ───────────────────────────────────────
  if (String(target.packageId) !== input.malformedPackageId) {
    violations.push('target_package_id_mismatch')
  }
  if (String(target.orderNumber) !== input.orderNumber) {
    violations.push('target_order_number_mismatch')
  }
  // GERÇEK kimliği olan bir satır ASLA silinmez.
  if (isRealIdentity(target.packageId)) {
    violations.push('target_identity_is_valid')
  }

  // ── GEÇERLİ KARŞILIK AYNI KAPSAMDA VAR MI? ───────────────────────────────
  const [valid] = await db
    .select(orderFields)
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, target.organizationId),
        eq(orders.marketplace, target.marketplace),
        eq(orders.packageId, input.validPackageId),
        eq(orders.orderNumber, input.orderNumber),
      ),
    )
  if (!valid) violations.push('valid_counterpart_missing')
  else if (
    String(valid.marketplaceAccountId ?? '') !==
    String(target.marketplaceAccountId ?? '')
  ) {
    // Farklı hesap kapsamındaki bir satır "karşılık" sayılmaz.
    violations.push('valid_counterpart_scope_mismatch')
  }

  // ── BAĞIMLI KAYITLAR ─────────────────────────────────────────────────────
  const orderLineCount = await countRows(
    db
      .select({ total: count() })
      .from(orderLines)
      .where(
        and(
          eq(orderLines.organizationId, target.organizationId),
          eq(orderLines.orderId, target.id),
        ),
      ),
  )
  const shipmentCount = await countRows(
    db
      .select({ total: count() })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, target.organizationId),
          eq(shipments.marketplace, target.marketplace),
          eq(shipments.packageId, String(target.packageId)),
        ),
      ),
  )
  const operationCount = await countRows(
    db
      .select({ total: count() })
      .from(shipmentOperations)
      .where(
        and(
          eq(shipmentOperations.organizationId, target.organizationId),
          eq(shipmentOperations.marketplace, target.marketplace),
          eq(shipmentOperations.packageId, String(target.packageId)),
        ),
      ),
  )
  // TAŞIYICI KANITI VARSA TEMİZLİK YOK: gönderi/operasyon kaydı, gerçek bir
  // taşıyıcı işlemi yapılmış olabileceği anlamına gelir.
  if (shipmentCount > 0) violations.push('target_has_shipment')
  if (operationCount > 0) violations.push('target_has_shipment_operation')

  return {
    target,
    valid: valid ?? null,
    childCounts: {
      orderLines: orderLineCount,
      shipments: shipmentCount,
      shipmentOperations: operationCount,
    },
    violations,
    safe: violations.length === 0,
  }
}

export interface CleanupResult {
  applied: boolean
  deletedOrders: number
  deletedOrderLines: number
  violations: CleanupViolation[]
}

/**
 * TEK TRANSACTION: son doğrulama + yalnız hedefe bağlı satırların silinmesi.
 * Doğrulama düşerse hiçbir şey silinmez (`applied=false`).
 *
 * FK sırası: `order_lines` → `orders`. `shipments` / `shipment_operations`
 * SİLİNMEZ — varlıkları zaten işlemi ENGELLER.
 */
export async function cleanupMalformedOrder(
  db: Db,
  input: CleanupTarget,
): Promise<CleanupResult> {
  const database = db as unknown as {
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>
  }
  return database.transaction(async (tx) => {
    // Transaction İÇİNDE tekrar doğrula (dry-run ile apply arasında kayıt
    // değişmiş olabilir).
    const inspection = await inspectCleanupTarget(tx, input)
    if (!inspection.safe) {
      return {
        applied: false,
        deletedOrders: 0,
        deletedOrderLines: 0,
        violations: inspection.violations,
      }
    }
    const target = inspection.target as Record<string, unknown>

    await (tx as Db)
      .delete(orderLines)
      .where(
        and(
          eq(orderLines.organizationId, String(target.organizationId)),
          eq(orderLines.orderId, String(target.id)),
        ),
      )
    await (tx as Db)
      .delete(orders)
      .where(
        and(
          eq(orders.organizationId, String(target.organizationId)),
          eq(orders.id, String(target.id)),
        ),
      )

    return {
      applied: true,
      deletedOrders: 1,
      deletedOrderLines: inspection.childCounts.orderLines,
      violations: [],
    }
  })
}
