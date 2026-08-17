// FATURALAMA KANITI TARAYICISI (CLI) — SALT OKUNUR, AĞSIZ.
//
// Kullanım:
//   npm run surat:billing:scan -- --name MonalisaToka
//   npm run surat:billing:scan -- --org <organizationId> --limit 100
//   npm run surat:billing:scan -- --name MonalisaToka --shipments --limit 1000
//   npm run surat:billing:scan -- --name MonalisaToka --unknown-reasons --limit 1000
//
// AĞ ÇAĞRISI YAPMAZ: bu komutta `--get-cargo` gibi bir anahtar YOKTUR.
// Vendor sorgusu yalnız `surat:billing:inspect --get-cargo` ile mümkündür.
//
// Yeni migration'lara (0008/0009) BAĞIMLI DEĞİLDİR; bugünkü üretim şemasıyla
// çalışır. DB yazma 0 · migration 0 · PII çıktısı 0.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { loadOrganizationIntegrationConfig } from '../integrations/credentialService.ts'
import {
  formatScanReport,
  maskIdentifier,
  resolveOrganizationByName,
  scanTenantBillingCandidates,
} from './suratBillingScanner.ts'
import {
  discoverSuratShipmentBillingEvidence,
  formatShipmentDiscoveryReport,
} from './suratShipmentBillingDiscovery.ts'
import {
  analyzeSuratCreateEvidence,
  formatCreateEvidenceReport,
} from './suratCreateEvidenceForensics.ts'

function readArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

export async function runSuratBillingScan(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[surat:billing:scan] DATABASE_URL tanımlı değil.')
    return 1
  }
  const db = getDb()
  const name = readArg('name')
  const orgId = readArg('org')
  if (!name && !orgId) {
    console.error('[surat:billing:scan] --name veya --org ZORUNLU.')
    return 1
  }

  let organization = { id: orgId, name: orgId, slug: '' }
  if (name) {
    const resolved = await resolveOrganizationByName(db, name)
    if (resolved.status === 'not_found') {
      console.error(`[surat:billing:scan] "${name}" için tenant bulunamadı.`)
      return 1
    }
    if (resolved.status === 'ambiguous') {
      // FAIL-CLOSED: yanlış tenant'ta teşhis yanlış sonuç üretir.
      console.error('[surat:billing:scan] BİRDEN FAZLA eşleşme — tahmin YOK:')
      for (const candidate of resolved.candidates) {
        console.error(`  ${maskIdentifier(candidate.id)}  ${candidate.name}`)
      }
      return 1
    }
    organization = resolved.organization
  }

  // GÖNDERİ-ÖNCELİKLİ KEŞİF: sipariş-öncelikli tarama en yeni siparişleri
  // alır ve bunlar henüz kargoya verilmemiş olabilir. Gerçek `whoPays`
  // doğrulama evreni, taşıyıcı kaydı GERÇEKTEN oluşmuş gönderilerdir.
  // UNKNOWN KÖK NEDEN FORENSİĞİ: "300 gönderi UNKNOWN" sonucunun NEDENİNİ
  // sayarak kanıtlar. "Create yapılmadı" ile "sınıflandıramıyorum" AYRIDIR.
  if (process.argv.includes('--unknown-reasons')) {
    const forensics = await analyzeSuratCreateEvidence(db, organization, {
      limit: Number(readArg('limit')) || undefined,
    })
    for (const line of formatCreateEvidenceReport(forensics)) console.info(line)
    return 0
  }

  if (process.argv.includes('--shipments')) {
    const discovery = await discoverSuratShipmentBillingEvidence(db, organization, {
      limit: Number(readArg('limit')) || undefined,
    })
    for (const line of formatShipmentDiscoveryReport(discovery)) console.info(line)
    return 0
  }

  // Tenant Sürat yapılandırması TEK kez okunur (sipariş başına DEĞİL).
  let suratConfig: Record<string, unknown>
  try {
    // Tip sınırı: repo genelinde kullanılan gevşetme (bkz. diğer CLI'lar).
    const config = await loadOrganizationIntegrationConfig(
      db as never,
      organization.id,
    )
    suratConfig = ((config as Record<string, unknown>)?.surat ?? {}) as Record<
      string,
      unknown
    >
  } catch {
    suratConfig = {}
  }

  const result = await scanTenantBillingCandidates(db, organization, {
    limit: Number(readArg('limit')) || undefined,
    suratConfig,
  })
  for (const line of formatScanReport(result, organization.name)) {
    console.info(line)
  }
  return 0
}

const invokedDirectly = process.argv[1]?.includes('suratBillingScanCli')
if (invokedDirectly) {
  runSuratBillingScan()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(
        '[surat:billing:scan] Tarama başarısız:',
        error instanceof Error ? error.message : error,
      )
      process.exitCode = 2
    })
    .finally(() => closePool().catch(() => undefined))
}
