// ARAS taşıyıcı kimliği — Sürat'tan bağımsız, paylaşılan registry ile hizalı.

export const ARAS_PERSISTENCE_PROVIDER = 'aras'
export const ARAS_MARKETPLACE_KEY = 'aras'

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('tr-TR')
}

export function isArasCargoProviderName(value: unknown = ''): boolean {
  const normalized = normalizeSearchText(value)
  const compact = normalized.replace(/[^a-z0-9]/g, '')
  return compact.includes('aras')
}

export function isExplicitArasCargoAssignment(value: unknown): boolean {
  const name = String(value ?? '').trim()
  if (!name) return false
  return isArasCargoProviderName(name)
}
