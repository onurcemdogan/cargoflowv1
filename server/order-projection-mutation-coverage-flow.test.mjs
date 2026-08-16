import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// B1-C — MERKEZİ KAPSAMA MATRİSİ.
//
// AMAÇ: production mutation yüzeyindeki HER gerçek yol TAM OLARAK BİR sınıfa
// sahip olsun. Sayılar elle yazılmaz; site listesi KAYNAK TARANARAK türer.
// Gelecekte biri yeni bir write path eklerse ve projeksiyon bakımını unutursa
// bu test UNCLASSIFIED verip CI'yı düşürür.
//
// Sınıflandırma (hangi yolun neden hook GEREKTİRMEDİĞİ) elle yazılır — bu bir
// tasarım kararıdır, türetilemez. Ama her karar burada gerekçesiyle kilitli ve
// davranışsal karşılığı `order-projection-invariants-flow` testinde kanıtlı.

const nl = (v) => v.split('\r\n').join('\n')
const source = (p) => nl(readFileSync(p, 'utf8'))

/** Projeksiyon kaynağı olan iş tabloları. */
const BUSINESS_TABLES = ['orders', 'shipments', 'shipmentOperations']
const HOOKS = [
  'refreshOrderProjectionFragment',
  'updateShipmentProjectionFragment',
  'updateOperationProjectionFragment',
]

const ALLOWED = new Set([
  'REQUIRED_HOOKED',
  'NOT_REQUIRED_BY_DESIGN_CASCADE',
  'NOT_REQUIRED_BY_DESIGN_ARCHIVE_NOT_FILTERED',
  'NOT_REQUIRED_BY_DESIGN_ACTIVITY_ONLY',
  'NOT_REQUIRED_BY_DESIGN_ARTIFACT_ONLY',
  'NOT_REQUIRED_BY_DESIGN_RESERVATION_ONLY',
  'NOT_REQUIRED_BY_DESIGN_SCOPE_ONLY',
])

