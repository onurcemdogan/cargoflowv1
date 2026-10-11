// MAĞAZA URL POLİTİKASI — SSRF SINIRI.
//
// ═══ NEDEN BU BİR GÜVENLİK SINIRI ════════════════════════════════════════
//
// `storeUrl` KULLANICI GİRDİSİDİR ve SUNUCUNUN kendi ağından HTTP isteği
// başlatır. Doğrulanmazsa kiracı, CargoFlow sunucusunu kendi iç ağına
// (veya bulut metadata ucuna) istek atmaya ZORLAYABİLİR. Bu, kimlik bilgisi
// sızdıran klasik SSRF'tir.
//
// ═══ HOSTNAME METNİNE GÜVENİLMEZ ═════════════════════════════════════════
//
// `evil.example.com` herkese açık GÖRÜNÜR ama 127.0.0.1'e ÇÖZÜLEBİLİR.
// Bu yüzden ad çözümlemesi YAPILIR ve ÇÖZÜLEN ADRESLER denetlenir.
// Yönlendirmeler de aynı kapıdan geçer: her hedef YENİDEN doğrulanır.
//
// ═══ DOĞRULAMA İLE BAĞLANTI AYNI ÇÖZÜMLEMEYİ PAYLAŞMAK ZORUNDA ═══════════
//
// ÖLÇÜLEN AÇIK: politika adı çözüp adresleri onaylıyordu, ama istek sonra
// `fetch(hostname)` ile gidiyordu ve çalışma zamanı adı BİR KEZ DAHA
// çözüyordu. İki BAĞIMSIZ çözümleme = DNS rebinding / doğrulama-kullanım
// TOCTOU: ilk arama herkese açık adres, ikinci arama loopback/RFC1918/
// metadata dönebilir.
//
// "Fetch'ten hemen önce bir kez daha DNS bak" bunu ÇÖZMEZ — aynı hata
// sınıfıdır, yalnız pencere daralır.
//
// Bu yüzden politika artık ONAYLANMIŞ ADRES KÜMESİNİ döndürür ve taşıma
// katmanı soketi YALNIZ o kümeyle kurar (`createPinnedLookup`). Ad,
// Host başlığı ve TLS SNI için OLDUĞU GİBİ korunur; sertifika doğrulaması
// KAPATILMAZ. Bağlantı anında YENİ bir ad araması YAPILMAZ.
//
// ═══ KİMLİK BU DOSYADA ÜRETİLMEZ ═════════════════════════════════════════
//
// Mağaza kimliği `canonicalIdentity.storeFingerprint` ile üretilir. Buradaki
// normalleştirme YALNIZCA politika içindir; ikinci bir normalleştirme
// algoritması YAZILMAZ (WOO-ACC-1 bunu kilitler).
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Politikanın reddetme sebepleri — kararlı kodlar, ham metin değil. */
export const STORE_URL_REJECTIONS = [
  'EMPTY',
  'MALFORMED',
  'NOT_HTTPS',
  'EMBEDDED_CREDENTIALS',
  'QUERY_NOT_ALLOWED',
  'FRAGMENT_NOT_ALLOWED',
  'PRIVATE_HOST',
  'DNS_UNRESOLVED',
  'PRIVATE_RESOLVED_ADDRESS',
] as const
export type StoreUrlRejection = (typeof STORE_URL_REJECTIONS)[number]

export interface StoreUrlAccepted {
  ok: true
  /** Politika-normalleştirilmiş mutlak kök (istek kurmak için). */
  normalizedUrl: string
  host: string
  /** Anlamlı WordPress alt yolu (yoksa ''). */
  basePath: string
  /**
   * POLİTİKANIN ONAYLADIĞI ADRES KÜMESİ.
   *
   * Soket YALNIZ bunlardan birine bağlanır. Sözdizimi denetimi (ağ yok) bir
   * IP literali için o adresi döndürür, ad için BOŞ küme döndürür — boş küme
   * "henüz çözümlenmedi" demektir ve sabitlenmiş arama onu FAIL-CLOSED
   * reddeder.
   */
  approvedAddresses: string[]
}
export interface StoreUrlRejected {
  ok: false
  rejection: StoreUrlRejection
}
export type StoreUrlDecision = StoreUrlAccepted | StoreUrlRejected

/**
 * Adres ÖZEL Mİ — metin değil, SAYISAL denetim.
 *
 * Kapsananlar: loopback, RFC1918, link-local (169.254/16 → bulut metadata
 * 169.254.169.254 dâhil), CGNAT, multicast, broadcast, "bu ağ", IPv6
 * loopback/ULA/link-local ve IPv4-eşlemli IPv6.
 */
