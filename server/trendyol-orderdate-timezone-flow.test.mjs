// TRENDYOL-ORDERDATE-TZ-001 — `orderDate` GMT+3 ÇİFT DÖNÜŞÜMÜ.
//
// ═══ RESMÎ SÖZLEŞME (developers.trendyol.com, v3.0 Get Shipment Packages) ══
//
//   "The orderDate is in timestamp (milliseconds) format GMT +3,
//    while createdDate is in GMT format."
//
// Uç nokta aynı sayfada v2'dir:
//   /integration/order/sellers/{sellerId}/v2/orders
// Resmî örnek değer: orderDate = 1762253333685
//
// ═══ ÖLÇÜLEN ÜRETİM KUSURU ═══════════════════════════════════════════════
//
//   ham orderDate             1789418160000
//   new Date(raw).toISO()     2026-09-14T20:36:00.000Z
//   Trendyol duvar saati      14.09.2026 20:36   ← DOĞRU
//   ESKİ etiket çıktısı       14.09.2026 23:36   ← ÜRETİMDE GÖRÜLEN (+3)
//   YENİ etiket çıktısı       14.09.2026 20:36
//
// Kök neden: `orderDate` düz UTC epoch sanılıyor, ardından formatlayıcı onu
// Europe/Istanbul'a çeviriyordu → +03 İKİ KEZ.
//
// Düzeltme SAĞLAYICI SINIRINDADIR. Genel formatlayıcı DEĞİŞMEDİ; sözleşmesi
// hâlâ "gerçek UTC anı → Europe/Istanbul, TEK dönüşüm"dür.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

/** Resmî dokümandaki örnek `orderDate`. */
const OFFICIAL_SAMPLE_ORDER_DATE = 1_762_253_333_685
/** Üretim gözlemi sınıfı: Trendyol duvar saati 14.09.2026 20:36. */
const OBSERVED_ORDER_DATE = Date.UTC(2026, 8, 14, 20, 36, 0)
const OBSERVED_CORRECT_LABEL = '14.09.2026 20:36'
const OBSERVED_BUGGY_LABEL = '14.09.2026 23:36'
/** Trendyol'un GMT+3 ofseti (dakika). */
const OFFSET_MS = 180 * 60_000

