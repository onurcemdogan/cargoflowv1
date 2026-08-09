// Auth modu shipment persistence adapter'ı. index.mjs'teki idempotency store
// üçlüsünü (read/write/delete) organization bazlı PostgreSQL'e bağlar. JSON
// record ŞEKLİ korunur (executeIdempotentSuratCreate değişmez); yalnız kaynak
// PG olur. Başarılı create'te shipment + operation TEK transaction'da yazılır.
import {
  deleteCreateOperation,
  findOperationByIdempotencyKey,
  reserveCreateOperation,
  upsertCreateOperation,
  type OperationColumns,
  type OperationDb,
} from './shipmentOperationRepository.ts'
import { upsertShipment, type RepositoryDb } from './shipmentRepository.ts'
import { SURAT_PERSISTENCE_PROVIDER } from './suratProvider.ts'

type ServiceDb = OperationDb &
  RepositoryDb & {
    transaction: (fn: (tx: OperationDb & RepositoryDb) => Promise<void>) => Promise<void>
  }

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

// JSON idempotency record → operation kolonları. Record'un tamamı şifreli
// payload olarak saklanır; sorgu kolonları (status/tracking/sender/sayaç)
// ayrıca doldurulur.
function recordToColumns(
  organizationId: string,
  record: Record<string, unknown>,
): OperationColumns {
  const status = String(record.status ?? '')
  const opStatus =
    status === 'SUCCESS'
      ? 'succeeded'
      : status === 'FAILED_SAFE'
        ? 'failed'
        : 'pending'
  const shipment = (record.shipment ?? {}) as Record<string, unknown>
  return {
    organizationId,
    marketplace: first(record.marketplace, 'Trendyol'),
    packageId: first(record.packageId, shipment.packageId),
    orderNumber: first(record.orderNumber, record.orderId) || null,
    provider: first(record.provider, SURAT_PERSISTENCE_PROVIDER),
    operationType: first(record.operation, 'CREATE'),
    idempotencyKey: String(record.idempotencyKey ?? ''),
    status: opStatus,
    requestFingerprint: (record.requestFingerprint as string) ?? null,
    payload: record,
    trackingNumber:
      first(record.carrierTrackingNumber, record.candidateTrackingNumber) || null,
    senderNumber:
      first(record.carrierSenderNumber, record.senderNumber, shipment.senderNumber) ||
      null,
    createCallCount: Number(record.createCallCount ?? 0),
    carrierCreateCalled: Boolean(
      record.carrierCreateCalled ?? record.completedAt,
    ),
    errorCode: first(record.errorCode, record.businessCode) || null,
    errorMessage: record.businessMessage
      ? String(record.businessMessage).slice(0, 600)
      : null,
    completedAt: record.completedAt ? new Date(String(record.completedAt)) : null,
  }
}

