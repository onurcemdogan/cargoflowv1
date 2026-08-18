import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// P5/ARAS — TAŞIYICI-NÖTR TEMEL.
//
// Bu dosya İKİNCİ BİR TAŞIYICI UYGULAMAZ. Aras'ın dış sözleşmesi repoda YOK
// (bkz. P5_AUDIT.md) ve uydurulmayacaktır. Burada ölçülen tek şey şudur:
// Sürat'a özel kod, KENDİSİNE AİT OLMAYAN gönderileri sahiplenmiyor mu?
//
// Bu, taşıyıcı-nötr temelin sözleşmeden BAĞIMSIZ yarısıdır: ikinci taşıyıcı
// eklendiğinde Sürat yolunun onun gönderilerine el koymaması GEREKİR ve bu
// bugün ölçülebilir.
//
// Ağ YOK, DB YOK, gerçek taşıyıcı çağrısı YOK.

const here = dirname(fileURLToPath(import.meta.url))
const read = (...parts) =>
  readFileSync(join(here, ...parts), 'utf8').split('\r\n').join('\n')

const SOURCE = read('index.mjs')
const PROVIDER = await import('./shipments/suratProvider.ts')
const PLAN = read('..', 'src', 'utils', 'suratCreatePrintPlan.ts')
const REGISTRY = read('..', 'src', 'dashboard', 'providerRegistry.ts')

/* ═══ KANONİK SAĞLAYICI ANAHTARI ═════════════════════════════════════ */

test('CN-1: DB saglayici anahtari TEK kanonik dizedir', () => {
  // Gorunen ad ('Surat Kargo Marketplace') ile DB anahtari AYNI SEY DEGILDIR.
  // Karisirsa kayitli etiket bulunamaz (uretimde yasanmis kok neden).
  assert.equal(PROVIDER.SURAT_PERSISTENCE_PROVIDER, 'surat')
})

test('CN-2: gorunen ad dogrulamasi DB anahtari olarak KULLANILMAZ', () => {
  // Yardimci yalniz DOGRULAMA icindir; genis eslesir.
  assert.equal(PROVIDER.isSuratProviderName('Sürat Kargo Marketplace'), true)
  assert.equal(PROVIDER.isSuratProviderName('surat-kargo'), true)
  // Yabanci tasiyicilar bu yardimciya UYMAZ.
  for (const foreign of ['Aras Kargo', 'Yurtiçi', 'MNG', 'PTT', 'UPS']) {
    assert.equal(
      PROVIDER.isSuratProviderName(foreign), false,
      `${foreign} Surat sanildi`,
    )
  }
})

/* ═══ SÜRAT YOLU YABANCI GÖNDERİYİ SAHİPLENMEZ ══════════════════════ */

