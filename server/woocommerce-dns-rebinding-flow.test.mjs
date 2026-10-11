// WOOCOMMERCE-001 — DNS REBINDING / DOĞRULAMA-KULLANIM TOCTOU KABUL PAKETİ.
//
// ═══ ÖLÇÜLEN AÇIK ════════════════════════════════════════════════════════
//
// Politika adı çözüp adresleri onaylıyordu:
//
//   assertStoreUrlAllowed(storeUrl) → ad çözümle → adresleri denetle
//
// ...ama istek sonra `fetch(hostname)` ile gidiyordu ve ÇALIŞMA ZAMANI adı
// BİR KEZ DAHA çözüyordu. İki BAĞIMSIZ çözümleme:
//
//   doğrulama araması : herkese açık adres  → KABUL
//   soket araması     : 127.0.0.1 / RFC1918 / metadata → BAĞLANIR
//
// "Fetch'ten hemen önce bir kez daha bak" bunu ÇÖZMEZ: aynı hata sınıfıdır.
//
// ═══ KANIT BİÇİMİ ════════════════════════════════════════════════════════
//
// Sabitleme KAYNAK TARAMASIYLA değil, GERÇEK SOKETLE kanıtlanır: yerel bir
// TCP dinleyici kurulur ve "bağlantı oraya DÜŞTÜ MÜ" sayılır. Aynı ad, aynı
// kod yolu — yalnız SABİTLENEN ADRES değişir ve paket BAŞKA yere gider.
//
// GERÇEK bir WooCommerce mağazasına istek ATILMAZ; hedefler yereldir ya da
// yönlendirilemez TEST-NET adresleridir.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))

const policy = await import('./connectors/storeUrlPolicy.ts')
const wooClient = await import('./connectors/woocommerce/wooClient.ts')

const CREDENTIALS = {
  storeUrl: 'https://shop.example.com',
  consumerKey: 'ck_live_abcd1234',
  consumerSecret: 'cs_live_zzzz9999',
}

/** Herkese açık adrese çözen sahte DNS (politika girdisi). */
const publicResolver = async () => [{ address: '93.184.216.34' }]

/**
 * YEREL TCP DİNLEYİCİ — "bağlantı buraya düştü mü" sayacı.
 *
 * TLS SONLANDIRILMAZ: sertifika üretmeye gerek yoktur ve gerekmez de —
 * ölçtüğümüz şey TCP bağlantısının NEREYE gittiğidir. İstemcinin ilk
 * gönderdiği bayt bloğu TLS ClientHello'dur ve SNI orada DÜZ METİNDİR.
 */
