// KALICI AUGMENTED BASKI ZPL'İ (printZpl) — tek kaynak okuma/yazma katmanı.
//
// KAYNAK KUTSALDIR: technicalZpl (carrier payload içindeki resmî ZPL) ASLA
// üzerine yazılmaz, normalize edilmez, satır sonu değiştirilmez. Türetilmiş
// printZpl AYRI alanlarda saklanır.
//
// SAKLAMA YERİ: mevcut şifreli `shipments.carrier_payload_encrypted` sütunu
// (AES-256-GCM). YENİ KOLON veya MIGRATION GEREKMEZ.
//
// SÖZLEŞME:
//  1) Kalıcı printZpl varsa ve hash'leri geçerliyse AYNEN kullanılır —
//     metadata resolver ÇALIŞMAZ, ürün kataloğu OKUNMAZ, ZPL yeniden
//     ÜRETİLMEZ. Reprint byte-for-byte aynıdır.
//  2) Legacy kayıtta (technicalZpl var, printZpl yok) ilk kullanımda
//     compare-and-set ile YALNIZ BİR KEZ üretilip yazılır; eşzamanlı ikinci
//     istek kazananın kaydını okur.
//  3) printZplSourceSha256 !== technicalZplSha256 ise sessizce eski kayıt
//     KULLANILMAZ ve üzerine YAZILMAZ: açık hata verilir.
//
// Hata mesajları ve loglar ham ZPL veya müşteri verisi İÇERMEZ.
import { and, eq, isNull } from 'drizzle-orm'
import { shipments } from '../db/schema.ts'
import {
  decryptShipmentPayload,
  encryptShipmentPayload,
} from './shipmentEncryption.ts'
import {
  deriveAugmentedSuratZplWithHashes,
  sha256Hex,
} from '../../src/utils/augmentedSuratZpl.ts'
import type { SuratProductLineItem } from '../../src/utils/suratZplProductLine.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const PRINT_ZPL_SOURCE_MISMATCH_MESSAGE =
  'Baskı etiketi kayıtlı kaynak ZPL ile eşleşmiyor.'
export const PRINT_ZPL_SOURCE_MISSING_MESSAGE =
  'Bu gönderi için kayıtlı resmî kargo etiketi (ZPL) bulunamadı.'

export interface PersistedPrintZpl {
  printZpl: string
  printZplLength: number
  printZplSha256: string
  printZplSourceSha256: string
  printZplVersion: string
  printZplFooterProfile: string | null
  templateFingerprint: string
  printZplCreatedAt: string
}

export type AugmentationStatus = 'augmented' | 'source_only'

export interface PrintableLabelModel extends PersistedPrintZpl {
  sourceZpl: string
  sourceZplSha256: string
  augmentationStatus: AugmentationStatus
  /** Bu çağrıda mı üretildi (legacy hydration) yoksa kayıttan mı geldi. */
  hydrated: boolean
  /** Bu turda Chrome rasterizasyonu YOK; native/indirme ZPL kullanır. */
  renderMode: 'raw-zpl'
}

// Payload içindeki resmî ZPL alan adları (persistence katmanının kullandığı
// isimler). Sıra ÖNCELİKTİR.
const SOURCE_KEYS = ['technicalZpl', 'barcodeRaw', 'BarcodeRaw']

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function pickSourceZpl(payload: Record<string, unknown>): string {
  for (const key of SOURCE_KEYS) {
    const direct = readString(payload[key])
    if (direct.trim()) return direct
  }
  const shipment = (payload.shipment ?? {}) as Record<string, unknown>
  for (const key of SOURCE_KEYS) {
    const nested = readString(shipment[key])
    if (nested.trim()) return nested
  }
  return ''
}

