import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

// KALICI `renderContract` AYIRICISI — GERIYE DONUK UYUMLULUK.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
// `renderContract` turetilmis baski artefaktiyla birlikte sifreli shipment
// payload'inda SAKLANIR. Sozlesmenin kanonik adi yeniden adlandirildiginda
// (yalniz isimlendirme; uretilen ZPL AYNI kaldi) daha once yazilmis kayitlar
// hala ESKI ayiriciyi tasir.
//
// Okuma kapisi yalniz guncel adlari taniyordu: eski kayitta alan DUSUYOR ve
// DTO `official_augmented` varsayilanina iniyordu — yani composer'dan gecmis
// bir gonderi "yalniz augmentation" gibi YANLIS siniflaniyordu.
//
// ═══ FIXTURE NEDEN SIFRELI ═══════════════════════════════════════════════
// Eski ayirici, depodan kaldirilmis bir dis saglayici adini icerir ve duz
// metin olarak GERI GELMEMELIDIR. Bu yuzden legacy kayit, uretimdeki gercek
// sekliyle — AES-256-GCM ile sifrelenmis shipment payload'i olarak — saklanir.
// Fixture opaktir; icinden ad okunamaz, kaynak temiz kalir.
//
// AG YOK, DB YOK: yalniz saf okuma yolu (`readPersistedPrintZpl`) sinanir.

process.env.SHIPMENT_ENCRYPTION_KEY ??= 'a'.repeat(64)

const here = dirname(fileURLToPath(import.meta.url))
const LEGACY_PAYLOAD = readFileSync(
  join(here, 'fixtures', 'legacy-render-contract.payload'),
  'utf8',
)

/** Eski ayiricinin SHA-256 ozeti — ad DUZ METIN olarak tutulmaz. */
const LEGACY_CONTRACT_SHA256 =
  '920a3418e4df577449682659d23da924039261090ff4ad0a83a33af820b5d039'

let _vite
let readPersisted
let decryptShipmentPayload
let normalizeRenderContract
let normalizeComposeMode
let isLegacyComposedContract

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({
    __testing: { readPersisted },
  } = await _vite.ssrLoadModule('/server/shipments/printZplRepository.ts'))
  ;({ decryptShipmentPayload } = await _vite.ssrLoadModule(
    '/server/shipments/shipmentEncryption.ts',
  ))
  ;({ normalizeRenderContract, normalizeComposeMode, isLegacyComposedContract } =
    await _vite.ssrLoadModule('/server/shipments/legacyRenderContract.ts'))
})
after(async () => {
  if (_vite) await _vite.close()
})

/** Fixture'daki legacy kaydin COZULMUS hali. */
function legacyRecord() {
  const payload = decryptShipmentPayload(LEGACY_PAYLOAD)
  assert.ok(payload, 'legacy fixture cozulebilmeli')
  return payload
}

test('COMPAT-0: fixture GERCEKTEN eski ayiriciyi tasiyor (duz metin YOK)', () => {
  const record = legacyRecord()
  const stored = record.printZplArtifact.renderContract
  assert.equal(
    createHash('sha256').update(stored, 'utf8').digest('hex'),
    LEGACY_CONTRACT_SHA256,
    'fixture eski ayiriciyi tasimali — aksi halde COMPAT-2 anlamsiz olur',
  )
  // Kaynak dosyada degil, YALNIZ sifreli fixture icinde bulunur.
  assert.equal(
    LEGACY_PAYLOAD.toLowerCase().includes(stored.toLowerCase()),
    false,
    'sifreli fixture ayiriciyi duz metin tasiyamaz',
  )
})

test('COMPAT-1: YENI kanonik deger aynen okunur', () => {
  const record = legacyRecord()
  const payload = {
    ...record,
    printZplArtifact: {
      ...record.printZplArtifact,
      renderContract: 'carrier_composed',
      composeMode: 'carrier_composed',
    },
  }
  const persisted = readPersisted(payload)
  assert.equal(persisted.renderContract, 'carrier_composed')
  assert.equal(persisted.composeMode, 'carrier_composed')

  const augmented = { ...payload }
  augmented.printZplArtifact = {
    ...payload.printZplArtifact,
    renderContract: 'official_augmented',
    composeMode: 'fallback_unknown_template',
  }
  const other = readPersisted(augmented)
  assert.equal(other.renderContract, 'official_augmented')
  assert.equal(other.composeMode, 'fallback_unknown_template')
})

