// Organization bazlı GÖNDERİ VARSAYILANLARI (şimdilik: varsayılan birim desi).
// Kaynak-of-truth PostgreSQL'dir (organization_settings.settings_json);
// localStorage'a GÜVENİLMEZ. organizationId ZORUNLU ilk parametredir → başka
// tenant'a sızmaz. Secret/PII TUTMAZ. YENİ KOLON/MIGRATION GEREKTİRMEZ: mevcut
// settings_json JSONB alanı altında `shipmentDefaults` anahtarı kullanılır ve
// aynı JSON'daki diğer anahtarlar KORUNUR (merge).
import { eq } from 'drizzle-orm'
import { organizationSettings } from '../db/schema.ts'
import { ensureSettings } from './onboardingRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface ShipmentDefaults {
  // Varsayılan BİRİM desi. null → ayar yok (eski davranış).
  defaultUnitDesi: number | null
  // Varsayılan desi ürün adediyle ÇARPILSIN mı?
  // VARSAYILAN true: alan bulunmayan ESKİ kayıtlarda mevcut canlı davranış
  // (adet çarpanı) AYNEN sürer; hiçbir müşterinin davranışı kendiliğinden
  // değişmez. false → varsayılan desi paket için YALNIZ BİR KEZ kullanılır.
  multiplyByItemQuantity: boolean
  // Hangi baskı şablonu kullanılacak?
  //   cargoflow_html     → mevcut CargoFlow HTML/CSS etiketi (VARSAYILAN)
  //   surat_official_zpl → Sürat'in resmî ZPL düzeni, yerel SVG render
  // VARSAYILAN cargoflow_html: alanı olmayan ESKİ kayıtlarda mevcut canlı
  // baskı davranışı AYNEN sürer; deploy ile kimsenin davranışı değişmez.
  labelPrintTemplate: LabelPrintTemplate
}

export type LabelPrintTemplate = 'cargoflow_html' | 'surat_official_zpl'

export const DEFAULT_LABEL_PRINT_TEMPLATE: LabelPrintTemplate = 'cargoflow_html'

// Bilinmeyen/eksik değer → cargoflow_html (geriye dönük uyumluluk).
export function normalizeLabelPrintTemplate(value: unknown): LabelPrintTemplate {
  return value === 'surat_official_zpl'
    ? 'surat_official_zpl'
    : DEFAULT_LABEL_PRINT_TEMPLATE
}

export const EMPTY_SHIPMENT_DEFAULTS: ShipmentDefaults = {
  defaultUnitDesi: null,
  multiplyByItemQuantity: true,
  labelPrintTemplate: DEFAULT_LABEL_PRINT_TEMPLATE,
}

// Eksik/geçersiz değer → true (geriye dönük uyumluluk). Yalnız açık `false`
// (veya 'false'/0) kapatır.
export function normalizeMultiplyByItemQuantity(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'false' || normalized === '0') return false
    if (normalized === 'true' || normalized === '1') return true
    return true
  }
  if (typeof value === 'number') return value !== 0
  return true
}

// Frontend normalizeTenantDesiConfig ile AYNI kural: pozitif sayı, 2 ondalık;
// virgüllü giriş kabul edilir; geçersiz/0/negatif → null (ayar yok).
export function normalizeDefaultUnitDesi(value: unknown): number | null {
  const raw = typeof value === 'string' ? value.trim().replace(',', '.') : value
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * 100) / 100
}

function readSettingsJson(row: Record<string, unknown> | null): Record<string, unknown> {
  const json = row?.settingsJson
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {}
}

export async function getShipmentDefaults(
  db: Db,
  organizationId: string,
): Promise<ShipmentDefaults> {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  const settings = readSettingsJson(rows[0] ?? null)
  const shipmentDefaults =
    settings.shipmentDefaults && typeof settings.shipmentDefaults === 'object'
      ? (settings.shipmentDefaults as Record<string, unknown>)
      : {}
  return {
    defaultUnitDesi: normalizeDefaultUnitDesi(shipmentDefaults.defaultUnitDesi),
    multiplyByItemQuantity: normalizeMultiplyByItemQuantity(
      shipmentDefaults.multiplyByItemQuantity,
    ),
    labelPrintTemplate: normalizeLabelPrintTemplate(
      shipmentDefaults.labelPrintTemplate,
    ),
  }
}

// Varsayılan desiyi KALICI yazar. settings_json içindeki diğer anahtarlar
// KORUNUR. null yazmak ayarı temizler (eski davranışa döner). Yalnız verilen
// organization'a yazar.
export async function saveShipmentDefaults(
  db: Db,
  organizationId: string,
  defaults: ShipmentDefaults,
): Promise<ShipmentDefaults> {
  const current = await ensureSettings(db, organizationId)
  const settings = readSettingsJson(current)
  const normalized: ShipmentDefaults = {
    defaultUnitDesi: normalizeDefaultUnitDesi(defaults?.defaultUnitDesi),
    multiplyByItemQuantity: normalizeMultiplyByItemQuantity(
      defaults?.multiplyByItemQuantity,
    ),
    labelPrintTemplate: normalizeLabelPrintTemplate(
      defaults?.labelPrintTemplate,
    ),
  }
  await db
    .update(organizationSettings)
    .set({
      settingsJson: { ...settings, shipmentDefaults: normalized },
      updatedAt: new Date(),
    })
    .where(eq(organizationSettings.organizationId, organizationId))
  return normalized
}
