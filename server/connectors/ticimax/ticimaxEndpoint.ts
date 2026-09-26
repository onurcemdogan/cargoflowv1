// TICIMAX UÇ NOKTA — MAĞAZA KÖKÜ + SABİT SERVİS YOLU.
//
// Sözleşme: https://{magazaAlanAdi}/Servis/SiparisServis.svc
// Kullanıcı YALNIZ mağaza kökünü verir. SOAP yolu SABİTTİR; kullanıcı
// kontrollü servis yolu YOKTUR (SSRF / path injection).
import {
  assertStoreUrlAllowed,
  inspectStoreUrlSyntax,
  type DnsResolver,
  type StoreUrlDecision,
  type StoreUrlRejection,
} from '../storeUrlPolicy.ts'

export const TICIMAX_PROVIDER_KEY = 'ticimax'
export const TICIMAX_SIPARIS_SERVICE_PATH = '/Servis/SiparisServis.svc'

export const TICIMAX_ENDPOINT_REJECTIONS = [
  'EMPTY',
  'MALFORMED',
  'NOT_HTTPS',
  'EMBEDDED_CREDENTIALS',
  'QUERY_NOT_ALLOWED',
  'FRAGMENT_NOT_ALLOWED',
  'PRIVATE_HOST',
  'DNS_UNRESOLVED',
  'PRIVATE_RESOLVED_ADDRESS',
  'USER_CONTROLLED_SERVICE_PATH',
] as const
export type TicimaxEndpointRejection = (typeof TICIMAX_ENDPOINT_REJECTIONS)[number]

export interface TicimaxEndpointAccepted {
  ok: true
  storeOrigin: string
  host: string
  soapEndpointUrl: string
  approvedAddresses: string[]
}

export interface TicimaxEndpointRejected {
  ok: false
  rejection: TicimaxEndpointRejection
}

export type TicimaxEndpointDecision = TicimaxEndpointAccepted | TicimaxEndpointRejected

function mapStoreRejection(rejection: StoreUrlRejection): TicimaxEndpointRejection {
  return rejection
}

export function inspectTicimaxStoreOrigin(rawUrl: unknown): TicimaxEndpointDecision {
  const syntax = inspectStoreUrlSyntax(rawUrl)
  if (!syntax.ok) {
    return { ok: false, rejection: mapStoreRejection(syntax.rejection) }
  }
  if (syntax.basePath !== '') {
    return { ok: false, rejection: 'USER_CONTROLLED_SERVICE_PATH' }
  }
  return {
    ok: true,
    storeOrigin: syntax.normalizedUrl,
    host: syntax.host,
    soapEndpointUrl: `${syntax.normalizedUrl}${TICIMAX_SIPARIS_SERVICE_PATH}`,
    approvedAddresses: syntax.approvedAddresses,
  }
}

export async function assertTicimaxStoreOriginAllowed(
  rawUrl: unknown,
  options: { resolver?: DnsResolver } = {},
): Promise<TicimaxEndpointDecision> {
  const syntax = inspectTicimaxStoreOrigin(rawUrl)
  if (!syntax.ok) return syntax

  const decision: StoreUrlDecision = await assertStoreUrlAllowed(syntax.storeOrigin, options)
  if (!decision.ok) {
    return { ok: false, rejection: mapStoreRejection(decision.rejection) }
  }
  if (decision.basePath !== '') {
    return { ok: false, rejection: 'USER_CONTROLLED_SERVICE_PATH' }
  }
  return {
    ok: true,
    storeOrigin: decision.normalizedUrl,
    host: decision.host,
    soapEndpointUrl: `${decision.normalizedUrl}${TICIMAX_SIPARIS_SERVICE_PATH}`,
    approvedAddresses: decision.approvedAddresses,
  }
}

export function isAllowedTicimaxSoapUrl(
  requestUrl: string,
  expectedEndpointUrl: string,
): boolean {
  try {
    const actual = new URL(requestUrl)
    const expected = new URL(expectedEndpointUrl)
    if (actual.protocol !== 'https:') return false
    if (actual.username !== '' || actual.password !== '') return false
    if (actual.search !== '' || actual.hash !== '') return false
    if (actual.pathname !== TICIMAX_SIPARIS_SERVICE_PATH) return false
    return actual.origin === expected.origin && actual.pathname === expected.pathname
  } catch {
    return false
  }
}
