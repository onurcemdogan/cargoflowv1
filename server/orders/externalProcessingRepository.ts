// HARİCİ SİSTEMDE İŞLENEN SİPARİŞLER — yerel, manuel, geri alınabilir arşiv.
//
// NEDEN: kullanıcı aynı anda başka bir entegrasyon programı kullanıyor. Orada
// barkodu basılan siparişler CargoFlow'da aktif listede kalıyor (canlı: Etiket
// Hazır tarafında ~105 kayıt). CargoFlow bunu GÜVENİLİR bir dış sinyal olmadan
// BİLEMEZ; bu yüzden OTOMATİK karar VERİLMEZ. Yalnız kullanıcının açıkça
// işaretlediği siparişler aktif görünümden çıkar ve her an geri alınabilir.
//
// PERSISTENCE KARARI (şema incelemesiyle):
//   orders tablosunda genel amaçlı JSONB metadata kolonu YOKTUR
//   (server/db/schema.ts). Var olan alanlar:
//     - operation_status TEXT  → pazaryeri/operasyon yaşam döngüsü; buraya
//       yeni bir durum UYDURULMAZ (classifier ve sync sözleşmesi bozulur).
//     - archived_at TIMESTAMP  → sync mutabakatının "pazaryerinin aktif
//       kümesinde yok" anlamı; orderRepository reconciliation'ı bu alanı
//       OKUYUP YAZAR. Aynı alanı ikinci bir anlamla kullanmak iki mekanizmayı
//       çakıştırır.
//   Bu yüzden ayrı ve GÜVENLİ olan mevcut JSONB kullanılır:
//     organization_settings.settings_json.externalProcessing
//   Sonuç: MIGRATION GEREKMEZ, yeni kolon YOKTUR, sipariş satırlarına HİÇ
//   yazılmaz (takip numarası, barkod, sipariş satırları ve işlem geçmişi
//   tanım gereği DEĞİŞMEZ), organizasyon kapsamı korunur.
//
// SAKLANAN VERİ: yalnız canonical sipariş kimliği (marketplace:package:<id>),
// zaman damgası, kaynak ve kullanıcı kimliği. PII, adres, telefon, ZPL veya
// credential SAKLANMAZ.
import { eq } from 'drizzle-orm'
import { organizationSettings } from '../db/schema.ts'

export interface ExternalProcessingEntry {
  processedAt: string
  source: 'manual'
  processedByUserId: string | null
}

export interface ExternalProcessingState {
  /** canonical sipariş kimliği → kayıt */
  entries: Record<string, ExternalProcessingEntry>
}

export interface ExternalProcessingChange {
  /** Bu çağrıda durumu DEĞİŞEN kayıt sayısı. */
  changed: number
  /** Zaten istenen durumda olan kayıt sayısı (idempotent tekrar). */
  unchanged: number
  /** Geçersiz/boş kimlik sayısı (sessizce yutulmaz, raporlanır). */
  invalid: number
  state: ExternalProcessingState
}

// Sessiz büyümeyi önleyen açık üst sınır. Aşılırsa hata verilir; SESSİZ
// KIRPMA YOKTUR.
export const MAX_EXTERNAL_PROCESSING_ENTRIES = 20000

export const EMPTY_EXTERNAL_PROCESSING: ExternalProcessingState = { entries: {} }

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('en-US')
}

function normalizeEntry(value: unknown): ExternalProcessingEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const processedAt = String(record.processedAt ?? '').trim()
  if (!processedAt) return null
  const userId = record.processedByUserId
  return {
    processedAt,
    source: 'manual',
    processedByUserId:
      typeof userId === 'string' && userId.trim() ? userId.trim() : null,
  }
}

export function normalizeExternalProcessing(
  value: unknown,
): ExternalProcessingState {
  if (!value || typeof value !== 'object') return { entries: {} }
  const raw = (value as Record<string, unknown>).entries
  if (!raw || typeof raw !== 'object') return { entries: {} }
  const entries: Record<string, ExternalProcessingEntry> = {}
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = normalizeKey(key)
    const normalizedEntry = normalizeEntry(entry)
    if (!normalizedKey || !normalizedEntry) continue
    entries[normalizedKey] = normalizedEntry
  }
  return { entries }
}

