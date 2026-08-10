import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// DAR FOOTER — CANLI VAKA REGRESYONU
// org b309a548-d729-406f-9516-a6cf232cf4ad / packageId 4057121401
//
// Canlı dry-run: outcome=still_overflow, itemCount=1 (ürün datası VARDI,
// şablon TANINIYORDU) → sorun kesin olarak yerleşimdi.
//
// İKİ AYRI KÖK NEDEN, İKİSİ DE GEREKLİ:
//
// 1) ÖLÇÜM: ^FO ve ^FT aynı işleniyordu. ZPL'de ^FO y ALANIN ÜST kenarı,
//    ^FT y ise TABAN ÇİZGİSİDİR (metin yukarı uzar). Etiketin en altındaki
//    büyük ^FT aktarma satırı (~44 dot font) yüzünden contentBottom bir font
//    boyu FAZLA ölçülüyordu (796 vs 754) ve footer alanı EKSİYE düşüyordu.
//
// 2) TİPOGRAFİ: ölçüm düzeltildikten sonra bile kalan 31 dot, eski merdivenin
//    EN AZ ihtiyacı olan 38 dot'un (wrapped-dense) altındaydı. Merdivenin
//    SONUNA okunabilirlik tabanındaki (12 dot ≈ 1,5 mm) kompakt kademeler
//    eklendi.
//
// technicalZpl DEĞİŞTİRİLMEZ; yalnız TÜRETİLMİŞ printZpl'e footer eklenir.
// ^LL SABİT KALIR (799): render motoru 799×799 dışını reddeder ve baskı
// belgesi 100×100 mm sabittir — ikinci etiket/clipping riski YOKTUR.
//
// Veriler SENTETİKTİR; yalnız ölçü ve metin uzunluğu canlı vakayla aynıdır.

const here = dirname(fileURLToPath(import.meta.url))
void here

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

// Canlı etiketin ŞEKLİ: resmî içerik ^FT ile etiketin çok altına iniyor.
const TIGHT_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO60,20^GB700,90,2^FS',
  '^FT80,50^A0N,24,24^FDSube: FERAH^FS',
  '^FT470,50^A0N,26,26^FDT.No: 10715069128642^FS',
  '^FO90,130^BY3^BCN,130,Y,N,N^FD01256423147^FS',
  '^FO60,300^GB700,140,2^FS',
  '^FT80,330^A0N,24,24^FDSENTETIK ALICI^FS',
  '^FO90,600^BXN,5,200^FD7270035470417450^FS',
  '^FT380,660^A0N,40,40^FDKIRIKHAN/05^FS',
  '^FT380,745^A0N,44,44^FDADANA AKTARMA^FS',
  '^FWB', '^FT40,700^A0B,18,18^FDSiparis No: 7270035470417450^FS', '^FWN',
  '^PQ1,0,1,Y', '^XZ',
].join('\n')

// Canlı ürün metni (106 karakter).
const LIVE_ITEM = {
  quantity: 1,
  productName: 'Scuba Seçil Detaylı Tesettür Lacivert Elbise SCUBA-SEC01, 40',
  color: 'Lacivert',
  size: '40',
  sku: 'SCUBA-SEC01',
}

// ═══ TF-1..TF-2: ÖLÇÜM (^FT taban çizgisi) ══════════════════════════════

test('TF-1: ^FT TABAN ÇİZGİSİ sayılır; contentBottom şişmez', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const geometry = parseSuratZplGeometry(TIGHT_ZPL)
  assert.equal(geometry.ok, true)
  assert.equal(geometry.labelLength, 799, '^LL DEĞİŞMEZ')
  assert.equal(geometry.printWidth, 799)
  // En alttaki ^FT: taban 745, font 44 → alt sınır ≈ 745 + %20 descender.
  assert.ok(
    geometry.contentBottom >= 745,
    `descender payı korunmalı: ${geometry.contentBottom}`,
  )
  assert.ok(
    geometry.contentBottom <= 760,
    `bir font boyu FAZLA ölçülmemeli (eski hata 796): ${geometry.contentBottom}`,
  )
})

