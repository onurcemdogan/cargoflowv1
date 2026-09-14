import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// SÜRAT ETİKET COMPOSER — ÜRETİM KABLOLAMASI (WIRING).
//
// NEDEN BU PAKET VAR:
// Composer'ın kendisi CF-*/CR-* ile doğrulanmıştı, ama üretimde HİÇ
// ÇALIŞMIYORDU: gerçek create yolu `attachPrintZplArtifact` →
// `buildPrintZplArtifact` çağrısında `compose` argümanını GEÇİRMİYORDU.
// Utility testleri geçiyordu çünkü hepsi compose'u KENDİSİ veriyordu; hiçbiri
// gerçek caller'ın onu gönderdiğini iddia etmiyordu.
//
// Bu paket iddiaları UTILITY seviyesinde değil, ÜRETİM YOLU seviyesinde kurar:
//   - create yolu ilk artefaktı carrier_composed üretmeli
//   - kalıcı artefakt varsa AYNEN dönmeli (immutable reprint)
//   - her kritik başarısızlıkta official_augmented'a düşmeli ve
//     YARIM composed çıktı ASLA kalıcı olmamalı
//
// Fixture MASKELİDİR; gerçek müşteri verisi içermez.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const repo = await import('./shipments/printZplRepository.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')

const zpl = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const BS = String.fromCharCode(92)
const VERIFIED_727 = '7271234567890'
const NOW = '2026-08-09T00:00:00.000Z'
const ITEMS = [
  {
    productName: 'Scuba Secil Detayli Tesettur Lacivert Elbise',
    quantity: 2,
    color: 'Lacivert',
    size: '40',
    sku: 'SCUBA-SEC01',
  },
]

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
      // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
      // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
      // "server is being restarted or closed" hatası verir. SSR-only test
      // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
      // tarama tamamen kapatılır.
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return drizzle(pglite, { schema })
}
async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}
async function seedShipment(db, organizationId, payload) {
  await db.insert(schema.shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: 'PKG-WIRE-1',
    orderNumber: '1141234567890',
    provider: 'surat',
    source: 'local_create',
    status: 'created',
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
  })
  return {
    organizationId,
    marketplace: 'Trendyol',
    packageId: 'PKG-WIRE-1',
    provider: 'surat',
  }
}
async function readArtifact(db, organizationId) {
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  return encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
    ?.printZplArtifact
}

/** Gerçek create akışındaki carrier payload şekli. */
const carrierPayload = (source = zpl, extra = {}) => ({
  technicalZpl: source,
  technicalZplLength: source.length,
  cargoTrackingNumber: VERIFIED_727,
  ozelKargoTakipNo: VERIFIED_727,
  ...extra,
})

/** referans çıktı composed çıktının GÖRSEL imzaları. */
function assertComposedMarkers(printZpl) {
  assert.ok(printZpl.includes('^BCN,,N,N'), 'dahili yorum satırı KAPALI')
  assert.equal(printZpl.includes('^BCN,,Y,N'), false)
  assert.match(
    printZpl,
    /\^FO48,306\^A0N,20,20\^FB\d+,1,0,C\^FD\d+\^FS/,
    'ayrı küçük ortalanmış barkod metni',
  )
  assert.ok(
    printZpl.includes(`^FT63,417^A@N,15,10,TT0003M_^FH${BS}^CI17^F8^FD`),
    'bold adres tekrarı',
  )
  assert.ok(
    printZpl.includes(`^FT64,417^A@N,15,10,TT0003M_^FH${BS}^CI17^F8^FD`),
    'bold adres çift vuruşu',
  )
  // Ölçek UYARLANABİLİR (mag 5 ideal, uzun aktarma adında mag 4).
  // İddia ölçekten BAĞIMSIZ, gövde ise EXACT doğrulanmış değerdir.
  assert.match(
    printZpl,
    new RegExp("\\^BQN,2,[45]\\^FDLA," + VERIFIED_727 + "\\^FS"),
    'QR',
  )
  assert.equal((printZpl.match(/\^BQ/g) ?? []).length, 1)
  assert.match(printZpl, /\^FB\d+,\d+,\d+,L/, 'ürün footer’ı')
}

