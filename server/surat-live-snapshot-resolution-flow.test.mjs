import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// CANLI ANLIK GÖRÜNTÜ ÇÖZÜMLEMESİ — üretim kusuru CF-4088678590.
//
// ═══ ÜRETİM KANITI ════════════════════════════════════════════════════════
//   traceId CF-4088678590 · order 11519990745 · package 4088678590
//   stages  PRE_FLIGHT → ROUTING → FINAL
//   credentialResolved=false · PRIMARY_CREDENTIAL_NOT_CONFIGURED
//   carrierCalled=false · NETWORK_CALLS=0 · CREATE_CALLS=0
//
// AYNI ANDA canary AYNI kiracıda çözüyordu: LEN10:****2622
//
// ═══ KÖK NEDEN ════════════════════════════════════════════════════════════
// `loadOrganizationIntegrationConfig` ŞİFRESİ ÇÖZÜLMÜŞ **HAM** kaydı döner.
// `canonicalPrimary*` alanları o kayıtta YOKTUR — `deriveCanonicalPrimaryAccount`
// TÜRETMESİNDE doğar (canonicalPrimary → live → kullaniciAdi → cariKodu).
// Canlı yol ham kaydı doğrudan anlık görüntüye veriyordu → alan yok → çözülemedi.
//
// Canary'nin kendi yorumu bunu öngörmüştü: "normalizasyonu atlarsa kanonik
// hesabı ASLA göremez ve YANLIŞ BLOCKED üretir."
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK.
assert.notEqual(process.env.REAL_CARRIER_NETWORK, '1')
assert.notEqual(process.env.LIVE_CREATE, '1')

const here = dirname(fileURLToPath(import.meta.url))
const SNAP = await import('./shipments/suratCredentialSnapshot.ts')

const read = (...parts) => readFileSync(join(here, ...parts), 'utf8')
const SERVER = read('index.mjs')
const ADAPTER = read('shipments', 'suratCanonicalCreateAdapter.ts')
const CANARY = read('shipments', 'suratCanaryPrecheckCli.ts')
const INSPECT = read('shipments', 'suratBillingInspectCli.ts')

/**
 * Monalisa-benzeri KİRACI DEPOSU: ham kayıt. `canonicalPrimary*` YOK —
 * müşteri kodu (`cariKodu`) ve gönderi şifresi var. Üretimde canary bunu
 * `LEN10:****2622` olarak çözüyordu.
 */
const RAW_TENANT_STORE = {
  serviceMode: 'SURAT_CANONICAL_API',
  cariKodu: '1234562622',
  sifre: 'tenant-shipping-password',
}

/* ═══ LIVE-CRED-1 — HAM DEPO ARTIK ÇÖZÜLÜR ═════════════════════════ */

test('LIVE-CRED-1: kiraci primary VARSA canli anlik goruntu COZULUR', () => {
  // KUSURUN AYNISI: ham depo dogrudan verilirse COZULMEZ.
  const rawOnly = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: RAW_TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(
    rawOnly.resolved, false,
    'senaryo ham deponun tek basina cozulmedigini temsil etmeli',
  )

  // PAYLASILAN NORMALIZASYON uygulaninca COZULUR.
  const normalized = SNAP.normalizeAuthoritativeSuratStore(RAW_TENANT_STORE)
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: normalized, role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(snapshot.resolved, true, 'PRIMARY_CREDENTIAL_NOT_CONFIGURED devam ediyor')
  assert.equal(snapshot.kullaniciAdi, '1234562622')
  assert.ok(snapshot.accountFingerprint)
})

/* ═══ LIVE-CRED-2 — ÜÇ YOL AYNI PARMAK İZİNİ ÜRETİR ════════════════ */