test('TF-2: ^FO ÜST KENAR olarak kalır (davranış değişmedi)', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const fo = parseSuratZplGeometry(
    ['^XA', '^PW799', '^LL0799', '^FO60,20^GB700,90,2^FS',
     '^FO100,700^A0N,40,40^FDALT METIN^FS',
     '^FO90,130^BY3^BCN,130,Y,N,N^FD012^FS',
     '^FO90,300^BXN,5,200^FD777^FS',
     '^FWB', '^FT40,600^A0B,18,18^FDRay^FS', '^FWN', '^XZ'].join('\n'),
  )
  const ft = parseSuratZplGeometry(
    ['^XA', '^PW799', '^LL0799', '^FO60,20^GB700,90,2^FS',
     '^FT100,700^A0N,40,40^FDALT METIN^FS',
     '^FO90,130^BY3^BCN,130,Y,N,N^FD012^FS',
     '^FO90,300^BXN,5,200^FD777^FS',
     '^FWB', '^FT40,600^A0B,18,18^FDRay^FS', '^FWN', '^XZ'].join('\n'),
  )
  // AYNI y için ^FO daha AŞAĞI uzanır (üst kenardan başlar).
  assert.ok(
    fo.contentBottom > ft.contentBottom,
    `^FO(${fo.contentBottom}) > ^FT(${ft.contentBottom}) olmalı`,
  )
})

// ═══ TF-3..TF-4: PROFİL MERDİVENİ ═══════════════════════════════════════

test('TF-3: kompakt kademeler merdivenin SONUNDA; mevcut seçimler DEĞİŞMEZ', async () => {
  const { SURAT_FOOTER_PROFILES, planSuratFooter } = await load(
    '/src/utils/suratZplProductLine.ts')
  // Merdivenin TAM sırası TEK yerde doğrulanır (TF-18); burada yalnız
  // kompakt kademelerin SONDA olduğu ve tabanın korunduğu kilitlenir.
  const keys = SURAT_FOOTER_PROFILES.map((p) => p.key)
  assert.ok(
    keys.indexOf('wrapped-compact') < keys.indexOf('single-line-micro'),
    'kompakt kademeler SONDA kalmalı',
  )
  for (const profile of SURAT_FOOTER_PROFILES) {
    assert.ok(profile.fontHeight >= 12, `çok küçük font: ${profile.key}`)
  }
  // SÖZLEŞME GÜNCELLENDİ (fiziksel okunabilirlik turu): yeri OLAN etikette
  // artık EN BÜYÜK font tercih edilir — 18 dot yerine 20 dot sarmalı.
  // İddia zayıflatılmadı: hâlâ deterministik tek bir profil kilitleniyor.
  const roomy = {
    ok: true, printWidth: 799, labelLength: 799,
    leftRailRight: 48, contentBottom: 700,
  }
  const roomyPlan = planSuratFooter([LIVE_ITEM], roomy)
  assert.equal(roomyPlan.profile.key, 'wrapped-standard')
  assert.equal(roomyPlan.profile.fontHeight, 20)
  assert.ok(roomyPlan.usedHeight <= roomyPlan.area.height, 'banda sığar')
})

test('TF-4: dar alanda kompakt kademe devreye girer', async () => {
  const { planSuratFooter } = await load('/src/utils/suratZplProductLine.ts')
  const tight = {
    ok: true, printWidth: 799, labelLength: 799,
    leftRailRight: 48, contentBottom: 755,
  }
  const plan = planSuratFooter([LIVE_ITEM], tight)
  assert.equal(plan.ok, true, 'artık sığmalı')
  assert.ok(String(plan.profile.key).endsWith('micro'))
  assert.ok(plan.usedHeight <= plan.area.height)
})

// ═══ TF-5..TF-10: CANLI VAKANIN UÇTAN UCA SONUCU ════════════════════════

test('TF-5: canlı vaka artık AUGMENTED (still_overflow YOK)', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  const derived = deriveAugmentedSuratZpl(TIGHT_ZPL, [LIVE_ITEM])
  assert.equal(derived.augmented, true, 'ürün satırı EKLENDİ')
  assert.equal(derived.augmentationStatus, 'success')
  assert.equal(derived.fallbackReason, undefined)
})

