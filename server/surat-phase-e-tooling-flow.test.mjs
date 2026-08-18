import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// FAZ E — ÜRETİM DENETİM ARAÇLARI.
//
// Kök neden: `surat:canary:precheck` `.env` YÜKLEMİYORDU. Aynı hostta
// `surat:billing:inspect` DATABASE_URL'i görüp 0 dönerken precheck
// göremiyordu. Postgres kapalı DEĞİLDİ; ortam dosyası okunmuyordu.

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

/** Üretim verisine bakan HER CLI aynı ortam dosyasını yüklemelidir. */
const PRODUCTION_READ_SCRIPTS = [
  'surat:billing:inspect',
  'surat:billing:scan',
  'surat:canary:precheck',
]

test('E-1: uretim okuyan CLI\'lar .env YUKLER', () => {
  for (const name of PRODUCTION_READ_SCRIPTS) {
    const script = pkg.scripts?.[name]
    assert.ok(script, `${name} tanimli olmali`)
    assert.match(
      script, /--env-file-if-exists=\.env/,
      `${name} .env yuklemiyor — ayni hostta farkli sonuc verir`,
    )
  }
})

test('E-2: precheck veri kaynagini ACIKCA bildirir', () => {
  const source = readFileSync(
    'server/shipments/suratCanaryPrecheckCli.ts', 'utf8',
  )
  assert.ok(source.includes('DATA_SOURCE'), 'veri kaynagi raporlanmali')
  assert.ok(source.includes('AUTHORITATIVE_SOURCE_RESOLVED'))
  // Cozulemediginde FAIL degil, tanimli bir dis engel bildirilir.
  assert.ok(source.includes('BLOCKED_EXTERNAL'))
  assert.ok(source.includes('CONFIG_NOT_FOUND'))
})

test('E-3: denetim araclari YAZMA yapmaz', () => {
  for (const file of [
    'server/shipments/suratCanaryPrecheckCli.ts',
    'server/shipments/suratBillingInspectCli.ts',
  ]) {
    const code = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    for (const forbidden of ['.insert(', '.update(', '.delete(']) {
      assert.equal(code.includes(forbidden), false, `${file} → ${forbidden}`)
    }
    // Tasiyiciya ag cagrisi YOK.
    assert.equal(/\bfetch\(/.test(code), false, `${file} → ag cagrisi`)
  }
})
