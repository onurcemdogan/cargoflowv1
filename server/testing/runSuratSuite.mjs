// SÜRAT TEST PAKETİ ÇALIŞTIRICISI.
//
// ═══ NEDEN BİR ÇALIŞTIRICI ═══════════════════════════════════════════════
// Dosya listesi `package.json` içinde TEK SATIR halinde duruyordu ve 190
// dosyaya ulaşınca komut satırı 8207 karaktere çıktı. npm betikleri
// Windows'ta cmd.exe üzerinden çalışır ve cmd.exe'nin sınırı 8191'dir;
// paket "The command line is too long." ile ÇALIŞMADAN düşüyordu.
//
// Liste `suratSuiteFiles.json` dosyasına taşındı ve buradan `spawn` ile
// ARGÜMAN DİZİSİ olarak verilir — cmd.exe'nin dize sınırına takılmaz.
//
// ═══ NEDEN PARTİLİ ═══════════════════════════════════════════════════════
// Paketin çoğu dosyası kendi PGlite (WASM Postgres) örneğini kurar. 190
// dosya TEK süreçte koşturulduğunda V8 ölümcül hatayla düşüyordu:
//
//   V8_Fatal ... WasmStreaming::Unpack ...
//
// Bu bir test hatası DEĞİL, birikmiş WASM belleğidir — düşen dosya tek
// başına çalıştırıldığında 9/9 geçer. Parti başına AYRI süreç, belleği
// işletim sistemine geri verir ve paket deterministik olur.
//
// AÇIK KAYIT KORUNUR: dosyalar hâlâ tek tek listelenir. Glob'a geçmek
// "yeni test dosyası pakete KAYITLI mı?" muhafızlarını anlamsız kılardı;
// kayıt bilinçli bir adım olarak kalır.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const listPath = join(here, 'suratSuiteFiles.json')

/** Parti boyutu — bellek birikimini sınırlar. */
const BATCH_SIZE = Number(process.env.SURAT_BATCH_SIZE ?? 40)

const files = JSON.parse(readFileSync(listPath, 'utf8'))
if (!Array.isArray(files) || files.length === 0) {
  console.error('[test:surat] dosya listesi BOŞ')
  process.exit(1)
}

// Listede olup DİSKTE olmayan dosya sessizce atlanmaz: paket kırmızı yanar.
const missing = files.filter((file) => !existsSync(join(root, file)))
if (missing.length > 0) {
  console.error(`[test:surat] listede olup bulunamayan dosya: ${missing.join(', ')}`)
  process.exit(1)
}

function runBatch(batch) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', ...batch],
      { cwd: root, stdio: ['inherit', 'pipe', 'inherit'] },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      output += text
      process.stdout.write(text)
    })
    child.on('exit', (code) => resolve({ code: code ?? 1, output }))
  })
}

const totals = { tests: 0, pass: 0, fail: 0 }
let failed = false

for (let index = 0; index < files.length; index += BATCH_SIZE) {
  const batch = files.slice(index, index + BATCH_SIZE)
  const batchNo = Math.floor(index / BATCH_SIZE) + 1
  const batchCount = Math.ceil(files.length / BATCH_SIZE)
  console.log(`\n[test:surat] parti ${batchNo}/${batchCount} (${batch.length} dosya)\n`)
  const { code, output } = await runBatch(batch)
  for (const key of ['tests', 'pass', 'fail']) {
    const match = output.match(new RegExp(`^ℹ ${key} (\\d+)$`, 'm'))
    if (match) totals[key] += Number(match[1])
  }
  // Çökme (exit != 0) sayaçlara yansımayabilir; AÇIKÇA hata sayılır.
  if (code !== 0) failed = true
}

console.log('\n═══ SÜRAT PAKETİ TOPLAM ═══')
console.log(`ℹ tests ${totals.tests}`)
console.log(`ℹ pass ${totals.pass}`)
console.log(`ℹ fail ${totals.fail}`)
process.exit(failed || totals.fail > 0 ? 1 : 0)