function readPersisted(
  payload: Record<string, unknown>,
): PersistedPrintZpl | null {
  const block = payload.printZplArtifact as Record<string, unknown> | undefined
  if (!block || typeof block !== 'object') return null
  const printZpl = readString(block.printZpl)
  if (!printZpl.trim()) return null
  return {
    printZpl,
    printZplLength: Number(block.printZplLength ?? printZpl.length),
    printZplSha256: readString(block.printZplSha256),
    printZplSourceSha256: readString(block.printZplSourceSha256),
    printZplVersion: readString(block.printZplVersion),
    printZplFooterProfile: block.printZplFooterProfile
      ? readString(block.printZplFooterProfile)
      : null,
    templateFingerprint: readString(block.templateFingerprint),
    printZplCreatedAt: readString(block.printZplCreatedAt),
  }
}

/**
 * Kalıcı kaydın kendi içinde tutarlı ve KAYNAKLA bağlı olduğunu doğrular.
 * Uyuşmazlıkta sessiz kullanım veya otomatik üzerine yazma YOKTUR.
 */
export function verifyPersistedPrintZpl(
  persisted: PersistedPrintZpl,
  sourceZplSha256: string,
): { ok: true } | { ok: false; reason: string } {
  if (persisted.printZplSourceSha256 !== sourceZplSha256) {
    return { ok: false, reason: PRINT_ZPL_SOURCE_MISMATCH_MESSAGE }
  }
  if (sha256Hex(persisted.printZpl) !== persisted.printZplSha256) {
    return { ok: false, reason: PRINT_ZPL_SOURCE_MISMATCH_MESSAGE }
  }
  if (persisted.printZpl.length !== persisted.printZplLength) {
    return { ok: false, reason: PRINT_ZPL_SOURCE_MISMATCH_MESSAGE }
  }
  return { ok: true }
}

export interface ShipmentKey {
  organizationId: string
  marketplace: string
  packageId: string
  provider: string
}

async function loadRow(db: Db, key: ShipmentKey) {
  const rows = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, key.organizationId),
        eq(shipments.marketplace, key.marketplace),
        eq(shipments.packageId, key.packageId),
        eq(shipments.provider, key.provider),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

/**
 * COMPARE-AND-SET: yalnız payload'da HÂLÂ printZplArtifact YOKKEN yazar.
 * Koşul SQL tarafında değerlendirilir; eşzamanlı iki hydration'dan yalnız
 * biri yazabilir, diğeri kazananın kaydını okur.
 */
async function compareAndSetArtifact(
  db: Db,
  key: ShipmentKey,
  currentEncrypted: string | null,
  nextPayload: Record<string, unknown>,
): Promise<boolean> {
  const encrypted = encryptShipmentPayload(nextPayload)
  const result = await db
    .update(shipments)
    .set({ carrierPayloadEncrypted: encrypted, updatedAt: new Date() })
    .where(
      and(
        eq(shipments.organizationId, key.organizationId),
        eq(shipments.marketplace, key.marketplace),
        eq(shipments.packageId, key.packageId),
        eq(shipments.provider, key.provider),
        // Yalnız payload DEĞİŞMEMİŞSE yaz (optimistic compare-and-set).
        currentEncrypted == null
          ? isNull(shipments.carrierPayloadEncrypted)
          : eq(shipments.carrierPayloadEncrypted, currentEncrypted),
      ),
    )
    .returning({ id: shipments.id })
  return Array.isArray(result) ? result.length > 0 : false
}

export function buildPrintZplArtifact(
  sourceZpl: string,
  items: SuratProductLineItem[],
  createdAt: string,
): { artifact: PersistedPrintZpl; augmentationStatus: AugmentationStatus } {
  const derived = deriveAugmentedSuratZplWithHashes(sourceZpl, items)
  return {
    artifact: {
      printZpl: derived.printZpl,
      printZplLength: derived.printZplLength,
      printZplSha256: derived.printZplSha256,
      printZplSourceSha256: derived.printZplSourceSha256,
      printZplVersion: derived.printZplVersion,
      printZplFooterProfile: derived.printZplFooterProfile,
      templateFingerprint: derived.templateFingerprint,
      printZplCreatedAt: createdAt,
    },
    augmentationStatus: derived.augmented ? 'augmented' : 'source_only',
  }
}

