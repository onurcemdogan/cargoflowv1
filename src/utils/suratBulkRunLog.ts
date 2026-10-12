// Toplu "Kargo Etiketi Oluştur ve Yazdır" çalışmasının GÜVENLİ özeti.
//
// YALNIZ sayılar ve süreler: sipariş numarası, müşteri bilgisi, ZPL veya
// kimlik bilgisi YOKTUR. Production'da da yazılır; yavaşlığın Sürat mi
// (createMs), kayıtlı etiket araması mı (lookupMs/hydrateMs) yoksa render/
// baskı mı (printMs) olduğu buradan ölçülür.
import type { OrchestratorRunSummary } from '../services/suratCreateAndPrintOrchestrator'

export function formatSuratBulkRunSummary(summary: OrchestratorRunSummary): string {
  const keys: Array<keyof OrchestratorRunSummary> = [
    'selected', 'blocked', 'inFlight', 'labelLookup', 'needsCreate', 'ready', 'reprint',
    'createSuccess', 'createFail', 'createSkipped', 'createCalls', 'printSuccess', 'printFail',
    'durationMs', 'preflightMs', 'lookupMs', 'createMs', 'hydrateMs', 'printMs',
  ]
  return keys.map((key) => `${key}=${Math.round(Number(summary[key]) || 0)}`).join(' ')
}

export function logSuratBulkRunSummary(summary: OrchestratorRunSummary): void {
  try {
    console.info(`[surat-bulk] ${formatSuratBulkRunSummary(summary)}`)
  } catch {
    // console erişilemiyorsa akışı bozma
  }
}
