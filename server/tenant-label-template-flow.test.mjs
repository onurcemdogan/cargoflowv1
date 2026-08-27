import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ KİRACI ETİKET ŞABLONU — KODSUZ ÖZELLEŞTİRME ═════════════════════════
//
// Hedef: "sipariş saatini göster", "alıcı adını altta büyük yaz",
// "SKU'yu gizle" gibi istekler KOD DEĞİŞİKLİĞİ OLMADAN karşılansın —
// ama taşıyıcı kimliği ASLA değiştirilemesin.

const TPL = await import('./labels/tenantLabelTemplate.ts')
const here = new URL('.', import.meta.url)

const def = (blocks) => ({ blocks })
const template = (over = {}) => ({
  templateId: 'T1', organizationId: 'org-1', name: 'CargoFlow Sürat Default',
  version: 1, active: true, marketplace: null, carrier: null,
  definition: def([{ block: 'BARCODE' }]), ...over,
})

/* ═══ TPL-1..3 — MÜŞTERİ İSTEKLERİ KODSUZ ══════════════════════════ */

test('TPL-1: siparis saati YAPILANDIRMAYLA acilir', () => {
  assert.ok(TPL.LABEL_BLOCKS.includes('ORDER_TIME'))
  const v = TPL.validateLabelTemplate(def([
    { block: 'ORDER_TIME', visible: true, fontSize: 24 },
  ]))
  assert.equal(v.valid, true, JSON.stringify(v.errors))
})

test('TPL-2: alici adi ALTTA ve BUYUK — konum/boyut yapilandirilabilir', () => {
  const v = TPL.validateLabelTemplate(def([
    { block: 'BUYER_NAME', visible: true, y: 700, fontSize: 64, bold: true, align: 'center' },
  ]))
  assert.equal(v.valid, true, JSON.stringify(v.errors))
})

test('TPL-3: SKU gizlenebilir; varyant/adet gosterilebilir', () => {
  const v = TPL.validateLabelTemplate(def([
    { block: 'SKU', visible: false },
    { block: 'VARIANT', visible: true },
    { block: 'QUANTITY', visible: true },
  ]))
  assert.equal(v.valid, true, JSON.stringify(v.errors))
  for (const b of ['SKU', 'VARIANT', 'QUANTITY', 'PRODUCT_LIST', 'FOOTER']) {
    assert.ok(TPL.LABEL_BLOCKS.includes(b), `${b} beyaz listede YOK`)
  }
})

test('TPL-5: adres stili yapilandirilabilir (sarma/satir siniri)', () => {
  const v = TPL.validateLabelTemplate(def([
    { block: 'DELIVERY_ADDRESS', fontSize: 30, wrap: true, maxLines: 4, width: 500 },
  ]))
  assert.equal(v.valid, true, JSON.stringify(v.errors))
})

/* ═══ TPL-6/7 — KİMLİK KİLİTLİ ═════════════════════════════════════ */

test('TPL-6/7: tasiyici kimlik bloklarinin DEGERI degistirilemez', () => {
  for (const locked of TPL.IDENTITY_LOCKED_BLOCKS) {
    const v = TPL.validateLabelTemplate(def([{ block: locked, text: 'SAHTE' }]))
    assert.equal(v.valid, false, `${locked} metni ezilebiliyor`)
    assert.ok(v.errors.some((e) => e.code === 'LOCKED_BLOCK_TEXT_OVERRIDE'))
  }
  // Sunum DEGISEBILIR — yasak olan DEGER.
  const presentation = TPL.validateLabelTemplate(def([
    { block: 'BARCODE', width: 400, height: 120, x: 40, y: 60 },
  ]))
  assert.equal(presentation.valid, true, JSON.stringify(presentation.errors))
})

test('TPL-7b: packageId barkod blogunun yerine GECEMEZ', () => {
  // `PACKAGE_ID` ayri bir bloktur; BARCODE'un degeri olamaz.
  assert.ok(TPL.LABEL_BLOCKS.includes('PACKAGE_ID'))
  assert.ok(TPL.IDENTITY_LOCKED_BLOCKS.includes('BARCODE'))
  assert.equal(TPL.IDENTITY_LOCKED_BLOCKS.includes('PACKAGE_ID'), false)
  const v = TPL.validateLabelTemplate(def([
    { block: 'BARCODE', text: 'PACKAGE_ID' },
  ]))
  assert.equal(v.valid, false)
})

test('TPL-SAFE: bilinmeyen token ve zorunlu blok gizleme REDDEDILIR', () => {
  const unknown = TPL.validateLabelTemplate(def([
    { block: 'order.rawOrder.customer.taxId' },
  ]))
  assert.equal(unknown.valid, false)
  assert.ok(unknown.errors.some((e) => e.code === 'UNKNOWN_BLOCK'))

  for (const required of TPL.REQUIRED_BLOCKS) {
    const hidden = TPL.validateLabelTemplate(def([
      { block: required, visible: false },
    ]))
    assert.equal(hidden.valid, false, `${required} gizlenebiliyor`)
  }
})