export function isPrivateAddress(address: string): boolean {
  const value = String(address ?? '').trim().toLowerCase()
  if (value === '') return true
  const version = isIP(value)

  if (version === 4) {
    const parts = value.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true
    }
    const [a, b] = parts as [number, number, number, number]
    if (a === 0) return true // "bu ağ"
    if (a === 10) return true // RFC1918
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local + bulut metadata
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
    if (a === 192 && b === 168) return true // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 192 && b === 0) return true // IETF protokol tahsisi
    if (a >= 224) return true // multicast + rezerve + broadcast
    return false
  }

  if (version === 6) {
    const plain = value.replace(/^\[|\]$/g, '')
    if (plain === '::1' || plain === '::') return true
    // IPv4-eşlemli/uyumlu: ::ffff:127.0.0.1 gibi kaçışlar kapatılır.
    const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(plain)
    if (mapped) return isPrivateAddress(mapped[1] as string)
    if (/^f[cd]/.test(plain)) return true // ULA fc00::/7
    if (/^fe[89ab]/.test(plain)) return true // link-local fe80::/10
    if (/^ff/.test(plain)) return true // multicast
    return false
  }

  // IP DEĞİL → burada karar verilmez (ad çözümlemesi ayrıca yapılır).
  return false
}

/** Kesinlikle yerel olan adlar — çözümlemeye bile gerek yok. */
const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
])

function hostIsForbiddenByName(host: string): boolean {
  const value = host.toLowerCase().replace(/\.$/, '')
  if (FORBIDDEN_HOSTNAMES.has(value)) return true
  // `.local` / `.internal` / `.localhost` TLD'leri dış dünyaya çözülmez.
  return /\.(local|internal|localhost|home\.arpa)$/.test(value)
}

/**
 * SÖZDİZİMİ + POLİTİKA denetimi (AĞ YOK).
 *
 * Ayrıştırılabilir olması yetmez: şema, gömülü kimlik, sorgu ve parça
 * ayrı ayrı REDDEDİLİR. Sorgu/parça reddedilir çünkü mağaza KÖKÜ bir uç
 * nokta değildir; sessizce atmak kullanıcının yanlış değeri fark
 * etmemesine yol açardı.
 */
export function inspectStoreUrlSyntax(rawUrl: unknown): StoreUrlDecision {
  const text = String(rawUrl ?? '').trim()
  if (text === '') return { ok: false, rejection: 'EMPTY' }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, rejection: 'MALFORMED' }
  }

  // CargoFlow YALNIZ HTTPS kabul eder. Düz HTTP'de OAuth1 uygulanmaz:
  // sözleşme bunu tanımlar ama anahtar düz metin ağdan geçerdi.
  if (url.protocol !== 'https:') return { ok: false, rejection: 'NOT_HTTPS' }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, rejection: 'EMBEDDED_CREDENTIALS' }
  }
  if (url.search !== '') return { ok: false, rejection: 'QUERY_NOT_ALLOWED' }
  if (url.hash !== '') return { ok: false, rejection: 'FRAGMENT_NOT_ALLOWED' }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '') return { ok: false, rejection: 'MALFORMED' }
  if (hostIsForbiddenByName(host)) return { ok: false, rejection: 'PRIVATE_HOST' }
  // ═══ IPv6 KÖŞELİ PARANTEZ — GERÇEK KAÇIŞ YOLU ══════════════════════
  //
  // `new URL('https://[::1]').hostname` → `'[::1]'` (PARANTEZLİ). `isIP()`
  // parantezli değere 0 döner; parantez soyulmazsa `https://[::1]` "IP
  // değil" sayılıp ad çözümlemesine düşer ve LOOPBACK'e istek atılırdı.
  // Testte yakalandı (WOO-SSRF-3).
  const hostAddress = host.replace(/^\[|\]$/g, '')
  if (isIP(hostAddress) !== 0 && isPrivateAddress(hostAddress)) {
    return { ok: false, rejection: 'PRIVATE_HOST' }
  }

  // Varsayılan port yazımı anlam TAŞIMAZ; anlamlı alt yol KORUNUR.
  const port = url.port === '443' ? '' : url.port
  const basePath = url.pathname.replace(/\/+$/, '')
  return {
    ok: true,
    normalizedUrl: `https://${host}${port ? `:${port}` : ''}${basePath}`,
    host,
    basePath,
    // IP literali ZATEN denetlendi ve kendi adresidir; ad için çözümleme
    // `assertStoreUrlAllowed`ta yapılır (burada AĞ YOK).
    approvedAddresses: isIP(hostAddress) !== 0 ? [hostAddress] : [],
  }
}

export type DnsResolver = (hostname: string) => Promise<{ address: string }[]>

const defaultResolver: DnsResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => ({ address: record.address }))
}

/**
 * TAM denetim: sözdizimi + AD ÇÖZÜMLEME.
 *
 * Herkese açık görünen bir ad özel adrese çözülüyorsa REDDEDİLİR
 * (WOO-SSRF-5). Çözümleme başarısızsa kabul EDİLMEZ — "bilmiyorum" asla
 * "güvenli" sayılmaz.
 */
