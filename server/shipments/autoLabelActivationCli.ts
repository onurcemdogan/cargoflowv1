// OTOMATİK ETİKET AKTİVASYONU — KOMUT SATIRI.
//
//   npm run auto-label:activation:inspect -- --name TarzimTuba
//   npm run auto-label:activation:enable  -- --name TarzimTuba
//   npm run auto-label:activation:enable-background-picking -- --name TarzimTuba
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
// `settings_json.autoLabel` üretimde OKUNUYORDU ama depoda onu YAZAN tek
// yol `activateAutoLabel` fonksiyonuydu ve o fonksiyonun üretim çağıranı
// YOKTU: ne API ucu, ne komut, ne arayüz. Yani "otomatik etiketi aç"
// eylemi elle SQL'e mahkûmdu ve bir operatör onu güvenle doğrulayamıyordu.
//
// Aktivasyon damgası (`activatedAt`) bu alt sistemin EN KRİTİK güvenlik
// mekanizmasıdır; elle SQL ile yazılan bir damga sessizce yanlış olabilir.
// Bu araç damgayı KODUN kendisine yazdırır ve önce SALT-OKUNUR gösterir.
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
//   • Organizasyon AÇIKÇA verilmelidir; varsayılan YOKTUR.
//   • Uygulama açılışına BAĞLI DEĞİLDİR; asla kendiliğinden çalışmaz.
//   • `inspect` hiçbir satır yazmaz, hiçbir ağ çağrısı yapmaz.
//   • Açma komutları YALNIZ kiracı ayarını yazar: Trendyol'a ÇAĞRI YOK,
//     Sürat'e ÇAĞRI YOK, iş satırı YOK.
//   • Damga DAİMA `now`dur; geçmişe çekilemez. Geçmiş yığın bu yüzden
//     otomatik olarak Picking'e alınmaz.
import process from 'node:process'

import { loadRepositoryEnv } from '../runtime/localEnv.ts'

loadRepositoryEnv()

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

function fail(message: string): never {
  console.error(`[auto-label] ${message}`)
  process.exit(1)
}

const mode = process.argv.includes('--enable-background-picking')
  ? 'enable-background-picking'
  : process.argv.includes('--enable')
    ? 'enable'
    : 'inspect'
const name = readFlag('name')
if (!name) fail('Organizasyon ZORUNLU: --name "TarzimTuba"')

const [{ getDb }, catchup, producer, policy] = await Promise.all([
  import('../db/client.ts'),
  import('./autoLabelCatchup.ts'),
  import('./autoLabelProducer.ts'),
  import('./suratAutoLabelPolicy.ts'),
])
const db = getDb()
const org = await catchup.resolveOrganizationByName(db, name)
if (!org) fail(`Organizasyon bulunamadi: ${name}`)

async function printState(): Promise<void> {
  const settings = await producer.loadAutoLabelSettings(db, org!.id)
  const autoBoundary = policy.resolveActivationBoundary(settings)
  const pickingBoundary = policy.resolveBackgroundPickingBoundary(settings)
  const iso = (value: number | null) =>
    value === null ? 'YOK' : new Date(value).toISOString()
  console.log('')
  console.log(`ORGANIZATION                  ${org!.name} (${org!.id})`)
  console.log(`AUTO_LABEL_ENABLED            ${settings?.enabled === true ? 'YES' : 'NO'}`)
  console.log(`AUTO_LABEL_MARKETPLACES       ${(settings?.marketplaces ?? []).join(',') || '(hepsi)'}`)
  console.log(`AUTO_LABEL_CARRIERS           ${(settings?.carriers ?? []).join(',') || '(hepsi)'}`)
  console.log(`AUTO_LABEL_ACTIVATED_AT       ${settings?.activatedAt ?? 'YOK'}`)
  console.log(`AUTO_LABEL_BOUNDARY           ${iso(autoBoundary)}`)
  console.log(`BACKGROUND_PICKING_ENABLED    ${settings?.backgroundPicking?.enabled === true ? 'YES' : 'NO'}`)
  console.log(`BACKGROUND_PICKING_ACTIVATED  ${settings?.backgroundPicking?.activatedAt ?? 'YOK'}`)
  console.log(`BACKGROUND_PICKING_BOUNDARY   ${iso(pickingBoundary)}`)
  if (autoBoundary !== null) {
    const candidates = await producer.countAutoLabelCandidates(
      db, org!.id, autoBoundary,
    )
    console.log(`CANDIDATES_AFTER_BOUNDARY     ${candidates}`)
  }
  console.log('')
  console.log('AÇIKLAMA')
  console.log('  BOUNDARY = YOK  → üretici HİÇBİR paket taramaz (fail-safe).')
  console.log('  BACKGROUND_PICKING kapalıyken `Created` paketler sıraya')
  console.log('  ALINMAZ; davranış bugünküyle aynıdır.')
}

if (mode === 'inspect') {
  await printState()
  console.log('')
  console.log('SALT-OKUNUR inceleme. Hicbir satir yazilmadi.')
  process.exit(0)
}

// ═══ SALT-OKUNUR ÖNCE ══════════════════════════════════════════════════
// Operatör neyi değiştirdiğini ÖNCE ve SONRA görür.
console.log('ÖNCE:')
await printState()

const now = new Date().toISOString()
if (mode === 'enable') {
  const marketplaces = (readFlag('marketplaces') ?? 'trendyol')
    .split(',').map((value) => value.trim()).filter(Boolean)
  const carriers = (readFlag('carriers') ?? 'surat')
    .split(',').map((value) => value.trim()).filter(Boolean)
  await producer.activateAutoLabel(db, org.id, { marketplaces, carriers, now })
  console.log('')
  console.log(`Otomatik etiket ACILDI. Aktivasyon siniri: ${now}`)
  console.log('Bu sinirdan ONCE gorulmus paketler otomatik etiketlenmez.')
} else {
  await producer.activateBackgroundPicking(db, org.id, { now })
  console.log('')
  console.log(`Arka plan Created→Picking ACILDI. Kendi siniri: ${now}`)
  console.log('Bu sinirdan ONCE gorulmus `Created` paketler DOKUNULMAZ;')
  console.log('onlar icin karar operatorundur (yakalama ayri bir komuttur).')
}

console.log('')
console.log('SONRA:')
await printState()
console.log('')
console.log('CARRIER_CALLS=0')
console.log('MARKETPLACE_CALLS=0')
process.exit(0)
