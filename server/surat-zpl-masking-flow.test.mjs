import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// GERÇEK technicalZpl → YAPISAL BİREBİR MASKELENMİŞ FIXTURE.
//
// Bu dosyadaki "kaynak" ZPL GERÇEK MÜŞTERİ VERİSİ DEĞİLDİR: gerçek şablonun
// ZORLU BİÇİMSEL ÖZELLİKLERİNİ (^FH hex kaçışları, Code128 kontrol ön ekleri,
// ^BQ hata-düzeltme ön eki, boş ^FD, CRLF satır sonu, ^GB çizgileri) taklit
// eden bir SINAMA girdisidir. Amaç maskeleme aracının bu yapıları BOZMADAN
// çalıştığını kanıtlamaktır.

const here = dirname(fileURLToPath(import.meta.url))

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

// Gerçek şablonun biçimsel zorluklarını taşıyan SINAMA girdisi (CRLF).
const PROBE_SOURCE = [
  '^XA',
  '^CI28',
  '^PW799',
  '^LL0799',
  '^LS0',
  '^FO20,15^GB760,770,3^FS',
  '^FO65,15^GB0,770,2^FS',
  '^FO20,110^GB760,0,2^FS',
  '^FT80,45^A0N,24,24^FDSube: MERKEZ^FS',
  '^FT80,78^A0N,30,30^FH_^FD_C3_96RNEK G_C3_9CREL^FS',
  '^FT80,102^A0N,20,20^FD^FS',
  '^FT470,45^A0N,26,26^FDT.No: 21012920014311^FS',
  '^FT560,95^A0N,20,20^FDTEL:  0555*******^FS',
  '^FO90,125^BY3^BCN,130,Y,N,N^FD>;01254596670^FS',
  '^FT80,312^A0N,24,24^FDMERYEM KARATAS^FS',
  '^FO80,320^A0N,19,19^FB690,4,2,L^FDFIRAT MAH 596. SOKAK NO:6 KAYAPINAR/DIYARBAKIR^FS',
  '^FO90,565^BXN,5,200^FD7270035184060553^FS',
  '^FO660,570^BQN,2,4^FDLA,01254596670^FS',
  '^FWB',
  '^FT48,690^A0B,20,20^FDSiparis No: 7270035184060553^FS',
  '^FWN',
  '^PQ1,0,1,Y',
  '^XZ',
].join('\r\n')

const REAL_TOKENS = [
  '21012920014311',
  '01254596670',
  '7270035184060553',
  'MERYEM KARATAS',
  'FIRAT MAH',
  'KAYAPINAR',
  'DIYARBAKIR',
]

async function mask(source) {
  const module = await load('/server/labels/zplMasking.ts')
  return { module, result: module.maskZpl(source) }
}

// ═══ 1-10: MASKELEME YAPISAL SÖZLEŞMESİ ═══════════════════════════════════

test('MSK-1: YALNIZ ^FD gövdeleri değişir, başka hiçbir bayt değişmez', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  assert.notEqual(result.masked, PROBE_SOURCE, 'maskeleme gerçekten yapılmalı')
  // İskeletler (^FD gövdeleri token'lanmış hâl) BİREBİR aynı olmalı.
  assert.equal(
    module.structuralSkeleton(result.masked),
    module.structuralSkeleton(PROBE_SOURCE),
  )
  // Gövdeler dışındaki tüm bölümler aynen korunur.
  const sourceFields = module.parseZplFields(PROBE_SOURCE)
  const maskedFields = module.parseZplFields(result.masked)
  assert.equal(sourceFields.length, maskedFields.length)
})

test('MSK-2: yapısal hash EŞİT', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  assert.equal(
    module.structuralHash(result.masked),
    module.structuralHash(PROBE_SOURCE),
  )
  const verification = module.verifyStructuralEquality(PROBE_SOURCE, result.masked)
  assert.equal(verification.ok, true, verification.reasons.join('; '))
  assert.equal(verification.structuralHashMatches, true)
  assert.equal(verification.commandSequenceMatches, true)
})

test('MSK-3: ^GB listesi BİREBİR aynı', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  assert.deepEqual(
    module.buildGbInventory(result.masked),
    module.buildGbInventory(PROBE_SOURCE),
  )
  assert.equal(module.buildGbInventory(result.masked).length, 3)
})

test('MSK-4: ^FO/^FT koordinatları BİREBİR aynı', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  const positions = (zpl) => (zpl.match(/\^F[OT]\d+,\d+/g) ?? [])
  assert.deepEqual(positions(result.masked), positions(PROBE_SOURCE))
  const fonts = (zpl) => (zpl.match(/\^A[0@][NRIB]?,\d+,\d+/g) ?? [])
  assert.deepEqual(fonts(result.masked), fonts(PROBE_SOURCE))
  const blocks = (zpl) => (zpl.match(/\^FB[0-9,LCRJ]*/g) ?? [])
  assert.deepEqual(blocks(result.masked), blocks(PROBE_SOURCE))
})

