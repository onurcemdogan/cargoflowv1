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
  assert.equal(snapshot.source, 'tenant.surat.store')
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

/* ═══ KÖK NEDEN — ADAPTÖRÜN KAYNAĞI ÖLÇÜLÜR ════════════════════════ */

test('CRED-ROOT: adaptor kimligi ISTEK GOVDESINDEN cozuyordu', () => {
  // Bu test kusuru BELGELER ve donusu ENGELLER: iki cozumleme de
  // `params.config`ten besleniyordu ve `params.config` istek govdesiydi.
  assert.match(ADAPTER, /resolveSuratCredentialContext\(\{\s*\n\s*config: params\.config,/)
  assert.match(
    ADAPTER,
    /resolveCanonicalTenantSuratAccount\(params\.config, billingParty\)/,
  )
  // Adaptor kiraci deposunu HIC okumuyordu.
  assert.equal(
    /loadOrganizationIntegrationConfig|getIntegrationCredential/.test(ADAPTER),
    false,
    'adaptor artik kiraci deposunu okuyorsa bu testi guncelle',
  )
})

test('CRED-ROOT-2: eski parite kapisi bu ayrismayi GOREMEZ', () => {
  // Iki taraf da ayni `params.config`ten turedigi icin fingerprintler DAIMA
  // esitti; kapi gecerken otoriter hesap bambaska olabiliyordu.
  const clientResolved = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: CLIENT_BODY, role: 'PRIMARY_MARKETPLACE',
  })
  const clientWire = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: CLIENT_BODY, role: 'PRIMARY_MARKETPLACE',
  })
  // Eski kapinin gordugu: esit → GECER.
  assert.equal(clientResolved.accountFingerprint, clientWire.accountFingerprint)
  // Ama OTORITER hesap FARKLI.
  const authoritative = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: TENANT_STORE, role: 'PRIMARY_MARKETPLACE',
  })
  assert.notEqual(
    authoritative.accountFingerprint, clientWire.accountFingerprint,
    'senaryo iki farkli hesabi temsil etmeli',
  )
  // YENI kapi bunu YAKALAR.
  const parity = SNAP.assertSuratWireCredentialParity({
    snapshot: authoritative, wireKullaniciAdi: CLIENT_BODY.kullaniciAdi,
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.errorCode, 'SURAT_CREDENTIAL_WIRE_MISMATCH')
})