test('TF-6: technicalZpl BAYT BAYT korunur ve ÖNEK olarak durur', async () => {
  const { deriveAugmentedSuratZpl, sha256Hex } = await load(
    '/src/utils/augmentedSuratZpl.ts')
  const derived = deriveAugmentedSuratZpl(TIGHT_ZPL, [LIVE_ITEM])
  assert.equal(derived.sourceZpl, TIGHT_ZPL)
  assert.equal(sha256Hex(derived.sourceZpl), sha256Hex(TIGHT_ZPL))
  // Kaynağın ^PQ ÖNCESİ tüm gövdesi AYNEN duruyor.
  const head = TIGHT_ZPL.slice(0, TIGHT_ZPL.lastIndexOf('^PQ'))
  assert.ok(derived.printZpl.startsWith(head), 'kaynak gövde aynen')
  assert.ok(derived.printZpl.trimEnd().endsWith('^XZ'))
})

test('TF-7: carrier alanları DEĞİŞMEZ (T.No, barkod, matris, rota, ray)', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  const printZpl = deriveAugmentedSuratZpl(TIGHT_ZPL, [LIVE_ITEM]).printZpl
  for (const carrier of [
    '^FT470,50^A0N,26,26^FDT.No: 10715069128642^FS',
    '^FO90,130^BY3^BCN,130,Y,N,N^FD01256423147^FS',
    '^FO90,600^BXN,5,200^FD7270035470417450^FS',
    '^FT380,660^A0N,40,40^FDKIRIKHAN/05^FS',
    '^FT380,745^A0N,44,44^FDADANA AKTARMA^FS',
    '^FT40,700^A0B,18,18^FDSiparis No: 7270035470417450^FS',
    '^FO60,20^GB700,90,2^FS',
  ]) {
    assert.ok(printZpl.includes(carrier), `carrier alanı bozuldu: ${carrier.slice(0, 24)}`)
    assert.equal(
      (printZpl.match(new RegExp(carrier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length,
      1,
      'carrier alanı ÇOĞALMAMALI',
    )
  }
})

test('TF-8: TEK etiket/sayfa — ^LL, ^PW ve ^XA/^XZ sayısı DEĞİŞMEZ', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  const printZpl = deriveAugmentedSuratZpl(TIGHT_ZPL, [LIVE_ITEM]).printZpl
  assert.equal((printZpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((printZpl.match(/\^XZ/g) ?? []).length, 1)
  assert.equal((printZpl.match(/\^PQ/g) ?? []).length, 1)
  assert.equal((printZpl.match(/\^LL0?799/g) ?? []).length, 1, '^LL UZATILMADI')
  assert.equal((printZpl.match(/\^PW799/g) ?? []).length, 1)
  // ^LL veya ^PW EKLENMEDİ/DEĞİŞTİRİLMEDİ.
  assert.equal((TIGHT_ZPL.match(/\^LL/g) ?? []).length, (printZpl.match(/\^LL/g) ?? []).length)
})

test('TF-9: footer resmî içeriğe BİNMEZ ve alt kenar payı korunur', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const derived = deriveAugmentedSuratZpl(TIGHT_ZPL, [LIVE_ITEM])
  const geometry = parseSuratZplGeometry(TIGHT_ZPL)
  // Eklenen komutlar: kaynakta ^FB YOK.
  assert.equal(TIGHT_ZPL.includes('^FB'), false)
  const added = derived.printZpl
    .split(/\r?\n/)
    .filter((line) => line.includes('^FB'))
  assert.ok(added.length > 0, 'footer üretildi')
  const ys = added.map((line) => Number(/\^FO\d+,(\d+)/.exec(line)[1]))
  assert.ok(Math.min(...ys) > geometry.contentBottom, 'içeriğin ALTINDA')
  assert.ok(
    derived.metrics.footerBottom <= geometry.labelLength - 8,
    `alt kenar payı: ${derived.metrics.footerBottom}`,
  )
  // SOL RAY SÖZLEŞMESİ (cila turunda GÜÇLENDİ, gevşemedi): eskiden footer
  // DAİMA rayın sağında tutuluyordu. Artık gerçek kutu ölçüldüğü için footer
  // rayın ALTINA da inebilir. Doğru iddia "x > rayın sağı" değil, KUTULARIN
  // ÇAKIŞMAMASIDIR: ya sağında ya altında.
  const xs = added.map((line) => Number(/\^FO(\d+),/.exec(line)[1]))
  const footerTop = Math.min(
    ...added.map((line) => Number(/\^FO\d+,(\d+)/.exec(line)[1])),
  )
  const clearsRail = footerTop >= geometry.leftRailBottom
  const rightOfRail = Math.min(...xs) >= geometry.leftRailRight
  assert.ok(clearsRail || rightOfRail, 'dikey ray ile ÇAKIŞMA yok')
})

test('TF-10: ürün adı, renk, beden ve SKU footer’da GÖRÜNÜR + kontrollü wrap', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  const printZpl = deriveAugmentedSuratZpl(TIGHT_ZPL, [LIVE_ITEM]).printZpl
  const added = printZpl.split(/\r?\n/).filter((l) => l.includes('^FB')).join('\n')
  for (const expected of [
    '1 x ', 'Scuba', 'Renk: Lacivert', 'Beden: 40', 'SCUBA-SEC01',
  ]) {
    assert.ok(added.includes(expected), `eksik: ${expected}`)
  }
  // ^FB: genişlik sınırlı, metin KESİLMEZ (ellipsis/truncation YOK).
  for (const [, width] of added.matchAll(/\^FB(\d+),(\d+),0,L,0/g)) {
    assert.ok(Number(width) > 0 && Number(width) < 799)
  }
  assert.equal(/\.\.\.|…/.test(added), false, 'kırpma YOK')
})

// ═══ TF-12..TF-15: GERÇEK PRODUCTION ŞEKLİ (contentBottom 898) ══════════
//
// Canlı diagnostic: contentBottom=898, maxContentBottomToFit=771 →
// still_overflow. 898 = 706 + 192; burada 192 = ^BXN,8,200 için 8 × 24 ve
// 706 = DataMatrix'in ^FT konumu. Yani ^FT ile konumlanan 2D kod AŞAĞI
// doğru sayılıyordu — oysa ^FT TABAN çizgisidir, kod YUKARI uzar.

const PROD_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO60,20^GB700,90,2^FS',
  '^FT80,50^A0N,24,24^FDSube: FERAH^FS',
  '^FT470,50^A0N,26,26^FDT.No: 10715069128642^FS',
  '^FT90,300^BY3^BCN,130,Y,N,N^FD01256423147^FS',
  '^FO60,330^GB700,140,2^FS',
  '^FT80,360^A0N,24,24^FDSENTETIK ALICI^FS',
  // Canlı vakadaki DataMatrix: ^FT taban 706, ^BXN,8,200 → 8 × 24 = 192.
  '^FT90,706^BXN,8,200^FD7270035470417450^FS',
  '^FT380,660^A0N,40,40^FDKIRIKHAN/05^FS',
  '^FT380,745^A0N,44,44^FDADANA AKTARMA^FS',
  '^FWB', '^FT40,700^A0B,18,18^FDSiparis No: 7270035470417450^FS', '^FWN',
  '^PQ1,0,1,Y', '^XZ',
].join('\n')