let _vite
let normalizeTrendyolOrderDate
let normalizeTrendyolGmtTimestamp
let TRENDYOL_TIMESTAMP_CONTRACT
let formatLabelOrderDateTime
let normalizeHistoricalPackage
let composeSuratLabel

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({
    normalizeTrendyolOrderDate,
    normalizeTrendyolGmtTimestamp,
    TRENDYOL_TIMESTAMP_CONTRACT,
  } = await _vite.ssrLoadModule('/server/marketplaces/trendyolOrderDate.ts'))
  ;({ formatLabelOrderDateTime } = await _vite.ssrLoadModule(
    '/src/utils/labelOrderDateTime.ts',
  ))
  ;({ normalizeHistoricalPackage } = await _vite.ssrLoadModule(
    '/server/trendyol/historicalOrderFetch.ts',
  ))
  ;({ composeSuratLabel } = await _vite.ssrLoadModule(
    '/src/utils/suratLabelComposer.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

/** Trendyol'un KASTETTİĞİ duvar saati = ham epoch'un UTC okuması. */
const trendyolWallClock = (raw) => {
  const iso = new Date(raw).toISOString()
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`
}

// ═══ TZ-1 / TZ-2 — NORMALİZASYON VE ÇİFT DÖNÜŞÜM ════════════════════════

test('TZ-1: resmî orderDate ornegi DOGRU mutlak ana normalize olur', () => {
  const normalized = normalizeTrendyolOrderDate(OFFICIAL_SAMPLE_ORDER_DATE)
  assert.equal(
    normalized,
    new Date(OFFICIAL_SAMPLE_ORDER_DATE - OFFSET_MS).toISOString(),
    'GMT+3 epoch -3 saat ile mutlak ana cevrilmeli',
  )
  // Ham deger DUZ UTC sayilsaydi bu esitlik TUTMAZDI.
  assert.notEqual(normalized, new Date(OFFICIAL_SAMPLE_ORDER_DATE).toISOString())
})

test('TZ-2: +03 IKI KEZ uygulanmaz — normalize + format = Trendyol duvar saati', () => {
  for (const raw of [OFFICIAL_SAMPLE_ORDER_DATE, OBSERVED_ORDER_DATE, 1_757_000_000_000]) {
    const display = formatLabelOrderDateTime(normalizeTrendyolOrderDate(raw))
    assert.equal(
      display,
      trendyolWallClock(raw),
      `raw=${raw} icin gosterim Trendyol duvar saatine ESIT olmali`,
    )
  }
})

// ═══ TZ-3 — GERÇEK ZİNCİR: 20:36 SINIFI ═════════════════════════════════

test('TZ-3: gozlenen 20:36 siparisi etikette 20:36 basar (23:36 DEGIL)', async () => {
  // GERCEK ZINCIR: saglayici paketi -> v2 normalizasyonu -> compose girdisi
  // -> composer -> ETIKET METNI. Yalniz tarih yardimcisi test EDILMEZ.
  const pack = normalizeHistoricalPackage({
    shipmentPackageId: '123456789',
    orderNumber: '1146787001',
    status: 'Created',
    orderDate: OBSERVED_ORDER_DATE,
    shipmentAddress: { city: 'ISTANBUL', district: 'KADIKOY' },
    lines: [],
  })
  assert.equal(
    pack.orderDate,
    new Date(OBSERVED_ORDER_DATE - OFFSET_MS).toISOString(),
    'v2 normalizasyonu duzeltilmis normalizeri KULLANMALI',
  )

  const zpl = readFileSync(
    join(here, 'fixtures', 'surat-real-v2-numeric.zpl'),
    'utf8',
  )
  const result = composeSuratLabel(zpl, {
    cargoTrackingNumber: '7270034422363739',
    orderDate: pack.orderDate,
  })
  assert.equal(result.composed, true, result.reason ?? '')
  assert.ok(
    result.zpl.includes(OBSERVED_CORRECT_LABEL),
    `etikette ${OBSERVED_CORRECT_LABEL} bulunmali`,
  )
  assert.equal(
    result.zpl.includes(OBSERVED_BUGGY_LABEL),
    false,
    `ESKI KUSUR: ${OBSERVED_BUGGY_LABEL} ARTIK BASILMAMALI`,
  )
})

// ═══ TZ-4 / TZ-9 — GENEL FORMATLAYICI SÖZLEŞMESİ KORUNUR ════════════════

test('TZ-4: genel UTC -> Istanbul donusumu TAM BIR KEZ yapilir', () => {
  assert.equal(formatLabelOrderDateTime('2026-09-12T18:28:00Z'), '12.09.2026 21:28')
  // Kis saati (yine +03; Turkiye'de DST YOK) ve gun sinirinda da tek donusum.
  assert.equal(formatLabelOrderDateTime('2026-01-15T22:30:00Z'), '16.01.2026 01:30')
})

test('TZ-9: naive (ofsetsiz) zaman dizgisi HALA REDDEDILIR', () => {
  for (const naive of ['2026-09-12 18:28', '2026-09-12T18:28:00', '12.09.2026 21:28']) {
    assert.equal(
      formatLabelOrderDateTime(naive),
      '',
      `naive deger kabul EDILMEMELI: ${naive}`,
    )
  }
})

// ═══ TZ-5 / TZ-12 — orderDate ≠ createdDate ═════════════════════════════

test('TZ-5: createdDate, orderDate semantigi ile ISLENMEZ', () => {
  const raw = OFFICIAL_SAMPLE_ORDER_DATE
  // createdDate DUZ GMT'dir: kaydirma UYGULANMAZ.
  assert.equal(normalizeTrendyolGmtTimestamp(raw), new Date(raw).toISOString())
  // Iki fonksiyonun sonucu TAM 3 saat FARKLI olmalidir.
  const delta =
    Date.parse(normalizeTrendyolGmtTimestamp(raw)) -
    Date.parse(normalizeTrendyolOrderDate(raw))
  assert.equal(delta, OFFSET_MS, 'orderDate ve createdDate 3 saat farkli yorumlanir')

  // KAYNAK SOZLESMESI: ingest yolunda duzeltme YALNIZ orderDate'e baglidir.
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(index, /normalizeTrendyolOrderDate\(item\.orderDate\)/)
  assert.equal(
    /normalizeTrendyolOrderDate\(\s*item\.createdDate/.test(index),
    false,
    'createdDate orderDate normalizerinden GECIRILMEMELI',
  )
})

test('TZ-12: resmî ornek uzerinde iki alanin anlam farki SABITLENIR', () => {
  assert.equal(TRENDYOL_TIMESTAMP_CONTRACT.orderDate, 'GMT+3')
  assert.equal(TRENDYOL_TIMESTAMP_CONTRACT.createdDate, 'GMT')
  const raw = OFFICIAL_SAMPLE_ORDER_DATE
  // orderDate: duvar saati = ham epoch'un UTC okumasi.
  assert.equal(
    formatLabelOrderDateTime(normalizeTrendyolOrderDate(raw)),
    trendyolWallClock(raw),
  )
  // createdDate: gercek UTC an -> Istanbul = +3 (duvar saati FARKLI).
  assert.notEqual(
    formatLabelOrderDateTime(normalizeTrendyolGmtTimestamp(raw)),
    trendyolWallClock(raw),
  )
})

// ═══ TZ-6 — V2 İNGESTİON ════════════════════════════════════════════════

test('TZ-6: v2 siparis alimi (canli + backfill) duzeltilmis normalizeri kullanir', () => {
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const historical = readFileSync(
    join(here, 'trendyol', 'historicalOrderFetch.ts'),
    'utf8',
  )
  // Iki Trendyol alim yolu da AYNI normalizeri kullanir.
  assert.match(index, /normalizeTrendyolOrderDate\(item\.orderDate\)/)
  assert.match(historical, /normalizeTrendyolOrderDate\(item\.orderDate\)/)
  // Eski, duzeltmesiz cagri GERI DONMEMELI.
  assert.equal(
    /const orderDate = toIsoDate\(item\.orderDate\)/.test(index),
    false,
    'duzeltmesiz toIsoDate(orderDate) geri gelmis',
  )
  assert.equal(
    /orderDate: toIso\(item\.orderDate\)/.test(historical),
    false,
    'backfill duzeltmesiz toIso(orderDate) kullaniyor',
  )
  // Yol UCU v2'dir (emekli v1 yoluna baglanmadigimiz ayrica kilitli).
  assert.match(historical, /buildTrendyolOrdersV2Url/)

  // FIXTURE ile davranissal kanit: v2 fixture'indaki paket dogru normalize olur.
  const pack = normalizeHistoricalPackage({
    shipmentPackageId: '987',
    orderNumber: 'TY-1',
    orderDate: OFFICIAL_SAMPLE_ORDER_DATE,
    shipmentAddress: {},
    lines: [],
  })
  assert.equal(
    pack.orderDate,
    new Date(OFFICIAL_SAMPLE_ORDER_DATE - OFFSET_MS).toISOString(),
  )
})

// ═══ TZ-8 — SAĞLAYICI İZOLASYONU ════════════════════════════════════════

test('TZ-8: Trendyol DISI saglayici yollari ETKILENMEZ', () => {
  const hepsiburada = readFileSync(
    join(here, 'marketplaces', 'hepsiburada', 'hepsiburadaOrderSource.ts'),
    'utf8',
  )
  assert.equal(
    hepsiburada.includes('normalizeTrendyolOrderDate'),
    false,
    'Trendyol semantigi Hepsiburada yoluna SIZMIS',
  )
  assert.equal(
    hepsiburada.includes('trendyolOrderDate'),
    false,
    'Trendyol zaman modulu HB tarafindan import EDILMEMELI',
  )
  // GENEL KATMANLARA SAAT DILIMI SEMANTIGI SIZMAZ.
  //
  // DIKKAT — DAR ARAMA: burada "trendyol kelimesi gecmesin" ARANMAZ.
  // `orderMapper` bu degisiklikten ONCE de Trendyol'dan soz ediyordu
  // (varsayilan pazaryeri degeri ve aciklamalar). Onemli olan kelime degil,
  // ZAMAN DILIMI DONUSUMUNUN orada olup olmadigidir.
  for (const generic of [
    join(here, '..', 'src', 'utils', 'labelOrderDateTime.ts'),
    join(here, 'orders', 'orderMapper.ts'),
  ]) {
    const source = readFileSync(generic, 'utf8')
    assert.equal(
      source.includes('normalizeTrendyolOrderDate'),
      false,
      `genel katman saglayici normalizerini cagiriyor: ${generic}`,
    )
    assert.equal(
      source.includes('trendyolOrderDate'),
      false,
      `genel katman saglayici zaman modulunu import ediyor: ${generic}`,
    )
    // Elle kaydirma da YOK: "3 saat" aritmetigi genel katmanda bulunmamali.
    assert.equal(
      /180\s*\*\s*60|3\s*\*\s*3600|10800000/.test(source),
      false,
      `genel katmanda elle +/-3 saat kaydirmasi var: ${generic}`,
    )
  }
  // Duzeltme YALNIZ Trendyol modulunde tanimlidir.
  const contract = readFileSync(
    join(here, 'marketplaces', 'trendyolOrderDate.ts'),
    'utf8',
  )
  assert.match(contract, /GMT \+3|GMT\+3/)
})

// ═══ TZ-10 — TEK KANONİK AN, TÜM YÜZEYLER ══════════════════════════════

test('TZ-10: projeksiyon ve etiket AYNI kanonik ani cozer', () => {
  const pack = normalizeHistoricalPackage({
    shipmentPackageId: '555',
    orderNumber: 'TY-2',
    orderDate: OBSERVED_ORDER_DATE,
    shipmentAddress: {},
    lines: [],
  })
  // Kanonik an TEKTIR: DB'ye giden deger ile etikete giden deger AYNI.
  const canonical = pack.orderDate
  assert.equal(canonical, new Date(OBSERVED_ORDER_DATE - OFFSET_MS).toISOString())
  // Her yuzey AYNI kanonik andan AYNI duvar saatini uretir; yuzeyler kendi
  // saat dilimi yorumunu UYGULAMAZ.
  const label = formatLabelOrderDateTime(canonical)
  const listing = formatLabelOrderDateTime(new Date(canonical))
  assert.equal(label, OBSERVED_CORRECT_LABEL)
  assert.equal(listing, label, 'iki yuzey ayni ani FARKLI gosteremez')
})

// ═══ TZ-11 — SUNUCU SAAT DİLİMİ ETKİSİZ ═════════════════════════════════

test('TZ-11: sunucu/tarayici saat dilimi normalize sonucunu DEGISTIRMEZ', () => {
  const original = process.env.TZ
  const results = []
  try {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/Istanbul']) {
      process.env.TZ = zone
      results.push({
        zone,
        epoch: normalizeTrendyolOrderDate(OBSERVED_ORDER_DATE),
        naive: normalizeTrendyolOrderDate('2026-09-14 20:36:00'),
      })
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
  const expectedEpoch = new Date(OBSERVED_ORDER_DATE - OFFSET_MS).toISOString()
  for (const entry of results) {
    assert.equal(entry.epoch, expectedEpoch, `${entry.zone}: epoch sonucu kaydi`)
    // Naive dizgi de SAGLAYICI sozlesmesine gore cozulur (Istanbul duvar
    // saati), sunucu yereline gore DEGIL — aksi halde makineye gore degisirdi.
    assert.equal(entry.naive, expectedEpoch, `${entry.zone}: naive sonucu kaydi`)
  }
})

// ═══ TZ-7 — GEÇMİŞ VERİ ONARIM FİZİBİLİTESİ (YALNIZ SINIFLANDIRMA) ══════

test('TZ-7: gecmis satirlarin onarim fizibilitesi KANITLANIR (mutasyon YOK)', () => {
  // Ham saglayici payload'i SIFRELI olarak saklanir: hem ilk yazimda hem de
  // pazaryeri guncellemesinde. Yani ORIJINAL numerik `orderDate` kurtarilabilir.
  const mapper = readFileSync(join(here, 'orders', 'orderMapper.ts'), 'utf8')
  const insertAndUpdate = (mapper.match(
    /rawPayloadEncrypted: encryptOrderPayload\(order\.rawOrder \?\? order\)/g,
  ) ?? []).length
  assert.ok(insertAndUpdate >= 2, 'ham payload hem insert hem update yolunda saklanmali')

  const schema = readFileSync(join(here, 'db', 'schema.ts'), 'utf8')
  assert.match(schema, /rawPayloadEncrypted: text\('raw_payload_encrypted'\)/)

  // Her iki Trendyol alim yolu ham paketi TASIR.
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const historical = readFileSync(join(here, 'trendyol', 'historicalOrderFetch.ts'), 'utf8')
  assert.match(index, /rawOrder: item/)
  assert.match(historical, /rawOrder: item/)

  // SINIFLANDIRMA: SAFE_REPAIR_FROM_RAW — orijinal ham `orderDate` mevcut
  // oldugu icin duzeltilmis kanonik deger YENIDEN TURETILEBILIR.
  // BU TEST URETIM VERISINI DEGISTIRMEZ; yalnizca fizibiliteyi kanitlar.
  const rawOrderDate = OBSERVED_ORDER_DATE
  const recovered = normalizeTrendyolOrderDate(rawOrderDate)
  const currentlyStored = new Date(rawOrderDate).toISOString()
  assert.equal(
    Date.parse(currentlyStored) - Date.parse(recovered),
    OFFSET_MS,
    'kayitli deger ile onarilmis deger arasindaki fark TAM 3 saattir',
  )
})

// ═══ TZ-7b — KURU ÇALIŞMA TANI ARACI (YAZMA MODU YOK) ═══════════════════

test('TZ-7b: drift tani araci SALT OKUNURDUR ve kaymayi dogru siniflandirir', async () => {
  // SAF modul ice aktarilir; CLI girisi DEGIL. CLI dosyasi ice aktarildiginda
  // `main()` calisir ve DATABASE_URL ister — tani mantigi bu yuzden ayri,
  // yan etkisiz bir modulde durur (repo konvansiyonu: *Audit.ts + *AuditCli.ts).
  const { classifyOrderDateDrift } = await _vite.ssrLoadModule(
    '/server/orders/trendyolOrderDateDrift.ts',
  )
  const raw = OBSERVED_ORDER_DATE
  // Kayitli (kusurlu) deger: ham epoch duz UTC sayilmis hali.
  assert.deepEqual(
    classifyOrderDateDrift({
      storedOrderDate: new Date(raw),
      rawOrderDate: raw,
    }),
    {
      correctedOrderDate: new Date(raw - OFFSET_MS).toISOString(),
      driftMinutes: 180,
      classification: 'DRIFTED_BY_OFFSET',
    },
  )
  // Duzeltilmis satir TEKRAR duzeltilmez.
  assert.equal(
    classifyOrderDateDrift({
      storedOrderDate: new Date(raw - OFFSET_MS),
      rawOrderDate: raw,
    }).classification,
    'ALREADY_CORRECT',
  )
  // Ham yuk yoksa TAHMIN YAPILMAZ.
  assert.equal(
    classifyOrderDateDrift({ storedOrderDate: new Date(raw), rawOrderDate: null })
      .classification,
    'RAW_UNAVAILABLE',
  )

  // ARACIN YAZMA YOLU YOKTUR: mutasyon cagrisi kaynakta BULUNMAMALI.
  const cli = readFileSync(
    join(here, 'orders', 'trendyolOrderDateDriftCli.ts'),
    'utf8',
  )
  for (const mutation of ['db.update', 'db.insert', 'db.delete', '.set(']) {
    assert.equal(cli.includes(mutation), false, `tani aracinda mutasyon: ${mutation}`)
  }
  // Trendyol-only ve kiraci kapsamli.
  assert.match(cli, /eq\(orders\.marketplace, 'Trendyol'\)/)
  assert.match(cli, /eq\(orders\.organizationId, organizationId\)/)
})
