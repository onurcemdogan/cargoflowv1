// Account-scoped order_line DUPLICATE onarım çekirdeği. YALNIZ kanıtlanmış
// duplicate satırları (aynı canonical anahtar + AYNI içerik) kaldırır. Gerçek
// quantity=2 veya iki gerçek provider satırı KORUNUR (içerik farkı → conflict,
// dokunulmaz). Başka tenant/account'a DOKUNMAZ. orders.totalAmount,
// operationStatus, LABEL_READY/PRINTED, reprint, desi ve shipment DEĞİŞMEZ
// (yalnız order_lines satırları silinir). Ham PII/provider id/credential
// DÖNDÜRMEZ; yalnız güvenli aggregate + iç uuid satır id'leri.
import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'
import { canonicalLineKeyFromRow } from './orderMapper.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface RepairScope {
  organizationId: string
  marketplaceAccountId: string | null
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
function str(value: unknown): string {
  return String(value ?? '').trim()
}

// Bir duplicate grubunda içerik eşleşmesi (gerçek duplicate mı, yoksa iki farklı
// satır mı). Aynı productId+merchantSku+barcode+unitPrice → kanıtlanmış duplicate.
function contentSignature(row: Record<string, unknown>): string {
  return [
    str(row.productId),
    str(row.merchantSku),
    str(row.barcode),
    str(row.unitPrice),
  ].join('|')
}

// Grupta KORUNACAK satırı seç: canonical (ty_line_ ön eki OLMAYAN, ck_ olmayan)
// externalLineId tercih edilir (gelecekteki upsert ile eşleşsin, churn olmasın);
// yoksa en eski (min createdAt) korunur.
function pickKeeper(group: Record<string, unknown>[]): Record<string, unknown> {
  const canonical = group.find((row) => {
    const id = str(row.externalLineId)
    return id !== '' && !id.startsWith('ty_line_') && !id.startsWith('ck_')
  })
  if (canonical) return canonical
  return [...group].sort((left, right) => {
    const lt = new Date(str(left.createdAt)).getTime() || 0
    const rt = new Date(str(right.createdAt)).getTime() || 0
    return lt - rt
  })[0]
}

export interface OrderLineRepairPlan {
  organizationId: string
  marketplaceAccountId: string | null
  affectedOrderCount: number
  duplicateLineCount: number
  quantityBefore: number
  quantityAfter: number
  amountBefore: number
  amountAfter: number
  conflictCount: number
  confirmationToken: string
  willModify: false
}

export interface RepairPlanResult {
  plan: OrderLineRepairPlan
  // Silinecek order_lines.id kümesi (iç uuid — PII/provider id DEĞİL). Apply bunu
  // kullanır; token bu kümeye bağlıdır (dry-run ↔ apply tutarlılığı).
  deleteLineIds: string[]
}

function accountScope(scope: RepairScope) {
  return and(
    eq(orders.organizationId, scope.organizationId),
    scope.marketplaceAccountId == null
      ? isNull(orders.marketplaceAccountId)
      : eq(orders.marketplaceAccountId, scope.marketplaceAccountId),
  )
}

function tokenFor(scope: RepairScope, deleteIds: string[]): string {
  return createHash('sha256')
    .update(
      `${scope.organizationId}|${scope.marketplaceAccountId ?? 'null'}|${[...deleteIds]
        .sort()
        .join(',')}`,
    )
    .digest('hex')
    .slice(0, 16)
}