test('LIVE-CRED-2: canary · dry-run · canli AYNI fonksiyonu kullanir', () => {
  // Yapisal kanit: uc yol da TEK normalizasyon fonksiyonunu cagirir.
  assert.match(SERVER, /normalizeAuthoritativeSuratStore\(tenantIntegration\?\.surat\)/)
  assert.match(CANARY, /normalizeAuthoritativeSuratStore\(stored\)/)
  assert.match(INSPECT, /normalizeAuthoritativeSuratStore\(stored\)/)
  // Kopya turev KALMADI.
  for (const [name, src] of [['canary', CANARY], ['inspect', INSPECT]]) {
    assert.equal(
      /\.\.\.deriveCanonicalPrimaryAccount\(/.test(src), false,
      `${name} hala KENDI turevini uyguluyor`,
    )
  }
  // Davranissal kanit: ayni girdi → ayni parmak izi.
  const fp = (store) => SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: SNAP.normalizeAuthoritativeSuratStore(store),
    role: 'PRIMARY_MARKETPLACE',
  }).accountFingerprint
  assert.equal(fp(RAW_TENANT_STORE), fp({ ...RAW_TENANT_STORE }))
  assert.ok(fp(RAW_TENANT_STORE).startsWith('LEN10:'))
})

test('LIVE-CRED-2b: turev ONCELIK sirasini KORUR', () => {
  // canonicalPrimary → live → kullaniciAdi → cariKodu
  const withLive = SNAP.normalizeAuthoritativeSuratStore({
    liveKullaniciAdi: 'LIVE_ACC', kullaniciAdi: 'ENV_POISONED',
    liveSifre: 'L', sifre: 'E',
  })
  assert.equal(withLive.canonicalPrimaryKullaniciAdi, 'LIVE_ACC',
    'ENV zehirli taban alani live degerini EZDI')
  const withCanonical = SNAP.normalizeAuthoritativeSuratStore({
    canonicalPrimaryKullaniciAdi: 'CANON', liveKullaniciAdi: 'LIVE',
    canonicalPrimarySifre: 'C', liveSifre: 'L',
  })
  assert.equal(withCanonical.canonicalPrimaryKullaniciAdi, 'CANON')
})

/* ═══ LIVE-CRED-3 — İSTEMCİ HÂLÂ SEÇEMEZ ══════════════════════════ */

test('LIVE-CRED-3: istemci B, kiraci A yerine GECEMEZ', () => {
  const tenantA = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: SNAP.normalizeAuthoritativeSuratStore(RAW_TENANT_STORE),
    role: 'PRIMARY_MARKETPLACE',
  })
  // Istemcinin gonderdigi "gecerli gorunumlu" hesap.
  const clientB = '1537690944'
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot: tenantA, wireKullaniciAdi: clientB,
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.errorCode, 'SURAT_CREDENTIAL_WIRE_MISMATCH')
  assert.equal(parity.networkCallCount, 0)
  // Canli yol kimligi KIRACI deposundan yukler; istek govdesinden DEGIL.
  assert.match(SERVER, /loadOrganizationIntegrationConfig\(/)
  assert.match(SERVER, /storedSuratConfig: authoritativeSuratStore/)
  // Duzeltme istemci kimligini GERI ACMADI.
  const live = SERVER.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.equal(
    /storedSuratConfig:\s*request\.body/.test(live), false,
    'istek govdesi yeniden kimlik kaynagi oldu',
  )
})

/* ═══ LIVE-CRED-4 — GERÇEKTEN YOKSA HÂLÂ BLOKLANIR ════════════════ */

test('LIVE-CRED-4: kimlik GERCEKTEN yoksa preflight BLOKLAR, ag 0', () => {
  const empty = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: SNAP.normalizeAuthoritativeSuratStore({}),
    role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(empty.resolved, false)
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot: empty, wireKullaniciAdi: 'anything',
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.errorCode, 'SURAT_ACCOUNT_NOT_CONFIGURED')
  assert.equal(parity.carrierCreateCalled, false)
  assert.equal(parity.networkCallCount, 0)
})

/* ═══ LIVE-CRED-5 — BLOKLU İZDE SAHTE HESAP YOK ═══════════════════ */

