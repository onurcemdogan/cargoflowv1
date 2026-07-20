// Uygulama servis singleton'ları. App ve Onboarding ekranı AYNI örnekleri
// paylaşır; böylece auth modu bayrağı, katalog memory cache ve entegrasyon
// durumu iki ekran arasında tutarlı kalır (ikinci bir servis örneği YARATILMAZ).
import { IntegrationConfigService } from './integrationConfigService'
import { AuditLogService } from './auditLogService'
import { OrderWorkflowService } from './orderWorkflowService'
import { TrendyolProvider } from '../providers/marketplace/TrendyolProvider'
import { SuratKargoProvider } from '../providers/shipping/SuratKargoProvider'
import { ZebraZplLabelProvider } from '../providers/labels/ZebraZplLabelProvider'
import { BrowserDownloadPrintProvider } from '../providers/printing/BrowserDownloadPrintProvider'

export const integrationConfigService = new IntegrationConfigService()
export const auditLogService = new AuditLogService()
export const workflowService = new OrderWorkflowService(
  new TrendyolProvider(),
  new SuratKargoProvider(),
  new ZebraZplLabelProvider(),
  new BrowserDownloadPrintProvider(),
  auditLogService,
)
