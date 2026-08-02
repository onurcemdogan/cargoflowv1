// CLI: Sürat resmî ZPL teşhisi — SALT OKUNUR.
//
// Production'da YENİ GÖNDERİ OLUŞTURMAZ, Sürat API'sini ÇAĞIRMAZ, DB'ye
// YAZMAZ. Yalnız hâlihazırda persist edilmiş shipments.carrier_payload ve
// shipment_operations.response_payload kayıtlarını okur ve sınıflandırır.
//
// Çıktı YALNIZ aggregate'tir: ham ZPL, adres, telefon, müşteri adı, açık
// sipariş/takip numarası veya credential BASILMAZ. Kayıt düzeyinde dışarı
// çıkan tek bilgi SHA-256'nın ilk 12 karakteri + sınıf adıdır.
//
//   npm run surat:zpl:diagnose -- \
//     --organization-id <org-uuid> \
//     --provider-account-id 277221 \
//     --limit 200 \
//     --dry-run
//
// --dry-run bayrağı kabul edilir ve varsayılandır; bu komutun YAZAN bir modu
// YOKTUR. --apply verilirse bilinçli olarak reddedilir.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  decideSuratZplReadiness,
  summarizeSuratZplDiagnostic,
} from './suratZplDiagnostic.ts'
import { loadSuratLabelArtifacts } from './suratZplDiagnosticLoader.ts'

const TAG = '[surat:zpl:diagnose]'
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 2000

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

async function main(): Promise<number> {
  if (hasFlag('apply')) {
    console.error(`${TAG} Bu komut SALT OKUNUR'dur; --apply desteklenmez.`)
    return 1
  }
  if (!isDatabaseConfigured()) {
    console.error(`${TAG} DATABASE_URL tanımlı değil.`)
    return 1
  }
  const organizationId = parseArg('organization-id')
  if (!organizationId) {
    console.error(`${TAG} --organization-id zorunlu.`)
    return 1
  }

  // --provider verilmezse BİLİNEN TÜM Sürat kimlikleri taranır. Verilse bile
  // alias'lar eklenir; yanlış isim yüzünden "0 kayıt" raporlanmasın.
  const providerArg = parseArg('provider')
  const scope = {
    organizationId,
    marketplace: parseArg('marketplace') ?? 'Trendyol',
    providers: providerArg ? [providerArg] : undefined,
    providerAccountId: parseArg('provider-account-id'),
    limit: Math.min(
      MAX_LIMIT,
      Math.max(1, Number(parseArg('limit')) || DEFAULT_LIMIT),
    ),
  }

  const loaded = await loadSuratLabelArtifacts(getDb(), scope)
  if (!loaded.accountResolved) {
    console.error(`${TAG} Hesap bulunamadı (org/marketplace kapsamında).`)
    return 1
  }

  const report = summarizeSuratZplDiagnostic(loaded.artifacts)
  const decision = decideSuratZplReadiness(report)

  console.info(`${TAG} SALT OKUNUR tarama tamamlandı (DB değişmedi).`)
  console.info(
    `${TAG} Taranan provider kimlikleri: ${loaded.providersScanned.join(', ')}`,
  )
  console.info(JSON.stringify(report, null, 2))
  if (loaded.scopedPackageCount === 0) {
    console.info(`${TAG} Bu hesapta sipariş yok; taranacak kayıt bulunamadı.`)
  }
  if (loaded.undecryptableCount > 0) {
    console.info(
      `${TAG} Çözülemeyen payload sayısı: ${loaded.undecryptableCount} ` +
        '(SHIPMENT_ENCRYPTION_KEY rotasyonu olabilir; tarama dışı bırakıldı).',
    )
  }
  console.info(`${TAG} KARAR [${decision.decision}]: ${decision.message}`)
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  // Hata metni payload/PII sızdırmasın diye YALNIZ mesaj basılır.
  console.error(
    `${TAG} Hata:`,
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
