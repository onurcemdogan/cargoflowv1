// DÜZENLEYİCİ DURUMU — GERİ AL / YİNELE, JESTLERİ BİRLEŞTİREREK.
//
// ═══ NEDEN PİKSEL BAŞINA GEÇMİŞ KAYDI YOK ════════════════════════════════
// Sürükleme sırasında her `pointermove` bir geçmiş adımı üretseydi, tek bir
// sürükleme yüzlerce adım biriktirir ve "Geri Al" kullanıcı için ANLAMSIZ
// hale gelirdi (bir tuşa 200 kez basmak gerekirdi).
//
// Bu yüzden jest MODELİ vardır: `beginGesture()` jest ÖNCESİ durumu
// çıpalar, ara güncellemeler geçmişe YAZMAZ, `endGesture()` jesti TEK bir
// anlamlı adım olarak kaydeder. Ayrık değişiklikler (punto, kalın, hizalama,
// görünürlük) doğrudan tek adım olur.
//
// SAF: React'a bağlı değildir; ağ/DOM yoktur ve testte doğrudan çalıştırılır.

import type { LabelDocument, LabelElement } from './labelDocument.ts'

export interface LabelEditorState {
  past: LabelDocument[]
  present: LabelDocument
  future: LabelDocument[]
  /** Jest sürüyorsa jest ÖNCESİ belge; yoksa null. */
  gestureAnchor: LabelDocument | null
  /** Son kaydedilen (sunucudaki) belge — kirli durum bundan türetilir. */
  savedBaseline: LabelDocument
}

export type LabelEditorAction =
  | { type: 'replace'; document: LabelDocument; resetHistory?: boolean }
  | { type: 'beginGesture' }
  | { type: 'updateElement'; elementId: string; patch: Partial<LabelElement> }
  | { type: 'endGesture' }
  | { type: 'commit'; document: LabelDocument }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'markSaved' }

/** Geçmişte tutulacak EN FAZLA adım — sınırsız büyüme YOK. */
export const MAX_HISTORY = 100

export function createLabelEditorState(
  document: LabelDocument,
): LabelEditorState {
  return {
    past: [],
    present: document,
    future: [],
    gestureAnchor: null,
    savedBaseline: document,
  }
}

function withElement(
  document: LabelDocument,
  elementId: string,
  patch: Partial<LabelElement>,
): LabelDocument {
  return {
    ...document,
    elements: document.elements.map((element) =>
      element.id === elementId ? { ...element, ...patch } : element,
    ),
  }
}

function pushPast(state: LabelEditorState, snapshot: LabelDocument): LabelDocument[] {
  const next = [...state.past, snapshot]
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
}

export function labelEditorReducer(
  state: LabelEditorState,
  action: LabelEditorAction,
): LabelEditorState {
  switch (action.type) {
    case 'replace':
      // Şablon değiştirildi/yeniden yüklendi: geçmiş bu belgeye SIFIRLANIR.
      // Farklı şablonların adımlarını tek geçmişte karıştırmak, "Geri Al"ı
      // beklenmedik biçimde başka bir şablona döndürürdü.
      return action.resetHistory === false
        ? { ...state, present: action.document }
        : createLabelEditorState(action.document)

    case 'beginGesture':
      // Zaten bir jest sürüyorsa çıpa DEĞİŞMEZ (iç içe pointer olayları).
      return state.gestureAnchor
        ? state
        : { ...state, gestureAnchor: state.present }

    case 'updateElement': {
      const next = withElement(state.present, action.elementId, action.patch)
      if (state.gestureAnchor) {
        // Jest içi: geçmişe YAZMA, yalnız şimdiki durumu güncelle.
        return { ...state, present: next, future: [] }
      }
      // Ayrık değişiklik: TEK adım.
      return {
        ...state,
        past: pushPast(state, state.present),
        present: next,
        future: [],
      }
    }

    case 'endGesture': {
      if (!state.gestureAnchor) return state
      const anchor = state.gestureAnchor
      // Jest hiçbir şey değiştirmediyse (tıklayıp bırakma) adım ÜRETİLMEZ.
      if (documentsEqual(anchor, state.present)) {
        return { ...state, gestureAnchor: null }
      }
      return {
        ...state,
        past: pushPast(state, anchor),
        gestureAnchor: null,
        future: [],
      }
    }

    case 'commit':
      return {
        ...state,
        past: pushPast(state, state.present),
        present: action.document,
        future: [],
        gestureAnchor: null,
      }

    case 'undo': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return {
        ...state,
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        gestureAnchor: null,
      }
    }

    case 'redo': {
      if (state.future.length === 0) return state
      const [next, ...rest] = state.future
      return {
        ...state,
        past: pushPast(state, state.present),
        present: next,
        future: rest,
        gestureAnchor: null,
      }
    }

    case 'markSaved':
      return { ...state, savedBaseline: state.present }

    default:
      return state
  }
}

export function canUndo(state: LabelEditorState): boolean {
  return state.past.length > 0
}

export function canRedo(state: LabelEditorState): boolean {
  return state.future.length > 0
}

/** Kaydedilmemiş değişiklik var mı? Sayfadan ayrılma uyarısı buna dayanır. */
export function isDirty(state: LabelEditorState): boolean {
  return !documentsEqual(state.savedBaseline, state.present)
}

export function documentsEqual(
  left: LabelDocument,
  right: LabelDocument,
): boolean {
  if (left === right) return true
  if (left.id !== right.id || left.name !== right.name) return false
  if (left.elements.length !== right.elements.length) return false
  for (let index = 0; index < left.elements.length; index += 1) {
    const a = left.elements[index]
    const b = right.elements[index]
    if (
      a.id !== b.id ||
      a.type !== b.type ||
      a.x !== b.x ||
      a.y !== b.y ||
      a.width !== b.width ||
      a.height !== b.height ||
      a.visible !== b.visible ||
      a.z !== b.z ||
      a.fontSize !== b.fontSize ||
      a.bold !== b.bold ||
      a.align !== b.align ||
      a.lineHeight !== b.lineHeight ||
      a.wrap !== b.wrap ||
      a.maxLines !== b.maxLines ||
      a.text !== b.text ||
      a.showHumanReadable !== b.showHumanReadable
    ) {
      return false
    }
  }
  return true
}