/* ═══ KAYNAK TARAMASI — site listesi BURADAN türer ══════════════════════ */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name).split('\\').join('/')
    if (entry.isDirectory()) {
      if (!p.includes('node_modules')) walk(p, out)
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** `.insert|update|delete(<table>)` çağrılarını saran fonksiyonla eşler. */
function scanMutations(file, tables) {
  const src = source(file)
  const lines = src.split('\n')
  const found = []
  const re = /\.(insert|update|delete)\(\s*([A-Za-z_][A-Za-z0-9_]*)/g
  let match
  while ((match = re.exec(src))) {
    if (!tables.includes(match[2])) continue
    const line = src.slice(0, match.index).split('\n').length
    let fn = '<module>'
    for (let i = line - 1; i >= 0; i -= 1) {
      const hit = (lines[i] ?? '').match(
        /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/,
      )
      if (hit) {
        fn = hit[1]
        break
      }
    }
    found.push(`${file}#${fn}::${match[1]}:${match[2]}`)
  }
  return found
}

const PRODUCTION_FILES = walk('server').filter(
  (p) => !p.includes('/testing/') && !p.endsWith('.test.ts'),
)

const DISCOVERED = [
  ...new Set(
    PRODUCTION_FILES.flatMap((f) => scanMutations(f, BUSINESS_TABLES)),
  ),
].sort()

/**
 * Bir fonksiyonun gövdesi: bildiriminden BİR SONRAKİ üst düzey bildirime
 * kadar. (Naif `\n}` araması dönüş tipi `Promise<{…}>` üzerinde erken keser.)
 */
function functionBody(file, name) {
  const src = source(file)
  const start = src.search(
    new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'),
  )
  assert.ok(start >= 0, `${file}#${name} bulunamadi`)
  const rest = src.slice(start + 1)
  const next = rest.search(
    /^(?:export )?(?:async )?(?:function|const|let|interface|type|class|enum) /m,
  )
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
}

/* ═══ SINIFLANDIRMA — her karar gerekçesiyle ════════════════════════════ */

const REGISTRY = {
  // ── REQUIRED_HOOKED (8) ────────────────────────────────────────────────
  'server/orders/orderRepository.ts#upsertMarketplaceOrders::insert:orders': {
    class: 'REQUIRED_HOOKED',
    hookedIn: ['server/orders/orderRepository.ts', 'upsertMarketplaceOrders'],
  },
  'server/orders/orderRepository.ts#markOrderLabelReady::update:orders': {
    class: 'REQUIRED_HOOKED',
    hookedIn: ['server/orders/orderRepository.ts', 'markOrderLabelReady'],
  },
  'server/orders/orderRepository.ts#markOrderLabelPrinted::update:orders': {
    class: 'REQUIRED_HOOKED',
    hookedIn: ['server/orders/orderRepository.ts', 'markOrderLabelPrinted'],
  },
  'server/orders/importLegacyOrders.ts#importOne::insert:orders': {
    class: 'REQUIRED_HOOKED',
    // Toplu yol: kimlikler toplanır, hook TEK sefer batch fonksiyonunda.
    hookedIn: ['server/orders/importLegacyOrders.ts', 'importLegacyOrders'],
    batched: true,
  },
  'server/shipments/suratTrackingReconciler.ts#applyTrackingDecision::update:orders':
    {
      class: 'REQUIRED_HOOKED',
      hookedIn: [
        'server/shipments/suratTrackingReconciler.ts',
        'applyTrackingDecision',
      ],
    },
  'server/shipments/shipmentRepository.ts#upsertShipment::insert:shipments': {
    class: 'REQUIRED_HOOKED',
    hookedIn: ['server/shipments/shipmentRepository.ts', 'upsertShipment'],
  },
  'server/shipments/shipmentOperationRepository.ts#upsertCreateOperation::insert:shipmentOperations':
    {
      class: 'REQUIRED_HOOKED',
      hookedIn: [
        'server/shipments/shipmentOperationRepository.ts',
        'upsertCreateOperation',
      ],
    },
  'server/shipments/importLegacyShipments.ts#importOne::insert:shipmentOperations':
    {
      class: 'REQUIRED_HOOKED',
      // `upsertCreateOperation` yerine DOĞRUDAN insert eder; kendi hook'u var.
      hookedIn: ['server/shipments/importLegacyShipments.ts', 'importOne'],
    },

  // ── NOT_REQUIRED_BY_DESIGN (12) ────────────────────────────────────────
  'server/orders/orderRepository.ts#archiveMissingOrders::update:orders': {
    class: 'NOT_REQUIRED_BY_DESIGN_ARCHIVE_NOT_FILTERED',
    // KANIT: `buildOrderWhere` archivedAt yüklemi İÇERMEZ (ayrı test dosyası).
    reason: 'arsivleme bugunku okuma uygunlugunu DEGISTIRMEZ',
  },
  'server/orders/orderRetention.ts#archiveEligibleOrders::update:orders': {
    class: 'NOT_REQUIRED_BY_DESIGN_ARCHIVE_NOT_FILTERED',
    reason: 'arsivleme bugunku okuma uygunlugunu DEGISTIRMEZ',
  },
  'server/orders/orderRepository.ts#touchOrderOperationalActivity::update:orders':
    {
      class: 'NOT_REQUIRED_BY_DESIGN_ACTIVITY_ONLY',
      // SET listesi: lastOperationalActivityAt + updatedAt. Token kaynağı YOK.
      reason: 'yalniz aktivite damgasi',
      setColumns: ['lastOperationalActivityAt', 'updatedAt'],
    },
  'server/orders/orderRetention.ts#applyActivityBaseline::update:orders': {
    class: 'NOT_REQUIRED_BY_DESIGN_ACTIVITY_ONLY',
    reason: 'retention baseline; yalniz aktivite damgasi',
    setColumns: ['lastOperationalActivityAt', 'updatedAt'],
  },
  'server/orders/orderRetention.ts#purgeOrderRecord::delete:orders': {
    class: 'NOT_REQUIRED_BY_DESIGN_CASCADE',
    reason: 'order silinince projeksiyon FK CASCADE ile duser',
  },
  'server/orders/orderRetention.ts#purgeOrderRecord::delete:shipments': {
    class: 'NOT_REQUIRED_BY_DESIGN_CASCADE',
    reason: 'ayni islemde order da silinir; projeksiyon CASCADE ile duser',
  },
  'server/orders/orderRetention.ts#purgeOrderRecord::delete:shipmentOperations':
    {
      class: 'NOT_REQUIRED_BY_DESIGN_CASCADE',
      reason: 'ayni islemde order da silinir; projeksiyon CASCADE ile duser',
    },
  'server/shipments/shipmentOperationRepository.ts#reserveCreateOperation::insert:shipmentOperations':
    {
      class: 'NOT_REQUIRED_BY_DESIGN_RESERVATION_ONLY',
      // Yalnız IN_PROGRESS rezervasyonu. Taşıyıcı henüz çağrılmadığı için
      // aranabilir tanımlayıcı (T.No/barkod) HENÜZ YOKTUR.
      reason: 'rezervasyon; aranabilir tanimlayici URETMEZ',
    },
  'server/shipments/shipmentOperationRepository.ts#deleteCreateOperation::delete:shipmentOperations':
    {
      class: 'NOT_REQUIRED_BY_DESIGN_RESERVATION_ONLY',
      // KANIT: yalnız `carrierCreateCalled === false` dalında çağrılır —
      // istek taşıyıcıya HİÇ ulaşmadığı için tanımlayıcı da atanmamıştır.
      reason: 'yalniz tasiyiciya ULASMAYAN rezervasyonu geri alir',
    },
  'server/shipments/printZplRepository.ts#compareAndSetArtifact::update:shipments':
    {
      class: 'NOT_REQUIRED_BY_DESIGN_ARTIFACT_ONLY',
      reason: 'yalniz printZplArtifact; kaynak alanlar AYNEN korunur',
    },
  'server/shipments/repairPrintZpl.ts#repairSourceOnlyPrintZpl::update:shipments':
    {
      class: 'NOT_REQUIRED_BY_DESIGN_ARTIFACT_ONLY',
      reason: 'yalniz printZplArtifact tamiri; kaynak alanlar AYNEN korunur',
    },
  'server/integrations/marketplaceAccountBackfill.ts#applyBackfill::update:orders':
    {
      class: 'NOT_REQUIRED_BY_DESIGN_SCOPE_ONLY',
      // marketplaceAccountId PROJEKSİYON KOLONU DEĞİLDİR: hesap kapsamı
      // okuma yolunda `orders` üzerinden gelir. Token yenilemesi GEREKMEZ.
      reason: 'yalniz hesap kapsami; token kaynagi degil',
      setColumns: ['marketplaceAccountId', 'updatedAt'],
    },
}

/* ═══ MATRİS TESTLERİ ═══════════════════════════════════════════════════ */

test('MTX-1: kaynak taramasi gercek mutation yuzeyini bulur', () => {
  // Site listesi elle yazılmaz. Bilinen çapa yollar taramada GÖRÜNMELİ.
  assert.ok(DISCOVERED.length >= 20, `az site bulundu: ${DISCOVERED.length}`)
  for (const anchor of [
    'server/orders/orderRepository.ts#upsertMarketplaceOrders::insert:orders',
    'server/shipments/shipmentRepository.ts#upsertShipment::insert:shipments',
    'server/orders/orderRetention.ts#purgeOrderRecord::delete:orders',
  ]) {
    assert.ok(DISCOVERED.includes(anchor), `capa kaybolmus: ${anchor}`)
  }
})

test('MTX-2: UNCLASSIFIED = 0 (her mutation kayitli)', () => {
  const unclassified = DISCOVERED.filter((site) => !REGISTRY[site])
  assert.deepEqual(
    unclassified,
    [],
    `SINIFLANDIRILMAMIS mutation: ${unclassified.join(', ')}`,
  )
})

test('MTX-3: STALE = 0 (kayitta artik var olmayan yol yok)', () => {
  const stale = Object.keys(REGISTRY).filter((k) => !DISCOVERED.includes(k))
  assert.deepEqual(stale, [], `kaynakta olmayan kayit: ${stale.join(', ')}`)
})

test('MTX-4: her site TAM OLARAK BIR sinifta (duplicate = 0)', () => {
  // Nesne anahtarı doğal olarak tekildir; kopya anahtar sessizce EZERDİ.
  // Bu yüzden kaynağı metin olarak sayıp gerçek tekilliği doğruluyoruz.
  const self = source('server/order-projection-mutation-coverage-flow.test.mjs')
  const registryText = self.slice(
    self.indexOf('const REGISTRY = {'),
    self.indexOf('/* ═══ MATRİS TESTLERİ'),
  )
  for (const site of DISCOVERED) {
    const occurrences = registryText.split(`'${site}'`).length - 1
    assert.equal(occurrences, 1, `${site} icin ${occurrences} kayit`)
  }
  for (const [site, entry] of Object.entries(REGISTRY)) {
    assert.ok(ALLOWED.has(entry.class), `${site}: gecersiz sinif ${entry.class}`)
  }
})

test('MTX-5: REQUIRED_HOOKED yollarin hook cagrisi GERCEKTEN var', () => {
  for (const [site, entry] of Object.entries(REGISTRY)) {
    if (entry.class !== 'REQUIRED_HOOKED') continue
    const body = functionBody(entry.hookedIn[0], entry.hookedIn[1])
    assert.ok(
      HOOKS.some((hook) => body.includes(hook)),
      `${site}: hook cagrisi YOK (${entry.hookedIn.join('#')})`,
    )
  }
})

test('MTX-6: NOT_REQUIRED yollara SESSIZCE hook eklenmemis', () => {
  // Sınıflandırma ile kod birbirinden kaymasın: NOT_REQUIRED bir yol hook
  // çağırmaya başlarsa sınıflandırma yanlış demektir.
  for (const [site, entry] of Object.entries(REGISTRY)) {
    if (entry.class === 'REQUIRED_HOOKED') continue
    const [file, fn] = site.split('#')[0] === site ? [] : [site.split('#')[0], site.split('#')[1].split('::')[0]]
    const body = functionBody(file, fn)
    for (const hook of HOOKS) {
      assert.equal(body.includes(hook), false, `${site}: beklenmeyen ${hook}`)
    }
  }
})

test('MTX-7: ACTIVITY_ONLY / SCOPE_ONLY yollar token kaynagi YAZMAZ', () => {
  const TOKEN_SOURCES = [
    'marketplace:',
    'operationStatus:',
    'marketplaceStatus:',
    'shippingCity:',
    'shippingDistrict:',
    'customerFirstName:',
    'customerPhone:',
    'orderNumber:',
    'externalOrderId:',
    'cargoTrackingNumber:',
    'orderDate:',
  ]
  for (const [site, entry] of Object.entries(REGISTRY)) {
    if (!entry.setColumns) continue
    const [file, fn] = [site.split('#')[0], site.split('#')[1].split('::')[0]]
    const body = functionBody(file, fn)
    const setStart = body.indexOf('.set(')
    assert.ok(setStart > 0, `${site}: .set( bulunamadi`)
    const setBlock = body.slice(setStart, body.indexOf('})', setStart))
    for (const column of entry.setColumns) {
      assert.ok(setBlock.includes(column), `${site}: ${column} SET edilmeli`)
    }
    for (const forbidden of TOKEN_SOURCES) {
      assert.equal(
        setBlock.includes(forbidden),
        false,
        `${site}: token kaynagi ${forbidden} YAZILMAMALI`,
      )
    }
  }
})

test('MTX-8: ARTIFACT_ONLY yazicilar kaynak alanlari AYNEN korur', () => {
  // `{...payload, printZplArtifact}` — takip/barkod alanlarına DOKUNULMAZ.
  for (const [file, fn] of [
    ['server/shipments/printZplRepository.ts', 'compareAndSetArtifact'],
    ['server/shipments/repairPrintZpl.ts', 'repairSourceOnlyPrintZpl'],
  ]) {
    const callers = source(file)
    assert.ok(
      callers.includes('...payload,'),
      `${file}: payload yayilimi (kaynak koruma) bulunamadi`,
    )
    const body = functionBody(file, fn)
    // Takip/barkod alanlarını hiçbir artifact yolu SET etmez.
    for (const forbidden of ['trackingNumber:', 'barcode:', 'senderNumber:']) {
      assert.equal(body.includes(forbidden), false, `${fn}: ${forbidden} yazilmamali`)
    }
  }
})

test('MTX-9: projeksiyon tablosu YALNIZ yazici modulunde mutate edilir', () => {
  const writers = PRODUCTION_FILES.filter(
    (f) => scanMutations(f, ['orderFilterProjection']).length > 0,
  )
  assert.deepEqual(
    writers,
    ['server/orders/orderFilterProjectionRepository.ts'],
    'projeksiyon yazimi TEK sinirda kalmali',
  )
})

test('MTX-10: kapsama ozeti — REQUIRED 8 / NOT_REQUIRED 12 / TOPLAM 20', () => {
  const required = Object.values(REGISTRY).filter(
    (e) => e.class === 'REQUIRED_HOOKED',
  ).length
  const notRequired = Object.values(REGISTRY).length - required
  // Sayılar taramadan türer; sabitler yalnızca bugünkü gerçeği kilitler.
  assert.equal(DISCOVERED.length, Object.keys(REGISTRY).length)
  assert.equal(required, 8)
  assert.equal(notRequired, 12)
  assert.equal(required + notRequired, DISCOVERED.length)
})
