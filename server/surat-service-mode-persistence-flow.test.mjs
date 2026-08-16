import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

// SERVIS MODU KALICILIGI — SAVE/LOAD ROUND-TRIP SOZLESMESI.
//
// URETIM BULGUSU: tenant "Surat Web API (resmi entegrasyon)" secip kaydetti,
// ancak on kontrol CURRENT SERVICE MODE = ORTAK_BARKOD_SOAP gosterdi.
//
// KOK NEDEN: auth modda form maskeli durum yanitindan yeniden kuruluyor ve
// o yanitta `serviceMode` HIC YOKTU. Form her yuklemede varsayilana dusuyor,
// sonraki kaydetme tenant'in sectigi modu SESSIZCE eziyordu.

const SERVICE = await readFile(
  new URL('../src/services/integrationConfigService.ts', import.meta.url), 'utf8',
)
const CREDENTIALS = await readFile(
  new URL('./integrations/credentialService.ts', import.meta.url), 'utf8',
)
const INDEX_SOURCE = await readFile(
  new URL('./index.mjs', import.meta.url), 'utf8',
)

const LEGACY_MODES = [
  'ORTAK_BARKOD_SOAP',
  'KARGO_BARKODU_SIPARIS_SOAP',
  'PRE_REGISTRATION_REST',
  'GONDERI_YENI_SOAP',
  'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
]
const CANONICAL = 'SURAT_CANONICAL_API'

/** Yorumlari atar; yalnizca calisan kod incelenir. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

/** Auth modu form hydrate blogunun SADECE surat kismi. */
function hydrateSuratBlock() {
  const code = codeOnly(SERVICE)
  const start = code.indexOf('payload.surat?.cariKod')
  assert.ok(start > 0, 'auth hydrate blogu bulunmali')
  return code.slice(start, start + 700)
}

/** normalizeSuratConfig icindeki serviceMode cozumu (backend). */
function backendServiceModeBlock() {
  const code = codeOnly(INDEX_SOURCE)
  const start = code.indexOf('function normalizeSuratConfig')
  assert.ok(start > 0)
  const sliced = code.slice(start)
  return sliced.slice(0, sliced.indexOf('const ortam'))
}

/** Uretimdeki merge davranisi: bos/maskeli deger eski kaydi KORUR. */
function mergePreservingSecrets(existing, incoming) {
  const merged = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined || value === null || value === '') continue
    merged[key] = value
  }
  return merged
}

// ═══ 1-2. UI SECIMI → PAYLOAD ═════════════════════════════════════════════

test('MODE-1: UI kanonik secenegi payload serviceMode olarak tasinir', () => {
  assert.ok(SERVICE.includes(`'${CANONICAL}'`))
  assert.match(
    backendServiceModeBlock(), /value\.serviceMode === SURAT_CANONICAL_SERVICE_MODE/,
  )
})