/** Composed çıktının HİÇBİR parçası sızmamalı. */
function assertNoComposedLeak(printZpl) {
  assert.equal((printZpl.match(/\^BQ/g) ?? []).length, 0, 'QR sızmamalı')
  assert.equal(printZpl.includes('^BCN,,N,N'), false, 'yorum satırı kapatılmamalı')
  assert.equal(
    /\^FO48,306\^A0N,20,20\^FB/.test(printZpl),
    false,
    'ayrı barkod metni sızmamalı',
  )
  assert.equal(
    printZpl.includes('^FT64,417^A@N'),
    false,
    'bold adres çift vuruşu sızmamalı',
  )
}

// ═══ CW-1..CW-3: CREATE YOLU (attachPrintZplArtifact) ════════════════════

test('CW-1: create yolu İLK artefaktı carrier_composed üretir', () => {
  const next = repo.attachPrintZplArtifact(carrierPayload(), ITEMS, NOW)
  const artifact = next.printZplArtifact
  assert.ok(artifact, 'artefakt yazılmalı')
  assert.equal(artifact.renderContract, 'carrier_composed')
  assert.equal(artifact.composeMode, 'carrier_composed')
  assertComposedMarkers(artifact.printZpl)
  // Kaynak alanlara DOKUNULMAZ.
  assert.equal(next.technicalZpl, zpl)
  assert.equal(next.technicalZplLength, zpl.length)
})

test('CW-2: create artefaktında semantic invariant’lar KORUNUR', async () => {
  const { extractSuratSemanticFields } = await load(
    '/src/utils/suratSemanticParser.ts')
  const { INVARIANT_KEYS } = await load('/src/utils/suratLabelComposer.ts')
  const artifact = repo.attachPrintZplArtifact(carrierPayload(), ITEMS, NOW)
    .printZplArtifact
  const before = extractSuratSemanticFields(zpl).fields
  const after = extractSuratSemanticFields(artifact.printZpl).fields
  for (const key of INVARIANT_KEYS) {
    assert.equal(after[key].raw, before[key].raw, `invariant: ${key}`)
  }
  // Kaynak SHA artefaktta kaynağa bağlı kalır.
  const { sha256Hex } = await load('/src/utils/augmentedSuratZpl.ts')
  assert.equal(artifact.printZplSourceSha256, sha256Hex(zpl))
})

test('CW-3: 727 payload’ın shipment alt kapsamından da çözülür', () => {
  const artifact = repo.attachPrintZplArtifact(
    { technicalZpl: zpl, shipment: { ozelKargoTakipNo: VERIFIED_727 } },
    ITEMS,
    NOW,
  ).printZplArtifact
  assert.equal(artifact.renderContract, 'carrier_composed')
  assert.ok(artifact.printZpl.includes(`^FDLA,${VERIFIED_727}^FS`))
})

// ═══ CW-4..CW-5: REPOSITORY ORKESTRASYONU ════════════════════════════════

test('CW-4: kalıcı artefakt varsa AYNEN döner, YENİDEN compose EDİLMEZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'wire-immutable')
  // Create yolunun ürettiği composed artefakt kalıcı hale gelir.
  const payload = repo.attachPrintZplArtifact(carrierPayload(), ITEMS, NOW)
  const key = await seedShipment(db, organizationId, payload)
  const persisted = payload.printZplArtifact

  const model = await repo.resolvePersistedPrintableLabel(db, key, {
    // Katalog OKUNMAMALI: okunursa test patlar.
    loadItems: async () => {
      throw new Error('reprint sırasında ürün satırı OKUNMAMALI')
    },
    now: '2027-01-01T00:00:00.000Z',
  })
  assert.equal(model.hydrated, false, 'yeniden üretim YOK')
  assert.equal(model.printZpl, persisted.printZpl, 'bayt bayt aynı')
  assert.equal(model.printZplSha256, persisted.printZplSha256)
  assert.equal(model.renderContract, 'carrier_composed', 'sözleşme taşınır')
  assert.equal(model.composeMode, 'carrier_composed')
  // İkinci okuma da AYNI.
  const again = await repo.resolvePersistedPrintableLabel(db, key, {
    items: [],
    now: '2028-01-01T00:00:00.000Z',
  })
  assert.equal(again.printZpl, persisted.printZpl)
  assert.equal(await readArtifact(db, organizationId).then((a) => a.printZpl),
    persisted.printZpl, 'DB’deki kayıt değişmedi')
})

