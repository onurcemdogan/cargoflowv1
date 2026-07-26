/**
 * Tenant credential injection places the full integration config under
 * request.body.config, while legacy callers send only the Sürat config.
 * Keep both request shapes supported so production auth mode and local mode
 * use the same handlers safely.
 */
export function extractSuratConfigCandidate(body = {}) {
  const config = body && typeof body === 'object' ? body.config : undefined
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const nested = config.surat
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested
  }
  return config
}

/**
 * CariKoduveSifre uses the e-Sürat WebPassword. Older CargoFlow setups used
 * the single "Şifre" field for the same value, so preserve that compatible
 * fallback for the connection test only. Shipment operations keep their own
 * stricter credential validation.
 */
export function resolveSuratConnectionTestPassword(config = {}) {
  const candidates = [
    config.webPassword,
    config.webSifre,
    config.sorguSifresi,
    config.suratWebPassword,
    config.sifre,
    config.password,
  ]
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) return value
  }
  return ''
}