test('TF-12: ^FT + ^BX DataMatrix TABAN çizgisidir (898 → şişme YOK)', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const geometry = parseSuratZplGeometry(PROD_ZPL)
  assert.equal(geometry.labelLength, 799)
  // Eski hata: 706 + 192 = 898.
  assert.notEqual(geometry.contentBottom, 898, 'eski şişme tekrarlamamalı')
  assert.ok(
    geometry.contentBottom < 771,
    `canlı eşiğin (maxContentBottomToFit=771) ALTINDA olmalı: ${geometry.contentBottom}`,
  )
  // En alttaki gerçek içerik aktarma satırıdır (^FT 745, font 44).
  assert.ok(geometry.contentBottom >= 745)
})

test('TF-13: ^FO + ^BX hâlâ ÜST kenardır (davranış değişmedi)', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const withFo = parseSuratZplGeometry(
    PROD_ZPL.replace('^FT90,706^BXN,8,200', '^FO90,706^BXN,8,200'),
  )
  const withFt = parseSuratZplGeometry(PROD_ZPL)
  // ^FO aşağı uzar → 706 + 192 = 898'e kadar ölçülür.
  assert.equal(withFo.contentBottom, 898, '^FO davranışı KORUNDU')
  assert.ok(withFt.contentBottom < withFo.contentBottom)
})