/* ═══ TPL-9/10 — TAŞIYICI ÇAĞRISI YOK ══════════════════════════════ */

test('TPL-9: sablon degisikligi TASIYICI CAGRISI GEREKTIRMEZ', () => {
  assert.equal(TPL.templateChangeRequiresCarrierCall(), false)
  // Surum degisince onbellek anahtari degisir → YEREL yeniden render.
  const v1 = TPL.renderCacheKey({ rawArtifactId: 'RAW-1', templateId: 'T1', templateVersion: 1 })
  const v2 = TPL.renderCacheKey({ rawArtifactId: 'RAW-1', templateId: 'T1', templateVersion: 2 })
  assert.notEqual(v1, v2)
  // Ayni surum → ayni anahtar → yeniden render YOK.
  assert.equal(
    v1, TPL.renderCacheKey({ rawArtifactId: 'RAW-1', templateId: 'T1', templateVersion: 1 }),
  )
})

test('TPL-10: ham tasiyici artefakti anahtarin PARCASIDIR (degismez)', () => {
  const a = TPL.renderCacheKey({ rawArtifactId: 'RAW-1', templateId: 'T1', templateVersion: 1 })
  const b = TPL.renderCacheKey({ rawArtifactId: 'RAW-2', templateId: 'T1', templateVersion: 1 })
  assert.notEqual(a, b, 'farkli ham artefakt ayni render veremez')
  // Sablon YOKSA ham etiket kullanilir (guvenli geri donus).
  assert.ok(TPL.renderCacheKey({ rawArtifactId: 'RAW-1' }).includes('raw'))
})

/* ═══ TPL-11 — KİRACI YALITIMI ═════════════════════════════════════ */

test('TPL-11: kiraci A sablonu kiraci B yi ETKILEMEZ', () => {
  const templates = [
    template({ templateId: 'A', organizationId: 'org-A' }),
    template({ templateId: 'B', organizationId: 'org-B' }),
  ]
  assert.equal(
    TPL.resolveActiveTemplate({ templates, organizationId: 'org-A' }).templateId, 'A',
  )
  assert.equal(
    TPL.resolveActiveTemplate({ templates, organizationId: 'org-B' }).templateId, 'B',
  )
  // Sablonu olmayan kiraci BASKASININKINI ALMAZ.
  assert.equal(
    TPL.resolveActiveTemplate({ templates, organizationId: 'org-C' }), null,
  )
})

test('TPL-SCOPE: pazaryeri+tasiyici onceligi, sonra tasiyici, sonra varsayilan', () => {
  const templates = [
    template({ templateId: 'DEFAULT' }),
    template({ templateId: 'CARRIER', carrier: 'Surat' }),
    template({ templateId: 'EXACT', marketplace: 'Trendyol', carrier: 'Surat' }),
  ]
  const pick = (marketplace, carrier) => TPL.resolveActiveTemplate({
    templates, organizationId: 'org-1', marketplace, carrier,
  }).templateId
  assert.equal(pick('Trendyol', 'Surat'), 'EXACT')
  assert.equal(pick('Hepsiburada', 'Surat'), 'CARRIER')
  assert.equal(pick('Hepsiburada', 'Aras'), 'DEFAULT')
  // Pasif sablon SECILMEZ.
  const inactive = [template({ templateId: 'X', active: false })]
  assert.equal(
    TPL.resolveActiveTemplate({ templates: inactive, organizationId: 'org-1' }), null,
  )
})

/* ═══ TPL-12 — GÜVENLİ GERİ DÖNÜŞ ══════════════════════════════════ */

test('TPL-12: sablon yoksa HAM tasiyici etiketi kullanilir', () => {
  assert.equal(
    TPL.resolveActiveTemplate({ templates: [], organizationId: 'org-1' }), null,
  )
  // `null` sablon → ham anahtar → ham etiket basilir.
  assert.equal(
    TPL.renderCacheKey({ rawArtifactId: 'RAW-9', templateId: null }),
    'RAW-9:raw:0',
  )
})

test('TPL-NO-CODE: modul rasgele kod/alan yolu CALISTIRMAZ', () => {
  const source = readFileSync(
    new URL('./labels/tenantLabelTemplate.ts', here), 'utf8',
  )
  for (const forbidden of ['eval(', 'new Function', 'require(', 'vm.', 'exec(']) {
    assert.equal(source.includes(forbidden), false, `guvensiz: ${forbidden}`)
  }
})

test('TPL-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})
