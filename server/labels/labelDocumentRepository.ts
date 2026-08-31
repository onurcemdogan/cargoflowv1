// ETİKET BELGESİ DEPOSU — KİRACI KAPSAMLI, SÜRÜMLÜ, TASLAK/AKTİF AYRIMLI.
//
// ═══ NEDEN TASLAK VE AKTİF AYRI ══════════════════════════════════════════
// Bir operatör yerleşimi denerken arka planda ETİKET BASILIYOR olabilir.
// "Kaydet" tek bir sürüm üzerine yazsaydı, yarım kalmış bir düzenleme
// üretimdeki etikete ANINDA yansırdı. Bu yüzden kayıt TASLAĞA gider;
// üretimde kullanılan sürüm YALNIZ açık bir "Yayınla" ile değişir.
//
// ═══ NEDEN SÜRÜM (İYİMSER KİLİT) ═════════════════════════════════════════
// İki sekme veya iki kullanıcı aynı şablonu düzenlerse, son yazan diğerinin
// işini SESSİZCE yok ederdi. Her yazım `baseVersion` taşır; uyuşmazlıkta
// yazım REDDEDİLİR ve çağırana çakışma bildirilir. Sessiz kayıp YOK.
//
// ═══ KİRACI SINIRI ═══════════════════════════════════════════════════════
// Tüm işlemler `organizationId` ile kapsamlıdır ve bu kimlik YALNIZ sunucu
// auth bağlamından gelir. İstemci gövdesindeki hiçbir organizasyon alanı
// otorite DEĞİLDİR. Sistem şablonları burada SAKLANMAZ; salt okunurdurlar
// ve kiracı deposuna yazılamazlar.
//
// ŞEMA GÖÇÜ GEREKMEZ: `settings_json` zaten JSONB'dir ve diğer anahtarlar
// (labelTemplate, shipmentDefaults, externalProcessing, onboarding) MERGE
// ile KORUNUR.

import { eq } from 'drizzle-orm'
import { organizationSettings } from '../db/schema.ts'
import {
  normalizeLabelDocument,
  validateLabelDocument,
  type LabelDocument,
} from '../../src/labels/labelDocument.ts'
import {
  cloneDocument,
  findSystemTemplate,
} from '../../src/labels/labelSystemTemplates.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = {
  select: (...args: unknown[]) => any
  insert: (...args: unknown[]) => any
  update: (...args: unknown[]) => any
}

/** settings_json altındaki anahtar. */
export const LABEL_DOCUMENTS_SETTINGS_KEY = 'labelDocuments'

/** Bir kiracının tutabileceği en fazla özel şablon. */
export const MAX_CUSTOM_TEMPLATES = 40

export interface StoredLabelTemplateRecord {
  id: string
  name: string
  basedOn?: string
  /** Her yazımda artan revizyon — iyimser kilit anahtarı. */
  version: number
  updatedAt: string
  draft: LabelDocument | null
  active: LabelDocument | null
  /** Aktif sürümün yayına alındığı an. Hiç yayınlanmadıysa yok. */
  activatedAt?: string
  /**
   * ARŞİV — önceki AKTİF sürümler, en yenisi başta.
   *
   * ═══ NEDEN ═════════════════════════════════════════════════════════════
   * Yayınlanan bir yerleşim üretimde bozuk çıkarsa operatörün tek ihtiyacı
   * "bir önceki hâline dön"dür. Arşiv olmadan geri dönüş, yerleşimi elle
   * yeniden kurmak demekti. Sınırlıdır: sınırsız geçmiş, ayar satırını
   * süresiz büyütürdü.
   */
  history: LabelDocumentVersion[]
}

export interface LabelDocumentVersion {
  document: LabelDocument
  /** Bu sürümün yayınlandığı andaki kayıt sürümü. */
  version: number
  activatedAt: string
}

/** En fazla kaç önceki aktif sürüm saklanır. */
export const MAX_VERSION_HISTORY = 10

export interface StoredLabelDocuments {
  activeTemplateId: string | null
  templates: Record<string, StoredLabelTemplateRecord>
}

export const EMPTY_LABEL_DOCUMENTS: StoredLabelDocuments = {
  activeTemplateId: null,
  templates: {},
}

export type LabelDocumentErrorCode =
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'INVALID_DOCUMENT'
  | 'SYSTEM_TEMPLATE_IMMUTABLE'
  | 'LIMIT_REACHED'
  | 'NO_DRAFT'

