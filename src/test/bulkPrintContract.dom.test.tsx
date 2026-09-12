import { describe, expect, test } from 'vitest'

// ═══ 10 × 10 SAYFA SÖZLEŞMESİ VE TOPLU BASKI ════════════════════════════
//
// ═══ ÜRETİMDE ÖLÇÜLEN KUSUR ══════════════════════════════════════════════
// Operatör birden çok sipariş seçiyor, "Yazdır" diyor, Chrome penceresi
// AÇILIYOR — ama içinde TEK sayfa oluyordu.
//
// Kayıp baskı belgesinde DEĞİLDİ. `App` şu kuralı kullanıyordu:
//
//     includePreviouslyPrinted = selectedOrders.every(daha önce basılmış)
//
// `printLabels` bu bayrak `false` iken daha önce basılmış HER siparişi aday
// listesinden düşürür:
//
//   seçim                      bayrak   belgeye giren
//   5 basılmış                 true     5
//   4 basılmış + 1 yeni        false    1   ← şikâyet
//   1 basılmış (tekli)         true     1
//
// Tekli baskı tek elemanlı `every()` ile DAİMA `true` ürettiği için hiç
// bozulmuyordu: tekli ve toplu yol TAM BURADA ayrışıyordu.
//
// Üstelik kardinalite kilidi bunu yakalayamazdı — belgeye gerçekten tek
// sayfa girmişti, yani "beklenen 1, gerçek 1" doğruydu.

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function buildDocument(pageCount: number) {
  const { buildOfficialSuratPrintDocument } = await import(
    '../utils/officialSuratPrintDocument'
  )
  return buildOfficialSuratPrintDocument(
    Array.from({ length: pageCount }, (_, index) => ({
      orderNumber: `ORD-${index}`,
      imageBase64: PNG_BASE64,
      mimeType: 'image/png',
    })),
  )
}

const styleOf = (html: string) =>
  html.slice(html.indexOf('<style>'), html.indexOf('</style>'))