// Mevcut repository'lerle AYNI kalıp (bkz. shipmentDefaultsRepository.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

async function readSettingsRow(db: Db, organizationId: string) {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  return rows[0] ?? null
}

export async function getExternalProcessing(
  db: Db,
  organizationId: string,
): Promise<ExternalProcessingState> {
  const row = await readSettingsRow(db, organizationId)
  if (!row) return { entries: {} }
  const settings = (row.settingsJson ?? {}) as Record<string, unknown>
  return normalizeExternalProcessing(settings.externalProcessing)
}

// settings_json MERGE ile yazılır: diğer ayarlar (shipmentDefaults, onboarding)
// KORUNUR.
async function writeExternalProcessing(
  db: Db,
  organizationId: string,
  state: ExternalProcessingState,
): Promise<void> {
  const row = await readSettingsRow(db, organizationId)
  const settings = ((row?.settingsJson ?? {}) as Record<string, unknown>) || {}
  const nextSettings = { ...settings, externalProcessing: state }
  if (!row) {
    await db
      .insert(organizationSettings)
      .values({ organizationId, settingsJson: nextSettings })
    return
  }
  await db
    .update(organizationSettings)
    .set({ settingsJson: nextSettings, updatedAt: new Date() })
    .where(eq(organizationSettings.organizationId, organizationId))
}

export interface MarkOptions {
  processedByUserId?: string | null
  /** Zaman damgası çağıran katmandan gelir (test edilebilirlik). */
  processedAt?: string
}

// İDEMPOTENT: zaten işaretli sipariş yeniden işaretlenirse kayıt DEĞİŞMEZ ve
// hata oluşmaz; yalnız `unchanged` artar.
export async function markExternallyProcessed(
  db: Db,
  organizationId: string,
  orderKeys: unknown[],
  options: MarkOptions = {},
): Promise<ExternalProcessingChange> {
  const state = await getExternalProcessing(db, organizationId)
  const entries = { ...state.entries }
  const processedAt = options.processedAt ?? new Date().toISOString()
  const processedByUserId = options.processedByUserId ?? null
  let changed = 0
  let unchanged = 0
  let invalid = 0
  for (const rawKey of Array.isArray(orderKeys) ? orderKeys : []) {
    const key = normalizeKey(rawKey)
    if (!key) {
      invalid += 1
      continue
    }
    if (entries[key]) {
      unchanged += 1
      continue
    }
    entries[key] = { processedAt, source: 'manual', processedByUserId }
    changed += 1
  }
  if (Object.keys(entries).length > MAX_EXTERNAL_PROCESSING_ENTRIES) {
    throw new Error(
      `Harici işlem arşivi üst sınırı aşıldı (${MAX_EXTERNAL_PROCESSING_ENTRIES}).`,
    )
  }
  const next = { entries }
  if (changed > 0) await writeExternalProcessing(db, organizationId, next)
  return { changed, unchanged, invalid, state: next }
}

// İDEMPOTENT: zaten aktif olan sipariş geri alınırsa hata oluşmaz.
export async function restoreToActive(
  db: Db,
  organizationId: string,
  orderKeys: unknown[],
): Promise<ExternalProcessingChange> {
  const state = await getExternalProcessing(db, organizationId)
  const entries = { ...state.entries }
  let changed = 0
  let unchanged = 0
  let invalid = 0
  for (const rawKey of Array.isArray(orderKeys) ? orderKeys : []) {
    const key = normalizeKey(rawKey)
    if (!key) {
      invalid += 1
      continue
    }
    if (!entries[key]) {
      unchanged += 1
      continue
    }
    delete entries[key]
    changed += 1
  }
  const next = { entries }
  if (changed > 0) await writeExternalProcessing(db, organizationId, next)
  return { changed, unchanged, invalid, state: next }
}