async function startConnectionSink() {
  let connections = 0
  const firstBytes = []
  const server = createServer((socket) => {
    connections += 1
    socket.once('data', (chunk) => firstBytes.push(Buffer.from(chunk)))
    socket.on('error', () => {})
  })
  // Host verilmez → IPv6 varsa `::` (çift yığın): 127.0.0.1 de ::1 de düşer.
  await new Promise((resolve) => server.listen(0, resolve))
  return {
    port: server.address().port,
    get connections() {
      return connections
    },
    get firstBytes() {
      return firstBytes
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Kontrollü `https.request` — seçenekleri kaydeder, hazır yanıt döndürür. */
function fakeHttpsRequest(reply = { statusCode: 200, headers: {}, body: '[]' }) {
  const calls = []
  const request = (options, callback) => {
    calls.push(options)
    const clientRequest = new EventEmitter()
    clientRequest.end = () => {
      queueMicrotask(() => {
        const response = Readable.from([Buffer.from(String(reply.body ?? ''), 'utf8')])
        response.statusCode = reply.statusCode
        response.headers = reply.headers ?? {}
        callback(response)
      })
    }
    clientRequest.destroy = () => {}
    return clientRequest
  }
  return { request, calls }
}

/** Taşımayı kaydeden sahte taşıma katmanı (politika kapısı testleri için). */
function recordingTransport(response = { status: 200, headers: {}, bodyText: '[]' }) {
  const requests = []
  return {
    requests,
    transport: async (request) => {
      requests.push(request)
      return response
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   SABİTLENMİŞ AD ARAMASI — BİRİM DAVRANIŞI
   ═══════════════════════════════════════════════════════════════════════ */

test('WOO-DNS-PIN: sabitlenmiş arama YALNIZ onaylanmış adresleri döndürür', async () => {
  const lookup = policy.createPinnedLookup(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])

  // `all: true` (Node autoSelectFamily) → DİZİ biçimi.
  const all = await new Promise((resolve, reject) => {
    lookup('shop.example.com', { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    )
  })
  assert.deepEqual(
    all.map((record) => record.address),
    ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
  )

  // `all` yok → TEK adres biçimi. İki biçimden yalnız birini desteklemek
  // üretimde SESSİZCE kırardı.
  const single = await new Promise((resolve, reject) => {
    lookup('shop.example.com', {}, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    )
  })
  assert.deepEqual(single, { address: '93.184.216.34', family: 4 })

  // Aile süzgeci — sayı ve METİN ('IPv6') biçimi.
  for (const family of [6, 'IPv6']) {
    const only = await new Promise((resolve, reject) => {
      lookup('shop.example.com', { family, all: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses),
      )
    })
    assert.deepEqual(
      only.map((record) => record.address),
      ['2606:2800:220:1:248:1893:25c8:1946'],
    )
  }
})

test('WOO-DNS-PIN-2: küme BOŞSA sistem aramasına DÜŞÜLMEZ (fail-closed)', async () => {
  const empty = policy.createPinnedLookup([])
  const error = await new Promise((resolve) => {
    empty('localhost', { all: true }, (err) => resolve(err))
  })
  assert.ok(error, 'boş kümede hata dönmeli')
  assert.equal(error.code, 'ENOTFOUND')

  // İstenen aile kümede yoksa da DÜŞÜLMEZ.
  const ipv4Only = policy.createPinnedLookup(['93.184.216.34'])
  const familyError = await new Promise((resolve) => {
    ipv4Only('shop.example.com', { family: 6, all: true }, (err) => resolve(err))
  })
  assert.ok(familyError)
  assert.equal(familyError.code, 'ENOTFOUND')
})

/* ═══════════════════════════════════════════════════════════════════════
   GERÇEK SOKET — SABİTLEME KANITI
   ═══════════════════════════════════════════════════════════════════════ */

test('WOO-DNS-1: sistem DNS loopback dese bile bağlantı ORAYA GİTMEZ', async (t) => {
  const sink = await startConnectionSink()
  t.after(() => sink.close())

  // `localhost` SİSTEM çözümleyicisinde loopback'e gider — yani "sonraki
  // arama 127.0.0.1 döndürür" senaryosu GERÇEKTEN kurulur.
  //
  // Politika bu adı ZATEN reddeder (WOO-SSRF); burada ölçülen şey POLİTİKA
  // DEĞİL, TAŞIMA KATMANININ SABİTLEMESİDİR: "doğrulama herkese açık adres
  // gördü" varsayımı taşımaya AÇIKÇA verilir.
  const transport = wooClient.createPinnedHttpsTransport({ timeoutMs: 1500 })
  let failed = false
  try {
    await transport({
      url: `https://localhost:${sink.port}/wp-json/wc/v3/orders`,
      method: 'GET',
      headers: { Authorization: 'Basic redacted' },
      // TEST-NET-3 — yönlendirilemez, "herkese açık" adres.
      approvedAddresses: ['203.0.113.10'],
    })
  } catch {
    failed = true
  }

  assert.equal(
    sink.connections,
    0,
    'SABİTLEME KIRILDI: bağlantı sistem DNS sonucuna (loopback) düştü',
  )
  assert.equal(failed, true, 'onaylanmayan hedefe bağlanma BAŞARILI sayılamaz')
})

test('WOO-DNS-2: bağlantı TAM OLARAK onaylanmış adrese kurulur + SNI ADdır', async (t) => {
  const sink = await startConnectionSink()
  t.after(() => sink.close())

  // `.test` AYRILMIŞ TLD'dir: sistem çözümleyicisi bunu ASLA çözemez.
  // Bağlantı kurulabiliyorsa bunun TEK açıklaması SABİTLENMİŞ adrestir.
  const hostname = 'cargoflow-pinned.test'
  const transport = wooClient.createPinnedHttpsTransport({ timeoutMs: 1500 })
  try {
    await transport({
      url: `https://${hostname}:${sink.port}/wp-json/wc/v3/orders`,
      method: 'GET',
      headers: { Authorization: 'Basic redacted' },
      approvedAddresses: ['127.0.0.1'],
    })
  } catch {
    // TLS sonlandırılmıyor; el sıkışma tamamlanmaz. Ölçtüğümüz şey BU DEĞİL.
  }

  assert.equal(sink.connections, 1, 'bağlantı onaylanmış adrese kurulmalıydı')

  // ═══ WOO-DNS-6: TLS SNI ORİJİNAL AD, IP DEĞİL ═══════════════════════
  //
  // ClientHello DÜZ METİNDİR ve SNI uzantısı ADI taşır. IP yazılsaydı
  // sertifika doğrulaması anlamsızlaşırdı.
  const hello = Buffer.concat(sink.firstBytes)
  assert.ok(hello.length > 0, 'ClientHello alınmalıydı')
  assert.equal(hello[0], 0x16, 'ilk kayıt TLS handshake olmalı (düz HTTP DEĞİL)')
  assert.ok(
    hello.includes(Buffer.from(hostname, 'ascii')),
    'SNI orijinal AD olmalı',
  )
  assert.ok(
    !hello.includes(Buffer.from('127.0.0.1', 'ascii')),
    'SNI yerine IP yazılmamalı',
  )
})

/* ═══════════════════════════════════════════════════════════════════════
   TAŞIMA SEÇENEKLERİ — TLS / BAŞLIK / YÖNLENDİRME
   ═══════════════════════════════════════════════════════════════════════ */

test('WOO-DNS-6b: sertifika doğrulaması AÇIK, Host ve SNI ORİJİNAL AD', async () => {
  const fake = fakeHttpsRequest()
  const transport = wooClient.createPinnedHttpsTransport({ request: fake.request })
  await transport({
    url: 'https://shop.example.com/wp-json/wc/v3/orders?page=1',
    method: 'GET',
    headers: { Authorization: 'Basic secret', Accept: 'application/json' },
    approvedAddresses: ['93.184.216.34'],
  })

  assert.equal(fake.calls.length, 1)
  const options = fake.calls[0]
  assert.equal(options.host, 'shop.example.com', 'Host başlığı ADdan türemeli')
  assert.equal(options.servername, 'shop.example.com', 'TLS SNI ADdır')
  assert.equal(options.rejectUnauthorized, true, 'sertifika doğrulaması KAPATILAMAZ')
  assert.equal(options.protocol, 'https:')
  assert.equal(options.path, '/wp-json/wc/v3/orders?page=1')
  assert.equal(typeof options.lookup, 'function', 'soket SABİTLENMİŞ arama kullanmalı')

  // Soketin kullanacağı arama GERÇEKTEN onaylanmış kümeyi döndürüyor mu.
  const resolved = await new Promise((resolve, reject) => {
    options.lookup('shop.example.com', { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    )
  })
  assert.deepEqual(
    resolved.map((record) => record.address),
    ['93.184.216.34'],
  )
})

test('WOO-DNS-8: yönlendirme İZLENMEZ', async () => {
  const fake = fakeHttpsRequest({
    statusCode: 302,
    headers: { location: 'https://169.254.169.254/latest/meta-data/' },
    body: '',
  })
  const transport = wooClient.createPinnedHttpsTransport({ request: fake.request })
  const response = await transport({
    url: 'https://shop.example.com/wp-json/wc/v3/orders',
    method: 'GET',
    headers: {},
    approvedAddresses: ['93.184.216.34'],
  })

  assert.equal(response.status, 302, 'yönlendirme çağırana OLDUĞU GİBİ bildirilir')
  assert.equal(fake.calls.length, 1, 'İKİNCİ istek AÇILMAZ — yönlendirme izlenmez')
  assert.equal(response.headers.location, 'https://169.254.169.254/latest/meta-data/')

  // İzlenecek olsaydı hedef AYNI kapıdan geçmek zorundaydı (bu bilette YOK).
  const verdict = await wooClient.validateRedirectTarget(response.headers.location)
  assert.equal(verdict.allowed, false)
})

/* ═══════════════════════════════════════════════════════════════════════
   POLİTİKA — AĞA ÇIKMADAN RET
   ═══════════════════════════════════════════════════════════════════════ */

test('WOO-DNS-3: A + AAAA karışımında BİRİ özelse TÜM hedef reddedilir', async () => {
  const mixed = async () => [
    { address: '93.184.216.34' },
    { address: 'fd00::1' },
  ]
  const decision = await policy.assertStoreUrlAllowed('https://shop.example.com', {
    resolver: mixed,
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.rejection, 'PRIVATE_RESOLVED_ADDRESS')

  // AĞA HİÇ ÇIKILMADI: taşıma katmanı ÇAĞRILMADI.
  const recorder = recordingTransport()
  const result = await wooClient.testWooConnection(CREDENTIALS, {
    transport: recorder.transport,
    resolver: mixed,
  })
  assert.equal(result.errorClass, 'STORE_URL_REJECTED')
  assert.equal(recorder.requests.length, 0, 'reddedilen hedefe istek KURULMAZ')
})

test('WOO-DNS-4: IPv6 loopback / ULA / link-local REDDEDİLİR', async () => {
  for (const literal of ['https://[::1]', 'https://[fd00::1]', 'https://[fe80::1]']) {
    const decision = await policy.assertStoreUrlAllowed(literal, { resolver: publicResolver })
    assert.equal(decision.ok, false, `${literal} kabul edilmemeli`)
    assert.equal(decision.rejection, 'PRIVATE_HOST')
  }
  // Ad herkese açık GÖRÜNÜP özel IPv6'ya çözülüyorsa da reddedilir.
  for (const address of ['::1', 'fd00::abcd', 'fe80::1234', '::ffff:127.0.0.1']) {
    const decision = await policy.assertStoreUrlAllowed('https://shop.example.com', {
      resolver: async () => [{ address }],
    })
    assert.equal(decision.ok, false, `${address} kabul edilmemeli`)
    assert.equal(decision.rejection, 'PRIVATE_RESOLVED_ADDRESS')
  }
})

test('WOO-DNS-5: bulut metadata / link-local REDDEDİLİR', async () => {
  const decision = await policy.assertStoreUrlAllowed('https://169.254.169.254', {
    resolver: publicResolver,
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.rejection, 'PRIVATE_HOST')

  for (const host of ['metadata', 'metadata.google.internal']) {
    const byName = await policy.assertStoreUrlAllowed(`https://${host}`, {
      resolver: publicResolver,
    })
    assert.equal(byName.ok, false, `${host} kabul edilmemeli`)
  }

  const rebind = await policy.assertStoreUrlAllowed('https://shop.example.com', {
    resolver: async () => [{ address: '169.254.169.254' }],
  })
  assert.equal(rebind.ok, false)
  assert.equal(rebind.rejection, 'PRIVATE_RESOLVED_ADDRESS')
})

/* ═══════════════════════════════════════════════════════════════════════
   UÇTAN UCA BAĞLANTI — ONAY KÜMESİ İSTEĞE TAŞINIR
   ═══════════════════════════════════════════════════════════════════════ */

test('WOO-DNS-7: Authorization YALNIZ doğrulanmış hedefe ve onaylı adrese gider', async () => {
  const recorder = recordingTransport()
  const result = await wooClient.testWooConnection(CREDENTIALS, {
    transport: recorder.transport,
    resolver: publicResolver,
  })
  assert.equal(result.ok, true)
  assert.equal(recorder.requests.length, 1)
  const sent = recorder.requests[0]

  // Sır BAŞLIKTA; sorgu dizesinde ASLA.
  assert.match(sent.headers.Authorization, /^Basic /)
  assert.ok(!sent.url.includes('consumer_secret'))
  assert.ok(!sent.url.includes(CREDENTIALS.consumerSecret))
  assert.ok(sent.url.startsWith('https://shop.example.com/wp-json/wc/v3/orders'))

  // POLİTİKANIN ÇÖZDÜĞÜ KÜME isteğe TAŞINIR: taşıma yeniden çözmez.
  assert.deepEqual([...sent.approvedAddresses], ['93.184.216.34'])

  // Hedef reddedilirse başlık HİÇBİR YERE gitmez.
  const blocked = recordingTransport()
  const rejected = await wooClient.testWooConnection(CREDENTIALS, {
    transport: blocked.transport,
    resolver: async () => [{ address: '10.0.0.5' }],
  })
  assert.equal(rejected.errorClass, 'STORE_URL_REJECTED')
  assert.equal(blocked.requests.length, 0)
})

test('WOO-DNS-WIRE: IP literali hedefte onay kümesi KENDİ adresidir', async () => {
  const syntax = policy.inspectStoreUrlSyntax('https://93.184.216.34')
  assert.equal(syntax.ok, true)
  assert.deepEqual(syntax.approvedAddresses, ['93.184.216.34'])

  // Ad için sözdizimi denetimi BOŞ küme verir (henüz çözümlenmedi) —
  // sabitlenmiş arama bunu fail-closed reddeder.
  const nameOnly = policy.inspectStoreUrlSyntax('https://shop.example.com')
  assert.deepEqual(nameOnly.approvedAddresses, [])

  const resolved = await policy.assertStoreUrlAllowed('https://shop.example.com', {
    resolver: async () => [{ address: '93.184.216.34' }, { address: '93.184.216.35' }],
  })
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.approvedAddresses, ['93.184.216.34', '93.184.216.35'])
})

test('WOO-DNS-REG: paket tam pakete KAYITLI', () => {
  const files = JSON.parse(readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'))
  assert.ok(files.includes('server/woocommerce-dns-rebinding-flow.test.mjs'))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.ok(
    String(pkg.scripts['test:woocommerce']).includes('woocommerce-dns-rebinding-flow.test.mjs'),
  )
})