test('COMPAT-2: ESKI ayirici kanonik ada normalize edilir', () => {
  const persisted = readPersisted(legacyRecord())
  assert.equal(
    persisted.renderContract,
    'carrier_composed',
    'eski kayit composed olarak taninmali',
  )
  assert.equal(
    persisted.composeMode,
    'carrier_composed',
    'composeMode de kaldirilmis adi API yanitina SIZDIRMAMALI',
  )
  // Regresyon kilidi: duzeltmeden ONCE bu alan DUSUYOR ve DTO
  // `official_augmented` varsayilanina iniyordu.
  assert.notEqual(persisted.renderContract, 'official_augmented')
})

test('COMPAT-3: GERCEK bilinmeyen deger legacy SANILMAZ', () => {
  const record = legacyRecord()
  for (const unknown of [
    'totally_unrelated_contract',
    'carrier_composed_v2',
    'official_augmented_x',
    '',
    '   ',
  ]) {
    const payload = {
      ...record,
      printZplArtifact: { ...record.printZplArtifact, renderContract: unknown },
    }
    const persisted = readPersisted(payload)
    assert.equal(
      persisted.renderContract,
      undefined,
      `bilinmeyen deger legacy sayilmamali: ${JSON.stringify(unknown)}`,
    )
    assert.equal(isLegacyComposedContract(unknown), false)
  }
  // Tip guvenligi: dize olmayan degerler de legacy DEGILDIR.
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(isLegacyComposedContract(value), false)
    assert.equal(normalizeRenderContract(value), null)
  }
})

test('COMPAT-3b: normalize edici saf sozlesme', () => {
  assert.equal(normalizeRenderContract('carrier_composed'), 'carrier_composed')
  assert.equal(normalizeRenderContract('official_augmented'), 'official_augmented')
  assert.equal(normalizeRenderContract('nope'), null)
  // `composeMode` icin ILGISIZ mod degerleri AYNEN korunur.
  assert.equal(normalizeComposeMode('fallback_geometry_failure'), 'fallback_geometry_failure')
  assert.equal(normalizeComposeMode(null), null)
})

test('COMPAT-4: uyumluluk katmani ZPL ciktisini DEGISTIRMEZ', () => {
  const record = legacyRecord()
  const before = record.printZplArtifact.printZpl
  const persisted = readPersisted(record)
  assert.equal(persisted.printZpl, before, 'kalici ZPL baytlari AYNEN doner')
  assert.equal(persisted.printZplLength, record.printZplArtifact.printZplLength)
  assert.equal(persisted.printZplSha256, record.printZplArtifact.printZplSha256)
  assert.equal(
    persisted.templateFingerprint,
    record.printZplArtifact.templateFingerprint,
  )
  // Kaynak (technicalZpl) KUTSAL: okuma yolu ona dokunmaz.
  assert.equal(record.technicalZpl, legacyRecord().technicalZpl)
})

test('COMPAT-5: composer geometrisi bu degisiklikten ETKILENMEZ', async () => {
  // Uyumluluk katmani YALNIZ okuma yolundadir; composer'i hic gormez.
  const { composeSuratLabel } = await _vite.ssrLoadModule(
    '/src/utils/suratLabelComposer.ts',
  )
  const zpl = readFileSync(
    join(here, 'fixtures', 'surat-real-v2-numeric.zpl'),
    'utf8',
  )
  const composed = composeSuratLabel(zpl, {})
  assert.equal(composed.mode, 'carrier_composed')
  const diagnostics = composed.diagnostics
  // barkod / QR / 727 geometrisi — bu paketin sabitledigi degerler.
  assert.equal(diagnostics.barcodeModules, 112)
  // 14 haneli yuk: basilan (subset B) genislik 189 modul x 4 = 756 dot;
  // blok etiket kenarina (799 - 48) kirpilir.
  assert.equal(diagnostics.humanTextBlockWidth, 799 - 48)
  assert.equal(diagnostics.carrierQr.magnification, 5)
  assert.equal(diagnostics.carrierQr.size, 105)
  assert.equal(diagnostics.orderReferenceShift.fromX, 25)
  assert.equal(diagnostics.orderReferenceShift.x, 39)
  assert.equal(diagnostics.orderReferenceShift.inkLeft, 24)
  // Telefon / adres alanlari taşıyıcınındır; composer bunlara dokunmaz.
  assert.equal(diagnostics.diff.deletions, 0)
  assert.equal(diagnostics.diff.unexpectedMutations, 0)
})