test('CW-5: artefaktı OLMAYAN legacy kayıt hydration’da composed üretir', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'wire-hydration')
  const key = await seedShipment(db, organizationId, carrierPayload())
  const model = await repo.resolvePersistedPrintableLabel(db, key, {
    items: ITEMS,
    now: NOW,
  })
  assert.equal(model.hydrated, true)
  assert.equal(model.renderContract, 'carrier_composed')
  assertComposedMarkers(model.printZpl)
  const stored = await readArtifact(db, organizationId)
  assert.equal(stored.printZpl, model.printZpl, 'kalıcı kayıt da composed')
})

// ═══ CW-6..CW-8: FALLBACK — ÜRETİM YOLU SEVİYESİNDE ══════════════════════

test('CW-6: BİLİNMEYEN şablon → official_augmented, sızıntı YOK', () => {
  const unknown = '^XA^PW400^LL0400^LS0^FO10,10^A0N,20,20^FDx^FS^PQ1^XZ'
  const artifact = repo.attachPrintZplArtifact(
    carrierPayload(unknown),
    ITEMS,
    NOW,
  ).printZplArtifact
  assert.equal(artifact.renderContract, 'official_augmented')
  assert.equal(artifact.composeMode, 'fallback_unknown_template')
  assertNoComposedLeak(artifact.printZpl)
})

test('CW-7: SEMANTIC başarısızlık → official_augmented, sızıntı YOK', () => {
  // T.No slotunu ÇİFTLE → belirsizlik → composer reddeder.
  const tNo = '^FT514,79^A0N,28,28^FH' + BS + '^FD63074185296307^FS'
  assert.ok(zpl.includes(tNo), 'kurgu gerçek fixture ile eşleşmeli')
  const ambiguous = zpl.replace(tNo, tNo + tNo)
  const artifact = repo.attachPrintZplArtifact(
    carrierPayload(ambiguous),
    ITEMS,
    NOW,
  ).printZplArtifact
  assert.equal(artifact.renderContract, 'official_augmented')
  assert.equal(artifact.composeMode, 'fallback_unknown_template')
  assertNoComposedLeak(artifact.printZpl)
  // Kaynak bayt öneki sözleşmesi (RT-10A) burada YÜRÜRLÜKTE.
  assert.ok(
    artifact.printZpl.startsWith(ambiguous.slice(0, ambiguous.lastIndexOf('^PQ'))),
  )
})

// PRINT-GEOMETRY-002B — EŞİK TAŞINDI, SÖZLEŞME AYNI.
//
// Eskiden "sığmayan ad" örneği "ISTANBUL ANADOLU AKTARMA MERKEZI" idi. Uzun
// adlar artık İKİ SATIRA sarıldığı için o ad SIĞIYOR (ölçüldü: 33/24 font,
// kanonik 105 dot QR). Test edilen SÖZLEŞME değişmedi: "güvenli yerleşim
// YOKSA composer tümüyle reddeder, QR'sız KISMİ etiket ÜRETİLMEZ".
//
// Yeni örnek BOŞLUKSUZ tek bir token'dır: sarma kelime sınırında yapıldığı
// için tek kelime BÖLÜNEMEZ ve hiçbir kademe sığdıramaz. Kelime ortasından
// bölmek YOKTUR — bu yüzden bu ad gerçekten imkânsızdır.
const UNFITTABLE_TRANSFER = 'ISTANBULANADOLUAKTARMAMERKEZIBOLGEMUDURLUGU'
/** Eskiden sığmayan, ARTIK iki satırla sığan gerçek ad. */
const WRAPPABLE_TRANSFER = 'ISTANBUL ANADOLU AKTARMA MERKEZI'

