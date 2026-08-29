// ETİKET ŞABLONU DÜZENLEYİCİSİ — ÜÇ BÖLGE: TARAYICI | TUVAL | ÖZELLİKLER.
//
// ═══ NEDEN KAYDIRAK EKRANI DEĞİL ═════════════════════════════════════════
// Önceki ekran blok aç/kapa ve punto kaydırağından ibaretti: operatör
// "adresi 4 mm yukarı al" diyemiyor, sonucu ancak baskıdan sonra görüyordu.
// Burada yerleşim DOĞRUDAN, gerçek 10×10 cm yüzeyde ve GERÇEK sipariş
// verisiyle düzenlenir.
//
// ═══ NEDEN TASLAK VE YAYIN AYRI ══════════════════════════════════════════
// "Kaydet" üretimdeki etiketi DEĞİŞTİRMEZ. Arka planda otomatik etiket
// basılıyor olabilir; yarım kalmış bir düzenlemenin oraya sızması kabul
// edilemez. Üretim sürümü YALNIZ açık "Yayınla" ile değişir.
//
// ═══ TAŞIYICI ÇAĞRISI YOK ════════════════════════════════════════════════
// Bu sayfadaki HİÇBİR eylem (seç, sürükle, boyutlandır, kaydet, yayınla,
// önizle) Sürat'a veya Trendyol'a çıkmaz; ham taşıyıcı artefaktına dokunmaz,
// takip numarasını/barkodu DEĞİŞTİRMEZ.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Copy, Plus, Redo2, Save, Undo2, UploadCloud } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { LabelCanvas } from '../components/labels/LabelCanvas'
import { LabelElementInspector } from '../components/labels/LabelElementInspector'
import { labelElementLabel } from '../labels/labelElementLabels'
import type { CargoOrder, CargoProduct } from '../types/cargoflow'
import type { LabelDocument, LabelElement } from '../labels/labelDocument'
import { validateLabelDocument } from '../labels/labelDocument'
import { renderLabelDocument } from '../labels/labelDocumentRenderer'
import {
  buildEditorPreviewSource,
  buildStressPreviewSource,
} from '../labels/labelPreviewSource'
import {
  canRedo,
  canUndo,
  createLabelEditorState,
  isDirty,
  labelEditorReducer,
  type LabelEditorAction,
  type LabelEditorState,
} from '../labels/labelEditorState'
import { SYSTEM_LABEL_TEMPLATES } from '../labels/labelSystemTemplates'
import {
  LabelDocumentConflictError,
  activateLabelDocument,
  createLabelDocument,
  fetchLabelDocuments,
  renameLabelDocument,
  saveLabelDocumentDraft,
  type LabelTemplateRecord,
} from '../services/labelDocumentService'

const ZOOM_STEPS = [0.75, 1, 1.5, 2, 3]

interface LabelTemplateEditorPageProps {
  orders: CargoOrder[]
  products?: CargoProduct[]
  /**
   * Sürat RESMÎ etiketinin kiracı bandı ayarları (eski panel).
   *
   * Resmî ZPL etiketin gövdesini TAŞIYICI basar; adres/barkod oradan gelir ve
   * serbestçe konumlandırılamaz. O yüzden bant ayarları AYRI bir sekmede
   * korunur — bu düzenleyici CargoFlow'un KENDİ bastığı HTML etiketi içindir.
   */
  legacyBandPanel?: ReactNode
  /**
   * YAYINDAKİ belge değiştiğinde çağrılır.
   *
   * Baskı yolu bu belgeyi kullanır; yayınlamanın etkisi bir sonraki tam
   * sayfa yenilemesine ERTELENMEZ. Çağıran KARARLI bir fonksiyon vermelidir
   * (aksi halde her render yeniden yükleme tetikler).
   */
  onActiveDocumentChange?: (document: LabelDocument | null) => void
}

interface EditorSlot {
  state: LabelEditorState
  record: LabelTemplateRecord
}

