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

const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { cwd: root, stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))
