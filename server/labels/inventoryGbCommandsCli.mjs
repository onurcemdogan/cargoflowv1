// ^GB (kutu/cizgi) ENVANTERI — hangi cizginin hangi komuttan geldigini kanitlar.
// Girdi: repodaki ZPL kaynaklari. Cikti: gb-command-comparison.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(here, '..', 'fixtures', 'surat-render')

function parseGb(zpl, source) {
  const rows = []
  // ^FOx,y (veya ^FTx,y) ... ^GBw,h,t
  const re = /\^F([OT])(\d+),(\d+)[^^]*\^GB([0-9]*),([0-9]*),([0-9]*)/g
  let m
  while ((m = re.exec(zpl)) !== null) {
    const x = Number(m[2]); const y = Number(m[3])
    const thickness = Number(m[6] || 1)
    const width = m[4] === '' ? thickness : Number(m[4])
    const height = m[5] === '' ? thickness : Number(m[5])
    const type =
      width > thickness && height > thickness ? 'rectangle'
      : height > width ? 'vertical' : 'horizontal'
    rows.push({
      source, rawCommand: m[0].slice(m[0].indexOf('^GB')),
      anchor: '^F' + m[1], x, y, width, height, thickness, type,
    })
  }
  return rows
}

const syntheticPath = join(here, '..', 'fixtures', 'synthetic-surat-reference.zpl')
const synthetic = existsSync(syntheticPath)
  ? parseGb(readFileSync(syntheticPath, 'utf8'), 'synthetic')
  : []

// GERCEK sablon: repoda YOK. Varsa su yola konulmali.
const realPath = join(here, '..', 'fixtures', 'real-template-masked.zpl')
const realAvailable = existsSync(realPath)
const real = realAvailable ? parseGb(readFileSync(realPath, 'utf8'), 'real') : []

const key = (r) => `${r.x},${r.y},${r.width},${r.height},${r.thickness}`
const realKeys = new Set(real.map(key))
const synthKeys = new Set(synthetic.map(key))

const report = {
  generatedFrom: 'server/labels/inventoryGbCommandsCli.mjs',
  realTemplate: {
    available: realAvailable,
    path: 'server/fixtures/real-template-masked.zpl',
    reason: realAvailable ? null
      : 'Repoda GERCEK Surat technicalZpl ornegi YOK. Depodaki tek .zpl dosyasi sentetik fixture. Karsilastirma YAPILAMADI.',
    gbCount: real.length,
    commands: real,
  },
  syntheticFixture: {
    path: 'server/fixtures/synthetic-surat-reference.zpl',
    gbCount: synthetic.length,
    commands: synthetic,
  },
  onlyInSynthetic: synthetic.filter((r) => !realKeys.has(key(r))),
  onlyInReal: real.filter((r) => !synthKeys.has(key(r))),
  provenance: synthetic.map((r) => ({
    rawCommand: r.rawCommand, x: r.x, y: r.y, type: r.type,
    evidence:
      r.type === 'rectangle'
        ? 'DOLAYLI KANIT: canli production regresyonunda gercek Surat ZPL inde etiketin buyuk bolumunu kaplayan bir ^GB cercevesi bulundugu davranisla kanitlandi (contentBottom ~785).'
        : 'KANIT YOK: bu cizgi DuruSoft fotografina bakilarak TARAFIMDAN uydurulmustur; gercek Surat ZPL inde bulundugu KANITLANMAMISTIR.',
  })),
}
writeFileSync(join(out, 'gb-command-comparison.json'), JSON.stringify(report, null, 2), 'utf8')

console.log('gercek sablon mevcut mu :', realAvailable)
console.log('sentetik ^GB sayisi     :', synthetic.length)
console.log('gercek   ^GB sayisi     :', real.length)
console.log('\nsentetik fixture ^GB envanteri:')
console.log('rawCommand'.padEnd(18), 'x'.padStart(4), 'y'.padStart(5), 'w'.padStart(5), 'h'.padStart(5), 't'.padStart(3), ' type')
for (const r of synthetic) {
  console.log(r.rawCommand.padEnd(18), String(r.x).padStart(4), String(r.y).padStart(5),
    String(r.width).padStart(5), String(r.height).padStart(5), String(r.thickness).padStart(3), ' ' + r.type)
}
console.log('\nKANIT DURUMU:')
for (const p of report.provenance) console.log(' -', p.rawCommand.padEnd(16), p.evidence.slice(0, 72) + '...')
