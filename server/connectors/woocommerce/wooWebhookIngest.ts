// WOOCOMMERCE WEBHOOK ALIMI — DOĞRULA → KALICI YAZ → 2xx → İŞLE.
//
// ═══ SIRA NEDEN BU ═══════════════════════════════════════════════════════
//
// Sözleşme: ardışık 5 başarısız teslimden sonra WooCommerce webhook'u
// DISABLED yapar. "Doğrula → uzun senkron → sonra 2xx" akışı, yavaş bir
// işlemede teslimi düşürür ve 5 kerede mağaza akışı SESSİZCE kapatır.
//
// Bu yüzden 2xx kararı YALNIZ iki şeye bakar:
//   1) imza HAM GÖVDE üzerinden doğrulandı mı
//   2) kalıcı gelen kutusu yazımı BAŞARILI mı
//
// İşleme ondan SONRA gelir ve düşerse sağlayıcıya yeniden gönder DENMEZ —
// kayıt `RETRYABLE` kalır ve İÇERİDE tekrar denenir.
//
// ═══ SAHTE BAŞARI YOK ════════════════════════════════════════════════════
//
// Geçersiz imza 2xx ALMAZ (gelen kutusuna da girmez). Kalıcı yazım
// başarısızsa 2xx DÖNMEZ: "aldım" demek "tutuyorum" demektir.
import {
  acceptVerifiedDelivery,
  markInboxProcessing,
  type WebhookInboxRecord,
} from '../webhookInbox.ts'
import { canPersistCanonicalOrders } from '../liveWriteGate.ts'
import {
  isSupportedOrderTopic,
  normalizeTopic,
  verifyWooWebhookSignature,
  WOO_WEBHOOK_HEADERS,
  type WooSignatureRejection,
} from './wooWebhookSignature.ts'
import { normalizeWooOrder, type WooNormalizedOrder } from './wooOrderNormalizer.ts'
import { WOO_PROVIDER_KEY } from './wooConnectionService.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const WOO_INGEST_OUTCOMES = [
  /** Doğrulandı + kalıcı yazıldı → 2xx. */
  'ACCEPTED',
  /** Aynı teslim daha önce kabul edildi → 2xx, İŞLEME TEKRARLANMAZ. */
  'DUPLICATE',
  /** İmza doğrulanamadı → 401, gelen kutusuna GİRMEZ. */
  'SIGNATURE_REJECTED',
  /** Teslim kimliği yok → 400. */
  'MISSING_DELIVERY_ID',
  /** Hesap çözülemedi/secret yok → 404/409. */
  'ACCOUNT_UNRESOLVED',
  /** Kalıcı yazım düştü → 5xx, BAŞARI İDDİA EDİLMEZ. */
  'NOT_DURABLE',
] as const
export type WooIngestOutcome = (typeof WOO_INGEST_OUTCOMES)[number]

export interface WooIngestResult {
  outcome: WooIngestOutcome
  /** Sağlayıcıya dönecek HTTP durumu. */
  httpStatus: number
  signatureRejection: WooSignatureRejection | null
  record: WebhookInboxRecord | null
  topic: string
  /** Desteklenmeyen konu: kabul edilir ama SİPARİŞ İŞLEMEYE GİRMEZ. */
  topicSupported: boolean
}

export interface WooWebhookRequest {
  /** HAM istek gövdesi — Buffer OLMAK ZORUNDA. */
  rawBody: Buffer
  headers: Record<string, string | undefined>
}

function header(headers: Record<string, string | undefined>, name: string): string {
  return String(headers[name] ?? headers[name.toLowerCase()] ?? '').trim()
}

/**
 * ALIM SINIRI.
 *
 * `webhookSecret` HESAP KAPSAMLIDIR: çağıran onu hesap kimliğinden çözer.
 * Sağlayıcı geneli tek secret YOKTUR — A mağazasının sırrı B'nin teslimini
 * doğrulayamaz.
 */
