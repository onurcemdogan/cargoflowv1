import type { LabelPreviewOverrides } from '../types/cargoflow'
import { loadFromStorage, saveToStorage } from './storage'

const LABEL_PREVIEW_DRAFTS_KEY = 'cargoflow.labelPreviewDrafts'

export type LabelPreviewDraftMap = Record<string, LabelPreviewOverrides>

export function loadLabelPreviewDrafts(): LabelPreviewDraftMap {
  return loadFromStorage<LabelPreviewDraftMap>(LABEL_PREVIEW_DRAFTS_KEY, {})
}

export function saveLabelPreviewDrafts(
  drafts: LabelPreviewDraftMap,
): LabelPreviewDraftMap {
  saveToStorage(LABEL_PREVIEW_DRAFTS_KEY, drafts)
  return drafts
}