export async function assertStoreUrlAllowed(
  rawUrl: unknown,
  options: { resolver?: DnsResolver } = {},
): Promise<StoreUrlDecision> {
  const syntax = inspectStoreUrlSyntax(rawUrl)
  if (!syntax.ok) return syntax
  // Parantez burada da soyulur; aksi hâlde IPv6 literali "ad" sanılırdı.
  if (isIP(syntax.host.replace(/^\[|\]$/g, '')) !== 0) return syntax // zaten denetlendi

  const resolver = options.resolver ?? defaultResolver
  let addresses: { address: string }[]
  try {
    addresses = await resolver(syntax.host)
  } catch {
    return { ok: false, rejection: 'DNS_UNRESOLVED' }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, rejection: 'DNS_UNRESOLVED' }
  }
  // HERHANGİ biri özelse TÜM hedef reddedilir: DNS rebinding'de tek kayıt
  // yeter ve "özel olanı ele, kalanını kullan" saldırgana seçim bırakırdı.
  const approved: string[] = []
  for (const record of addresses) {
    const address = String(record?.address ?? '').trim()
    if (isPrivateAddress(address)) {
      return { ok: false, rejection: 'PRIVATE_RESOLVED_ADDRESS' }
    }
    if (isIP(address) === 0) {
      // Çözümleyici IP olmayan bir şey döndürdüyse GÜVENİLMEZ.
      return { ok: false, rejection: 'DNS_UNRESOLVED' }
    }
    approved.push(address)
  }
  // BU KÜME BAĞLAYICIDIR: taşıma katmanı soketi yalnız bunlarla kurar.
  return { ...syntax, approvedAddresses: approved }
}

// ═══ SABİTLENMİŞ AD ARAMASI — DOĞRULAMA İLE SOKETİ AYNI GERÇEĞE BAĞLAR ═══

export interface PinnedLookupOptions {
  /**
   * Node bunu SAYI ya da `'IPv4'`/`'IPv6'` METNİ olarak geçebilir.
   * Yalnız sayıyı beklemek, metin geldiğinde sessizce YANLIŞ süzerdi.
   */
  family?: number | string
  all?: boolean
  hints?: number
}
export type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  /**
   * Node'un `LookupFunction` imzası bunu ZORUNLU tutar. Hata yolunda değer
   * OKUNMAZ (çağıran `err` görünce erken döner), yine de boş metin geçilir:
   * imzayı gevşetmek `lookup` sözleşmesinden sapmak olurdu.
   */
  address: string | { address: string; family: number }[],
  family?: number,
) => void

export class PinnedAddressUnavailableError extends Error {}

/**
 * `dns.lookup` YERİNE geçen, YALNIZ onaylanmış adresleri döndüren arama.
 *
 * `net.connect` bunu soket kurarken çağırır; sistem çözümleyicisine HİÇ
 * gidilmez. Böylece doğrulamanın gördüğü adresler ile soketin bağlandığı
 * adres AYNI KÜMEDEN gelir — rebinding penceresi KAPANIR.
 *
 * FAIL-CLOSED: küme boşsa ya da istenen aile için uygun adres yoksa HATA
 * döner. Sessizce sistem aramasına DÜŞÜLMEZ (düşseydi açık geri gelirdi).
 *
 * Node `autoSelectFamily` açıkken `all: true` ile çağırır ve DİZİ bekler;
 * kapalıyken tek adres bekler. İKİ BİÇİM DE desteklenir — yalnız birini
 * desteklemek üretimde sessizce kırardı.
 */
export function createPinnedLookup(
  approvedAddresses: readonly string[],
): (
  hostname: string,
  options: PinnedLookupOptions | PinnedLookupCallback,
  callback?: PinnedLookupCallback,
) => void {
  const approved = approvedAddresses
    .map((value) => String(value ?? '').trim())
    .filter((value) => isIP(value) !== 0)

  return function pinnedLookup(hostname, options, callback) {
    const done: PinnedLookupCallback =
      typeof options === 'function' ? options : (callback as PinnedLookupCallback)
    const opts: PinnedLookupOptions = typeof options === 'function' ? {} : (options ?? {})
    const fail = (message: string) => {
      const error = new PinnedAddressUnavailableError(
        `${message} (${String(hostname)})`,
      ) as NodeJS.ErrnoException
      error.code = 'ENOTFOUND'
      done(error, '')
    }
    if (approved.length === 0) {
      fail('Onaylanmış adres yok; sistem ad aramasına DÜŞÜLMEZ')
      return
    }
    const rawFamily = opts.family
    const wanted =
      rawFamily === 'IPv4' ? 4 : rawFamily === 'IPv6' ? 6 : Number(rawFamily ?? 0) || 0
    const selected = approved
      .map((address) => ({ address, family: isIP(address) }))
      .filter((record) => wanted === 0 || record.family === wanted)
    if (selected.length === 0) {
      fail('Onaylanmış kümede istenen aile için adres yok')
      return
    }
    if (opts.all) {
      done(null, selected)
      return
    }
    const first = selected[0] as { address: string; family: number }
    done(null, first.address, first.family)
  }
}