test('LIVE-CRED-5: cozulmemis kimlikte maskedAccount BOS', () => {
  // OLCULEN KUSUR: credentialResolved=false iken iz "15******44" gosteriyordu
  // ve bu deger ISTEK GOVDESINDEN geliyordu. Iz, cozulmemis bir kimligi
  // cozulmus gibi GOSTEREMEZ.
  const live = ADAPTER.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(live, /maskedAccount: snapshotUsable && snapshot\.resolved/)
  assert.match(live, /maskAccount\(snapshot\.kullaniciAdi\)/)
  // roleContext (istek govdesi turevi) ARTIK maske kaynagi DEGIL.
  assert.equal(
    /maskedAccount: roleContext\.maskedAccount/.test(live), false,
    'maske hala istek govdesinden turuyor',
  )
})

/* ═══ LIVE-CRED-6 — KAYNAK ETİKETİ KORUNUR ════════════════════════ */

test('LIVE-CRED-6: credentialSource tenant.surat.primary kalir', () => {
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: SNAP.normalizeAuthoritativeSuratStore(RAW_TENANT_STORE),
    role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(snapshot.source, 'tenant.surat.primary')
  assert.equal(snapshot.role, 'PRIMARY_MARKETPLACE')
})

/* ═══ PART 7 — BLOKLU DENEMEDE UYDURMA WIRE AŞAMASI YOK ═══════════ */

test('LIVE-CRED-7: preflight blokluysa REQUEST_READY/CARRIER asamasi YOK', () => {
  const live = ADAPTER.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  // Bloklu donuslerde FINAL asamasi eklenir; REQUEST_READY EKLENMEZ.
  const blockedAt = live.indexOf("outcome: 'BLOCKED_BY_PREFLIGHT'")
  assert.ok(blockedAt > 0, 'preflight blok dali bulunamadi')
  const region = live.slice(Math.max(0, blockedAt - 1200), blockedAt + 400)
  assert.match(region, /carrierCalled: false/)
  assert.match(region, /carrierCreateStatus: 'NOT_STARTED'/)
  assert.equal(
    /stage: 'REQUEST_READY'/.test(region), false,
    'bloklu denemeye uydurma wire asamasi eklenmis',
  )
})

/* ═══ PART 5 — TEK CREATE DOĞRULUK KAYNAĞI ════════════════════════ */

test('LIVE-CRED-8: operator ekraninda legacy create dogruluk kaynagi YOK', () => {
  // Satir sonu (CRLF/LF) checkout ayarina gore degisir; arama bundan
  // ETKILENMEMELI.
  const page = read('..', 'src', 'pages', 'IntegrationDebugPage.tsx')
    .split(String.fromCharCode(13) + String.fromCharCode(10))
    .join(String.fromCharCode(10))
  const guardAt = page.indexOf('{developerDiagnostics ? (')
  // Kapanis, ic ice ternary'lerle KARISMAMALI: fragman kapanisi aranir.
  const closeMarker = ['        </>', '      ) : null}'].join(
    String.fromCharCode(10),
  )
  const guardEnd = page.indexOf(closeMarker, guardAt)
  assert.ok(guardAt > 0 && guardEnd > guardAt, 'gelistirici kapisi yok')
  const gated = page.slice(guardAt, guardEnd)
  // Istemci enstrumantasyonu (API Cagrilari) ve legacy paneller kapinin ICINDE.
  for (const heading of ['API Çağrıları', 'Hata Merkezi', 'Eski Teknik Tanı']) {
    assert.ok(gated.includes(heading), `${heading} operator ekraninda ACIKTA`)
  }
  // Trace V2 paneli kapinin DISINDA (operator gorur).
  const outside = page.slice(0, guardAt) + page.slice(guardEnd)
  assert.ok(
    outside.includes('SuratLiveDebugPanel'),
    'Trace V2 paneli operator ekranindan kalkmis',
  )
})
