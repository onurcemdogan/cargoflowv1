// CLI: ürün satırı eklenememiş (source_only) kayıtlı printZpl artefaktlarını
// org kapsamlı onarır. VARSAYILAN DRY-RUN — DB'ye YAZMAZ.
//
// DRY-RUN AYNI ZAMANDA TEŞHİSTİR: her gönderi için augmentation'ın hangi
// sebeple düştüğünü (no_items / unsupported_template / footer_overflow)
// gösterir.
//
//   npm run surat:print-zpl:repair -- --organization-id <org>
//   npm run surat:print-zpl:repair -- --organization-id <org> --package-id 4056494300
//   npm run surat:print-zpl:repair -- --organization-id <org> --apply \
//     --confirmation-token <DRY-RUN'DAN GELEN TOKEN>
//
// GÜVENLİK: provider/marketplace çağrısı YOK, technicalZpl YAZILMAZ,
// labelStatus/printCount DEĞİŞMEZ, migration YOK. Çıktı ham ZPL veya müşteri
// verisi TAŞIMAZ.
//
// DİKKAT: onarılan gönderide tekrar baskı artık eski byte'larla AYNI DEĞİLDİR
// (ürün satırı eklenir). Bu bilinçli ve opt-in bir davranıştır.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  buildConfirmationToken,
  repairSourceOnlyPrintZpl,
  type RepairScope,
} from './repairPrintZpl.ts'

const TAG = '[surat:print-zpl:repair]'

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return undefined
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function manifestDir(): string {
  return String(process.env.ORDER_BACKFILL_MANIFEST_DIR ?? process.cwd())
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error(`${TAG} DATABASE_URL tanımlı değil.`)
    return 1
  }
  const organizationId = parseArg('organization-id')
  if (!organizationId) {
    console.error(`${TAG} --organization-id zorunlu (org kapsamı ŞART).`)
    return 1
  }
  const limitRaw = parseArg('limit')
  const scope: RepairScope = {
    organizationId,
    marketplace: parseArg('marketplace') ?? 'Trendyol',
    ...(parseArg('package-id') ? { packageId: parseArg('package-id') } : {}),
    ...(limitRaw && Number.isFinite(Number(limitRaw))
      ? { limit: Math.max(1, Math.trunc(Number(limitRaw))) }
      : {}),
  }
  const db = getDb()

  if (!hasFlag('apply')) {
    const report = await repairSourceOnlyPrintZpl(db, scope, { apply: false })
    console.info(`${TAG} DRY-RUN (DB DEĞİŞMEDİ):`)
    console.info(JSON.stringify(report, null, 2))
    if (report.candidates === 0) {
      console.info(`${TAG} Onarılacak source_only artefakt bulunamadı.`)
      return 0
    }
    console.info(
      `${TAG} Apply için: --apply --confirmation-token ${report.confirmationToken}`,
    )
    return 0
  }

  const confirmationToken = parseArg('confirmation-token')
  if (!confirmationToken) {
    console.error(`${TAG} --apply için --confirmation-token zorunlu.`)
    return 1
  }
  // Jeton, apply anındaki aday kümesiyle YENİDEN hesaplanır: küme değiştiyse
  // (araya yeni gönderi girdiyse) komut çalışmaz.
  const plan = await repairSourceOnlyPrintZpl(db, scope, { apply: false })
  const expected = buildConfirmationToken(
    organizationId,
    plan.entries
      .filter((entry) => entry.outcome !== 'already_augmented')
      .filter((entry) => entry.outcome !== 'no_persisted_artifact')
      .filter((entry) => entry.outcome !== 'no_source_zpl')
      .filter((entry) => entry.outcome !== 'source_hash_mismatch')
      .map((entry) => entry.packageId),
  )
  if (confirmationToken !== expected) {
    console.error(
      `${TAG} Onay jetonu eşleşmedi (aday kümesi değişmiş olabilir). ` +
        `Dry-run'ı tekrar çalıştırın.`,
    )
    return 1
  }

  const batchId = randomUUID()
  const appliedAt = new Date().toISOString()
  const report = await repairSourceOnlyPrintZpl(db, scope, {
    apply: true,
    confirmationToken,
    batchId,
    now: appliedAt,
  })
  try {
    mkdirSync(manifestDir(), { recursive: true })
  } catch {
    // dizin zaten olabilir
  }
  const manifestPath = join(manifestDir(), `surat-print-zpl-repair-${batchId}.json`)
  writeFileSync(manifestPath, JSON.stringify(report, null, 2), 'utf8')
  console.info(`${TAG} APPLY tamamlandı. Manifest:`, manifestPath)
  console.info(JSON.stringify(report, null, 2))
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    `${TAG} Hata:`,
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
