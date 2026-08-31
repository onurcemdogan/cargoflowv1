// ETİKET BELGESİ İSTEMCİSİ.
//
// TAŞIYICI ÇAĞRISI YOKTUR: bu servis yalnız yerleşim belgesini okur/yazar.
// Ne Sürat'a ne Trendyol'a çıkar; gönderi oluşturmaz, takip numarası veya
// barkod değeri DEĞİŞTİRMEZ.
//
// Çakışma (409) SESSİZCE yutulmaz: çağıran katman kullanıcıya "şablon bu
// arada değişti" diyebilsin diye tiplenmiş bir hata fırlatılır.

import type { LabelDocument } from '../labels/labelDocument'

export interface LabelTemplateRecord {
  id: string
  name: string
  basedOn?: string
  version: number
  updatedAt: string
  draft: LabelDocument | null
  active: LabelDocument | null
}

export interface LabelDocumentsResponse {
  system: LabelDocument[]
  templates: LabelTemplateRecord[]
  activeTemplateId: string | null
}

export class LabelDocumentConflictError extends Error {
  readonly currentVersion?: number
  constructor(message: string, currentVersion?: number) {
    super(message)
    this.name = 'LabelDocumentConflictError'
    this.currentVersion = currentVersion
  }
}

export class LabelDocumentValidationError extends Error {
  readonly detail: unknown
  constructor(message: string, detail: unknown) {
    super(message)
    this.name = 'LabelDocumentValidationError'
    this.detail = detail
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers:
      init.body != null ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 409) {
    throw new LabelDocumentConflictError(
      String(payload?.message ?? 'Şablon bu arada değişti.'),
      Number(payload?.currentVersion),
    )
  }
  if (!response.ok || payload?.ok === false) {
    if (payload?.code === 'INVALID_DOCUMENT') {
      throw new LabelDocumentValidationError(
        String(payload?.message ?? 'Şablon doğrulanamadı.'),
        payload?.detail ?? null,
      )
    }
    throw new Error(String(payload?.message ?? 'Etiket şablonu işlenemedi.'))
  }
  return payload as T
}

/**
 * ÖNİZLEME İÇİN TEK SİPARİŞ.
 *
 * Düzenleyiciye doğrudan gelen (Siparişler ekranını hiç açmamış) bir
 * operatör, uydurma DEMO veriyle yerleşim yapmak zorunda kalmamalıdır.
 * Bu çağrı `/api/orders` sözleşmesini KULLANIR ve TEK kayıt ister:
 * tam koleksiyon İNDİRİLMEZ, taşıyıcıya/pazaryerine ÇIKILMAZ.
 */
export async function fetchPreviewOrder(): Promise<unknown | null> {
  try {
    const response = await fetch('/api/orders?page=1&pageSize=1', {
      credentials: 'include',
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { orders?: unknown[] }
    return Array.isArray(payload.orders) ? (payload.orders[0] ?? null) : null
  } catch {
    // Önizleme siparişi alınamazsa DEMO veriye düşülür; düzenleyici AÇILIR.
    return null
  }
}

/**
 * UÇUŞTAKİ İSTEK TEKİLLEŞTİRME (cache DEĞİL).
 *
 * ═══ NEDEN ══════════════════════════════════════════════════════════════
 * Aynı belge listesi açılışta İKİ yerden okunuyordu: App (baskı yolu için
 * yayındaki yerleşim) ve düzenleyici sayfası (şablon listesi). Düzenleyici
 * doğrudan açıldığında bu, AYNI parametresiz GET'in iki kez gitmesi demekti.
 *
 * ═══ NEDEN BAYATLAMAZ ═══════════════════════════════════════════════════
 * Sonuç SAKLANMAZ. Yalnız halihazırda UÇUŞTA olan bir istek varsa aynı söz
 * paylaşılır; istek biter bitmez kayıt SİLİNİR. Kaydet/yayınla sonrası
 * yapılan her `load()` yine GERÇEK bir istektir — bayat liste GÖSTERİLMEZ.
 */
let documentsInFlight: Promise<LabelDocumentsResponse> | null = null

export function fetchLabelDocuments(): Promise<LabelDocumentsResponse> {
  if (documentsInFlight) return documentsInFlight
  const pending = (async () => {
    const payload = await request<{
      system?: LabelDocument[]
      templates?: LabelTemplateRecord[]
      activeTemplateId?: string | null
    }>('/api/labels/documents')
    return {
      system: Array.isArray(payload.system) ? payload.system : [],
      templates: Array.isArray(payload.templates) ? payload.templates : [],
      activeTemplateId: payload.activeTemplateId ?? null,
    }
  })()
  documentsInFlight = pending
  // Kayıt HER İKİ sonuçta da temizlenir. Hata dalı da ele alındığı için
  // türetilmiş sözden "unhandled rejection" ÇIKMAZ; asıl hatayı çağıran
  // görmeye devam eder.
  const clear = () => {
    documentsInFlight = null
  }
  void pending.then(clear, clear)
  return pending
}

export async function createLabelDocument(input: {
  fromSystemId?: string
  fromTemplateId?: string
  name: string
}): Promise<LabelTemplateRecord> {
  const payload = await request<{ template: LabelTemplateRecord }>(
    '/api/labels/documents',
    { method: 'POST', body: JSON.stringify(input) },
  )
  return payload.template
}

export async function saveLabelDocumentDraft(
  templateId: string,
  document: LabelDocument,
  baseVersion: number,
): Promise<LabelTemplateRecord> {
  const payload = await request<{ template: LabelTemplateRecord }>(
    `/api/labels/documents/${encodeURIComponent(templateId)}/draft`,
    { method: 'PUT', body: JSON.stringify({ document, baseVersion }) },
  )
  return payload.template
}

export async function activateLabelDocument(
  templateId: string,
  baseVersion: number,
): Promise<LabelTemplateRecord> {
  const payload = await request<{ template: LabelTemplateRecord }>(
    `/api/labels/documents/${encodeURIComponent(templateId)}/activate`,
    { method: 'POST', body: JSON.stringify({ baseVersion }) },
  )
  return payload.template
}

export async function renameLabelDocument(
  templateId: string,
  name: string,
  baseVersion: number,
): Promise<LabelTemplateRecord> {
  const payload = await request<{ template: LabelTemplateRecord }>(
    `/api/labels/documents/${encodeURIComponent(templateId)}`,
    { method: 'PATCH', body: JSON.stringify({ name, baseVersion }) },
  )
  return payload.template
}

export async function deleteLabelDocument(templateId: string): Promise<void> {
  await request(`/api/labels/documents/${encodeURIComponent(templateId)}`, {
    method: 'DELETE',
  })
}