test('MSK-5: barkod komut parametreleri aynı (^BY/^BC)', async () => {
  const { result } = await mask(PROBE_SOURCE)
  for (const needle of ['^BY3', '^BCN,130,Y,N,N']) {
    assert.ok(result.masked.includes(needle), needle)
  }
})

test('MSK-6: DataMatrix/QR parametreleri aynı (^BX/^BQ)', async () => {
  const { result } = await mask(PROBE_SOURCE)
  assert.ok(result.masked.includes('^BXN,5,200'))
  assert.ok(result.masked.includes('^BQN,2,4'))
  // ^BQ hata düzeltme ön eki KORUNUR (modül sayısını belirler).
  assert.match(result.masked, /\^BQN,2,4\^FDLA,/)
})

test('MSK-7: satır sonu biçimi korunur (CRLF)', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  assert.ok(PROBE_SOURCE.includes('\r\n'))
  assert.ok(result.masked.includes('\r\n'))
  assert.equal(
    (result.masked.match(/\r\n/g) ?? []).length,
    (PROBE_SOURCE.match(/\r\n/g) ?? []).length,
  )
  assert.equal(
    module.verifyStructuralEquality(PROBE_SOURCE, result.masked).lineEndingMatches,
    true,
  )
})

test('MSK-8: boş ^FD^FS korunur', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  assert.ok(result.masked.includes('^FD^FS'), 'boş alan aynen kalmalı')
  assert.equal(result.emptyFieldCount, 1)
  const empties = module
    .parseZplFields(result.masked)
    .filter((field) => field.data === '')
  assert.equal(empties.length, 1)
})

test('MSK-9: ^FH heksadesimal kaçışları GEÇERLİ kalır', async () => {
  const { result } = await mask(PROBE_SOURCE)
  assert.ok(result.masked.includes('^FH_^FD'), '^FH bloğu korunur')
  const field = /\^FH_\^FD([^^]*)\^FS/.exec(result.masked)
  assert.ok(field, 'maskelenmiş ^FH alanı bulunmalı')
  // Kaynaktaki 4 kaçış dizisi, maskede de 4 GEÇERLİ hex kaçışı olmalı.
  const escapes = field[1].match(/_[0-9A-Fa-f]{2}/g) ?? []
  assert.equal(escapes.length, 4)
  // Gerçek Türkçe karakterler kaçış olarak DA sızmamalı.
  assert.equal(/_C3|_96|_9C/.test(field[1]), false)
})

test('MSK-10: Code128 kontrol ön eki korunur', async () => {
  const { result } = await mask(PROBE_SOURCE)
  assert.match(result.masked, /\^FD>;/, 'Code128 ">;" ön eki korunur')
  // Payload uzunlugu korunur, degeri degisir.
  const field = /\^FD>;([^^]*)\^FS/.exec(result.masked)
  assert.ok(field)
  assert.equal(field[1].length, '01254596670'.length)
  assert.notEqual(field[1], '01254596670')
  assert.match(field[1], /^\d+$/, 'sayısal payload sayısal kalır')
})

// ═══ 11-16: GİZLİLİK VE CLI GÜVENLİĞİ ═════════════════════════════════════

test('MSK-11: gerçek değerler maskede KALMAZ, uzunluklar korunur', async () => {
  const { result } = await mask(PROBE_SOURCE)
  for (const token of REAL_TOKENS) {
    assert.equal(result.masked.includes(token), false, `sızıntı: ${token}`)
  }
  assert.equal(
    Buffer.byteLength(result.masked, 'utf8') <= Buffer.byteLength(PROBE_SOURCE, 'utf8'),
    true,
    'maskeleme dosyayı büyütmemeli',
  )
})

test('MSK-12: PII taraması ve --deny-token', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  assert.equal(module.scanForPii(result.masked).ok, true)
  // Kullanıcı token'ı maskede kalsaydı işlem başarısız olmalı.
  const denied = module.scanForPii(result.masked + 'GIZLI-TOKEN', ['GIZLI-TOKEN'])
  assert.equal(denied.ok, false)
  assert.equal(denied.findings[0].rule, 'deny-token')
  // Bulgu DEĞERİ raporlanmaz, yalnız kural adı ve konum.
  assert.deepEqual(Object.keys(denied.findings[0]).sort(), ['index', 'rule'])
  // Türkçe harf kalıntısı da yakalanır.
  assert.equal(module.scanForPii('^FDÖRNEK^FS').ok, false)
})

