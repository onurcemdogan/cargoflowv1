// TICIMAX SELECTSİPARİS TEL SÖZLEŞMESİ KAPISI — FAIL-CLOSED.
//
// Resmî doküman metot imzasını doğrular; SOAP sarmalayıcı / QName /
// namespace / iç öğe nitelendirmesi DOĞRULANMADI. Bu yüzden
// `selectSiparisVerified` bilerek `false` kalır ve canlı SOAP gönderimi
// `DEFERRED_TO_LIVE_PROVIDER_VERIFICATION` ile engellenir.
//
// Uydurma XML / namespace / parametre QName YAZILMAZ.

export const TICIMAX_WIRE_DEFER_REASON = 'DEFERRED_TO_LIVE_PROVIDER_VERIFICATION' as const

/**
 * Tel düzeyinde SelectSiparis sözleşmesi.
 *
 * `selectSiparisVerified` yalnız canlı sağlayıcı / WSDL doğrulamasından
 * sonra `true` yapılabilir. Bu iskelette sabit `false`dır.
 */
export const TICIMAX_WIRE_CONTRACT = {
  operation: 'SelectSiparis',
  selectSiparisVerified: false,
  reason: TICIMAX_WIRE_DEFER_REASON,
  note:
    'Method signature (UyeKodu, WebSiparisFiltre, WebSiparisSayfalama) is ' +
    'contract-level verified; SOAP wrapper/QNames/namespaces are not. Do not invent wire XML.',
} as const

export class TicimaxWireContractError extends Error {
  readonly code = TICIMAX_WIRE_DEFER_REASON
  constructor(message = TICIMAX_WIRE_DEFER_REASON) {
    super(message)
    this.name = 'TicimaxWireContractError'
  }
}

/** SelectSiparis tel sözleşmesi hazır mı — hazır değilse ASLA SOAP yollama. */
export function isSelectSiparisWireVerified(): boolean {
  return TICIMAX_WIRE_CONTRACT.selectSiparisVerified === true
}

/**
 * Fail-closed kapı: doğrulanmamış tel → SOAP / probe YOK.
 *
 * Canlı doğrulama öncesi her SelectSiparis giriş noktası bunu ÇAĞIRMALI.
 */
export function assertSelectSiparisWireReady(): void {
  if (!isSelectSiparisWireVerified()) {
    throw new TicimaxWireContractError(TICIMAX_WIRE_DEFER_REASON)
  }
}
