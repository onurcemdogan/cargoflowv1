// Read verification never authorizes create/labels/writes. Use the unchanged rollout gate.
import { and, eq, or, sql } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import { supportsAccountOrdersRead } from '../connectors/connectorKernel.ts'
import { buildProviderCatalog } from '../connectors/providerCatalog.ts'
import { canTriggerFulfillmentSideEffects } from '../connectors/liveWriteGate.ts'
const catalog = buildProviderCatalog()

export function orderSourceFulfillmentAllowed(marketplace: unknown): boolean {
  const key = String(marketplace ?? '').trim().toLowerCase()
  const descriptor = catalog.get(key)
  return !supportsAccountOrdersRead(descriptor) || canTriggerFulfillmentSideEffects(key).decision === 'ALLOWED'
}

/** Same descriptor decision, available to candidate queries before batch limits. */
export function orderSourcesWithoutFulfillment(): string[] {
  return catalog.list().map((descriptor) => descriptor.providerKey).filter((key) => !orderSourceFulfillmentAllowed(key))
}

/** DB identity takes precedence over caller-supplied marketplace names. */
export async function loadOrderSourceFulfillmentAllowed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  organizationId: string,
  order: Record<string, unknown>,
): Promise<boolean> {
  if (!organizationId.trim()) return false
  if (!orderSourceFulfillmentAllowed(order.marketplace)) return false
  const id = String(order.id ?? '').trim()
  const packageId = String(order.packageId ?? order.shipmentPackageId ?? '').trim()
  const orderNumber = String(order.orderNumber ?? '').trim()
  if (id) {
    const rows = await db.select({ marketplace: orders.marketplace, packageId: orders.packageId, orderNumber: orders.orderNumber }).from(orders).where(and(
      eq(orders.organizationId, organizationId), sql`${orders.id}::text = ${id}`,
    ))
    if (rows.length) return rows.every((row: { marketplace: string; packageId: string; orderNumber: string }) =>
      (!packageId || packageId === row.packageId) && (!orderNumber || orderNumber === row.orderNumber) && orderSourceFulfillmentAllowed(row.marketplace))
  }
  // Legacy callers carry package/order identity rather than the canonical UUID.
  if (!packageId && !orderNumber) return true
  const rows = await db.select({ marketplace: orders.marketplace }).from(orders).where(and(
    eq(orders.organizationId, organizationId),
    ...(packageId ? [eq(orders.packageId, packageId)] : []),
    ...(orderNumber ? [eq(orders.orderNumber, orderNumber)] : []),
  ))
  if (rows.length) return rows.every((row: { marketplace: string }) => orderSourceFulfillmentAllowed(row.marketplace))
  // An edited second identifier must not hide a restricted persisted package.
  // An exact legitimate tuple above wins over unrelated single-field collisions.
  const partial = await db.select({ marketplace: orders.marketplace }).from(orders).where(and(
    eq(orders.organizationId, organizationId),
    or(...(packageId ? [eq(orders.packageId, packageId)] : []), ...(orderNumber ? [eq(orders.orderNumber, orderNumber)] : [])),
  ))
  return partial.every((row: { marketplace: string }) => orderSourceFulfillmentAllowed(row.marketplace))
}