describe('10 x 10 sayfa sozlesmesi', () => {
  test('PRINT-10X10-1: tekli baski belgesi 100mm x 100mm', async () => {
    const doc = await buildDocument(1)
    expect(doc.pageSizeMm.widthMm).toBe(100)
    expect(doc.pageSizeMm.heightMm).toBe(100)
    expect(styleOf(doc.html)).toContain('@page { size: 100mm 100mm; margin: 0; }')
  })

  test('PRINT-10X10-2: toplu belgede HER sayfa 100mm x 100mm', async () => {
    for (const count of [2, 3, 5]) {
      const doc = await buildDocument(count)
      expect(doc.pageSizeMm).toEqual({ widthMm: 100, heightMm: 100 })
      const style = styleOf(doc.html)
      // TEK `@page` kurali — sayfa basina farkli olcu YOK.
      expect(style.match(/@page/g)).toHaveLength(1)
      expect(style).toContain('@page { size: 100mm 100mm; margin: 0; }')
      // Etiket kabi ve goruntu de AYNI olcude.
      expect(style).toContain('width: 100mm; height: 100mm')
      // N bolum = N fiziksel sayfa.
      expect(doc.html.match(/class="surat-official-page"/g)).toHaveLength(count)
      expect(style).toContain('page-break-after: always')
      expect(style).toContain('break-after: page')
      // SONDA bos sayfa yok.
      expect(style).toContain('.surat-official-page:last-child')
    }
  })

  test('PRINT-10X10-3: belge A4/Letter fallback KULLANMAZ', async () => {
    const style = styleOf((await buildDocument(2)).html)

    // ═══ SAYFA KUTUSU: ACIK OLCU, OFIS KAGIDI DEGIL ════════════════════
    // `@page size` bir ofis kagidi ADI ya da `auto` OLAMAZ; ikisi de belgeyi
    // surucunun varsayilan medyasina birakirdi.
    const pageRule = style.match(/@page[^}]*}/)?.[0] ?? ''
    expect(pageRule).toBe('@page { size: 100mm 100mm; margin: 0; }')
    expect(pageRule).not.toMatch(/(a4|letter|legal|auto|portrait|landscape)/i)

    // Otomatik sigdirma / olcekleme kurali YOK.
    for (const forbidden of ['scale(', 'zoom', 'transform', 'fit-content']) {
      expect(style).not.toContain(forbidden)
    }
    // `auto` YALNIZ sayfa sonu kuralinda gecer (son sayfada bos yaprak
    // olusmasin diye) — olcu taniminda ASLA.
    for (const match of style.match(/[a-z-]+:\s*auto/g) ?? []) {
      expect(match).toMatch(/^(page-)?break-after:\s*auto$/)
    }

    // Olcu milimetre cinsinden SABIT; yuzde/viewport birimi YOK.
    expect(style).not.toMatch(/width:\s*\d+%/)
    expect(style).not.toMatch(/\d+(vw|vh)/)
  })

  test('BULK-PRINT-3: tekli ve toplu AYNI kanonik olcu kaynagini kullanir', async () => {
    const single = await buildDocument(1)
    const bulk = await buildDocument(4)
    expect(bulk.pageSizeMm).toEqual(single.pageSizeMm)
    expect(styleOf(bulk.html).match(/@page[^}]*}/)?.[0]).toBe(
      styleOf(single.html).match(/@page[^}]*}/)?.[0],
    )

    // Olcu KANONIK geometri sabitinden gelir; dosyada literal DEGIL.
    const { DEFAULT_PRINT_PAGE_SIZE_MM } = await import(
      '../utils/officialSuratPrintDocument'
    )
    const { LABEL_CANVAS_WIDTH_MM, LABEL_CANVAS_HEIGHT_MM } = await import(
      '../labels/labelGeometry'
    )
    expect(DEFAULT_PRINT_PAGE_SIZE_MM.widthMm).toBe(LABEL_CANVAS_WIDTH_MM)
    expect(DEFAULT_PRINT_PAGE_SIZE_MM.heightMm).toBe(LABEL_CANVAS_HEIGHT_MM)
  })

  test('PRINT-10X10-4: render artefaktinin turetilmis olcusu sayfayi DEGISTIREMEZ', async () => {
    // ═══ NEDEN BU KILIT VAR ═════════════════════════════════════════════
    // Render artefakti `widthMm`/`heightMm` dondurur ve bunu `@page`'e
    // baglamak ilk bakista dogru gorunur. DEGILDIR: o deger nokta sayisindan
    // TUREYEN bir render ayrintisidir (fixture'da 99.875 mm) ve FIZIKSEL
    // ETIKET STOGUNA esit degildir. Sayfa kutusu stoktur.
    const doc = await buildDocument(2)
    expect(doc.html).not.toContain('99.875')
    expect(doc.pageSizeMm).toEqual({ widthMm: 100, heightMm: 100 })

    // Belge kurucusu olcu parametresi KABUL ETMEZ: turetilmis bir degerin
    // sayfa kutusuna sizacagi bir kapi YOKTUR.
    const { buildOfficialSuratPrintDocument } = await import(
      '../utils/officialSuratPrintDocument'
    )
    expect(buildOfficialSuratPrintDocument.length).toBeLessThanOrEqual(2)
  })
})