export async function readOperationRecord(
  db: OperationDb,
  organizationId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | undefined> {
  const row = await findOperationByIdempotencyKey(db, organizationId, idempotencyKey)
  if (!row) return undefined
  // Kaydın orijinal (JSON) şekli şifreli payload'dadır.
  const payload = row.payload as Record<string, unknown> | null
  return payload ?? undefined
}

const SURAT_HARD_FAILURE_LIFECYCLES = new Set([
  'SURAT_BARCODE_FAILED',
  'SURAT_DISPATCH_REJECTED',
  'SURAT_CREATE_UNCERTAIN',
])

// MERKEZİ BAŞARI KRİTERİ (SDP fiziksel kabul ayrı uygulamada): fiziksel Sürat
// kabulü doğrulanmamış (verifiedShipment=false) OLSA BİLE, YAZDIRILABİLİR ZPL
// üretilmişse bu bir LABEL OLUŞTURMA başarısıdır ve canonical shipment satırı
// yazılmalıdır ki markLabelReady (findShipment) çalışsın ve sipariş kalıcı
// "Etiket Hazır" olsun. T.No/barkod parse edilemese BİLE geçerli ZPL varsa
// yeterlidir (kimlik yalnız varsa canonical alanlara yazılır). Yalnız gerçek
// hard-failure (FAILED_SAFE veya dispatch reddi / barkod üretilemedi / belirsiz)
// ya da ZPL yokluğu durumunda shipment YAZILMAZ.
export function isSuratRecordPreassignedReady(
  record: Record<string, unknown>,
): boolean {
  if (String(record.status ?? '') === 'FAILED_SAFE') return false
  const shipment = (record.shipment ?? {}) as Record<string, unknown>
  if (SURAT_HARD_FAILURE_LIFECYCLES.has(String(shipment.lifecycleStatus ?? ''))) {
    return false
  }
  const hasZpl = Boolean(
    record.technicalZpl ||
      record.technicalZplSha256 ||
      shipment.barcodeRaw ||
      shipment.zplReady ||
      shipment.technicalZplReceived,
  )
  return hasZpl
}

// Carrier payload'a türetilmiş printZpl artifact'ini ekler. Kaynak alanlara
// (technicalZpl, technicalZplSha256, technicalZplLength) DOKUNULMAZ.
async function withPrintZplArtifact(
  db: ServiceDb,
  organizationId: string,
  marketplace: string,
  packageId: string,
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const { loadPrintLineItems } = await import('./printZplItems.ts')
    const { attachPrintZplArtifact } = await import('./printZplRepository.ts')
    const items = await loadPrintLineItems(db, organizationId, marketplace, packageId)
    if (items.length === 0) return record
    return attachPrintZplArtifact(record, items, new Date().toISOString())
  } catch {
    // Artifact üretilemedi: create AKIŞI BOZULMAZ, kaynak ZPL aynen persist
    // edilir ve kayıt legacy hydration yoluna düşer. Ham ZPL LOGLANMAZ.
    return record
  }
}

// Başarılı create'te shipment + operation TEK transaction'da yazılır (M:
// yarıda hata → sahte shipment oluşmaz). Doğrulanmış SUCCESS ve ön-atanmış hazır
// (preassigned) create'lerde canonical shipment yazılır; belirsiz/başarısız
// (kimliksiz/ZPL'siz) durumlarda YALNIZ operation kaydı yazılır (sahte shipment yok).
export async function writeOperationRecord(
  db: ServiceDb,
  organizationId: string,
  record: Record<string, unknown>,
): Promise<void> {
  const columns = recordToColumns(organizationId, record)
  const shouldPersistShipment =
    columns.status === 'succeeded' || isSuratRecordPreassignedReady(record)
  if (shouldPersistShipment) {
    const shipment = (record.shipment ?? {}) as Record<string, unknown>
    // TÜRETİLMİŞ BASKI ZPL'İ: resmî technicalZpl AYNEN korunur; ürün satırı
    // eklenmiş printZpl AYNI carrier payload nesnesinde, AYNI shipment
    // yazımında (tek transaction) kalıcı hale gelir. Provider'a İKİNCİ create
    // çağrısı YAPILMAZ; tracking/barkod/desi DEĞİŞMEZ.
    //
    // Satırlar veya katalog okunamazsa artifact ÜRETİLMEZ ve create eskisi
    // gibi devam eder: kayıt legacy sayılır ve ilk baskı/indirme sırasında
    // compare-and-set ile hydrate edilir (sahte READY veya sessiz ürün kaybı
    // OLUŞMAZ).
    const carrierPayload = await withPrintZplArtifact(
      db,
      organizationId,
      columns.marketplace,
      columns.packageId,
      record,
    )
    // ARKA PLAN HAZIRLAMA (Aşama 3B): artefakt bu yazımda üretilemediyse
    // (satır/katalog yoktu, geçici hata) kayıt legacy hydration yoluna
    // düşer ve gecikme İLK BASKI anında kullanıcıya yansır. Bunun yerine
    // gönderi arka plan kuyruğuna alınır. Kuyruk SÜREÇ İÇİ ve SINIRLIDIR;
    // sağlayıcıya ÇIKMAZ, yeni gönderi/barkod OLUŞTURMAZ.
    const needsBackgroundPrepare = !('printZplArtifact' in carrierPayload)
    await db.transaction(async (tx) => {
      await upsertCreateOperation(tx, columns)
      await upsertShipment(tx, {
        organizationId,
        marketplace: columns.marketplace,
        packageId: columns.packageId,
        orderNumber: columns.orderNumber,
        provider: columns.provider,
        source: 'local_create',
        status: 'created',
        // columns.trackingNumber = carrierTrackingNumber || candidateTrackingNumber
        // (preassigned'da aday T.No canonical tracking olarak yazılır).
        trackingNumber: columns.trackingNumber,
        senderNumber: columns.senderNumber,
        barcode:
          first(
            shipment.barkodNo,
            shipment.barcode,
            record.carrierBarcodeNumber,
            record.candidateBarcodeNumber,
          ) || null,
        trackingLink: first(shipment.trackingLink) || null,
        carrierPayload,
      })
    })
    // Kuyruğa alma YAZIMDAN SONRA ve transaction DIŞINDA yapılır: hazırlama
    // işçisi kaydı okuyabilsin. Hata create sonucunu ETKİLEMEZ.
    if (needsBackgroundPrepare) {
      try {
        const { enqueueBundlePreparation } = await import(
          './labelBundlePreparer.ts'
        )
        const enqueued = enqueueBundlePreparation(db, {
          organizationId,
          marketplace: columns.marketplace,
          packageId: columns.packageId,
          provider: columns.provider,
        })
        // KUYRUK DOLU → iş KAYBOLMAZ. Kayıt DB'de "taşıyıcı hazır +
        // artefakt yok" durumunda kalır; bu SOURCE-OF-TRUTH'tur ve
        // periyodik mutabakat onu sonraki sınırlı turda alır. Burada
        // yalnız görünürlük sağlanır; create sonucu ETKİLENMEZ.
        if (!enqueued) {
          console.warn(
            '[label-bundle] hazırlama kuyruğu dolu; kayıt mutabakata bırakıldı',
          )
        }
      } catch {
        // Arka plan hazırlama BEST-EFFORT: ilk baskıda hydration devrede.
      }
    }
    return
  }
  await upsertCreateOperation(db, columns)
}