test('CW-8: GEÇERLİ 727 + QR geometri çakışması → official_augmented', () => {
  // Aktarma merkezi adı uzarsa QR güvenli alana sığmaz; QR’sız KISMİ referans çıktı
  // etiketi üretmek YASAK → composer tümüyle reddeder.
  const crowded = zpl.replace(
    /\^FT220,705\^A0N,70,50\^FH.\^FD[^^]*\^FS/,
    `^FT220,705^A0N,70,50^FH${BS}^FD${UNFITTABLE_TRANSFER}^FS`,
  )
  assert.notEqual(crowded, zpl, 'kurgu gerçek fixture ile eşleşmeli')
  const artifact = repo.attachPrintZplArtifact(
    carrierPayload(crowded),
    ITEMS,
    NOW,
  ).printZplArtifact
  assert.equal(artifact.renderContract, 'official_augmented')
  assert.equal(artifact.composeMode, 'fallback_geometry_failure')
  assertNoComposedLeak(artifact.printZpl)

  // YENİ DAVRANIŞ AYRICA KİLİTLENİR: boşluk içeren aynı uzunluktaki ad
  // artık REDDEDİLMEZ, iki satıra sarılarak compose EDİLİR.
  const wrapped = zpl.replace(
    /\^FT220,705\^A0N,70,50\^FH.\^FD[^^]*\^FS/,
    `^FT220,705^A0N,70,50^FH${BS}^FD${WRAPPABLE_TRANSFER}^FS`,
  )
  const wrappedArtifact = repo.attachPrintZplArtifact(
    carrierPayload(wrapped),
    ITEMS,
    NOW,
  ).printZplArtifact
  assert.equal(wrappedArtifact.renderContract, 'carrier_composed')
  assert.ok(
    wrappedArtifact.printZpl.includes(`^FD${WRAPPABLE_TRANSFER}^FS`),
    'aktarma gövdesi BAYT BAYT korunur',
  )
})

test('CW-9: 727 YOK → composed sürer ama QR BASILMAZ', () => {
  const artifact = repo.attachPrintZplArtifact(
    { technicalZpl: zpl },
    ITEMS,
    NOW,
  ).printZplArtifact
  assert.equal(artifact.renderContract, 'carrier_composed')
  assert.equal((artifact.printZpl.match(/\^BQ/g) ?? []).length, 0)
  // Diğer referans çıktı dönüşümleri YİNE uygulanır.
  assert.ok(artifact.printZpl.includes('^BCN,,N,N'))
  assert.ok(artifact.printZpl.includes('^FT64,417^A@N'))
})

test('CW-10: utility varsayılanı DEĞİŞMEDİ (CF-34 sözleşmesi)', async () => {
  const { deriveAugmentedSuratZpl } = await load(
    '/src/utils/augmentedSuratZpl.ts')
  // compose GEÇİLMEZSE composer çalışmaz — bu bilinçli varsayılandır.
  const derived = deriveAugmentedSuratZpl(zpl, ITEMS)
  assert.equal(derived.renderContract, 'official_augmented')
  assert.equal(derived.composeMode, null)
  assert.ok(derived.printZpl.startsWith(zpl.slice(0, zpl.lastIndexOf('^PQ'))))
  // Composer YALNIZ caller açıkça istediğinde devreye girer.
  const opted = deriveAugmentedSuratZpl(zpl, ITEMS, {
    compose: { cargoTrackingNumber: VERIFIED_727 },
  })
  assert.equal(opted.renderContract, 'carrier_composed')
})

// ═══ CW-11..CW-14: UYARLANABİLİR QR YERLEŞİMİ ════════════════════════════
//
// Üretimde "IKITELLI AKTARMA" taşıyan gerçek gönderi
// composeMode=fallback_geometry_failure veriyordu. Kök neden yerleşim değil,
// KABA GENİŞLİK TAHMİNİYDİ: aktarma metni gerçekte x=606'da bitiyor, tek
// oranlı tahmin ise 700 diyordu. Tahminci karakter tablosuna geçirildi ve
// yerleşim deterministik aday aramasına dönüştürüldü.

/** Aktarma merkezi adını değiştirilmiş gerçek şablon üretir. */
function withTransferCenter(value) {
  const next = zpl.replace(
    /\^FT220,705\^A0N,70,50\^FH.\^FD[^^]*\^FS/,
    `^FT220,705^A0N,70,50^FH${BS}^FD${value}^FS`,
  )
  assert.notEqual(next, zpl, 'kurgu gerçek fixture ile eşleşmeli')
  return next
}

test('CW-11: ÜRETİM VAKASI "IKITELLI AKTARMA" artık composed üretir', () => {
  const artifact = repo.attachPrintZplArtifact(
    carrierPayload(withTransferCenter('IKITELLI AKTARMA')),
    ITEMS,
    NOW,
  ).printZplArtifact
  // Üretimde fallback_geometry_failure veren SINIF.
  assert.equal(artifact.renderContract, 'carrier_composed')
  assert.equal(artifact.composeMode, 'carrier_composed')
  assertComposedMarkers(artifact.printZpl)
  assert.ok(
    artifact.printZpl.includes(`^BQN,2,5^FDLA,${VERIFIED_727}^FS`),
    'ideal referans ölçek (mag 5) seçilmeli',
  )
  // Aktarma merkezi gövdesi AYNEN korunur.
  assert.ok(artifact.printZpl.includes('^FDIKITELLI AKTARMA^FS'))
})

