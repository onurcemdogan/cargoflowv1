// ARAS — SetOrder İSTEK KURUCUSU + IDEMPOTENCY (saf karar; ağ YOK).
//
// Resmî sözleşme alanları `arasContract.ts` içindedir ve BURADA GENİŞLETİLMEZ.
//
// ═══ SÜRAT ALANLARI BURAYA SIZAMAZ ═══════════════════════════════════════
// Sürat'ın kanonik modeli (`Pazaryerimi`, `EntegrasyonFirmasi`,
// `OzelKargoTakipNo`, `KimOder` …) Aras sözleşmesinde YOKTUR. İstek kurucusu
// yalnız beyaz listedeki alanları yazar; tanınmayan alan SESSİZCE ATILMAZ,
// hata olarak bildirilir.

import {
  ARAS_SET_ORDER_FIELDS,
  resolveArasCod,
  type ArasSetOrderField,
} from './arasContract.ts'

const FIELD_SET = new Set<string>(ARAS_SET_ORDER_FIELDS)

/** Kimlik alanları — istek gövdesine girer ama LOGLANMAZ/serileştirilmez. */
const SECRET_FIELDS = new Set<string>(['UserName', 'Password'])

export interface ArasSetOrderBuildResult {
  ok: boolean
  /** Telde gidecek alanlar (sır DAHİL) — yalnız taşıma katmanına verilir. */
  order: Record<string, unknown>
  /** Denetim/log için GÜVENLİ görünüm — sır YOK. */
  redactedOrder: Record<string, unknown>
  errorCode:
    | 'ARAS_UNKNOWN_FIELD'
    | 'ARAS_INTEGRATION_CODE_REQUIRED'
    | 'ARAS_CREDENTIALS_INCOMPLETE'
    | 'ARAS_COD_VALUE_TABLE_UNVERIFIED'
    | 'ARAS_COD_AMOUNT_INVALID'
    | null
  reason: string | null
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/**
 * SetOrder gövdesini kurar.
 *
 * `IntegrationCode` ZORUNLUDUR: idempotency onun üzerinden yürür ve kod
 * olmadan aynı gönderi iki kez açılabilir.
 */
export function buildArasSetOrder(params: {
  credentials?: { userName?: string | null; password?: string | null }
  integrationCode?: string | null
  fields?: Record<string, unknown>
  cod?: {
    isCod?: boolean
    codAmount?: unknown
    verifiedCollectionType?: number | null
    verifiedBillingType?: number | null
  }
}): ArasSetOrderBuildResult {
  const empty = { ok: false, order: {}, redactedOrder: {} }
  const userName = str(params.credentials?.userName)
  const password = str(params.credentials?.password)
  if (!userName || !password) {
    return {
      ...empty,
      errorCode: 'ARAS_CREDENTIALS_INCOMPLETE',
      reason: 'Aras kullanıcı adı/parolası eksik.',
    }
  }
  const integrationCode = str(params.integrationCode)
  if (!integrationCode) {
    return {
      ...empty,
      errorCode: 'ARAS_INTEGRATION_CODE_REQUIRED',
      reason: 'IntegrationCode olmadan idempotency kurulamaz.',
    }
  }

  const incoming = params.fields ?? {}
  for (const key of Object.keys(incoming)) {
    if (!FIELD_SET.has(key)) {
      return {
        ...empty,
        errorCode: 'ARAS_UNKNOWN_FIELD',
        reason: `Aras sözleşmesinde olmayan alan: ${key}`,
      }
    }
  }

  const cod = resolveArasCod(params.cod ?? {})
  if (!cod.ok) {
    return {
      ...empty,
      errorCode: cod.errorCode,
      reason: cod.reason,
    }
  }

  const order: Record<string, unknown> = {
    ...incoming,
    UserName: userName,
    Password: password,
    IntegrationCode: integrationCode,
    IsCod: cod.isCod ? 1 : 0,
  }
  if (cod.isCod) {
    order.CodAmount = cod.codAmount
    order.CodCollectionType = cod.codCollectionType.value
    order.CodBillingType = cod.codBillingType.value
  }

  const redactedOrder: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(order)) {
    redactedOrder[key] = SECRET_FIELDS.has(key) ? '***' : value
  }
  return { ok: true, order, redactedOrder, errorCode: null, reason: null }
}

/**
 * SOAP 1.1 zarfı kurar.
 *
 * Şekil repoda YERLEŞİK SOAP üslubuyla aynıdır. Alan sırası sözleşme
 * listesine göre DETERMİNİSTİK tutulur: aynı girdi aynı zarfı üretmelidir
 * (idempotency parmak izi bunun üzerine kurulur).
 */
export function buildArasSetOrderEnvelope(order: Record<string, unknown>): string {
  const ordered = ARAS_SET_ORDER_FIELDS.filter((field: ArasSetOrderField) =>
    Object.prototype.hasOwnProperty.call(order, field),
  )
  const body = ordered
    .map((field) => `      <${field}>${escapeXml(order[field])}</${field}>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
      + ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
      + ' xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    '  <soap:Body>',
    '    <SetOrder xmlns="http://tempuri.org/">',
    '      <orderInfo>',
    body,
    '      </orderInfo>',
    '    </SetOrder>',
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n')
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&apos;')
}

// ═══ IDEMPOTENCY — P3 DESENİNİN AYNISI ═══════════════════════════════════

/**
 * `IntegrationCode` TEK bir fiziksel gönderi için KARARLI olmalıdır.
 *
 * Kararlı olması, "değişen semantikte tekrar kullanılabilir" demek DEĞİLDİR.
 * P3'te Sürat için kanıtlanan kural burada da geçerlidir: kayıtlı gönderi
 * FARKLI koşullarda oluşturulmuşsa ne replay ne yeni create yapılır —
 * ikinci fiziksel gönderi geri alınamaz.
 */
export function buildArasIntegrationCode(params: {
  organizationId?: string | null
  orderId?: string | null
}): string {
  const org = str(params.organizationId) || 'legacy'
  const order = str(params.orderId)
  if (!order) return ''
  return `ARAS:${org}:${order}:CREATE`
}
