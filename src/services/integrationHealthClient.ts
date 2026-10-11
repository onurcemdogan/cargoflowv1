// ENTEGRASYON SAĞLIĞI İSTEMCİSİ — yalnız saklanmış durumu okur.
//
// Uç (`/api/integrations/health`) sağlayıcıya ÇAĞRI YAPMAZ; senkron geçmişi,
// yapılandırılmış hesaplar ve kimlik VARLIĞINDAN türetilmiş kararlı durum
// kodları döner. Sunumu `presentIntegrationHealth` yapar.
import type { IntegrationHealthViewModel } from '../integrations/integrationHealthView'

export class IntegrationHealthUnavailableError extends Error {}

export async function fetchIntegrationHealth(): Promise<IntegrationHealthViewModel[]> {
  let response: Response
  try {
    response = await fetch('/api/integrations/health', { credentials: 'include' })
  } catch {
    throw new IntegrationHealthUnavailableError('Bağlantı durumu alınamadı.')
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    integrations?: IntegrationHealthViewModel[]
  } | null
  if (!response.ok || !payload?.ok) {
    throw new IntegrationHealthUnavailableError('Bağlantı durumu alınamadı.')
  }
  return Array.isArray(payload.integrations) ? payload.integrations : []
}