test('CN-3: create on kontrolu YABANCI tasiyiciyi ENGELLER', () => {
  // `suratAssigned === false` create'i kapatan kosullardan BIRIDIR.
  assert.match(SOURCE, /suratAssigned !== false,/)
  const gateAt = SOURCE.indexOf('const canCallGonderiyiKargoyaGonder = Boolean(')
  const end = SOURCE.indexOf(')', SOURCE.indexOf('suratAssigned !== false,'))
  assert.ok(gateAt > 0 && end > gateAt, 'create on kontrolu bulunamadi')
  // canCallSurat AYNI degerden turer; ayri/gevsek bir yol OLMAMALI.
  assert.match(SOURCE, /canCallSurat: canCallGonderiyiKargoyaGonder,/)
  // Route bu bayrak dusukse DERHAL doner.
  assert.match(SOURCE, /if \(!trendyolPreflight\.canCallSurat\) \{/)
})

test('CN-4: istemci plani DESTEKLENMEYEN tasiyiciyi ayri kovaya koyar', () => {
  // Yabanci tasiyici akisi COKERTMEZ; ayri "blocked" sonucu olur.
  assert.match(PLAN, /UNSUPPORTED_CARRIER_MESSAGE/)
  assert.match(PLAN, /if \(!input\.isSuratOrder\(order\)\) \{/)
  // Ayni gecişte create kuyruguna DUSMEZ.
  const at = PLAN.indexOf('if (!input.isSuratOrder(order)) {')
  const needsCreateAt = PLAN.indexOf('plan.needsCreate.push')
  assert.ok(at > 0 && at < needsCreateAt)
})

/* ═══ SAĞLAYICI KAYDI GENİŞLEMEYE AÇIK ══════════════════════════════ */

test('CN-5: tasiyici kaydi cok saglayicili ve Aras KAPALI duruyor', () => {
  assert.match(REGISTRY, /export const carrierProviderRegistry/)
  // Aras yalnizca GORUNUM kaydidir; entegrasyon DEGILDIR.
  assert.match(REGISTRY, /aras: \{[\s\S]*?enabled: false,/)
  // Surat TEK etkin tasiyicidir; ikinci bir taşıyıcı sessizce acilmamali.
  const enabled = [...REGISTRY.matchAll(/(\w+): \{[\s\S]*?enabled: (true|false),/g)]
  const carrierStart = REGISTRY.indexOf('carrierProviderRegistry')
  const enabledCarriers = enabled
    .filter((m) => m.index > carrierStart && m[2] === 'true')
    .map((m) => m[1])
  assert.deepEqual(
    enabledCarriers, ['surat'],
    `beklenmeyen etkin tasiyici: ${enabledCarriers.join(', ')}`,
  )
})

/* ═══ BİLİNEN VE BİLEREK ALINAN VARSAYILAN ══════════════════════════ */

test('CN-6: tasiyici adi YOKSA Surat varsayilir — BILINCLI ve TEK YERDE', () => {
  // OLCUM: `suratAssigned` yalniz cargoProviderName VARSA hesaplanir; yoksa
  // null kalir ve `!== false` kosulundan GECER. Istemci plani da ayni sekilde
  // bos adi Surat sayar.
  //
  // NEDEN BUGUN DOGRU: Trendyol paketi Picking'e alinmadan cargoProviderName
  // BOS gelebilir; bunu bloklamak calisan akisi durdururdu. Surat da su an TEK
  // etkin tasiyicidir (CN-5), yani "bilinmeyen" ile "Surat" pratikte ayni.
  //
  // NEDEN IKINCI TASIYICIDA DEGISMELI: Aras etkinlestiginde adi bos bir
  // siparis Surat yoluna girmeye devam eder ve YANLIS tasiyiciya gidebilir.
  // Bu test o gunun sessizce gelmesini ENGELLER: davranis degistiginde burasi
  // duser ve karar BILINCLI verilir.
  assert.match(SOURCE, /const suratAssigned = cargoProviderName\n\s*\? isSuratCargoProviderName\(cargoProviderName\)\n\s*: null/)
  assert.match(PLAN, /isSuratOrder: \(order: CargoOrder\) => boolean/)
  const app = read('..', 'src', 'App.tsx')
  assert.match(app, /!order\.cargoProviderName \|\|/)
})

/* ═══ İKİNCİ TAŞIYICI İÇİN GEREKEN — HENÜZ YOK ══════════════════════ */

test('CN-7: Aras icin uydurma wire sozlesmesi YOK', () => {
  // P5 sinirinin kendisi test edilir: dis sozlesme gelmeden Aras'a ait
  // endpoint/auth/alan adi repoya GIRMEMELIDIR.
  const forbidden = /aras[A-Za-z]*(Client|Adapter|Endpoint|Soap|Rest|Wsdl)/i
  assert.equal(
    forbidden.test(SOURCE), false,
    'index.mjs icinde Aras adaptor/endpoint izi var — sozlesme YOK',
  )
  assert.equal(forbidden.test(PLAN), false)
})