export async function deleteOperationRecord(
  db: OperationDb,
  organizationId: string,
  idempotencyKey: string,
): Promise<void> {
  await deleteCreateOperation(db, organizationId, idempotencyKey)
}

// Atomik rezervasyon (JSON record ile): kazanan tek request. Kaybeden mevcut
// kaydın (payload) orijinal şeklini alır.
export async function reserveOperationRecord(
  db: OperationDb,
  organizationId: string,
  record: Record<string, unknown>,
): Promise<{ won: boolean; existing: Record<string, unknown> | null }> {
  const { won, existing } = await reserveCreateOperation(
    db,
    recordToColumns(organizationId, record),
  )
  const existingRecord =
    existing && (existing.payload as Record<string, unknown> | null)
  return { won, existing: existingRecord ?? null }
}

// Atomik rezervasyon proxy'si (eşzamanlı create koruması testleri için).
export { reserveCreateOperation }

// Harici (marketplace) shipment: operation ÜRETMEZ, salt okunur upsert.
// Yalnız KANITLI (sender_number veya Shipped statü) durumda çağrılmalı;
// ön-atanmış cargoTrackingNumber tek başına yeterli değildir (çağıran karar verir).
export async function upsertExternalShipment(
  db: RepositoryDb,
  input: {
    organizationId: string
    marketplace: string
    packageId: string
    orderNumber?: string | null
    provider: string
    status: string
    trackingNumber?: string | null
    senderNumber?: string | null
  },
): Promise<void> {
  await upsertShipment(db, {
    organizationId: input.organizationId,
    marketplace: input.marketplace,
    packageId: input.packageId,
    orderNumber: input.orderNumber ?? null,
    provider: input.provider,
    source: 'marketplace_external',
    status: input.status,
    trackingNumber: input.trackingNumber ?? null,
    senderNumber: input.senderNumber ?? null,
    carrierPayload: null,
  })
}