test('CW-12: uzunluk sınıfları — yaygın adlar composed, ekstrem ad fallback', async () => {
  const { composeSuratLabel } = await load(
    '/src/utils/suratLabelComposer.ts')
  const expectations = [
    ['VAN AKTARMA', true],
    ['GEBZE AKTARMA', true],
    ['IKITELLI AKTARMA', true],
    ['ERZURUM AKTARMA', true],
    // PRINT-GEOMETRY-002B: boşluklu uzun ad artık İKİ SATIRA sarılır ve
    // compose EDİLİR. Eskiden burada `false` bekleniyordu.
    [WRAPPABLE_TRANSFER, true],
    // Gerçekten sığmayan ekstrem ad: BÖLÜNEMEYEN tek token, güvenli yerleşim YOK.
    [UNFITTABLE_TRANSFER, false],
  ]
  for (const [name, shouldCompose] of expectations) {
    const result = composeSuratLabel(withTransferCenter(name), {
      cargoTrackingNumber: VERIFIED_727,
    })
    assert.equal(result.composed, shouldCompose, `${name}: ${result.reason ?? 'composed'}`)
    if (shouldCompose) {
      assert.ok(result.diagnostics.qrBox, `${name}: QR üretilmeli`)
      assert.ok(
        [4, 5].includes(result.diagnostics.qrMagnification),
        `${name}: okunabilir modül boyutu`,
      )
    } else {
      assert.equal(result.mode, 'fallback_geometry_failure')
      assert.equal(result.zpl, withTransferCenter(name), 'kaynak AYNEN')
    }
  }
})

test('CW-13: eşik KARAKTER SAYISINA değil GERÇEK GENİŞLİĞE bağlı', async () => {
  const { composeSuratLabel, estimateA0Width } = await load(
    '/src/utils/suratLabelComposer.ts')
  // Aynı karakter sayısı, çok farklı genişlik: dar harfler vs geniş harfler.
  //
  // PRINT-GEOMETRY-002B — EŞİK TAŞINDI, İDDİA AYNI: iki satır sarma yatay
  // bütçeyi büyüttüğü için 16 karakterlik geniş token ARTIK SIĞIYOR. Test
  // edilen şey eşiğin DEĞERİ değil, eşiğin KARAKTER SAYISINA DEĞİL GERÇEK
  // GENİŞLİĞE bağlı olmasıdır. Bu yüzden uzunluk 16 → 28'e taşındı; iki
  // dizge HÂLÂ AYNI uzunlukta ve sonuçları HÂLÂ zıt (ölçüldü: I×28 sığar,
  // W×28 sığmaz).
  const narrow = 'I'.repeat(28) // 28 karakter, dar
  const wide = 'W'.repeat(28) // 28 karakter, geniş
  assert.equal(narrow.length, wide.length)
  assert.ok(
    estimateA0Width(wide, 50) > estimateA0Width(narrow, 50) * 2,
    'tahminci karakter genişliğini AYIRT ETMELİ',
  )
  assert.equal(
    composeSuratLabel(withTransferCenter(narrow), {
      cargoTrackingNumber: VERIFIED_727,
    }).composed,
    true,
    'dar 28 karakter sığar',
  )
  assert.equal(
    composeSuratLabel(withTransferCenter(wide), {
      cargoTrackingNumber: VERIFIED_727,
    }).composed,
    false,
    'geniş 28 karakter sığmaz',
  )
})