// DRY-RUN: DB'yi DEĞİŞTİRMEZ. Kanıtlanmış duplicate satırları tespit eder,
// güvenli aggregate + silinecek iç id kümesini döner.
export async function planOrderLineRepair(
  db: Db,
  scope: RepairScope,
): Promise<RepairPlanResult> {
  // Hedef account kapsamındaki siparişler.
  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(accountScope(scope))
  const orderIds: string[] = orderRows.map((row: { id: string }) => String(row.id))

  const deleteLineIds: string[] = []
  const affectedOrders = new Set<string>()
  let duplicateLineCount = 0
  let conflictCount = 0
  let quantityRemoved = 0
  let amountRemoved = 0
  let quantityBefore = 0
  let amountBefore = 0

  const CHUNK = 500
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const chunk = orderIds.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    const lines = await db
      .select()
      .from(orderLines)
      .where(
        and(
          eq(orderLines.organizationId, scope.organizationId),
          inArray(orderLines.orderId, chunk),
        ),
      )
    // orderId → canonicalKey → satırlar
    const byOrder = new Map<string, Map<string, Record<string, unknown>[]>>()
    for (const line of lines as Record<string, unknown>[]) {
      quantityBefore += num(line.quantity)
      amountBefore += num(line.lineTotal)
      const orderId = str(line.orderId)
      const key = canonicalLineKeyFromRow(line)
      if (!byOrder.has(orderId)) byOrder.set(orderId, new Map())
      const groups = byOrder.get(orderId)!
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(line)
    }
    for (const [orderId, groups] of byOrder) {
      for (const group of groups.values()) {
        if (group.length < 2) continue
        // İçerik imzaları farklıysa → conflict (gerçek farklı satır olabilir).
        const signatures = new Set(group.map(contentSignature))
        if (signatures.size > 1) {
          conflictCount += 1
          continue
        }
        // Kanıtlanmış duplicate: keeper hariç sil.
        const keeper = pickKeeper(group)
        affectedOrders.add(orderId)
        for (const row of group) {
          if (row === keeper) continue
          deleteLineIds.push(str(row.id))
          duplicateLineCount += 1
          quantityRemoved += num(row.quantity)
          amountRemoved += num(row.lineTotal)
        }
      }
    }
  }

  const confirmationToken = tokenFor(scope, deleteLineIds)
  return {
    plan: {
      organizationId: scope.organizationId,
      marketplaceAccountId: scope.marketplaceAccountId,
      affectedOrderCount: affectedOrders.size,
      duplicateLineCount,
      quantityBefore,
      quantityAfter: quantityBefore - quantityRemoved,
      amountBefore: Math.round(amountBefore * 100) / 100,
      amountAfter: Math.round((amountBefore - amountRemoved) * 100) / 100,
      conflictCount,
      confirmationToken,
      willModify: false,
    },
    deleteLineIds,
  }
}

export interface RepairManifest {
  batchId: string
  organizationId: string
  marketplaceAccountId: string | null
  appliedAt: string
  affectedOrderCount: number
  deletedLineCount: number
  quantityBefore: number
  quantityAfter: number
  amountBefore: number
  amountAfter: number
  conflictCount: number
  checksum: string
}

// APPLY: onay token'ı YENİDEN hesaplanan planla eşleşmeli (veri dry-run'dan beri
// değişmediyse). YALNIZ kanıtlanmış duplicate satırlar silinir (account+org
// scoped, tek transaction). orders/operationStatus/shipment'e DOKUNMAZ.
export async function applyOrderLineRepair(
  db: Db,
  scope: RepairScope,
  options: { confirmationToken: string; batchId: string; appliedAt: string },
): Promise<RepairManifest> {
  const { plan, deleteLineIds } = await planOrderLineRepair(db, scope)
  if (options.confirmationToken !== plan.confirmationToken) {
    throw new Error(
      'Onay token\'ı güncel planla eşleşmiyor (veri değişmiş olabilir); apply reddedildi.',
    )
  }
  if (deleteLineIds.length > 0) {
    const CHUNK = 500
    await db.transaction(async (tx: Db) => {
      for (let i = 0; i < deleteLineIds.length; i += CHUNK) {
        const chunk = deleteLineIds.slice(i, i + CHUNK)
        await tx
          .delete(orderLines)
          .where(
            and(
              eq(orderLines.organizationId, scope.organizationId),
              inArray(orderLines.id, chunk),
            ),
          )
      }
    })
  }
  const checksum = createHash('sha256')
    .update([...deleteLineIds].sort().join(','))
    .digest('hex')
    .slice(0, 16)
  return {
    batchId: options.batchId,
    organizationId: scope.organizationId,
    marketplaceAccountId: scope.marketplaceAccountId,
    appliedAt: options.appliedAt,
    affectedOrderCount: plan.affectedOrderCount,
    deletedLineCount: deleteLineIds.length,
    quantityBefore: plan.quantityBefore,
    quantityAfter: plan.quantityAfter,
    amountBefore: plan.amountBefore,
    amountAfter: plan.amountAfter,
    conflictCount: plan.conflictCount,
    checksum,
  }
}