export interface ResolveOptions {
  /** Ürün satırları — YALNIZ ilk üretimde (hydration) kullanılır. */
  items: SuratProductLineItem[]
  /** Zaman damgası çağıran katmandan gelir (test edilebilirlik). */
  now?: string
}

/**
 * TEK KAYNAK: önizleme, ZPL indir, native/raw baskı ve reprint bu modeli
 * kullanır. Kalıcı kayıt varsa metadata resolver ÇALIŞTIRILMAZ.
 */
export async function resolvePersistedPrintableLabel(
  db: Db,
  key: ShipmentKey,
  options: ResolveOptions,
): Promise<PrintableLabelModel> {
  const row = await loadRow(db, key)
  if (!row) throw new Error(PRINT_ZPL_SOURCE_MISSING_MESSAGE)
  const encrypted = (row.carrierPayloadEncrypted ?? null) as string | null
  const payload = (decryptShipmentPayload(encrypted) ?? {}) as Record<
    string,
    unknown
  >
  const sourceZpl = pickSourceZpl(payload)
  if (!sourceZpl.trim()) throw new Error(PRINT_ZPL_SOURCE_MISSING_MESSAGE)
  const sourceZplSha256 = sha256Hex(sourceZpl)

  // 1) Kalıcı kayıt — metadata resolver ÇALIŞMAZ.
  const persisted = readPersisted(payload)
  if (persisted) {
    const verdict = verifyPersistedPrintZpl(persisted, sourceZplSha256)
    if (!verdict.ok) throw new Error(verdict.reason)
    return {
      ...persisted,
      sourceZpl,
      sourceZplSha256,
      augmentationStatus:
        persisted.printZpl === sourceZpl ? 'source_only' : 'augmented',
      hydrated: false,
      renderMode: 'raw-zpl',
    }
  }

  // 2) Legacy hydration — YALNIZ BİR KEZ, compare-and-set ile.
  const { artifact, augmentationStatus } = buildPrintZplArtifact(
    sourceZpl,
    options.items,
    options.now ?? new Date().toISOString(),
  )
  const won = await compareAndSetArtifact(db, key, encrypted, {
    ...payload,
    // Kaynak alanlar AYNEN korunur; yalnız yeni blok eklenir.
    printZplArtifact: artifact,
  })
  if (won) {
    return {
      ...artifact,
      sourceZpl,
      sourceZplSha256,
      augmentationStatus,
      hydrated: true,
      renderMode: 'raw-zpl',
    }
  }

  // 3) Yarışı başkası kazandı → KAZANANIN kalıcı kaydı okunur.
  const winnerRow = await loadRow(db, key)
  const winnerPayload = (decryptShipmentPayload(
    (winnerRow?.carrierPayloadEncrypted ?? null) as string | null,
  ) ?? {}) as Record<string, unknown>
  const winner = readPersisted(winnerPayload)
  if (!winner) throw new Error(PRINT_ZPL_SOURCE_MISSING_MESSAGE)
  const verdict = verifyPersistedPrintZpl(winner, sourceZplSha256)
  if (!verdict.ok) throw new Error(verdict.reason)
  return {
    ...winner,
    sourceZpl,
    sourceZplSha256,
    augmentationStatus:
      winner.printZpl === sourceZpl ? 'source_only' : 'augmented',
    hydrated: false,
    renderMode: 'raw-zpl',
  }
}

// Yeni create akışı için: kalıcı kaydı technicalZpl ile AYNI payload yazımında
// hazırlar. Kaynak alanlara DOKUNULMAZ.
export function attachPrintZplArtifact(
  carrierPayload: Record<string, unknown>,
  items: SuratProductLineItem[],
  now: string,
): Record<string, unknown> {
  const sourceZpl = pickSourceZpl(carrierPayload)
  if (!sourceZpl.trim()) return carrierPayload
  const { artifact } = buildPrintZplArtifact(sourceZpl, items, now)
  return { ...carrierPayload, printZplArtifact: artifact }
}

export const __testing = { pickSourceZpl, readPersisted }