test('CW-14: uzun aktarma adında METİN daralır, ölçek KANONİK kalır', async () => {
  const { composeSuratLabel } = await load(
    '/src/utils/suratLabelComposer.ts')
  const short = composeSuratLabel(withTransferCenter('VAN AKTARMA'), {
    cargoTrackingNumber: VERIFIED_727,
  }).diagnostics
  const long = composeSuratLabel(withTransferCenter('ERZURUM AKTARMA'), {
    cargoTrackingNumber: VERIFIED_727,
  }).diagnostics
  // PRINT-GEOMETRY-002: ölçek artık İÇERİKTEN BAĞIMSIZ. Eskiden uzun ad
  // mag 4'e (84 dot) düşüyordu — yani opsiyonel metin QR'ı küçültüyordu.
  // Artık ÖNCE aktarma fontu daralır (50 → 46), QR KANONİK kalır.
  // İDDİA GEVŞEMEDİ: eskiden "5 ya da 4" kabul ediliyordu, şimdi YALNIZ 5.
  assert.equal(short.qrMagnification, 5, 'kısa ad → kanonik ölçek')
  assert.equal(short.qrCandidateIndex, 0)
  assert.equal(long.qrMagnification, 5, 'uzun ad → AYNI kanonik ölçek')
  assert.equal(long.qrCandidateIndex, 0)
  assert.equal(long.transferFontWidth < short.transferFontWidth, true,
    'küçülen şey METİN olmalı')
  // Her iki durumda da etiket içinde ve sağ kenarda quiet-zone var.
  for (const diagnostics of [short, long]) {
    const quiet = 4 * diagnostics.qrMagnification
    assert.ok(
      diagnostics.qrBox.x + diagnostics.qrBox.size + quiet <= 799,
      'sağ quiet-zone',
    )
    assert.ok(
      diagnostics.qrBox.y + diagnostics.qrRenderYOffset + diagnostics.qrBox.size + quiet <= 799,
      'alt quiet-zone',
    )
  }
})

// ═══ CW-15: PRIMARY ŞABLON NİYETİ KABLOLAMASI ════════════════════════════
//
// Bu oturumda İKİ KEZ "yardımcı doğru, kablolama yanlış" hatası yaşandı:
// composer üretimde hiç çağrılmadı, sonra ana buton eski şablonu açtı.
// Her ikisinde de birim testleri geçiyordu çünkü çağıranın ne gönderdiğini
// hiçbir test iddia etmiyordu. Bu test tam olarak onu kilitler.

test('CW-15: App primary/advanced niyetini AÇIKÇA geçirir', () => {
  const app = readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8')

  // Override YOKSA niyet PRIMARY, VARSA advanced.
  assert.match(
    app,
    /intent:\s*templateOverride === undefined \? 'primary' : 'advanced'/,
    'resolveRunLabelTemplate niyeti açıkça geçirmeli',
  )
  // Araç çubuğu göstergesi organizasyon ayarından DEĞİL, primary şablondan
  // türetilmeli (aksi halde "CargoFlow" yazarken Sürat basılırdı).
  assert.match(
    app,
    /const labelPrintTemplateIndicator = describeLabelPrintTemplate\(\s*DEFAULT_LABEL_PRINT_TEMPLATE,\s*\)/,
  )
  assert.equal(
    /describeLabelPrintTemplate\(\s*organizationLabelPrintTemplate,\s*\)/.test(app),
    false,
    'gösterge organizasyon ayarını YAZMAMALI',
  )
  // Ayarlar ekranındaki şablon seçicisi KALDIRILDI.
  const settings = readFileSync(
    join(here, '..', 'src', 'pages', 'IntegrationsPage.tsx'),
    'utf8',
  )
  assert.equal(
    settings.includes('name="label-print-template"'),
    false,
    'Ayarlar ekranında şablon radio grubu OLMAMALI',
  )
})

// ═══ CW-16..CW-17: ÜÇ KOLON DENGESİ / UZUN AKTARMA ADI ═══════════════════
//
// ÜRETİM VAKASI: transferCenter = "DIYARBAKIR AKTARMA" (18 karakter).
// Ölçüm: tahmini genişlik 489 → sağ uç 709. mag5 için gereken sol kenar 729
// (max 674), mag4 için 725 (max 699) → İKİ ADAY DA elenip composer tümüyle
// fallback'e düşüyordu; etikette QR, bold adres ve küçük barkod metni yoktu.
//
// Çözüm: orta kolon (rota + aktarma) sağ sınırı QR quiet-zone'undan önce
// bitmeli. Aktarma metninin FONT GENİŞLİĞİ, QR sığana kadar kademeli daraltılır.
// Gövde, yükseklik ve konum DEĞİŞMEZ.

