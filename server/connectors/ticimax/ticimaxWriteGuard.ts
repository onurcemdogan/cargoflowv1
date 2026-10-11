// TICIMAX YAZMA DENYLIST — WAVE-1'DE HİÇBİR YAZMA AÇILMAZ.
//
// Kaynak: providers/ticimax/contracts/siparisservis-v1.json WRITE_OPERATIONS
// (verified:true). Statü / takip / fatura / entegrasyon işaretleme yazmaları
// AYRI bilette yetkilendirilir; bu iskelette hepsi engellenir.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packPath = join(here, '..', '..', '..', 'providers', 'ticimax', 'contracts', 'siparisservis-v1.json')

function loadWriteOperations(): readonly string[] {
  const pack = JSON.parse(readFileSync(packPath, 'utf8')) as {
    WRITE_OPERATIONS?: { documented?: string[] }
  }
  const documented = pack.WRITE_OPERATIONS?.documented
  if (!Array.isArray(documented) || documented.length === 0) {
    throw new Error('Ticimax WRITE_OPERATIONS.documented sözleşme paketinden okunamadı.')
  }
  return Object.freeze([...documented])
}

/** Sözleşme paketindeki yazma metotları — denylist. */
export const TICIMAX_WRITE_OPERATIONS: readonly string[] = loadWriteOperations()

const WRITE_SET = new Set(
  TICIMAX_WRITE_OPERATIONS.map((name) => String(name).trim().toLowerCase()),
)

export function isTicimaxWriteMethod(methodName: unknown): boolean {
  const name = String(methodName ?? '').trim().toLowerCase()
  if (name === '') return false
  return WRITE_SET.has(name)
}

export class TicimaxWriteDeniedError extends Error {
  readonly code = 'TICIMAX_WRITE_DENIED'
  readonly method: string
  constructor(method: string) {
    super(`Ticimax yazma metodu engellendi: ${method}`)
    this.method = method
    this.name = 'TicimaxWriteDeniedError'
  }
}

/** Yazma metodu çağrılmak istenirse FAIL-CLOSED. */
export function assertTicimaxWriteDenied(methodName: unknown): void {
  if (isTicimaxWriteMethod(methodName)) {
    throw new TicimaxWriteDeniedError(String(methodName).trim())
  }
}