test('TF-14: canlı şekil artık AUGMENTED ve footer içeriğe binmez', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const derived = deriveAugmentedSuratZpl(PROD_ZPL, [LIVE_ITEM])
  assert.equal(derived.augmented, true, 'still_overflow BİTTİ')
  assert.equal(derived.augmentationStatus, 'success')
  const geometry = parseSuratZplGeometry(PROD_ZPL)
  assert.ok(derived.metrics.footerTop > geometry.contentBottom, 'içeriğin ALTINDA')
  assert.ok(derived.metrics.footerBottom <= 799 - 8, 'alt kenar payı korunur')
  // Kaynak ve tek sayfa sözleşmesi.
  assert.equal(derived.sourceZpl, PROD_ZPL)
  assert.equal((derived.printZpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^XZ/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^LL0?799/g) ?? []).length, 1)
  assert.equal((derived.printZpl.match(/\^PW799/g) ?? []).length, 1)
  // DataMatrix, barkod, T.No ve rota AYNEN duruyor.
  for (const carrier of [
    '^FT90,706^BXN,8,200^FD7270035470417450^FS',
    '^FT90,300^BY3^BCN,130,Y,N,N^FD01256423147^FS',
    '^FT470,50^A0N,26,26^FDT.No: 10715069128642^FS',
    '^FT380,745^A0N,44,44^FDADANA AKTARMA^FS',
  ]) {
    assert.ok(derived.printZpl.includes(carrier), `bozuldu: ${carrier.slice(0, 22)}`)
  }
})

test('TF-15: ^FT + ^BC yorum satırı payı AŞAĞI eklenir, çubuklar YUKARI', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const base = ['^XA', '^PW799', '^LL0799', '^FO60,20^GB700,90,2^FS',
    '^FO90,300^BXN,5,200^FD777^FS',
    '^FWB', '^FT40,600^A0B,18,18^FDRay^FS', '^FWN']
  // Yorum satırı ALTA basılır (f=Y, g=N) → aşağı pay VAR.
  const below = parseSuratZplGeometry(
    [...base, '^FT100,500^BY3^BCN,130,Y,N,N^FD012^FS', '^XZ'].join('\n'))
  // Yorum satırı HİÇ basılmaz (f=N) → aşağı pay YOK.
  const none = parseSuratZplGeometry(
    [...base, '^FT100,500^BY3^BCN,130,N,N,N^FD012^FS', '^XZ'].join('\n'))
  assert.ok(
    below.contentBottom > none.contentBottom,
    `yorum satırı payı: ${below.contentBottom} > ${none.contentBottom}`,
  )
  // Çubuklar YUKARI uzadığı için taban 500'ün çok altına inilmez.
  assert.ok(none.contentBottom <= 500, `taban aşılmamalı: ${none.contentBottom}`)
})

// ═══ TF-16..TF-19: DURUSOFT CİLA TURU (yalnız augmentation katmanı) ═════

const LONG_ITEM = {
  quantity: 1,
  productName:
    'Scuba Secil Detayli Tesettur Lacivert Abiye Elbise Uzun Kollu Dik Yaka Ozel Gun',
  color: 'Lacivert',
  size: '40',
  sku: 'SCUBA-SEC01',
}
const ROOMY = {
  ok: true, printWidth: 799, labelLength: 799,
  leftRailRight: 61, contentBottom: 700,
}

test('TF-16: metin TEK sürekli ^FB bloğunda akar (başlık/meta ZORLA ayrılmaz)', async () => {
  const { planSuratFooter, buildFooterZplCommands } = await load(
    '/src/utils/suratZplProductLine.ts')
  const plan = planSuratFooter([LONG_ITEM], ROOMY)
  assert.equal(plan.ok, true)
  // Ürün başına TEK blok → DuruSoft gibi doğal sarma.
  assert.equal(plan.blocks[0].length, 1, 'iki bloklu biçim KALDIRILDI')
  const commands = buildFooterZplCommands(plan, { utf8: true })
  assert.equal(commands.length, 1, 'tek ^FB komutu')
  // Başlık ve meta AYNI bloktadır.
  assert.match(commands[0], /1 x Scuba .*\(Renk: Lacivert, Beden: 40\) \[SCUBA-SEC01\]/)
})

// SÖZLEŞME GÜNCELLENDİ: eski hedef "satır sayısını azalt" idi; fiziksel
// referans (DuruSoft termal çıktı) ise DAHA BÜYÜK FONT + SARMA gösteriyor.
// Yeni hedef: yer varken en büyük fontu kullan ve banda SIĞ.
test('TF-17: sürekli akış — yer varken EN BÜYÜK font, taşma YOK', async () => {
  const { planSuratFooter } = await load('/src/utils/suratZplProductLine.ts')
  const plan = planSuratFooter([LONG_ITEM], ROOMY)
  // Tek sürekli blok korunur (başlık/meta ZORLA ayrılmaz).
  assert.equal(plan.blocks[0].length, 1)
  // EN BÜYÜK okunur font seçilir.
  assert.equal(plan.profile.key, 'wrapped-standard')
  assert.equal(plan.profile.fontHeight, 20)
  // Sarma serbesttir; TEK KATI KURAL banda sığmaktır (sessiz kırpma YOK).
  assert.ok(plan.blocks[0][0].lines >= 2)
  assert.ok(
    plan.usedHeight <= plan.area.height,
    `footer taşıyor: ${plan.usedHeight} > ${plan.area.height}`,
  )
})