test('MSK-13: CLI ham ZPL YAZDIRMAZ ve yalnız güvenli özet basar', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'zplmask-'))
  try {
    const input = join(workDir, 'technical.zpl')
    const output = join(workDir, 'masked.zpl')
    writeFileSync(input, PROBE_SOURCE, 'utf8')
    const stdout = execFileSync(
      process.execPath,
      [join(here, 'labels', 'maskSuratZplCli.ts'), '--input', input, '--output', output],
      { encoding: 'utf8' },
    )
    // Güvenli özet alanları var.
    for (const needle of [
      'kaynak byte uzunlugu', 'komut sayisi', '^GB / ^BC / ^BX / ^BQ',
      'yapisal iskelet esit', 'PII taramasi temiz', 'maskelenmis fixture',
    ]) {
      assert.ok(stdout.includes(needle), `özet alanı yok: ${needle}`)
    }
    // HAM ZPL veya gerçek değer stdout'a ÇIKMAZ.
    assert.equal(/\^FD[^\s]/.test(stdout), false, 'stdout ^FD gövdesi içeriyor')
    for (const token of REAL_TOKENS) {
      assert.equal(stdout.includes(token), false, `stdout sızıntısı: ${token}`)
    }
    // Dosya yazıldı ve içinde gerçek değer yok.
    const masked = readFileSync(output, 'utf8')
    for (const token of REAL_TOKENS) {
      assert.equal(masked.includes(token), false, `fixture sızıntısı: ${token}`)
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('MSK-14: deny-token maskede kalırsa CLI BAŞARISIZ olur ve dosya YAZILMAZ', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'zplmask-'))
  try {
    const input = join(workDir, 'technical.zpl')
    const output = join(workDir, 'masked.zpl')
    // Maskelenmeyen bir bölge (komut adı) deny-token olarak verilirse süreç durur.
    writeFileSync(input, PROBE_SOURCE, 'utf8')
    let failed = false
    try {
      execFileSync(
        process.execPath,
        [
          join(here, 'labels', 'maskSuratZplCli.ts'),
          '--input', input, '--output', output,
          '--deny-token', '^BXN,5,200',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      )
    } catch {
      failed = true
    }
    assert.equal(failed, true, 'deny-token bulunduğunda çıkmalı')
    assert.equal(existsSync(output), false, 'başarısızlıkta fixture YAZILMAMALI')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('MSK-15: CLI kaynağı DB write / provider çağrısı İÇERMEZ', () => {
  const cli = readFileSync(join(here, 'labels', 'maskSuratZplCli.ts'), 'utf8')
  const code = cli
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'createShipment', 'ortakBarkod',
    'labelStatus', 'printCount', 'fetch(', 'labelary',
  ]) {
    assert.equal(code.includes(forbidden), false, `yasak çağrı: ${forbidden}`)
  }
  // Salt okunur select ve organization scope zorunlu.
  assert.match(code, /\.select\(\)/)
  assert.match(code, /eq\(shipments\.organizationId, options\.organizationId\)/)
  assert.match(code, /--organization-id ve --package-id zorunlu/)
  // Çıktı dosyası kısıtlı izinle yazılır.
  assert.match(code, /mode: 0o600/)
})

test('MSK-16: maskeleme modülü LOG YAZMAZ ve içerikten türetme YAPMAZ', () => {
  const source = readFileSync(join(here, 'labels', 'zplMasking.ts'), 'utf8')
  assert.equal(/console\.(log|info|warn|error|debug)/.test(source), false)
  assert.equal(/fetch\(|https?:\/\//.test(source), false)
  // Sentetik değerler ALAN SIRASINDAN türetilir; gövde içeriğinden değil.
  assert.match(source, /fieldIndex \* 31 \+ 7/)
})

// ═══ 17-20: AUGMENTATION VE RENDER SÖZLEŞMESİ ═════════════════════════════

test('MSK-17: augmentation ürün satırını YALNIZ final ^PQ öncesine ekler', async () => {
  const { result } = await mask(PROBE_SOURCE)
  const { deriveAugmentedSuratZplWithHashes } = await load(
    '/src/utils/augmentedSuratZpl.ts',
  )
  const augmented = deriveAugmentedSuratZplWithHashes(result.masked, [
    { productName: 'SENTETIK URUN', quantity: 1, color: 'Krem', size: '40', sku: '6496' },
  ])
  const printZpl = augmented.printZpl
  assert.ok(printZpl.startsWith(result.masked.slice(0, 120)), 'kaynak korunur')
  assert.equal((printZpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((printZpl.match(/\^XZ/g) ?? []).length, 1)
  if (augmented.augmented) {
    const productAt = printZpl.indexOf('SENTETIK URUN')
    assert.ok(productAt > -1, 'ürün satırı eklendi')
    assert.ok(productAt < printZpl.lastIndexOf('^PQ'), 'final ^PQ ÖNCESİNDE')
  }
})

test('MSK-18: augmentation YENİ ^GB EKLEMEZ', async () => {
  const { module, result } = await mask(PROBE_SOURCE)
  const { deriveAugmentedSuratZplWithHashes } = await load(
    '/src/utils/augmentedSuratZpl.ts',
  )
  const augmented = deriveAugmentedSuratZplWithHashes(result.masked, [
    { productName: 'SENTETIK URUN', quantity: 1, color: 'Krem', size: '40', sku: '6496' },
  ])
  assert.deepEqual(
    module.buildGbInventory(augmented.printZpl),
    module.buildGbInventory(result.masked),
    'augmentation ^GB envanterini DEĞİŞTİRMEMELİ',
  )
  // Ürün satırı komutlarında ^GB yok (kaynak kodda da yok).
  const productLine = readFileSync(
    join(here, '..', 'src', 'utils', 'suratZplProductLine.ts'), 'utf8',
  )
  assert.equal(productLine.includes('^GB'), false)
})

test('MSK-19: kaynak technicalZpl DEĞİŞMEDEN kalır', async () => {
  const before = PROBE_SOURCE
  const { result } = await mask(PROBE_SOURCE)
  assert.equal(PROBE_SOURCE, before, 'girdi mutasyona uğramamalı')
  assert.notEqual(result.masked, before)
  // Maskeleme SAF: aynı girdi aynı çıktıyı verir.
  const again = await mask(PROBE_SOURCE)
  assert.equal(again.result.masked, result.masked)
})

test('MSK-20: maskelenmiş fixture zebrash ile DETERMİNİSTİK render edilir', async () => {
  const { result } = await mask(PROBE_SOURCE)
  const { renderZplToPng } = await import('./labels/zplRenderService.ts')
  const first = await renderZplToPng({ zpl: result.masked })
  const second = await renderZplToPng({ zpl: result.masked })
  assert.equal(first.widthPx, 799)
  assert.equal(first.heightPx, 799)
  assert.equal(first.renderSha256, second.renderSha256, 'render deterministik')
  assert.equal(first.engine.zebrashVersion, 'v1.38.0')
})

// ═══ MP-1..MP-3: MASKELEME CLI SAĞLAYICI KANONİKLEŞTİRME ════════════════
//
// KÖK NEDEN: CLI varsayılanı 'surat-kargo' idi; üretim `shipments.provider`
// kolonuna DAİMA kanonik 'surat' yazar ve sorgu exact eq(...) kullanır.
// Bu yüzden komut HİÇBİR kaydı bulamıyor, maskelenmiş gerçek şablon
// üretilemiyordu. (Render ucundaki fa6b26b hatasıyla AYNI sınıf.)

test('MP-1: CLI varsayılan sağlayıcısı KANONİK değerdir', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = dirname(fileURLToPath(import.meta.url))
  const cli = readFileSync(join(root, 'labels/maskSuratZplCli.ts'), 'utf8')
  const { SURAT_PERSISTENCE_PROVIDER } = await import(
    './shipments/suratProvider.ts'
  )
  assert.equal(SURAT_PERSISTENCE_PROVIDER, 'surat')
  assert.match(cli, /provider: SURAT_PERSISTENCE_PROVIDER,/)
  assert.equal(
    /provider: 'surat-kargo'/.test(cli),
    false,
    'görünen ad varsayılan OLAMAZ',
  )
})

test('MP-2: --provider görünen adı KANONİK değere çevrilir', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = dirname(fileURLToPath(import.meta.url))
  const cli = readFileSync(join(root, 'labels/maskSuratZplCli.ts'), 'utf8')
  assert.match(cli, /options\.provider = canonicalProvider\(next\(\)\)/)
  assert.match(cli, /isSuratProviderName\(raw\) \? SURAT_PERSISTENCE_PROVIDER : raw/)
})

test('MP-3: Sürat OLMAYAN sağlayıcı sessizce çevrilmez', async () => {
  const { isSuratProviderName } = await import('./shipments/suratProvider.ts')
  for (const alias of ['surat', 'surat-kargo', 'Sürat Kargo', 'Sürat Kargo Marketplace']) {
    assert.equal(isSuratProviderName(alias), true, alias)
  }
  for (const foreign of ['Aras', 'Yurtiçi', 'MNG']) {
    assert.equal(isSuratProviderName(foreign), false, foreign)
  }
})