describe('toplu baski secim niyeti', () => {
  const order = (id: string, printed: boolean) => ({
    id,
    orderNumber: `ORD-${id}`,
    labelStatus: printed ? 'PRINTED' : 'READY',
    label: printed ? { printedAt: '2026-09-10T08:00:00.000Z' } : null,
  })

  /** `printLabels` aday kapisinin AYNI kurali. */
  const survivesServiceGate = (
    item: ReturnType<typeof order>,
    includePreviouslyPrinted: boolean,
  ) =>
    !(item.labelStatus === 'PRINTED' && Boolean(item.label?.printedAt))
    || includePreviouslyPrinted

  test('BULK-PRINT-1: 4 basilmis + 1 yeni -> 5 aday, sessiz skip = 0', async () => {
    const { resolveExplicitPrintSelectionIntent } = await import(
      '../utils/printSelectionIntent'
    )
    const selection = [
      order('1', true), order('2', true), order('3', true),
      order('4', true), order('5', false),
    ]
    const intent = resolveExplicitPrintSelectionIntent(selection)

    // URETIMDEKI SIKAYETIN TAM SENARYOSU.
    expect(intent.includePreviouslyPrinted).toBe(true)
    expect(intent.selectedCount).toBe(5)
    expect(intent.reprintOrderNumbers).toEqual([
      'ORD-1', 'ORD-2', 'ORD-3', 'ORD-4',
    ])

    // Servis kapisi bu bayrakla HICBIR siparisi dusurmez -> sessiz skip 0.
    const survived = selection.filter((item) =>
      survivesServiceGate(item, intent.includePreviouslyPrinted),
    )
    expect(survived).toHaveLength(5)

    // ESKI KURAL AYNI SECIMDE 1'E DUSURUYORDU — regresyon kilidi.
    const legacyFlag = selection.every(
      (item) =>
        item.labelStatus === 'PRINTED' && Boolean(item.label?.printedAt),
    )
    expect(legacyFlag).toBe(false)
    expect(
      selection.filter((item) => survivesServiceGate(item, legacyFlag)),
    ).toHaveLength(1)

    // 5 aday -> belgede 5 fiziksel sayfa, her biri 100 x 100 mm.
    const doc = await buildDocument(survived.length)
    expect(doc.html.match(/class="surat-official-page"/g)).toHaveLength(5)
    expect(doc.pageSizeMm).toEqual({ widthMm: 100, heightMm: 100 })
  })

  test('BULK-PRINT-1b: SESSIZ tekrar baski yok — hepsi raporlanir', async () => {
    const { describeReprintNotice, resolveExplicitPrintSelectionIntent } =
      await import('../utils/printSelectionIntent')
    const intent = resolveExplicitPrintSelectionIntent([
      order('1', true), order('2', false),
    ])
    const notice = describeReprintNotice(intent)
    expect(notice).toContain('ORD-1')
    expect(notice).not.toContain('ORD-2')
    // Tekrar baski yoksa satir da yok.
    expect(
      describeReprintNotice(
        resolveExplicitPrintSelectionIntent([order('9', false)]),
      ),
    ).toBe('')
    // BOS secim bir onay DEGILDIR.
    expect(
      resolveExplicitPrintSelectionIntent([]).includePreviouslyPrinted,
    ).toBe(false)
  })

  test('BULK-PRINT-2: sayfa sirasi DETERMINISTIK (secim sirasi korunur)', async () => {
    const { buildOfficialSuratPrintDocument } = await import(
      '../utils/officialSuratPrintDocument'
    )
    const wanted = ['B', 'A', 'C', 'A']
    const build = () =>
      buildOfficialSuratPrintDocument(
        wanted.map((orderNumber) => ({
          orderNumber,
          imageBase64: PNG_BASE64,
          mimeType: 'image/png',
        })),
      )
    const doc = build()
    const rendered = [...doc.html.matchAll(/data-order="([^"]+)"/g)].map(
      (match) => match[1],
    )
    expect(rendered).toEqual(wanted)
    // Ayni girdi -> ayni cikti (sira girdiye BAGLI).
    expect(build().html).toBe(doc.html)
  })

  test('BULK-PRINT-4: READY artefakt varsa carrier create cagrisi = 0', async () => {
    const policy = await import('../../server/shipments/suratAutoLabelPolicy')
    // Hazir etiketi olan siparis icin buton tasiyiciya CIKMAZ.
    for (const jobState of ['READY', null] as const) {
      const action = policy.resolveLabelButtonAction({
        jobState,
        hasStoredLabel: true,
        eligible: true,
      })
      expect(action.action).toBe('OPEN_STORED_LABEL')
      expect(action.carrierCalls).toBe(0)
    }
    // 5 siparislik toplu secimde TOPLAM tasiyici cagrisi SIFIR.
    const total = Array.from({ length: 5 }).reduce<number>(
      (sum) =>
        sum +
        policy.resolveLabelButtonAction({
          jobState: 'READY',
          hasStoredLabel: true,
          eligible: true,
        }).carrierCalls,
      0,
    )
    expect(total).toBe(0)
    // NOT: "resmi toplu baski yolu Surat create ucunu CAGIRMAZ" yapisal
    // kaniti, dosya okuyabilen sunucu paketindedir
    // (label-datestamp-geometry-flow -> BULK-PRINT-4-SOURCE).
  })
})
