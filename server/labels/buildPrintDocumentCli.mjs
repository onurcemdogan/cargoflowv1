// Fiziksel test icin tek sayfalik 100 x 100 mm Chrome baski belgesi uretir.
// Kaynak: yerel zebrash PNG'si. Goruntu uzerine HICBIR overlay eklenmez.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSuratPrintDocumentHtml } from './printDocument.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'fixtures', 'surat-render')
const png = readFileSync(join(dir, 'synthetic-surat-zebrash.png')).toString('base64')
writeFileSync(
  join(dir, 'synthetic-surat-print.html'),
  buildSuratPrintDocumentHtml([{ imageBase64: png }]),
  'utf8',
)
console.log('yazildi: synthetic-surat-print.html')
