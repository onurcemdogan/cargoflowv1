// CLI: npm run diagnose:surat-network
// Railway Shell'den güvenli çalıştırılır. Sürat SOAP hostname'ine DNS/TCP/TLS/
// HTTP erişimini test eder. CREATE/SOAP gönderi operasyonu YAPMAZ. Çıktı yalnız
// güvenli teknik alanlar içerir; credential/PII/SOAP body loglanmaz.
import { runNetworkProbe } from './surat-network-diagnostics.mjs'

const SURAT_SOAP_URL =
  process.env.SURAT_SOAP_URL || 'https://webservices.suratkargo.com.tr/services.asmx'

// Ortam yalnız etiket amaçlı raporlanır (endpoint tek: webservices).
const selectedEnvironment =
  process.env.SURAT_ENV === 'live'
    ? 'live'
    : process.env.SURAT_ENV === 'test'
      ? 'test'
      : 'default(test)'

console.info('[diagnose:surat-network] Sürat ağ erişim tanılaması (salt-okuma; create YOK)')
const probe = await runNetworkProbe(SURAT_SOAP_URL, { selectedEnvironment })

// Güvenli özet — yalnız teknik alanlar.
console.info(
  JSON.stringify(
    {
      selectedEnvironment: probe.selectedEnvironment,
      hostname: probe.hostname,
      port: probe.port,
      dnsAddresses: probe.dns?.addresses ?? [],
      dnsFamilies: probe.dns?.families ?? [],
      dnsError: probe.dns?.error ?? null,
      tcpConnected: probe.tcp?.connected ?? false,
      tcpError: probe.tcp?.error ?? null,
      tlsAuthorized: probe.tls?.authorized ?? false,
      tlsProtocol: probe.tls?.protocol ?? null,
      certSubjectCN: probe.tls?.certSubjectCN ?? null,
      certIssuerCN: probe.tls?.certIssuerCN ?? null,
      tlsError: probe.tls?.error ?? null,
      httpStatus: probe.http?.status ?? null,
      httpError: probe.http?.error ?? null,
      elapsedMs: probe.elapsedMs,
    },
    null,
    2,
  ),
)

// Yorum: erişilebilirlik özeti.
if (probe.tls?.authorized && (probe.http?.status ?? 0) > 0) {
  console.info('[diagnose:surat-network] SONUÇ: Sürat SOAP host erişilebilir (DNS+TLS+HTTP OK).')
} else if (!probe.dns?.addresses?.length) {
  console.info('[diagnose:surat-network] SONUÇ: DNS çözülemedi (ENOTFOUND/EAI_AGAIN?).')
} else if (!probe.tcp?.connected) {
  console.info(
    '[diagnose:surat-network] SONUÇ: TCP bağlantısı kurulamadı (connect timeout / IPv6 routing / IP whitelist?). ' +
      `DNS aileleri: ${(probe.dns?.families ?? []).join(', ')}.`,
  )
} else if (!probe.tls?.authorized) {
  console.info('[diagnose:surat-network] SONUÇ: TLS handshake/sertifika sorunu.')
} else {
  console.info('[diagnose:surat-network] SONUÇ: HTTP katmanında sorun; ayrıntı için httpError.')
}

process.exit(0)