test('TF-18: dar alanda ara kademe DAHA BÜYÜK fontu tercih eder', async () => {
  const { planSuratFooter, SURAT_FOOTER_PROFILES } = await load(
    '/src/utils/suratZplProductLine.ts')
  assert.deepEqual(
    SURAT_FOOTER_PROFILES.map((p) => p.key),
    // SIRA GÜNCELLENDİ (fiziksel okunabilirlik turu): BÜYÜK FONT → WRAP →
    // ancak son çare SHRINK. Her `wrapped-*` profili, KENDİNDEN KÜÇÜK
    // fontlu `single-line-*` profilinden ÖNCE gelir.
    [
      'single-line-standard', 'wrapped-standard',
      'single-line-compact', 'wrapped-compact',
      'single-line-dense', 'wrapped-dense',
      'wrapped-mid', 'single-line-micro', 'wrapped-micro',
    ],
  )
  // MERDİVEN KURALI makine tarafından da doğrulanır: font yüksekliği
  // ARTMAZ (monoton azalır) — böylece "önce büyük" garantisi kilitlenir.
  const heights = SURAT_FOOTER_PROFILES.map((profile) => profile.fontHeight)
  for (let index = 1; index < heights.length; index += 1) {
    assert.ok(
      heights[index] <= heights[index - 1],
      `merdivende font BÜYÜMEMELİ: ${heights[index - 1]} → ${heights[index]}`,
    )
  }
  // Okunabilirlik tabanı korunuyor.
  for (const profile of SURAT_FOOTER_PROFILES) {
    assert.ok(profile.fontHeight >= 12, `çok küçük font: ${profile.key}`)
  }
  // Canlı dar alan (31 dot): eskiden 12 dot'luk micro seçiliyordu.
  const tight = parseTight()
  const plan = planSuratFooter([LIVE_SHORT_ITEM], tight)
  assert.equal(plan.ok, true)
  assert.equal(plan.profile.fontHeight, 14, 'daha büyük okunur font seçildi')
  assert.equal(plan.profile.key, 'wrapped-mid')
  assert.ok(plan.usedHeight <= plan.area.height)
})

test('TF-19: cila turu OVERFLOW çözümünü BOZMAZ', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  // Canlı 898 şekli hâlâ augmented.
  const live = deriveAugmentedSuratZpl(PROD_ZPL, [LIVE_ITEM])
  assert.equal(live.augmented, true)
  assert.equal(live.augmentationStatus, 'success')
  // Alan gerçekten yoksa yine EKLENMEZ.
  const noRoom = PROD_ZPL.replace(
    '^FT380,745^A0N,44,44^FDADANA AKTARMA^FS',
    '^FO380,782^A0N,44,44^FDADANA AKTARMA^FS',
  )
  assert.notEqual(noRoom, PROD_ZPL, 'fixture GERÇEKTEN değişmeli')
  const blocked = deriveAugmentedSuratZpl(noRoom, [LIVE_ITEM])
  assert.equal(blocked.augmented, false)
  assert.equal(blocked.printZpl, noRoom, 'kaynak AYNEN')
})

// Canlı dar geometri + canlı (kısa) ürün adı.
const LIVE_SHORT_ITEM = {
  quantity: 1,
  productName: 'Scuba Secil Detayli Tesettur Lacivert Elbise',
  color: 'Lacivert',
  size: '40',
  sku: 'SCUBA-SEC01',
}
function parseTight() {
  return {
    ok: true, printWidth: 799, labelLength: 799,
    leftRailRight: 61, contentBottom: 754,
  }
}