export async function ingestWooWebhook(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    webhookSecret: string | null
    request: WooWebhookRequest
  },
): Promise<WooIngestResult> {
  const topic = normalizeTopic(header(params.request.headers, WOO_WEBHOOK_HEADERS.topic))
  const topicSupported = isSupportedOrderTopic(topic)

  if (!params.webhookSecret) {
    return {
      outcome: 'ACCOUNT_UNRESOLVED',
      httpStatus: 409,
      signatureRejection: null,
      record: null,
      topic,
      topicSupported,
    }
  }

  // ═══ 1) İMZA — JSON'A DOKUNMADAN ═══════════════════════════════════
  const signature = verifyWooWebhookSignature({
    rawBody: params.request.rawBody,
    signatureHeader: header(params.request.headers, WOO_WEBHOOK_HEADERS.signature),
    secret: params.webhookSecret,
  })
  if (!signature.verified) {
    // GELEN KUTUSUNA GİRMEZ ve 2xx ALMAZ.
    return {
      outcome: 'SIGNATURE_REJECTED',
      httpStatus: 401,
      signatureRejection: signature.rejection,
      record: null,
      topic,
      topicSupported,
    }
  }

  // ═══ 2) TESLİM KİMLİĞİ — resmî başlık ══════════════════════════════
  const deliveryId = header(params.request.headers, WOO_WEBHOOK_HEADERS.deliveryId)
  if (deliveryId === '') {
    // Yük özeti YEDEK KİMLİK OLARAK KULLANILMAZ: resmî teslim kimliği
    // varken özet kullanmak, aynı siparişin iki farklı teslimini TEK
    // teslim sanmaya yol açar.
    return {
      outcome: 'MISSING_DELIVERY_ID',
      httpStatus: 400,
      signatureRejection: null,
      record: null,
      topic,
      topicSupported,
    }
  }

  // ═══ 3) KALICI YAZIM — 2xx'TEN ÖNCE ════════════════════════════════
  let acceptance
  try {
    acceptance = await acceptVerifiedDelivery(db, {
      organizationId: params.organizationId,
      marketplaceAccountId: params.marketplaceAccountId,
      providerKey: WOO_PROVIDER_KEY,
      deliveryId,
      topic,
      rawBody: params.request.rawBody,
      // Desteklenmeyen konu KABUL EDİLİR ama işleme kuyruğuna girmez.
      status: topicSupported ? 'RECEIVED' : 'IGNORED',
    })
  } catch {
    return {
      outcome: 'NOT_DURABLE',
      httpStatus: 503,
      signatureRejection: null,
      record: null,
      topic,
      topicSupported,
    }
  }

  if (!acceptance.durable) {
    // BAŞARI İDDİA EDİLMEZ: sağlayıcının tekrar denemesi DOĞRUDUR.
    return {
      outcome: 'NOT_DURABLE',
      httpStatus: 503,
      signatureRejection: null,
      record: null,
      topic,
      topicSupported,
    }
  }

  return {
    outcome: acceptance.duplicate ? 'DUPLICATE' : 'ACCEPTED',
    httpStatus: 200,
    signatureRejection: null,
    record: acceptance.record,
    topic,
    topicSupported,
  }
}

export interface WooWebhookProcessResult {
  processed: boolean
  status: 'PROCESSED' | 'RETRYABLE' | 'IGNORED'
  normalized: WooNormalizedOrder | null
  canonicalPersisted: boolean
  liveWriteReason: string
  errorCode: string | null
}

/**
 * KABULDEN SONRAKİ İŞLEME — ayrı adım.
 *
 * `internal_test`te: doğrulanır, kalıcılaşır, NORMALLEŞTİRİLİR — ama kanonik
 * sipariş davranışı DEĞİŞMEZ. Kapı `liveWriteGate`tedir; sağlayıcı adına
 * dallanma YOKTUR.
 *
 * İşleme düşerse kayıt `RETRYABLE` olur: sağlayıcıya yeniden gönder DENMEZ
 * (bu webhook'u kapatırdı), içeride tekrar denenir.
 */
export async function processWooInboxItem(
  db: Db,
  params: {
    organizationId: string
    record: WebhookInboxRecord
    rawBody: Buffer
    persistCanonical?: (order: WooNormalizedOrder) => Promise<void>
  },
): Promise<WooWebhookProcessResult> {
  if (!isSupportedOrderTopic(params.record.topic)) {
    await markInboxProcessing(db, {
      organizationId: params.organizationId,
      inboxId: params.record.id,
      status: 'IGNORED',
      errorCode: 'TOPIC_NOT_SUPPORTED',
    })
    return {
      processed: false,
      status: 'IGNORED',
      normalized: null,
      canonicalPersisted: false,
      liveWriteReason: 'TOPIC_NOT_SUPPORTED',
      errorCode: 'TOPIC_NOT_SUPPORTED',
    }
  }

  let payload: unknown
  try {
    // Ayrıştırma DOĞRULAMADAN SONRA — baytlar zaten kanıtlandı.
    payload = JSON.parse(params.rawBody.toString('utf8'))
  } catch {
    await markInboxProcessing(db, {
      organizationId: params.organizationId,
      inboxId: params.record.id,
      status: 'RETRYABLE',
      errorCode: 'MALFORMED_JSON',
    })
    return {
      processed: false,
      status: 'RETRYABLE',
      normalized: null,
      canonicalPersisted: false,
      liveWriteReason: 'MALFORMED_JSON',
      errorCode: 'MALFORMED_JSON',
    }
  }

  const normalization = normalizeWooOrder(payload)
  if (!normalization.ok) {
    await markInboxProcessing(db, {
      organizationId: params.organizationId,
      inboxId: params.record.id,
      status: 'RETRYABLE',
      errorCode: normalization.rejection,
    })
    return {
      processed: false,
      status: 'RETRYABLE',
      normalized: null,
      canonicalPersisted: false,
      liveWriteReason: normalization.rejection,
      errorCode: normalization.rejection,
    }
  }

  const gate = canPersistCanonicalOrders(WOO_PROVIDER_KEY)
  let canonicalPersisted = false
  if (gate.decision === 'ALLOWED' && params.persistCanonical) {
    await params.persistCanonical(normalization.order)
    canonicalPersisted = true
  }

  await markInboxProcessing(db, {
    organizationId: params.organizationId,
    inboxId: params.record.id,
    status: 'PROCESSED',
    errorCode: null,
  })
  return {
    processed: true,
    status: 'PROCESSED',
    normalized: normalization.order,
    canonicalPersisted,
    liveWriteReason: gate.reasonCode,
    errorCode: null,
  }
}
