import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  classifyNetworkFailure,
  userMessageForNetworkFailure,
  runNetworkProbe,
} from './surat-network-diagnostics.mjs'

// Sürat ağ tanılaması testleri A-N. Kök neden (canlı): Sürat SOAP host'una
// (webservices.suratkargo.com.tr, tek IPv4) Railway egress'inden connect timeout
// — IP whitelist/geo-block. Bu testler sınıflandırmayı, NOT_SENT/UNKNOWN ayrımını,
// güvenli read-only probe'u ve endpoint'in ortamdan bağımsızlığını doğrular.
// CREATE/SOAP gönderi operasyonu ÜRETİLMEZ; secret/PII loglanmaz.

const here = dirname(fileURLToPath(import.meta.url))

function fetchErrorWith(code, extra = {}) {
  const error = new TypeError('fetch failed')
  error.cause = { code, ...extra }
  return error
}

test('sınıflandırma D-H: DNS/TLS/connect-timeout/reset + sent ayrımı', () => {
  // D) DNS failure → not_sent.
  const dns = classifyNetworkFailure(fetchErrorWith('ENOTFOUND', { hostname: 'x' }))
  assert.equal(dns.category, 'DNS_FAILURE')
  assert.equal(dns.sent, 'not_sent')
  assert.equal(dns.hostname, 'x')

  // E) TLS failure → not_sent.
  assert.equal(classifyNetworkFailure(fetchErrorWith('CERT_HAS_EXPIRED')).category, 'TLS_FAILURE')
  assert.equal(classifyNetworkFailure(fetchErrorWith('ERR_TLS_CERT_ALTNAME_INVALID')).sent, 'not_sent')

  // F) connect timeout → not_sent (canlı hatanın kategorisi).
  const ct = classifyNetworkFailure(fetchErrorWith('UND_ERR_CONNECT_TIMEOUT'))
  assert.equal(ct.category, 'CONNECT_TIMEOUT')
  assert.equal(ct.phase, 'connect_timeout')
  assert.equal(ct.sent, 'not_sent')

  // TCP refused/unreachable → not_sent.
  assert.equal(classifyNetworkFailure(fetchErrorWith('ECONNREFUSED')).category, 'CONNECT_REFUSED')
  assert.equal(classifyNetworkFailure(fetchErrorWith('ENETUNREACH')).sent, 'not_sent')

  // G) request gönderilmeden hata → NOT_SENT.
  assert.equal(ct.sent, 'not_sent')

  // H) request sonrası belirsiz hata (reset/socket) → UNKNOWN.
  const reset = classifyNetworkFailure(fetchErrorWith('ECONNRESET'))
  assert.equal(reset.category, 'CONNECTION_RESET')
  assert.equal(reset.sent, 'unknown')
  const closed = classifyNetworkFailure(fetchErrorWith('UND_ERR_SOCKET', { message: 'other side closed' }))
  assert.equal(closed.sent, 'unknown')

  // Sınıflanamayan → güvenli tarafta unknown (kör retry engellenir).
  assert.equal(classifyNetworkFailure(fetchErrorWith('SOMETHING_NEW')).sent, 'unknown')
})

test('mesaj I/J: NOT_SENT vs UNKNOWN kullanıcı mesajı (kör create engeli)', () => {
  const notSent = userMessageForNetworkFailure({ sent: 'not_sent' })
  assert.match(notSent, /ulaşılamıyor/)
  assert.match(notSent, /doğrulanmadan tekrar oluşturmayın/)
  // H/I) belirsiz durumda: gönderi oluşmuş OLABİLİR → doğrulamadan tekrar oluşturma.
  const unknown = userMessageForNetworkFailure({ sent: 'unknown' })
  assert.match(unknown, /oluşturulmuş olabilir/)
  assert.match(unknown, /doğrulamadan tekrar oluşturmayın/)
})

test('K: sınıflandırma/probe çıktısı secret/PII içermez', async () => {
  const c = classifyNetworkFailure(fetchErrorWith('ENOTFOUND', { hostname: 'h' }))
  // Yalnız güvenli teknik alanlar.
  assert.deepEqual(Object.keys(c).sort(), ['category', 'code', 'hostname', 'phase', 'sent'])
  const dump = JSON.stringify(c)
  assert.ok(!/sifre|password|kullaniciadi|websifre/i.test(dump))
})

test('D/probe: DNS çözülemeyen host → dns error, create yok', async () => {
  const probe = await runNetworkProbe('https://nonexistent-host.invalid/services.asmx', { timeoutMs: 2000 })
  assert.equal(probe.hostname, 'nonexistent-host.invalid')
  assert.equal(probe.dns.addresses.length, 0)
  assert.ok(probe.tcp.connected === false)
  // Probe read-only: http status alınmadı (DNS erken döndü).
  assert.equal(probe.http.status, null)
})

test('F/probe: erişilemez IP → TCP bağlanamaz (connect timeout benzeri)', async () => {
  // 203.0.113.0/24 = TEST-NET-3 (routable değil) → connect timeout/unreachable.
  const probe = await runNetworkProbe('https://203.0.113.1/services.asmx', { timeoutMs: 1500, selectedEnvironment: 'test' })
  assert.equal(probe.selectedEnvironment, 'test')
  assert.deepEqual(probe.dns.addresses, ['203.0.113.1'])
  assert.deepEqual(probe.dns.families, ['IPv4'])
  assert.equal(probe.tcp.connected, false)
  assert.ok(probe.tcp.error) // TCP_TIMEOUT / EHOSTUNREACH / ...
  // TLS/HTTP denenmedi (TCP başarısız) → authorized false.
  assert.equal(probe.tls.authorized, false)
})

// A/B/L) Endpoint ortamdan BAĞIMSIZDIR: tek SOAP URL (webservices), prova YOK.
// Kaynak-seviyesi regresyon guard'ı.
test('A/B/L: SOAP endpoint webservices (tek), prova endpoint yok', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(source, /webservices\.suratkargo\.com\.tr\/services\.asmx/)
  // prova/test SOAP endpoint kullanılmıyor (ortam yalnız credential seçer).
  assert.doesNotMatch(source, /prova\.suratkargo\.com\.tr/)
  // callSuratSoap tek fetch (kör retry döngüsü yok).
  const soapFn = source.slice(source.indexOf('async function callSuratSoap'))
  const soapBody = soapFn.slice(0, soapFn.indexOf('\n}\n'))
  const fetchCount = (soapBody.match(/await fetch\(/g) || []).length
  assert.equal(fetchCount, 1, 'callSuratSoap tek fetch yapar (retry döngüsü yok)')
})

// I/J/N) Diagnose script ve probe SALT-OKUMA: SOAP POST/SOAPAction YOK.
test('I/J/N: tanılama read-only (SOAP POST/create yok)', () => {
  const diag = readFileSync(join(here, 'diagnose-surat-network.mjs'), 'utf8')
  const mod = readFileSync(join(here, 'surat-network-diagnostics.mjs'), 'utf8')
  assert.doesNotMatch(diag, /SOAPAction/)
  assert.doesNotMatch(mod, /SOAPAction/)
  // Probe yalnız GET kullanır.
  assert.match(mod, /method:\s*'GET'/)
  assert.doesNotMatch(mod, /method:\s*'POST'/)
})