// ═══ TF-20..TF-24: DÖNDÜRÜLMÜŞ RAY GEOMETRİSİ + SOL SINIR ══════════════
//
// DuruSoft footer'ı etiketin sol fiziksel kenarına yakın başlar. Bizimki
// dikey "Sipariş No" rayının sağından başlıyordu, çünkü döndürülmüş metin
// yön (orientation) gözetmeden origin'den AŞAĞI uzatılıyordu: ^FWB rayı için
// bu, ^LL'yi (799) aşan sahte bir alt sınır üretiyordu (700 + 312 = 1012).
// ^FWB alttan üste okunur; ray origin'den YUKARI uzar.

test('TF-20: ^FWB ray gerçek kutusuyla ölçülür (YUKARI uzar)', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const geometry = parseSuratZplGeometry(PROD_ZPL)
  const rail = geometry.elements.filter((element) => element.rotated)
  assert.equal(rail.length > 0, true, 'ray ölçüldü')
  // Origin y=700; metin YUKARI uzadığı için kutu 700'ün ÜSTÜNDE kalır.
  assert.ok(rail[0].y < 700, `ray üste uzamalı: y=${rail[0].y}`)
  assert.equal(rail[0].y + rail[0].height, 700, 'alt kenar = origin')
  // Eksenler yer değiştirir: genişlik karakter hücresi, yükseklik metin boyu.
  assert.ok(rail[0].height > rail[0].width, 'dikey metin: h > w')
})

test('TF-21: ray alt sınırı ^LL DIŞINA taşmaz (sahte 1012 YOK)', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const geometry = parseSuratZplGeometry(PROD_ZPL)
  assert.equal(geometry.labelLength, 799)
  assert.notEqual(geometry.leftRailBottom, 1012, 'eski sahte değer')
  assert.ok(
    geometry.leftRailBottom > 0 && geometry.leftRailBottom <= geometry.labelLength,
    `ray alt sınırı etiket içinde olmalı: ${geometry.leftRailBottom}`,
  )
  // Hiçbir döndürülmüş öge etiket boyunu aşmamalı.
  for (const element of geometry.elements.filter((e) => e.rotated)) {
    assert.ok(
      element.y + element.height <= geometry.labelLength,
      `döndürülmüş öge taştı: ${element.y + element.height}`,
    )
  }
})

test('TF-22: footer rayla ÇAKIŞMAZ', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const { planSuratFooter } = await load('/src/utils/suratZplProductLine.ts')
  const geometry = parseSuratZplGeometry(PROD_ZPL)
  const plan = planSuratFooter([LIVE_ITEM], geometry)
  assert.equal(plan.ok, true)
  // Footer ya rayın ALTINDA başlar ya da rayın SAĞINDA kalır.
  const belowRail = plan.area.top >= geometry.leftRailBottom
  const rightOfRail = plan.area.x >= geometry.leftRailRight
  assert.ok(belowRail || rightOfRail, 'ray ile çakışma YOK')
  assert.equal(belowRail, true, 'bu şekilde footer rayın altındadır')
})

test('TF-23: footer sol sınırı DuruSoft gibi sola yaklaşır', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const { planSuratFooter } = await load('/src/utils/suratZplProductLine.ts')
  const geometry = parseSuratZplGeometry(PROD_ZPL)
  const plan = planSuratFooter([LIVE_ITEM], geometry)
  // ÖNCE: leftRailRight + 8 = 69. SONRA: sol kenar payı.
  assert.ok(plan.area.x < geometry.leftRailRight, `sola yaklaşmalı: ${plan.area.x}`)
  assert.equal(plan.area.x, 16)
  // Daha geniş alan → daha büyük okunur font.
  assert.ok(plan.area.width > 760, `genişlik arttı: ${plan.area.width}`)
  // Daha geniş alan → daha büyük okunur font. Cila turu ÖNCESİ bu şekilde
  // 12 dot'luk micro kademe seçiliyordu.
  assert.ok(plan.profile.fontHeight >= 14, `font büyüdü: ${plan.profile.fontHeight}`)
  assert.ok(plan.profile.fontHeight > 12, 'micro kademeden kurtuldu')
})