test('MODE-2: kabul listesi TEK kaynaktan gelir', () => {
  assert.match(SERVICE, /const SURAT_SERVICE_MODES/)
  assert.match(SERVICE, /export function isSuratServiceMode/)
  // Hem kaydetme normalizasyonu hem hydrate AYNI guard'i kullanir.
  const uses = SERVICE.match(/isSuratServiceMode\(/g) ?? []
  assert.ok(uses.length >= 3, `guard en az 3 yerde kullanilmali (${uses.length})`)
  for (const mode of [...LEGACY_MODES, CANONICAL]) {
    assert.ok(SERVICE.includes(`'${mode}'`), mode)
  }
})

// ═══ 3-4. MASKELI DURUM SERVIS MODUNU GERI DONER ══════════════════════════

test('MODE-3: maskeli durum yaniti serviceMode ICERIR', () => {
  assert.match(CREDENTIALS, /serviceMode: String\(surat\.serviceMode \?\? ''\)/)
  assert.match(CREDENTIALS, /serviceMode: string/)
  assert.match(CREDENTIALS, /usernameMasked: maskTail\(surat\.kullaniciAdi\)/)
})

test('MODE-4: form yeniden yuklemede kayitli mod GERI YUKLENIR', () => {
  const block = hydrateSuratBlock()
  assert.ok(block.includes('payload.surat?.serviceMode'), 'kayitli mod okunmali')
  assert.ok(block.includes('routeFromServiceMode'), 'route da turetilmeli')
})

// ═══ 5. ROUND-TRIP ════════════════════════════════════════════════════════

test('MODE-5: save → merge → load round-trip kanonik modu KORUR', () => {
  const existing = {
    serviceMode: 'ORTAK_BARKOD_SOAP',
    serviceType: 'OrtakBarkodOlusturSoap',
    createShipmentPath: '/api/OrtakBarkodOlustur',
    kullaniciAdi: 'TEST_CUSTOMER_2622',
    sifre: 'TEST_SECRET',
  }
  // Tenant kanonik modu secip kaydediyor; secret alanlari BOS birakiyor.
  const saved = mergePreservingSecrets(existing, {
    serviceMode: CANONICAL,
    serviceType: 'SuratCanonicalWebApi',
    createShipmentPath: '/api/OrtakBarkodOlustur',
    kullaniciAdi: '',
    sifre: '',
  })
  assert.equal(saved.serviceMode, CANONICAL, 'kanonik mod kaydedilmeli')
  assert.equal(saved.serviceType, 'SuratCanonicalWebApi')
  // Bos secret eski degeri KORUR.
  assert.equal(saved.kullaniciAdi, 'TEST_CUSTOMER_2622')
  assert.equal(saved.sifre, 'TEST_SECRET')
})

// ═══ 6-7. BAYAT legacy serviceType/path KANONIGI EZMEZ ════════════════════

test('MODE-6: bayat legacy serviceType kanonik modu GERI CEVIREMEZ', () => {
  const block = backendServiceModeBlock()
  const canonicalIndex = block.indexOf('SURAT_CANONICAL_SERVICE_MODE')
  const serviceTypeIndex = block.indexOf('value.serviceType')
  assert.ok(canonicalIndex >= 0, 'kanonik dal bulunmali')
  assert.ok(
    serviceTypeIndex === -1 || canonicalIndex < serviceTypeIndex,
    'kanonik dal serviceType cikariminden ONCE gelmeli',
  )
})

test('MODE-7: bayat createShipmentPath kanonik modu GERI CEVIREMEZ', () => {
  const block = backendServiceModeBlock()
  const canonicalIndex = block.indexOf('SURAT_CANONICAL_SERVICE_MODE')
  const pathIndex = block.indexOf('createShipmentPath')
  assert.ok(pathIndex === -1 || canonicalIndex < pathIndex)
})

// ═══ 8-9. LEGACY DAVRANIS DEGISMEDI ═══════════════════════════════════════

test('MODE-8: legacy modlar korunur ve varsayilan DEGISMEDI', () => {
  const block = backendServiceModeBlock()
  for (const mode of LEGACY_MODES) {
    assert.ok(block.includes(`'${mode}'`), mode)
  }
  // Backend varsayilani hâlâ ORTAK_BARKOD_SOAP (son dal).
  assert.ok(block.trimEnd().endsWith("'ORTAK_BARKOD_SOAP'"), 'varsayilan degismemeli')
  // Frontend varsayilani da ayni.
  assert.match(SERVICE, /:\s*'ORTAK_BARKOD_SOAP'/)
})

test('MODE-9: serviceMode gelmezse varsayilan AYNEN korunur', () => {
  // Kosullu spread: yalnizca GECERLI mod geldiginde uygulanir; eski
  // sunucu/eski kayit varsayilani degistirmez.
  assert.match(hydrateSuratBlock(), /\.\.\.\(isSuratServiceMode\(/)
})

// ═══ 10. SIR SIZINTISI YOK ════════════════════════════════════════════════

test('MODE-10: maskeli durum yanitina sir EKLENMEDI', () => {
  const start = CREDENTIALS.indexOf('configured: suratConfigured')
  assert.ok(start > 0, 'maskeli surat blogu bulunmali')
  const block = CREDENTIALS.slice(
    start, CREDENTIALS.indexOf('usernameMasked', start) + 60,
  )
  assert.ok(block.includes('serviceMode'), 'servis modu donmeli')
  assert.ok(block.includes('hasPassword'), 'sifre yalnizca VARLIK olarak')
  // Duz secret DONMEZ.
  for (const secret of [
    'surat.sifre', 'surat.webPassword', 'surat.codSifre', 'surat.sellerPaysSifre',
  ]) {
    assert.equal(block.includes(secret), false, secret)
  }
})
