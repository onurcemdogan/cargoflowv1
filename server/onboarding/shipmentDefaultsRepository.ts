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
  // Varsayılan BİRİM desi (satır adedi ile ÇARPILIR — mevcut çarpan sözleşmesi
  // korunur, bkz. orderDesi.calculateOrderDesi). null → ayar yok (eski davranış).
  defaultUnitDesi: number | null
}

export const EMPTY_SHIPMENT_DEFAULTS: ShipmentDefaults = {
  defaultUnitDesi: null,
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
