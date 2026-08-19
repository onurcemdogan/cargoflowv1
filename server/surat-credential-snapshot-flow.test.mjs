import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// CANLI KİMLİK AYRIŞMASI — üretimde ölçülen kusur.
//
// ═══ KANIT ════════════════════════════════════════════════════════════════
//   canary / create-context dry-run (kiracı deposu) → LEN10:****2622
//   canlı create (istek gövdesi)                    → LEN10:****0944
//
// KÖK NEDEN: kanonik adaptör kimliği İKİ kez çözüyordu ama İKİSİ DE
// `params.config`ten, ve `params.config` şuydu:
//     request.body?.config?.surat ?? request.body?.config ?? {}
// yani İSTEMCİ GÖVDESİ. Adaptör kiracının saklanmış kimliğini HİÇ okumuyordu.
//
// Parite kapısı bu yüzden ayrışmayı göremiyordu: aynı istemci gövdesinin iki
// çözümlemesini karşılaştırıyordu ve DAİMA eşit çıkıyordu.
//
// GÜVENLİK: istemci gönderinin hangi cariye yazılacağını belirleyebiliyordu.
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK.
assert.notEqual(process.env.REAL_CARRIER_NETWORK, '1')
assert.notEqual(process.env.LIVE_CREATE, '1')

const here = dirname(fileURLToPath(import.meta.url))
const SNAP = await import('./shipments/suratCredentialSnapshot.ts')
const ADAPTER = readFileSync(
  join(here, 'shipments', 'suratCanonicalCreateAdapter.ts'), 'utf8',
)

// Üretimdeki iki hesap: otoriter (kiracı) ve istemcinin gönderdiği.
const TENANT_STORE = {
  canonicalPrimaryKullaniciAdi: '1234562622',
  canonicalPrimarySifre: 'tenant-secret',
}
/** Aciklama satirlarini atar: kusuru ANLATAN yorumlar yanlis pozitif verir. */
function stripComments(source) {
  return source
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
}

const CLIENT_BODY = {
  kullaniciAdi: '1537690944',
  sifre: 'client-secret',
  firmaId: '1537690944',
}

/* ═══ CRED-1 — YANLIŞ HESAP AĞA ÇIKAMAZ ═════════════════════════════ */

test('CRED-1: otoriter A iken tel B ise AG CAGRISI YOK', () => {
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot, wireKullaniciAdi: CLIENT_BODY.kullaniciAdi,
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.errorCode, 'SURAT_CREDENTIAL_WIRE_MISMATCH')
  assert.equal(parity.carrierCreateCalled, false)
  assert.equal(parity.networkCallCount, 0)
  // Iki parmak izi GERCEKTEN farkli olmali (maskeleme degil, fingerprint).
  assert.notEqual(parity.snapshotFingerprint, parity.wireFingerprint)
})

/* ═══ CRED-2/3/4 — İSTEMCİ/LEGACY/ENV KİMLİĞİ KAZANAMAZ ════════════ */

test('CRED-2: istek govdesindeki kimlik YOK SAYILIR, tel A olur', () => {
  // Anlik goruntu YALNIZ kiraci deposundan uretilir; govde girdi DEGILDIR.
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(snapshot.kullaniciAdi, TENANT_STORE.canonicalPrimaryKullaniciAdi)
  assert.equal(snapshot.source, 'tenant.surat.primary')
  // Govde ile ayni fonksiyona girse bile sonuc DEGISMEZ (govde parametre degil).
  const again = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(again.accountFingerprint, snapshot.accountFingerprint)
  // Ve tel A ile eslesirse gecer.
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot, wireKullaniciAdi: TENANT_STORE.canonicalPrimaryKullaniciAdi,
  })
  assert.equal(parity.ok, true)
})

test('CRED-3: legacy/istemci kimlik alanlari TESPIT edilir (deger tasinmaz)', () => {
  const scan = SNAP.scanClientCredentialFields(CLIENT_BODY)
  assert.equal(scan.present, true)
  assert.ok(scan.fields.includes('kullaniciAdi'))
  assert.ok(scan.fields.includes('sifre'))
  assert.ok(scan.fields.includes('firmaId'))
  // DEGERLER tasinmaz — yalniz alan ADLARI.
  const serialized = JSON.stringify(scan)
  assert.equal(serialized.includes('1537690944'), false, 'kimlik degeri sizdi')
  assert.equal(serialized.includes('client-secret'), false)
  // Temiz govde: tespit YOK.
  assert.equal(SNAP.scanClientCredentialFields({ desi: 3 }).present, false)
})

