// ARAS GÖNDERİ İŞLEM KAYDI — ORTAK `shipment_operations` MODELİ (PHASE2-D).
//
// Aras için çift gönderi koruması yalnız `IntegrationCode` determinizmine
// BIRAKILMAZ: her create mantıksal bir işlemdir, deterministik anahtarla
// (`ARAS:<org>:<sipariş>:CREATE`) KALICI rezerve edilir ve ağ sınırına
// girildiği ağdan ÖNCE yazılır. Böylece çift tıklama, yeniden deneme, zaman
// aşımı ve istemcinin tekrar göndermesi İKİNCİ gönderi üretemez.
import {
  deleteCreateOperation,
  findOperationByIdempotencyKey,
  reserveCreateOperation,
  upsertCreateOperation,
  type OperationColumns,
} from '../../shipments/shipmentOperationRepository.ts'
import { upsertShipment } from '../../shipments/shipmentRepository.ts'
import { provenanceColumns, type ShipmentProvenance } from '../../shipments/shipmentPreflight.ts'
import { ARAS_PERSISTENCE_PROVIDER } from '../../shipments/arasProvider.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type ArasOperationStatus = 'pending' | 'succeeded' | 'failed'

export interface ArasOperationRecord {
  idempotencyKey: string
  status: ArasOperationStatus
  carrierCreateCalled: boolean
  integrationCode: string
  errorCode: string | null
}

export interface ArasOperationIdentity {
  organizationId: string
  idempotencyKey: string
  marketplace: string
  packageId: string
  integrationCode: string
  provenance: ShipmentProvenance
}

export interface ArasOperationStore {
  read(organizationId: string, idempotencyKey: string): Promise<ArasOperationRecord | null>
  /** Atomik rezervasyon — yalnız TEK istek kazanır. */
  reserve(identity: ArasOperationIdentity): Promise<{ won: boolean; existing: ArasOperationRecord | null }>
  /** Ağdan ÖNCE: taşıyıcı sınırına girildiği kalıcı yazılır. */
  markCarrierBoundary(identity: ArasOperationIdentity): Promise<void>
  /** Ağdan önce durulduysa rezervasyon bırakılır (gönderi YOK). */
  release(identity: ArasOperationIdentity): Promise<void>
  complete(
    identity: ArasOperationIdentity,
    outcome: { status: ArasOperationStatus; errorCode: string | null; shipmentRegistered: boolean; verificationState: string },
  ): Promise<void>
}

export function arasIdempotencyKey(organizationId: string, orderId: string): string {
  return `ARAS:${organizationId}:${orderId}:CREATE`
}

function fromRow(row: Record<string, unknown> | null): ArasOperationRecord | null {
  if (!row) return null
  const payload = (row.payload ?? {}) as Record<string, unknown>
  return {
    idempotencyKey: String(row.idempotencyKey),
    status: String(row.status) === 'succeeded' ? 'succeeded' : String(row.status) === 'failed' ? 'failed' : 'pending',
    carrierCreateCalled: row.carrierCreateCalled === true,
    integrationCode: String(payload.integrationCode ?? ''),
    errorCode: row.errorCode == null ? null : String(row.errorCode),
  }
}

function columns(
  identity: ArasOperationIdentity,
  overrides: Partial<OperationColumns> & { payload?: Record<string, unknown> },
): OperationColumns {
  return {
    organizationId: identity.organizationId,
    marketplace: identity.marketplace,
    packageId: identity.packageId,
    orderNumber: null,
    provider: ARAS_PERSISTENCE_PROVIDER,
    operationType: 'CREATE',
    idempotencyKey: identity.idempotencyKey,
    status: 'pending',
    createCallCount: 1,
    provenance: provenanceColumns(identity.provenance),
    ...overrides,
    payload: { integrationCode: identity.integrationCode, ...(overrides.payload ?? {}) },
  }
}

/** Kalıcı (PostgreSQL) işlem deposu — `shipment_operations` + `shipments`. */
export function createDbArasOperationStore(db: Db): ArasOperationStore {
  return {
    async read(organizationId, idempotencyKey) {
      return fromRow(await findOperationByIdempotencyKey(db, organizationId, idempotencyKey))
    },
    async reserve(identity) {
      const result = await reserveCreateOperation(db, columns(identity, { status: 'pending', carrierCreateCalled: false }))
      return { won: result.won, existing: fromRow(result.existing) }
    },
    async markCarrierBoundary(identity) {
      await upsertCreateOperation(db, columns(identity, { status: 'pending', carrierCreateCalled: true }))
    },
    async release(identity) {
      await deleteCreateOperation(db, identity.organizationId, identity.idempotencyKey)
    },
    async complete(identity, outcome) {
      const completedAt = new Date()
      await db.transaction(async (tx: Db) => {
        await upsertCreateOperation(
          tx,
          columns(identity, {
            status: outcome.status,
            carrierCreateCalled: true,
            errorCode: outcome.errorCode,
            completedAt: outcome.status === 'pending' ? null : completedAt,
            payload: { verificationState: outcome.verificationState },
          }),
        )
        if (outcome.status === 'succeeded' && outcome.shipmentRegistered) {
          await upsertShipment(tx, {
            organizationId: identity.organizationId,
            marketplace: identity.marketplace,
            packageId: identity.packageId,
            provider: ARAS_PERSISTENCE_PROVIDER,
            source: 'local_create',
            status: 'created',
            carrierPayload: { integrationCode: identity.integrationCode, verificationState: outcome.verificationState },
            provenance: provenanceColumns(identity.provenance),
          })
        }
      })
    },
  }
}

/** Test/izole çalışma için bellek deposu (aynı sözleşme). */
export function createMemoryArasOperationStore(): ArasOperationStore & { records: Map<string, ArasOperationRecord> } {
  const records = new Map<string, ArasOperationRecord>()
  return {
    records,
    async read(_organizationId, key) {
      return records.get(key) ?? null
    },
    async reserve(identity) {
      const existing = records.get(identity.idempotencyKey)
      if (existing) return { won: false, existing }
      records.set(identity.idempotencyKey, {
        idempotencyKey: identity.idempotencyKey,
        status: 'pending',
        carrierCreateCalled: false,
        integrationCode: identity.integrationCode,
        errorCode: null,
      })
      return { won: true, existing: null }
    },
    async markCarrierBoundary(identity) {
      const record = records.get(identity.idempotencyKey)
      if (record) record.carrierCreateCalled = true
    },
    async release(identity) {
      records.delete(identity.idempotencyKey)
    },
    async complete(identity, outcome) {
      records.set(identity.idempotencyKey, {
        idempotencyKey: identity.idempotencyKey,
        status: outcome.status,
        carrierCreateCalled: true,
        integrationCode: identity.integrationCode,
        errorCode: outcome.errorCode,
      })
    },
  }
}
