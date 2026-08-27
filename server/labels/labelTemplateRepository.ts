// KİRACI ETİKET ŞABLONU — KALICI DEPO.
//
// ═══ KÖK NEDEN: KODSUZ DÜZENLEYİCİ NEDEN "ÇALIŞMIYORDU" ══════════════════
// Şablon yalnız TARAYICI localStorage'ında duruyordu. Sunucu baskı yolu
// (`attachPrintZplArtifact`) onu HİÇ göremiyordu; dolayısıyla operatörün
// açtığı blok ne arka plan otomatik etiketinde ne de başka bir cihazda
// görünüyordu. Alan YAZILIYOR ama OKUNMUYORDU.
//
// Bu modül şablona org kapsamında KALICI bir ev verir:
//   organization_settings.settings_json.labelTemplate
//
// ŞEMA GÖÇÜ GEREKMEZ: `settings_json` zaten JSONB'dir ve diğer anahtarlar
// (shipmentDefaults, externalProcessing, onboarding) MERGE ile korunur.
//
// ═══ KİMLİK BURADA DA DOKUNULMAZ ═════════════════════════════════════════
// Normalizasyon, kiracının yapılandıramadığı her anahtarı ATAR.
// Kötü niyetli veya bozuk bir istemci gövdesi barkod/QR/takip bloğu için
// bir DEĞER veya sunum ayarı yazamaz.

import { eq } from 'drizzle-orm'
import { organizationSettings } from '../db/schema.ts'
import type { LabelFieldConfig, LabelFieldKey } from '../../src/types/cargoflow.ts'
import {
  isProductLinePart,
  isTenantRenderableBlock,
  TENANT_BLOCK_MAX_FONT,
  TENANT_BLOCK_MIN_FONT,
} from '../../src/utils/labelTenantBlocks.ts'

/**
 * Kiracının yapılandırabildiği anahtarlar.
 *
 * İKİ SINIF: composer bandına AYRI satır olarak basılan bloklar ve mevcut
 * ÜRÜN SATIRININ parçaları (adet / varyant / SKU / ürün adı). İkincisi
 * dışarıda bırakılınca "SKU'yu gizle" ayarı sunucuya HİÇ ulaşmıyordu:
 * düzenleyicide kapatılıyor, kaydediliyor, sonra sessizce varsayılana
 * dönüyordu.
 */
function isTenantConfigurableBlock(key: LabelFieldKey): boolean {
  return isTenantRenderableBlock(key) || isProductLinePart(key)
}

// Drizzle'ın akıcı sorgu kurucusu (`.from().where().limit()`) her adımda
// farklı bir jenerik tip döndürür ve burada elle yazılamaz. Depo kodunun
// geri kalanındaki (printZplItems, tenantBlockLoader) sözleşmeyle aynı
// biçimde, YALNIZ bu yerel `Db` şekli için kural gevşetilir.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = {
  select: (...args: unknown[]) => any
  insert: (...args: unknown[]) => any
  update: (...args: unknown[]) => any
}

/** settings_json altındaki anahtar. */
export const LABEL_TEMPLATE_SETTINGS_KEY = 'labelTemplate'

export interface StoredLabelTemplate {
  /** Her yazımda artan sürüm — eşzamanlı düzenleme kaybını görünür kılar. */
  readonly version: number
  readonly updatedAt: string
  readonly fields: readonly LabelFieldConfig[]
}

const PLACEMENTS = new Set(['top', 'body', 'bottom'])

function normalizeFont(value: unknown): number | undefined {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.min(
    TENANT_BLOCK_MAX_FONT,
    Math.max(TENANT_BLOCK_MIN_FONT, Math.round(numeric)),
  )
}

/**
 * Gövdeyi güvenli şablona indirger.
 *
 * KABUL EDİLEN: kiracının yapılandırabildiği bloklar (ayrı satır blokları
 * VE ürün satırı parçaları). Kimlik ve taşıyıcıya ait bloklar SESSİZCE
 * DEĞİL, açıkça atılır (`rejected` ile raporlanır) — çağıran katman bunu
 * yanıtta gösterir.
 */
export function normalizeLabelTemplateFields(input: unknown): {
  fields: LabelFieldConfig[]
  rejected: LabelFieldKey[]
} {
  const raw = Array.isArray(input) ? input : []
  const fields: LabelFieldConfig[] = []
  const rejected: LabelFieldKey[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const key = String((entry as Record<string, unknown>).key ?? '') as LabelFieldKey
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (!isTenantConfigurableBlock(key)) {
      rejected.push(key)
      continue
    }
    const record = entry as Record<string, unknown>
    const placement = String(record.placement ?? 'body')
    fields.push({
      key,
      label: String(record.label ?? key),
      visible: record.visible === true,
      order: Number.isFinite(Number(record.order))
        ? Number(record.order)
        : fields.length + 1,
      fontSize: normalizeFont(record.fontSize),
      bold: record.bold === true,
      placement: (PLACEMENTS.has(placement)
        ? placement
        : 'body') as LabelFieldConfig['placement'],
    })
  }
  fields.sort((left, right) => left.order - right.order)
  return {
    fields: fields.map((field, index) => ({ ...field, order: index + 1 })),
    rejected,
  }
}

async function readSettingsRow(db: Db, organizationId: string) {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  return rows[0] ?? null
}

export async function loadLabelTemplate(
  db: Db,
  organizationId: string,
): Promise<StoredLabelTemplate | null> {
  const row = await readSettingsRow(db, organizationId)
  const settings = (row?.settingsJson ?? {}) as Record<string, unknown>
  const stored = settings[LABEL_TEMPLATE_SETTINGS_KEY]
  if (!stored || typeof stored !== 'object') return null
  const record = stored as Record<string, unknown>
  const { fields } = normalizeLabelTemplateFields(record.fields)
  return {
    version: Number.isFinite(Number(record.version)) ? Number(record.version) : 1,
    updatedAt: String(record.updatedAt ?? ''),
    fields,
  }
}

/**
 * Şablonu KALICI yazar ve yeni sürümü döndürür.
 *
 * `settings_json` MERGE edilir: shipmentDefaults / externalProcessing /
 * onboarding anahtarları KORUNUR.
 */
export async function saveLabelTemplate(
  db: Db,
  organizationId: string,
  input: unknown,
  now: string,
): Promise<{ template: StoredLabelTemplate; rejected: LabelFieldKey[] }> {
  const { fields, rejected } = normalizeLabelTemplateFields(input)
  const row = await readSettingsRow(db, organizationId)
  const settings = ((row?.settingsJson ?? {}) as Record<string, unknown>) || {}
  const previous = settings[LABEL_TEMPLATE_SETTINGS_KEY] as
    | Record<string, unknown>
    | undefined
  const previousVersion = Number.isFinite(Number(previous?.version))
    ? Number(previous?.version)
    : 0
  const template: StoredLabelTemplate = {
    version: previousVersion + 1,
    updatedAt: now,
    fields,
  }
  const nextSettings = { ...settings, [LABEL_TEMPLATE_SETTINGS_KEY]: template }
  if (!row) {
    await db
      .insert(organizationSettings)
      .values({ organizationId, settingsJson: nextSettings })
  } else {
    await db
      .update(organizationSettings)
      .set({ settingsJson: nextSettings, updatedAt: new Date(now) })
      .where(eq(organizationSettings.organizationId, organizationId))
  }
  return { template, rejected }
}