export function LabelTemplateEditorPage({
  orders,
  products = [],
  legacyBandPanel,
  onActiveDocumentChange,
}: LabelTemplateEditorPageProps) {
  const [tab, setTab] = useState<'layout' | 'band'>('layout')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [notice, setNotice] = useState<{ level: 'info' | 'error'; text: string }>()
  const [records, setRecords] = useState<LabelTemplateRecord[]>([])
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>()
  const [selectedElementId, setSelectedElementId] = useState<string>()
  const [zoom, setZoom] = useState(1)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [previewMode, setPreviewMode] = useState<'order' | 'stress'>('order')
  const [busy, setBusy] = useState(false)

  // ŞABLON BAŞINA düzenleyici durumu: kaydedilmemiş değişiklikler şablon
  // değiştirip geri dönünce KAYBOLMAZ.
  //
  // Bu bir ref DEĞİL, state'tir: render sırasında ref okumak eşzamanlı
  // (concurrent) render'da bayat değer verir ve kaydedilmemiş bir taslağın
  // ekranda görünmemesine yol açardı.
  const [slots, setSlots] = useState<Record<string, EditorSlot>>({})

  const load = useCallback(async () => {
    try {
      const payload = await fetchLabelDocuments()
      setRecords(payload.templates)
      setActiveTemplateId(payload.activeTemplateId)
      setLoadError(undefined)
      const activeRecord = payload.activeTemplateId
        ? payload.templates.find((item) => item.id === payload.activeTemplateId)
        : undefined
      onActiveDocumentChange?.(activeRecord?.active ?? null)
      // Sunucudan gelen kayıtlar, YEREL kaydedilmemiş taslakları EZMEZ.
      setSlots((current) => {
        const next = { ...current }
        for (const record of payload.templates) {
          const existing = next[record.id]
          if (existing && isDirty(existing.state)) {
            next[record.id] = { ...existing, record }
            continue
          }
          const document = record.draft ?? record.active
          if (!document) continue
          next[record.id] = { record, state: createLabelEditorState(document) }
        }
        return next
      })
      setSelectedTemplateId((current) => {
        if (current && payload.templates.some((item) => item.id === current)) {
          return current
        }
        return payload.activeTemplateId ?? payload.templates[0]?.id
      })
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Şablonlar yüklenemedi.',
      )
    } finally {
      setLoading(false)
    }
  }, [onActiveDocumentChange])

  // İlk yükleme. setState HİÇBİR senkron yolda çağrılmaz: her yazım en az
  // bir `await` sonrasındadır ve `active` bayrağı sökülmüş bileşene yazımı
  // engeller (React'ın "efekt içinde senkron setState" uyarısı da böylece
  // gerçek bir sorunu işaret etmeye devam eder, gürültüye dönmez).
  useEffect(() => {
    let active = true
    void (async () => {
      if (!active) return
      await load()
    })()
    return () => {
      active = false
    }
  }, [load])

  const slot = selectedTemplateId ? slots[selectedTemplateId] : undefined

  const dispatchEditor = useCallback(
    (action: LabelEditorAction) => {
      if (!selectedTemplateId) return
      setSlots((current) => {
        const existing = current[selectedTemplateId]
        if (!existing) return current
        return {
          ...current,
          [selectedTemplateId]: {
            ...existing,
            state: labelEditorReducer(existing.state, action),
          },
        }
      })
    },
    [selectedTemplateId],
  )

  const document = slot?.state.present
  const preview = useMemo(
    () =>
      previewMode === 'stress'
        ? buildStressPreviewSource()
        : buildEditorPreviewSource(orders, products),
    [orders, previewMode, products],
  )

  const rendered = useMemo(
    () => (document ? renderLabelDocument(document, preview.source) : null),
    [document, preview.source],
  )
  const validation = useMemo(
    () => (document ? validateLabelDocument(document) : null),
    [document],
  )

  const selectedElement = document?.elements.find(
    (element) => element.id === selectedElementId,
  )

  const handleElementChange = useCallback(
    (elementId: string, patch: Partial<LabelElement>) => {
      dispatchEditor({ type: 'updateElement', elementId, patch })
    },
    [dispatchEditor],
  )

  // Klavye: Ctrl/Cmd+Z geri al, Ctrl/Cmd+Shift+Z (veya Ctrl+Y) yinele.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const meta = event.ctrlKey || event.metaKey
      if (!meta) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        dispatchEditor({ type: 'undo' })
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        dispatchEditor({ type: 'redo' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatchEditor])

  async function runAction(
    label: string,
    action: () => Promise<LabelTemplateRecord | void>,
  ) {
    setBusy(true)
    try {
      await action()
      setNotice({ level: 'info', text: label })
    } catch (error) {
      if (error instanceof LabelDocumentConflictError) {
        setNotice({
          level: 'error',
          text:
            'Bu şablon başka bir yerde değiştirilmiş. Değişiklikleriniz ' +
            'KORUNDU; birleştirmek için sayfayı yenileyin.',
        })
      } else {
        setNotice({
          level: 'error',
          text: error instanceof Error ? error.message : 'İşlem tamamlanamadı.',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveDraft() {
    if (!slot || !document) return
    await runAction('Taslak kaydedildi. Üretimdeki etiket DEĞİŞMEDİ.', async () => {
      const record = await saveLabelDocumentDraft(
        slot.record.id,
        document,
        slot.record.version,
      )
      setSlots((current) => ({
        ...current,
        [record.id]: {
          record,
          state: labelEditorReducer(current[record.id]?.state ?? slot.state, {
            type: 'markSaved',
          }),
        },
      }))
      setRecords((current) =>
        current.map((item) => (item.id === record.id ? record : item)),
      )
    })
  }

  async function handleActivate() {
    if (!slot || !document) return
    // Yayınlamadan ÖNCE taslak kaydedilir: yayınlanan şey ekranda görülen
    // yerleşimin TA KENDİSİ olmalıdır.
    await runAction('Şablon yayınlandı. Yeni etiketler bu yerleşimi kullanır.', async () => {
      const saved = await saveLabelDocumentDraft(
        slot.record.id,
        document,
        slot.record.version,
      )
      const record = await activateLabelDocument(saved.id, saved.version)
      setSlots((current) => ({
        ...current,
        [record.id]: {
          record,
          state: labelEditorReducer(current[record.id]?.state ?? slot.state, {
            type: 'markSaved',
          }),
        },
      }))
      setRecords((current) =>
        current.map((item) => (item.id === record.id ? record : item)),
      )
      setActiveTemplateId(record.id)
      // Yayınlama ANINDA baskı yoluna yansır.
      onActiveDocumentChange?.(record.active ?? null)
    })
  }

  async function handleCreateFromSystem(systemId: string, name: string) {
    await runAction('Sistem şablonundan özel şablon oluşturuldu.', async () => {
      const record = await createLabelDocument({ fromSystemId: systemId, name })
      setSlots((current) => ({
        ...current,
        [record.id]: {
          record,
          state: createLabelEditorState(record.draft ?? record.active!),
        },
      }))
      setRecords((current) => [...current, record])
      setSelectedTemplateId(record.id)
    })
  }

  async function handleDuplicate() {
    if (!slot) return
    await runAction('Şablon kopyalandı.', async () => {
      const record = await createLabelDocument({
        fromTemplateId: slot.record.id,
        name: `${slot.record.name} kopyası`,
      })
      setSlots((current) => ({
        ...current,
        [record.id]: {
          record,
          state: createLabelEditorState(record.draft ?? record.active!),
        },
      }))
      setRecords((current) => [...current, record])
      setSelectedTemplateId(record.id)
    })
  }

  async function handleRename(name: string) {
    if (!slot) return
    await runAction('Şablon adı güncellendi.', async () => {
      const record = await renameLabelDocument(
        slot.record.id,
        name,
        slot.record.version,
      )
      setSlots((current) => ({
        ...current,
        [record.id]: { ...(current[record.id] ?? slot), record },
      }))
      setRecords((current) =>
        current.map((item) => (item.id === record.id ? record : item)),
      )
    })
  }

  const dirty = slot ? isDirty(slot.state) : false

  return (
    <div className="label-editor-page" data-testid="label-editor-page">
      <PageHeader
        title="Etiket Şablonu"
        description="10×10 cm etiket yerleşimini gerçek sipariş verisiyle düzenleyin. Kaydetmek yayınlamaz."
      />

      {notice ? (
        <p
          className={`label-editor-notice label-editor-notice-${notice.level}`}
          role={notice.level === 'error' ? 'alert' : 'status'}
          data-testid="label-editor-notice"
        >
          {notice.text}
        </p>
      ) : null}
      {loadError ? (
        <p className="label-editor-notice label-editor-notice-error" role="alert">
          {loadError}
        </p>
      ) : null}

      <nav className="label-editor-tabs" aria-label="Etiket ayarları">
        <button
          type="button"
          data-testid="tab-layout"
          aria-pressed={tab === 'layout'}
          className={tab === 'layout' ? 'is-active' : undefined}
          onClick={() => setTab('layout')}
        >
          Yerleşim düzenleyici (CargoFlow etiketi)
        </button>
        {legacyBandPanel ? (
          <button
            type="button"
            data-testid="tab-band"
            aria-pressed={tab === 'band'}
            className={tab === 'band' ? 'is-active' : undefined}
            onClick={() => setTab('band')}
          >
            Sürat resmî etiket blokları
          </button>
        ) : null}
      </nav>

      {tab === 'band' && legacyBandPanel ? (
        <div data-testid="legacy-band-panel">{legacyBandPanel}</div>
      ) : null}

      <div
        className="label-editor-layout"
        hidden={tab !== 'layout'}
      >
        {/* ═══ SOL: ŞABLON TARAYICISI ═══════════════════════════════════ */}
        <aside className="label-template-browser" aria-label="Şablonlar">
          <section>
            <h3>Sistem şablonları</h3>
            <p className="label-browser-hint">
              Salt okunur. Düzenlemek için kopyalayın.
            </p>
            <ul data-testid="system-template-list">
              {SYSTEM_LABEL_TEMPLATES.map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    className="label-browser-item"
                    data-testid={`system-template-${template.id}`}
                    disabled={busy}
                    onClick={() =>
                      void handleCreateFromSystem(
                        template.id,
                        `${template.name} — özel`,
                      )
                    }
                  >
                    <SystemThumbnail document={template} />
                    <span className="label-browser-name">{template.name}</span>
                    <span className="label-browser-action">
                      <Plus size={14} aria-hidden="true" /> Kopyala
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>Özel şablonlarım</h3>
            {loading ? <p>Yükleniyor…</p> : null}
            {!loading && records.length === 0 ? (
              <p className="label-browser-hint" data-testid="no-custom-templates">
                Henüz özel şablon yok. Yukarıdan bir sistem şablonunu kopyalayın.
              </p>
            ) : null}
            <ul data-testid="custom-template-list">
              {records.map((record) => {
                const localSlot = slots[record.id]
                const localDirty = localSlot ? isDirty(localSlot.state) : false
                const isActive = activeTemplateId === record.id
                return (
                  <li key={record.id}>
                    <button
                      type="button"
                      className={`label-browser-item${
                        selectedTemplateId === record.id ? ' is-selected' : ''
                      }`}
                      data-testid={`custom-template-${record.id}`}
                      aria-pressed={selectedTemplateId === record.id}
                      onClick={() => {
                        setSelectedTemplateId(record.id)
                        setSelectedElementId(undefined)
                      }}
                    >
                      {localSlot ? (
                        <SystemThumbnail document={localSlot.state.present} />
                      ) : null}
                      <span className="label-browser-name">{record.name}</span>
                      <span className="label-browser-badges">
                        {isActive ? (
                          <em
                            className="label-badge label-badge-active"
                            data-testid={`badge-active-${record.id}`}
                          >
                            Yayında
                          </em>
                        ) : null}
                        {localDirty ? (
                          <em
                            className="label-badge label-badge-draft"
                            data-testid={`badge-dirty-${record.id}`}
                          >
                            Kaydedilmedi
                          </em>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        </aside>

        {/* ═══ ORTA: TUVAL ══════════════════════════════════════════════ */}
        <section className="label-editor-stage">
          <div className="label-editor-toolbar">
            <label htmlFor="template-name">
              <span className="sr-only">Şablon adı</span>
              <input
                id="template-name"
                data-testid="template-name-input"
                type="text"
                value={slot?.record.name ?? ''}
                disabled={!slot || busy}
                onChange={(event) => {
                  if (!slot) return
                  setRecords((current) =>
                    current.map((item) =>
                      item.id === slot.record.id
                        ? { ...item, name: event.target.value }
                        : item,
                    ),
                  )
                  setSlots((current) => ({
                    ...current,
                    [slot.record.id]: {
                      ...(current[slot.record.id] ?? slot),
                      record: { ...slot.record, name: event.target.value },
                    },
                  }))
                }}
                onBlur={(event) => void handleRename(event.target.value)}
              />
            </label>

            <button
              type="button"
              data-testid="editor-undo"
              disabled={!slot || !canUndo(slot.state)}
              onClick={() => dispatchEditor({ type: 'undo' })}
            >
              <Undo2 size={14} aria-hidden="true" /> Geri al
            </button>
            <button
              type="button"
              data-testid="editor-redo"
              disabled={!slot || !canRedo(slot.state)}
              onClick={() => dispatchEditor({ type: 'redo' })}
            >
              <Redo2 size={14} aria-hidden="true" /> Yinele
            </button>

            <label htmlFor="editor-zoom">
              <span>Yakınlaştırma</span>
              <select
                id="editor-zoom"
                data-testid="editor-zoom"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              >
                {ZOOM_STEPS.map((step) => (
                  <option key={step} value={step}>
                    %{Math.round(step * 100)}
                  </option>
                ))}
              </select>
            </label>

            <label className="label-editor-toggle" htmlFor="editor-snap">
              <input
                id="editor-snap"
                data-testid="editor-snap"
                type="checkbox"
                checked={snapEnabled}
                onChange={(event) => setSnapEnabled(event.target.checked)}
              />
              <span>Izgaraya yakala</span>
            </label>

            <label htmlFor="editor-preview-mode">
              <span>Önizleme verisi</span>
              <select
                id="editor-preview-mode"
                data-testid="editor-preview-mode"
                value={previewMode}
                onChange={(event) =>
                  setPreviewMode(event.target.value as 'order' | 'stress')
                }
              >
                <option value="order">Gerçek sipariş</option>
                <option value="stress">Uzun adres / çok ürün</option>
              </select>
            </label>

            <button
              type="button"
              data-testid="editor-duplicate"
              disabled={!slot || busy}
              onClick={() => void handleDuplicate()}
            >
              <Copy size={14} aria-hidden="true" /> Kopyala
            </button>
            <button
              type="button"
              data-testid="editor-save-draft"
              disabled={!slot || busy || !validation?.valid}
              onClick={() => void handleSaveDraft()}
            >
              <Save size={14} aria-hidden="true" /> Taslağı kaydet
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="editor-activate"
              disabled={!slot || busy || !validation?.valid}
              onClick={() => void handleActivate()}
            >
              <UploadCloud size={14} aria-hidden="true" /> Yayınla
            </button>
            {dirty ? (
              <span className="label-badge label-badge-draft" data-testid="editor-dirty">
                Kaydedilmemiş değişiklik
              </span>
            ) : null}
          </div>

          <p className="label-editor-source" data-testid="editor-preview-source">
            {preview.isDemo
              ? 'DEMO VERİ — kalıcı sipariş bulunamadı. Yerleşim gerçek veriyle doğrulanmadı.'
              : `Gerçek sipariş: ${preview.orderNumber}`}
          </p>

          {document && rendered ? (
            <LabelCanvas
              document={document}
              primitives={rendered.primitives}
              zoom={zoom}
              selectedId={selectedElementId}
              snapEnabled={snapEnabled}
              onSelect={setSelectedElementId}
              onGestureStart={() => dispatchEditor({ type: 'beginGesture' })}
              onGestureEnd={() => dispatchEditor({ type: 'endGesture' })}
              onElementChange={handleElementChange}
            />
          ) : (
            <p className="label-editor-empty" data-testid="editor-no-template">
              Düzenlemek için soldan bir şablon seçin veya bir sistem şablonunu
              kopyalayın.
            </p>
          )}

          <section className="label-editor-guards" aria-live="polite">
            <h4>Baskı kontrolleri</h4>
            {rendered && rendered.violations.length === 0 && validation?.valid ? (
              <p data-testid="guards-clean">
                Tüm kontroller geçti. Bu yerleşim basılabilir.
              </p>
            ) : null}
            <ul data-testid="guard-violations">
              {validation?.errors.map((error, index) => (
                <li key={`v-${index}`} data-code={error.code}>
                  {labelElementLabel(String(error.type ?? ''))} — {error.detail}
                </li>
              ))}
              {rendered?.violations.map((violation, index) => (
                <li key={`g-${index}`} data-code={violation.code}>
                  {violation.code}: {violation.detail}
                </li>
              ))}
            </ul>
          </section>
        </section>

        {/* ═══ SAĞ: ÖZELLİKLER ══════════════════════════════════════════ */}
        <LabelElementInspector
          element={selectedElement}
          onChange={(patch) => {
            if (!selectedElementId) return
            handleElementChange(selectedElementId, patch)
          }}
        />
      </div>
    </div>
  )
}

/** Küçük, ölçekli önizleme — şablon tarayıcısında kullanılabilir küçük resim. */
function SystemThumbnail({ document }: { document: LabelDocument }) {
  return (
    <span className="label-thumbnail" aria-hidden="true">
      {document.elements
        .filter((element) => element.visible !== false)
        .map((element) => (
          <span
            key={element.id}
            className={`label-thumbnail-block label-thumbnail-${element.type}`}
            style={{
              left: `${element.x}%`,
              top: `${element.y}%`,
              width: `${element.width}%`,
              height: `${element.height}%`,
            }}
          />
        ))}
    </span>
  )
}