test('CRED-4: ortam/legacy alanlari anlik goruntuye GIREMEZ', () => {
  const source = readFileSync(
    join(here, 'shipments', 'suratCredentialSnapshot.ts'), 'utf8',
  )
  // YALNIZ KOD olculur; aciklama satirlari kusuru ANLATTIGI icin metinde
  // `request.body` gecer ve ham arama yanlis pozitif verir.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(code.includes('process.env'), false, 'ortam degiskeni okunuyor')
  assert.equal(code.includes('request.body'), false, 'istek govdesi okunuyor')
  // Tek girdi: storedSuratConfig.
  assert.match(code, /storedSuratConfig/)
})

/* ═══ CRED-5/6 — DOĞRU HESAP GEÇER, FP AĞ SINIRINDA ═════════════════ */

test('CRED-5: resolver A · builder A · network A → IZIN VERILIR', () => {
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot, wireKullaniciAdi: snapshot.kullaniciAdi,
  })
  assert.equal(parity.ok, true)
  assert.equal(parity.errorCode, null)
  assert.equal(parity.snapshotFingerprint, parity.wireFingerprint)
})

test('CRED-6: parmak izi GERCEK ag sinirindaki degerden hesaplanir', () => {
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  // Bos/eksik tel degeri de DUSER — "bilinmiyor" gecerli sayilmaz.
  for (const wire of ['', null, undefined, '   ']) {
    const parity = SNAP.assertSuratWireCredentialParity({
      snapshot, wireKullaniciAdi: wire,
    })
    assert.equal(parity.ok, false, String(wire))
    assert.equal(parity.networkCallCount, 0)
  }
})

/* ═══ CRED-7 — KAPIDAN SONRA YENİDEN ÇÖZÜMLEME YOK ═════════════════ */

test('CRED-7: anlik goruntu DEGISMEZ (yeniden cozumleme engellenir)', () => {
  const snapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  assert.equal(Object.isFrozen(snapshot), true, 'anlik goruntu DONDURULMAMIS')
  assert.throws(
    () => { 'use strict'; snapshot.kullaniciAdi = CLIENT_BODY.kullaniciAdi },
    'anlik goruntu uzerine yazilabildi',
  )
})

/* ═══ CRED-8 — ROLLER BAĞIMSIZ, EKSİKSE FAIL-CLOSED ════════════════ */

test('CRED-8: roller BAGIMSIZ ve eksik kimlik fail-closed', () => {
  // SELLER_PAYS ve COD kendi alanlarindan okunur; PRIMARY'ye DUSMEZ.
  const sellerPays = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'SELLER_PAYS',
  })
  assert.equal(sellerPays.resolved, false, 'SELLER_PAYS sessizce PRIMARYye dustu')
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot: sellerPays, wireKullaniciAdi: 'anything',
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.errorCode, 'SURAT_ACCOUNT_NOT_CONFIGURED')
  assert.equal(parity.networkCallCount, 0)

  // Kendi alani varsa cozulur.
  const codSnapshot = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: {
      ...TENANT_STORE,
      canonicalCodKullaniciAdi: '9999992622',
      canonicalCodSifre: 'cod-secret',
    },
    role: 'COD',
  })
  assert.equal(codSnapshot.resolved, true)
  assert.notEqual(codSnapshot.accountFingerprint, sellerPays.accountFingerprint)
})

/* ═══ KÖK NEDEN — ARTIK KAPALI (testler TERSİNE ÇEVRİLDİ) ══════════ */