export class LabelDocumentError extends Error {
  readonly code: LabelDocumentErrorCode
  readonly detail?: unknown
  constructor(code: LabelDocumentErrorCode, message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

function normalizeRecord(input: unknown): StoredLabelTemplateRecord | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const id = String(record.id ?? '').trim()
  if (!id) return null
  return {
    id,
    name: String(record.name ?? '').trim().slice(0, 80) || id,
    basedOn:
      typeof record.basedOn === 'string' && record.basedOn.trim()
        ? record.basedOn.trim()
        : undefined,
    version: Number.isFinite(Number(record.version))
      ? Number(record.version)
      : 1,
    updatedAt: String(record.updatedAt ?? ''),
    draft: normalizeLabelDocument(record.draft),
    active: normalizeLabelDocument(record.active),
    activatedAt:
      typeof record.activatedAt === 'string' && record.activatedAt
        ? record.activatedAt
        : undefined,
    history: normalizeHistory(record.history),
  }
}

/** Arşiv okuması: bozuk giriş SESSİZCE düşer, kayıt açılmaya devam eder. */
function normalizeHistory(input: unknown): LabelDocumentVersion[] {
  if (!Array.isArray(input)) return []
  const out: LabelDocumentVersion[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const document = normalizeLabelDocument(row.document)
    if (!document) continue
    out.push({
      document,
      version: Number.isFinite(Number(row.version)) ? Number(row.version) : 0,
      activatedAt: String(row.activatedAt ?? ''),
    })
    if (out.length >= MAX_VERSION_HISTORY) break
  }
  return out
}

async function readSettingsRow(db: Db, organizationId: string) {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  return rows[0] ?? null
}

function readState(row: unknown): StoredLabelDocuments {
  const settings = ((row as any)?.settingsJson ?? {}) as Record<string, unknown>
  const stored = settings[LABEL_DOCUMENTS_SETTINGS_KEY]
  if (!stored || typeof stored !== 'object') return { ...EMPTY_LABEL_DOCUMENTS }
  const record = stored as Record<string, unknown>
  const templates: Record<string, StoredLabelTemplateRecord> = {}
  const rawTemplates =
    record.templates && typeof record.templates === 'object'
      ? (record.templates as Record<string, unknown>)
      : {}
  for (const value of Object.values(rawTemplates)) {
    const normalized = normalizeRecord(value)
    if (normalized) templates[normalized.id] = normalized
  }
  const activeTemplateId =
    typeof record.activeTemplateId === 'string' && record.activeTemplateId.trim()
      ? record.activeTemplateId.trim()
      : null
  return { activeTemplateId, templates }
}

export async function loadLabelDocuments(
  db: Db,
  organizationId: string,
): Promise<StoredLabelDocuments> {
  return readState(await readSettingsRow(db, organizationId))
}

async function writeState(
  db: Db,
  organizationId: string,
  next: StoredLabelDocuments,
  now: string,
): Promise<void> {
  const row = await readSettingsRow(db, organizationId)
  const settings = ((row as any)?.settingsJson ?? {}) as Record<string, unknown>
  const nextSettings = { ...settings, [LABEL_DOCUMENTS_SETTINGS_KEY]: next }
  if (!row) {
    await db
      .insert(organizationSettings)
      .values({ organizationId, settingsJson: nextSettings })
    return
  }
  await db
    .update(organizationSettings)
    .set({ settingsJson: nextSettings, updatedAt: new Date(now) })
    .where(eq(organizationSettings.organizationId, organizationId))
}

function requireTemplate(
  state: StoredLabelDocuments,
  templateId: string,
): StoredLabelTemplateRecord {
  const record = state.templates[templateId]
  if (!record) {
    throw new LabelDocumentError('NOT_FOUND', 'Şablon bulunamadı.')
  }
  return record
}

function assertVersion(
  record: StoredLabelTemplateRecord,
  baseVersion: unknown,
): void {
  // `baseVersion` verilmemişse yazım REDDEDİLİR: körlemesine üzerine yazmak
  // tam da önlenmek istenen davranıştır.
  const expected = Number(baseVersion)
  if (!Number.isFinite(expected) || expected !== record.version) {
    throw new LabelDocumentError(
      'VERSION_CONFLICT',
      'Şablon bu arada değişti. Değişikliklerinizi kaybetmemek için yeniden yükleyin.',
      { currentVersion: record.version },
    )
  }
}

function assertValidDocument(document: LabelDocument | null): LabelDocument {
  if (!document) {
    throw new LabelDocumentError('INVALID_DOCUMENT', 'Şablon okunamadı.')
  }
  const validation = validateLabelDocument(document)
  if (!validation.valid) {
    throw new LabelDocumentError(
      'INVALID_DOCUMENT',
      'Şablon doğrulanamadı.',
      validation.errors,
    )
  }
  return document
}

/** Sistem şablonundan yeni ÖZEL şablon üretir (sistem şablonu değişmez). */
export async function createLabelDocumentFromSystem(
  db: Db,
  organizationId: string,
  systemTemplateId: string,
  name: string,
  now: string,
  newId: string,
): Promise<StoredLabelTemplateRecord> {
  const system = findSystemTemplate(systemTemplateId)
  if (!system) {
    throw new LabelDocumentError('NOT_FOUND', 'Sistem şablonu bulunamadı.')
  }
  const state = await loadLabelDocuments(db, organizationId)
  if (Object.keys(state.templates).length >= MAX_CUSTOM_TEMPLATES) {
    throw new LabelDocumentError(
      'LIMIT_REACHED',
      `En fazla ${MAX_CUSTOM_TEMPLATES} özel şablon tutulabilir.`,
    )
  }
  const safeName = String(name ?? '').trim().slice(0, 80) || `${system.name} kopyası`
  const draft = cloneDocument(system, {
    id: newId,
    name: safeName,
    basedOn: system.id,
  })
  assertValidDocument(draft)
  const record: StoredLabelTemplateRecord = {
    id: newId,
    name: safeName,
    basedOn: system.id,
    version: 1,
    updatedAt: now,
    // Yeni şablon TASLAK doğar: kopyalamak YAYINLAMAK DEĞİLDİR.
    draft,
    active: null,
    history: [],
  }
  await writeState(
    db,
    organizationId,
    { ...state, templates: { ...state.templates, [newId]: record } },
    now,
  )
  return record
}

/** Var olan ÖZEL şablonu kopyalar. */
export async function duplicateLabelDocument(
  db: Db,
  organizationId: string,
  templateId: string,
  name: string,
  now: string,
  newId: string,
): Promise<StoredLabelTemplateRecord> {
  const state = await loadLabelDocuments(db, organizationId)
  const source = requireTemplate(state, templateId)
  if (Object.keys(state.templates).length >= MAX_CUSTOM_TEMPLATES) {
    throw new LabelDocumentError(
      'LIMIT_REACHED',
      `En fazla ${MAX_CUSTOM_TEMPLATES} özel şablon tutulabilir.`,
    )
  }
  const base = source.draft ?? source.active
  if (!base) {
    throw new LabelDocumentError('NO_DRAFT', 'Kopyalanacak içerik yok.')
  }
  const safeName = String(name ?? '').trim().slice(0, 80) || `${source.name} kopyası`
  const draft = cloneDocument(base, {
    id: newId,
    name: safeName,
    basedOn: source.basedOn ?? source.id,
  })
  const record: StoredLabelTemplateRecord = {
    id: newId,
    name: safeName,
    basedOn: source.basedOn ?? source.id,
    version: 1,
    updatedAt: now,
    draft,
    active: null,
    history: [],
  }
  await writeState(
    db,
    organizationId,
    { ...state, templates: { ...state.templates, [newId]: record } },
    now,
  )
  return record
}

export async function saveLabelDocumentDraft(
  db: Db,
  organizationId: string,
  templateId: string,
  input: unknown,
  baseVersion: unknown,
  now: string,
): Promise<StoredLabelTemplateRecord> {
  const state = await loadLabelDocuments(db, organizationId)
  const record = requireTemplate(state, templateId)
  assertVersion(record, baseVersion)
  const normalized = normalizeLabelDocument(input)
  const document = assertValidDocument(
    normalized ? { ...normalized, id: templateId, name: record.name } : null,
  )
  const next: StoredLabelTemplateRecord = {
    ...record,
    version: record.version + 1,
    updatedAt: now,
    draft: document,
    // TASLAK KAYDI YAYINLAMAZ: aktif sürüm OLDUĞU GİBİ kalır.
    active: record.active,
  }
  await writeState(
    db,
    organizationId,
    { ...state, templates: { ...state.templates, [templateId]: next } },
    now,
  )
  return next
}

/** Taslağı üretime alır. AÇIK bir eylemdir; kaydetmek bunu yapmaz. */
export async function activateLabelDocument(
  db: Db,
  organizationId: string,
  templateId: string,
  baseVersion: unknown,
  now: string,
): Promise<StoredLabelTemplateRecord> {
  const state = await loadLabelDocuments(db, organizationId)
  const record = requireTemplate(state, templateId)
  assertVersion(record, baseVersion)
  const candidate = record.draft ?? record.active
  if (!candidate) {
    throw new LabelDocumentError('NO_DRAFT', 'Yayınlanacak taslak yok.')
  }
  const document = assertValidDocument(candidate)
  // ÖNCEKİ AKTİF ARŞİVLENİR — geri dönüş için tek kaynak budur. Aynı belge
  // tekrar yayınlanırsa arşive KOPYA eklenmez (gürültü olurdu).
  const previous = record.active
  const unchanged =
    previous && JSON.stringify(previous) === JSON.stringify(document)
  const history =
    previous && !unchanged
      ? [
          {
            document: previous,
            version: record.version,
            activatedAt: record.activatedAt ?? record.updatedAt,
          },
          ...record.history,
        ].slice(0, MAX_VERSION_HISTORY)
      : record.history
  const next: StoredLabelTemplateRecord = {
    ...record,
    version: record.version + 1,
    updatedAt: now,
    activatedAt: now,
    draft: document,
    active: document,
    history,
  }
  await writeState(
    db,
    organizationId,
    {
      activeTemplateId: templateId,
      templates: { ...state.templates, [templateId]: next },
    },
    now,
  )
  return next
}

export async function renameLabelDocument(
  db: Db,
  organizationId: string,
  templateId: string,
  name: string,
  baseVersion: unknown,
  now: string,
): Promise<StoredLabelTemplateRecord> {
  const state = await loadLabelDocuments(db, organizationId)
  const record = requireTemplate(state, templateId)
  assertVersion(record, baseVersion)
  const safeName = String(name ?? '').trim().slice(0, 80)
  if (!safeName) {
    throw new LabelDocumentError('INVALID_DOCUMENT', 'Şablon adı boş olamaz.')
  }
  const next: StoredLabelTemplateRecord = {
    ...record,
    name: safeName,
    version: record.version + 1,
    updatedAt: now,
    draft: record.draft ? { ...record.draft, name: safeName } : null,
    active: record.active ? { ...record.active, name: safeName } : null,
  }
  await writeState(
    db,
    organizationId,
    { ...state, templates: { ...state.templates, [templateId]: next } },
    now,
  )
  return next
}

export async function deleteLabelDocument(
  db: Db,
  organizationId: string,
  templateId: string,
  now: string,
): Promise<void> {
  const state = await loadLabelDocuments(db, organizationId)
  requireTemplate(state, templateId)
  const templates = { ...state.templates }
  delete templates[templateId]
  await writeState(
    db,
    organizationId,
    {
      activeTemplateId:
        state.activeTemplateId === templateId ? null : state.activeTemplateId,
      templates,
    },
    now,
  )
}

/**
 * Üretimde kullanılacak AKTİF belge.
 *
 * Kiracının yayınlanmış bir şablonu yoksa `null` döner ve çağıran mevcut
 * (yerleşik) yerleşimi kullanmaya DEVAM EDER — sürüm yükseltmesi hiçbir
 * kiracının etiketini kendiliğinden değiştirmez.
 */
/**
 * ÖNCEKİ AKTİF SÜRÜME DÖN.
 *
 * ═══ NEDEN AYRI BİR İŞLEM ════════════════════════════════════════════════
 * "Taslağı düzelt, tekrar yayınla" bir geri dönüş DEĞİLDİR: bozuk yerleşim
 * üretimde dururken operatörden yeniden tasarım beklemek demektir. Geri
 * dönüş TEK adımdır ve arşivdeki son aktif sürümü geri yükler.
 *
 * TASLAK KORUNUR: operatörün üzerinde çalıştığı taslak silinmez; yalnız
 * AKTİF sürüm değişir.
 */
export async function rollbackLabelDocument(
  db: Db,
  organizationId: string,
  templateId: string,
  baseVersion: unknown,
  now: string,
): Promise<StoredLabelTemplateRecord> {
  const state = await loadLabelDocuments(db, organizationId)
  const record = requireTemplate(state, templateId)
  assertVersion(record, baseVersion)
  const [previous, ...rest] = record.history
  if (!previous) {
    throw new LabelDocumentError(
      'NO_DRAFT',
      'Geri dönülecek önceki yayınlanmış sürüm yok.',
    )
  }
  // Geri dönülen sürüm de DOĞRULANIR: arşivdeki bir kayıt bozuksa üretime
  // sessizce geri konmaz.
  const document = assertValidDocument(previous.document)
  const next: StoredLabelTemplateRecord = {
    ...record,
    version: record.version + 1,
    updatedAt: now,
    activatedAt: now,
    active: document,
    // Geri dönülen sürüm arşivden ÇIKAR; mevcut aktif onun yerine girer.
    history: record.active
      ? [
          {
            document: record.active,
            version: record.version,
            activatedAt: record.activatedAt ?? record.updatedAt,
          },
          ...rest,
        ].slice(0, MAX_VERSION_HISTORY)
      : rest,
  }
  await writeState(
    db,
    organizationId,
    {
      activeTemplateId: templateId,
      templates: { ...state.templates, [templateId]: next },
    },
    now,
  )
  return next
}

/**
 * TAMAMEN ORİJİNAL SÜRAT ETİKETİNE DÖN.
 *
 * Hiçbir kiracı katmanı uygulanmaz; baskı taşıyıcının çıktısını AYNEN
 * kullanır. Şablonlar SİLİNMEZ — yalnız aktiflik kaldırılır, böylece
 * operatör hazır olduğunda tekrar yayınlayabilir.
 */
export async function revertToCarrierOriginal(
  db: Db,
  organizationId: string,
  now: string,
): Promise<StoredLabelDocuments> {
  const state = await loadLabelDocuments(db, organizationId)
  const next = { ...state, activeTemplateId: null }
  await writeState(db, organizationId, next, now)
  return next
}

/** Baskıda hangi katmanın kullanıldığı — teşhis ve arayüz rozeti için. */
export type LabelFallbackTier = 'active' | 'previous' | 'carrier_original'

export interface ResolvedLabelLayer {
  document: LabelDocument | null
  tier: LabelFallbackTier
  /** `previous` veya `carrier_original` ise NEDEN düşüldüğü. */
  reason?: string
}

/**
 * BASKI KATMANI ÇÖZÜMÜ — DÜŞME SIRASI.
 *
 *   1. aktif kiracı şablonu
 *   2. önceki aktif sürüm (aktif olan doğrulamadan geçmiyorsa)
 *   3. saf orijinal Sürat etiketi (belge YOK)
 *
 * ═══ NEDEN ═══════════════════════════════════════════════════════════════
 * Üretim ETİKETSİZ KALMAMALIDIR. Bir yerleşim kaydı bozulursa ya da
 * doğrulamadan düşerse baskı durmaz: bir önceki çalışan sürüme, o da yoksa
 * taşıyıcının kendi etiketine düşer. Taşıyıcı etiketi HER ZAMAN basılabilir
 * — çünkü onu biz üretmiyoruz.
 */
export async function resolveActiveLabelLayer(
  db: Db,
  organizationId: string,
): Promise<ResolvedLabelLayer> {
  const state = await loadLabelDocuments(db, organizationId)
  if (!state.activeTemplateId) {
    return { tier: 'carrier_original', document: null }
  }
  const record = state.templates[state.activeTemplateId]
  if (!record) {
    return {
      tier: 'carrier_original',
      document: null,
      reason: 'Aktif şablon kaydı bulunamadı.',
    }
  }
  if (record.active && validateLabelDocument(record.active).valid) {
    return { tier: 'active', document: record.active }
  }
  for (const version of record.history) {
    if (validateLabelDocument(version.document).valid) {
      return {
        tier: 'previous',
        document: version.document,
        reason: 'Aktif sürüm doğrulamadan geçmedi; önceki sürüme düşüldü.',
      }
    }
  }
  return {
    tier: 'carrier_original',
    document: null,
    reason: 'Geçerli kiracı yerleşimi yok; taşıyıcı etiketi kullanılıyor.',
  }
}

export async function resolveActiveLabelDocument(
  db: Db,
  organizationId: string,
): Promise<LabelDocument | null> {
  const state = await loadLabelDocuments(db, organizationId)
  if (!state.activeTemplateId) return null
  const record = state.templates[state.activeTemplateId]
  return record?.active ?? null
}
