// Labelary referansı ile yerel zebrash çıktısını LANDMARK bazında karşılaştırır
// ve server/fixtures/surat-render/landmark-comparison.json üretir.
//
// Labelary YALNIZ sentetik, PII içermeyen fixture ile çağrılır. Gerçek müşteri
// ZPL'i bu araca VERİLMEZ (girdi sabit fixture dosyasıdır).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodePngToBitmap, scaleBitmap, measureInkBox,
  findHorizontalRules, findVerticalRules, pixelDiff,
} from './pngLandmarks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'fixtures', 'surat-render')

// Arama pencereleri KAYNAK ZPL koordinatlarından türetilir (elle görselden
// bakılarak değil): her landmark'ın ^FO/^FT konumu ± güvenli pay.
const WINDOWS = [
  { key: 'ust-gonderici-kutusu', x: 70, y: 18, width: 380, height: 92 },
  { key: 't-no', x: 455, y: 18, width: 320, height: 40 },
  { key: 'barkod-cubuklari', x: 70, y: 118, width: 700, height: 135 },
  { key: 'barkod-alt-numarasi', x: 70, y: 256, width: 700, height: 28 },
  { key: 'alici-adres-kutusu', x: 70, y: 288, width: 700, height: 80 },
  { key: 'odeme-desi-kutusu', x: 70, y: 458, width: 700, height: 85 },
  { key: 'buyuk-datamatrix', x: 82, y: 558, width: 90, height: 90 },
  { key: 'kucuk-qr', x: 652, y: 562, width: 100, height: 100 },
  { key: 'rota', x: 292, y: 620, width: 340, height: 42 },
  { key: 'aktarma', x: 292, y: 660, width: 460, height: 42 },
  // Dikey ray İKİ ayrı ^A0B metnidir; ayrı ölçülür. Bunlar aşağıdan yukarı
  // okunur, yani ANCHOR alt kenardır (üst kenar metin uzunluğuna bağlıdır).
  { key: 'dikey-ray-surat-kargo', x: 24, y: 170, width: 40, height: 145, anchor: 'bottom' },
  { key: 'dikey-ray-siparis-no', x: 24, y: 400, width: 40, height: 300, anchor: 'bottom' },
  { key: 'urun-footer', x: 70, y: 705, width: 700, height: 40 },
]

const labelary = decodePngToBitmap(
  readFileSync(join(dir, 'synthetic-surat-labelary.png')),
)
const zebrash = decodePngToBitmap(
  readFileSync(join(dir, 'synthetic-surat-zebrash.png')),
)
const reference = scaleBitmap(labelary, zebrash.width, zebrash.height)

const rows = []
const push = (key, ref, local) => {
  if (!ref || !local) {
    rows.push({ landmark: key, labelary: ref, zebrash: local, delta: null, note: 'ölçülemedi' })
    return
  }
  rows.push({
    landmark: key,
    labelary: { x: ref.x, y: ref.y, width: ref.width, height: ref.height },
    zebrash: { x: local.x, y: local.y, width: local.width, height: local.height },
    delta: {
      x: local.x - ref.x, y: local.y - ref.y,
      width: local.width - ref.width, height: local.height - ref.height,
      // Aşağıdan yukarı okunan dikey metinlerde ANLAMLI başlangıç alt kenardır.
      bottom: (local.y + local.height) - (ref.y + ref.height),
      right: (local.x + local.width) - (ref.x + ref.width),
    },
  })
}

// Dış çerçeve: tüm görüntüdeki mürekkep kutusu.
push('dis-cerceve',
  measureInkBox(reference, { x: 0, y: 0, width: reference.width, height: reference.height }),
  measureInkBox(zebrash, { x: 0, y: 0, width: zebrash.width, height: zebrash.height }))

for (const w of WINDOWS) push(w.key, measureInkBox(reference, w), measureInkBox(zebrash, w))

const refRules = findHorizontalRules(reference)
const locRules = findHorizontalRules(zebrash)
const refCols = findVerticalRules(reference)
const locCols = findVerticalRules(zebrash)
const diff = pixelDiff(reference, zebrash)

// Dikey (aşağıdan yukarı) metinlerde başlangıç = alt kenar.
const ANCHOR_BOTTOM = new Set(['dikey-ray-surat-kargo', 'dikey-ray-siparis-no'])
const originDelta = (r) =>
  ANCHOR_BOTTOM.has(r.landmark)
    ? Math.max(Math.abs(r.delta.x), Math.abs(r.delta.bottom))
    : Math.max(Math.abs(r.delta.x), Math.abs(r.delta.y))
const worst = rows
  .filter((r) => r.delta)
  .map(originDelta)
  .reduce((a, b) => Math.max(a, b), 0)
const worstBy = rows
  .filter((r) => r.delta)
  .map((r) => ({ landmark: r.landmark, delta: originDelta(r) }))
  .sort((a, b) => b.delta - a.delta)

const report = {
  fixture: 'synthetic-surat-reference.zpl',
  note: 'Labelary YALNIZ sentetik/PII-siz fixture ile cagrildi; gercek musteri ZPL i gonderilmedi.',
  reference: { engine: 'labelary', widthPx: labelary.width, heightPx: labelary.height,
    scaledTo: { width: reference.width, height: reference.height } },
  local: { engine: 'zebrash', widthPx: zebrash.width, heightPx: zebrash.height },
  horizontalRules: { labelary: refRules, zebrash: locRules },
  verticalRules: { labelary: refCols, zebrash: locCols },
  landmarks: rows,
  pixelDiff: { differentPixels: diff.different, totalPixels: diff.total,
    percent: Number(diff.percent.toFixed(3)) },
  worstOriginDeltaDots: worst,
  originDeltaByLandmark: worstBy,
  tolerance: { lineBoxDots: 3, codeBoxDots: 3, textOriginDots: 4 },
}
writeFileSync(join(dir, 'landmark-comparison.json'), JSON.stringify(report, null, 2), 'utf8')

console.log('landmark'.padEnd(24), 'labelary(x,y,w,h)'.padEnd(24), 'zebrash(x,y,w,h)'.padEnd(24), 'delta(x,y,w,h)')
for (const r of rows) {
  const f = (b) => (b ? `${b.x},${b.y},${b.width},${b.height}` : '-')
  const d = r.delta ? `${r.delta.x},${r.delta.y},${r.delta.width},${r.delta.height}` : '-'
  const o = r.delta ? String(originDelta(r)) : '-'
  console.log(r.landmark.padEnd(24), f(r.labelary).padEnd(24), f(r.zebrash).padEnd(24), d.padEnd(16), 'origin:' + o)
}
console.log('\nyatay cizgiler labelary:', refRules.map((r) => r.y).join(','))
console.log('yatay cizgiler zebrash :', locRules.map((r) => r.y).join(','))
console.log('dikey cizgiler labelary:', refCols.map((r) => r.x).join(','))
console.log('dikey cizgiler zebrash :', locCols.map((r) => r.x).join(','))
console.log('\npixel-diff:', diff.different, '/', diff.total, '=', diff.percent.toFixed(3) + '%')
console.log('en buyuk origin sapmasi:', worst, 'dot')