test('CRED-ROOT: adaptor kimligi ARTIK istek govdesinden COZMEZ', () => {
  // Aciklama satirlari kusuru ANLATTIGI icin YALNIZ KOD olculur.
  const live = stripComments(ADAPTER)
  // IKINCI cozumleme SILINDI.
  assert.equal(
    live.includes('resolveCanonicalTenantSuratAccount(params.config'),
    false,
    'IKINCI kimlik cozumlemesi hala var',
  )
  // Hesap alanlari ANLIK GORUNTUDEN okunur.
  assert.match(live, /kullaniciAdi: snapshot\.kullaniciAdi/)
  assert.match(live, /sifre: snapshot\.sifre/)
  // `config` artik kimlik kaynagi DEGIL: yalniz rol politikasi icin okunur.
  assert.match(live, /const roleContext = resolveSuratCredentialContext\(/)
  assert.match(live, /accountFingerprint: snapshotUsable/)
})

test('CRED-ROOT-2: parite ARTIK otoriter anlik goruntuye karsi olculur', () => {
  const live = stripComments(ADAPTER)
  // Eski kapi iki config cozumlemesini karsilastiriyordu; yenisi anlik
  // goruntuyu telde gidecek degerle karsilastirir.
  assert.match(live, /assertSuratWireCredentialParity\(\{/)
  assert.match(live, /snapshot, wireKullaniciAdi: account\?\.kullaniciAdi/)
})

test('CRED-ROOT-3: anlik goruntu YOKSA fail-closed, AG YOK', () => {
  const live = stripComments(ADAPTER)
  assert.match(live, /SURAT_CREDENTIAL_SNAPSHOT_MISSING/)
  assert.match(live, /networkCallCount: 0/)
  assert.match(live, /carrierCalled: false/)
})

/* ═══ CRED-9/10 — İSTEMCİ SEÇEMEZ · KİRACI İZOLASYONU ══════════════ */

test('CRED-9: istek govdesi faturalama hesabini SECEMEZ', () => {
  // Otoriter A, istemci B gonderiyor.
  const authoritative = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot: authoritative, wireKullaniciAdi: CLIENT_BODY.kullaniciAdi,
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.errorCode, 'SURAT_CREDENTIAL_WIRE_MISMATCH')
  assert.equal(parity.networkCallCount, 0)
  // index.mjs kimligi KIRACI DEPOSUNDAN yukler ve istemci alanlarini tarar.
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(server, /loadActiveSuratIntegrationForOrganization\(/)
  // Ham kayit DOGRUDAN kullanilmaz: normalizasyon paylasilan yukleyicinin
  // ICINDE yapilir; index.mjs yalnizca turetilmis depoyu alir.
  assert.match(server, /authoritativeSuratStore = activeSuratIntegration\.store/)
  assert.match(
    readFileSync(join(here, 'integrations', 'activeSuratIntegration.ts'), 'utf8'),
    /normalizeAuthoritativeSuratStore\(/,
  )
  assert.match(server, /storedSuratConfig: authoritativeSuratStore/)
  assert.match(server, /scanClientCredentialFields\(/)
})

test('CRED-10: kiraci izolasyonu — A kimligi B icin uretilmez', () => {
  const orgA = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  const orgB = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: {
      canonicalPrimaryKullaniciAdi: '7777770000',
      canonicalPrimarySifre: 'b-secret',
    },
    role: 'PRIMARY_MARKETPLACE',
  })
  assert.notEqual(orgA.accountFingerprint, orgB.accountFingerprint)
  // B'nin anlik goruntusuyle A'nin hesabi telde gidemez.
  const cross = SNAP.assertSuratWireCredentialParity({
    snapshot: orgB, wireKullaniciAdi: orgA.kullaniciAdi,
  })
  assert.equal(cross.ok, false)
  assert.equal(cross.networkCallCount, 0)
})

/* ═══ KAPIDAN SONRA ÜZERİNE YAZMA YOK ══════════════════════════════ */

test('CRED-POSTGUARD: parite kapisindan SONRA kimlik degistirilemez', () => {
  const service = readFileSync(
    join(here, 'shipments', 'suratCanonicalShipmentService.ts'), 'utf8',
  )
  const guardAt = service.indexOf('assertSuratWireCredentialParity({')
  const fetchAt = service.indexOf('await createOrtakBarkodShipment({')
  assert.ok(guardAt > 0, 'ag sinirinda parite kapisi YOK')
  assert.ok(guardAt < fetchAt, 'kapi fetchten SONRA calisiyor')
  // Kapi ile ag cagrisi ARASINDA kimlik atamasi/aramasi OLMAMALI.
  const between = service.slice(guardAt, fetchAt)
  for (const forbidden of [
    'credentials =', 'kullaniciAdi =', 'sifre =',
    'resolveTenantSuratProductionCredentials', 'resolveCanonicalTenantSuratAccount',
  ]) {
    assert.equal(
      between.includes(forbidden), false,
      `kapidan SONRA kimlik degistiriliyor: ${forbidden}`,
    )
  }
})