test('TF-24: ray ÖLÇÜLEMEZSE muhafazakâr sol sınır KORUNUR', async () => {
  const { planSuratFooter } = await load('/src/utils/suratZplProductLine.ts')
  // leftRailBottom = 0 → genişletme YAPILMAZ.
  const unmeasured = {
    ok: true, printWidth: 799, labelLength: 799,
    leftRailRight: 61, leftRailBottom: 0, contentBottom: 700,
  }
  assert.equal(planSuratFooter([LIVE_ITEM], unmeasured).area.x, 69)
  // Footer rayın alt kenarının ÜSTÜNDE kalıyorsa da genişletme YAPILMAZ.
  const overlapping = {
    ok: true, printWidth: 799, labelLength: 799,
    leftRailRight: 61, leftRailBottom: 780, contentBottom: 700,
  }
  assert.equal(planSuratFooter([LIVE_ITEM], overlapping).area.x, 69)
})

// ═══ TF-25..TF-28: ÜRÜN TEKİLLEŞTİRME (DuruSoft kompaktlığı) ═══════════

test('TF-25: AYNI ürünün tekrar satırları TEK satırda toplanır', async () => {
  const { aggregateProductLineItems, buildProductLineText } = await load(
    '/src/utils/suratZplProductLine.ts')
  const merged = aggregateProductLineItems([
    { productName: 'Elbise', quantity: 1, color: 'Lacivert', size: '40', sku: 'S1' },
    { productName: 'Elbise', quantity: 1, color: 'Lacivert', size: '40', sku: 'S1' },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].quantity, 2)
  assert.match(buildProductLineText(merged[0]), /^2 x Elbise /)
})

test('TF-26: FARKLI varyant/SKU ASLA birleştirilmez', async () => {
  const { aggregateProductLineItems } = await load(
    '/src/utils/suratZplProductLine.ts')
  const base = { productName: 'Elbise', quantity: 1, color: 'Lacivert', size: '40', sku: 'S1' }
  for (const farkli of [
    { ...base, color: 'Siyah' },
    { ...base, size: '42' },
    { ...base, sku: 'S2' },
    { ...base, productName: 'Etek' },
  ]) {
    const merged = aggregateProductLineItems([base, farkli])
    assert.equal(merged.length, 2, `birleştirilmemeli: ${JSON.stringify(farkli)}`)
    assert.equal(merged[0].quantity, 1)
    assert.equal(merged[1].quantity, 1)
  }
})

test('TF-27: tekilleştirme sıra KORUR ve adetleri TOPLAR', async () => {
  const { aggregateProductLineItems } = await load(
    '/src/utils/suratZplProductLine.ts')
  const merged = aggregateProductLineItems([
    { productName: 'Etek', quantity: 1, color: 'Siyah', size: '38', sku: 'E1' },
    { productName: 'Elbise', quantity: 2, color: 'Lacivert', size: '40', sku: 'S1' },
    { productName: 'Etek', quantity: 3, color: 'Siyah', size: '38', sku: 'E1' },
  ])
  assert.deepEqual(merged.map((i) => [i.productName, i.quantity]), [
    ['Etek', 4], ['Elbise', 2],
  ])
})

test('TF-28: footer planı tekilleştirilmiş listeyi kullanır (daha kompakt)', async () => {
  const { planSuratFooter } = await load('/src/utils/suratZplProductLine.ts')
  const geometry = {
    ok: true, printWidth: 799, labelLength: 799,
    leftRailRight: 61, leftRailBottom: 700, contentBottom: 700,
  }
  const tekrar = Array.from({ length: 3 }, () => ({
    productName: 'Elbise', quantity: 1, color: 'Lacivert', size: '40', sku: 'S1',
  }))
  const plan = planSuratFooter(tekrar, geometry)
  assert.equal(plan.ok, true)
  assert.equal(plan.blocks.length, 1, 'üç satır TEK bloğa indi')
  assert.match(plan.blocks[0][0].text, /^3 x Elbise /)
})

test('TF-11: alan gerçekten yetmiyorsa ürün satırı EKLENMEZ (sessiz kırpma yok)', async () => {
  const { deriveAugmentedSuratZpl } = await load('/src/utils/augmentedSuratZpl.ts')
  // İçerik etiketin en dibine kadar inen şablon.
  const noRoom = TIGHT_ZPL.replace(
    '^FT380,745^A0N,44,44^FDADANA AKTARMA^FS',
    '^FO380,780^A0N,44,44^FDADANA AKTARMA^FS',
  )
  const derived = deriveAugmentedSuratZpl(noRoom, [LIVE_ITEM])
  assert.equal(derived.augmented, false)
  assert.equal(derived.augmentationStatus, 'overflow')
  assert.equal(derived.printZpl, noRoom, 'kaynak AYNEN kullanılır')
})