test('CW-16: ÜRETİM VAKASI "DIYARBAKIR AKTARMA" artık composed üretir', () => {
  const artifact = repo.attachPrintZplArtifact(
    carrierPayload(withTransferCenter('DIYARBAKIR AKTARMA')),
    ITEMS,
    NOW,
  ).printZplArtifact
  assert.equal(artifact.renderContract, 'carrier_composed')
  assert.equal(artifact.composeMode, 'carrier_composed')
  // DÖRTLÜ AYNI ANDA: küçük barkod metni + bold adres + QR + footer.
  assertComposedMarkers(artifact.printZpl)
  // Aktarma GÖVDESİ değişmez; yalnız font genişliği daralır.
  assert.ok(artifact.printZpl.includes('^FDDIYARBAKIR AKTARMA^FS'))
  assert.match(artifact.printZpl, /\^FT220,705\^A0N,70,(4[0-9])\^FH/)
  assert.equal(artifact.printZpl.includes('^FT220,705^A0N,70,50^FH'), false)
})

test('CW-17: yaygın aktarma adları compose olur, aşırı uzun ad fallback kalır', async () => {
  const { composeSuratLabel } = await load(
    '/src/utils/suratLabelComposer.ts')
  const cases = [
    ['VAN AKTARMA', true],
    ['GEBZE AKTARMA', true],
    ['IKITELLI AKTARMA', true],
    ['ERZURUM AKTARMA', true],
    ['DIYARBAKIR AKTARMA', true],
    // PRINT-GEOMETRY-002B: boşluklu uzun ad İKİ SATIRA sarılır → compose EDİLİR.
    [WRAPPABLE_TRANSFER, true],
    // Bölünemez tek token: hiçbir kademe sığdıramaz → fallback AYNEN.
    [UNFITTABLE_TRANSFER, false],
  ]
  for (const [name, shouldCompose] of cases) {
    const result = composeSuratLabel(withTransferCenter(name), {
      cargoTrackingNumber: VERIFIED_727,
    })
    assert.equal(result.composed, shouldCompose, `${name}: ${result.reason ?? 'ok'}`)
    if (!shouldCompose) {
      assert.equal(result.mode, 'fallback_geometry_failure')
      continue
    }
    const {
      qrBox,
      transferFontWidth,
      transferFontWidthNative,
      transferFontHeight,
      transferFontHeightNative,
      transferBlockWidth,
    } = result.diagnostics
    // Daraltma YALNIZ gerektiğinde ve YALNIZ daralma yönünde.
    assert.ok(transferFontWidth <= transferFontWidthNative, name)
    assert.ok(transferFontHeight <= transferFontHeightNative, name)

    // ═══ OKUNABİLİRLİK TABANI — MODA GÖRE ═══════════════════════════════
    //
    // TEK SATIR: taban 40 (DEĞİŞMEDİ).
    // İKİ SATIR: glif ORANTILI küçülür (70/50 → 33/24, aynı en-boy oranı),
    // bu yüzden mutlak genişlik tabanı da orantılı olarak taşınır. Taban
    // KALDIRILMADI, ölçeğe göre TÜRETİLDİ: 40 × (33/70) ≈ 19.
    const wrapped = transferFontHeight !== transferFontHeightNative
    const floor = wrapped
      ? Math.round((40 * transferFontHeight) / transferFontHeightNative)
      : 40
    assert.ok(
      transferFontWidth >= floor,
      `${name}: okunabilirlik tabanı (${transferFontWidth} < ${floor})`,
    )

    // ÜÇ KOLON: orta blok QR'ın quiet-zone'undan ÖNCE biter.
    //
    // SARILMIŞ MODDA SAĞ SINIR `^FB` İLE YAPISALDIR: metin ne olursa olsun
    // blok genişliğini AŞAMAZ. Bu yüzden sağ uç, tüm adın tek satır
    // genişliğinden değil, BLOK GENİŞLİĞİNDEN hesaplanır.
    const { estimateA0Width } = await load('/src/utils/suratLabelComposer.ts')
    const transferRight = wrapped
      ? 220 + transferBlockWidth
      : 220 + estimateA0Width(name, transferFontWidth)
    const quiet = 4 * result.diagnostics.qrMagnification
    assert.ok(
      transferRight + quiet <= qrBox.x,
      `${name}: orta kolon QR'a taşıyor (${transferRight} + ${quiet} > ${qrBox.x})`,
    )
    // QR etiket içinde ve DataMatrix'in sağında.
    assert.ok(qrBox.x > 199, `${name}: QR DataMatrix'in sağında`)
    assert.ok(qrBox.x + qrBox.size + quiet <= 799, `${name}: sağ quiet-zone`)
  }
})
