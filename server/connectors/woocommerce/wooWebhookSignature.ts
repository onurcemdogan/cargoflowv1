// WOOCOMMERCE WEBHOOK İMZASI — HAM GÖVDE BAYTLARI ÜZERİNDEN.
//
// ═══ RESMÎ SÖZLEŞME (wc-v3.json / WEBHOOK_SIGNATURE) ═════════════════════
//
//   başlık   : X-WC-Webhook-Signature
//   algoritma: HMAC-SHA256
//   anahtar  : webhook'un yapılandırılmış secret değeri
//   girdi    : HAM istek gövdesi
//   kodlama  : base64
//
// ═══ NEDEN HAM BAYT — VE NEDEN JSON.stringify ÖLÜMCÜL ════════════════════
//
// `JSON.parse` → `JSON.stringify` turu AYNI nesneyi üretir ama AYNI BAYTLARI
// ÜRETMEZ: anahtar sırası, boşluk, unicode kaçışları ve sayı biçimi değişir
// (örn. `1.0` → `1`, `"ç"` → `"ç"`). İmza baytlar üzerinde hesaplandığı
// için yeniden serileştirilmiş gövde İMZAYI TUTMAZ.
//
// Bu yüzden doğrulama YALNIZ ham `Buffer` alır; bu modül JSON'u HİÇ
// AYRIŞTIRMAZ. Ayrıştırma doğrulamadan SONRA, çağıran tarafta yapılır.
//
// ═══ SABİT ZAMANLI KARŞILAŞTIRMA ═════════════════════════════════════════
//
// `===` ilk farklı baytta döner ve ölçülebilir zaman farkı bırakır. Doğru
// imzayı bayt bayt aramak mümkün olurdu. `timingSafeEqual` kullanılır.
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Sözleşmedeki resmî başlık adları (küçük harf — Node başlıkları böyle verir). */
export const WOO_WEBHOOK_HEADERS = {
  signature: 'x-wc-webhook-signature',
  topic: 'x-wc-webhook-topic',
  deliveryId: 'x-wc-webhook-delivery-id',
  webhookId: 'x-wc-webhook-id',
  source: 'x-wc-webhook-source',
  resource: 'x-wc-webhook-resource',
  event: 'x-wc-webhook-event',
} as const

export const WOO_SIGNATURE_REJECTIONS = [
  'MISSING_SIGNATURE',
  'MISSING_SECRET',
  'MISSING_BODY',
  'MALFORMED_SIGNATURE',
  'SIGNATURE_MISMATCH',
] as const
export type WooSignatureRejection = (typeof WOO_SIGNATURE_REJECTIONS)[number]

export interface WooSignatureResult {
  verified: boolean
  rejection: WooSignatureRejection | null
}

/** Sözleşme gereği base64 HMAC-SHA256 → 32 bayt → 44 karakter. */
const EXPECTED_DIGEST_BYTES = 32

/**
 * Ham gövde baytları üzerinden imza hesaplar.
 *
 * Girdi `Buffer` OLMAK ZORUNDADIR: dizge kabul etmek, çağıranın farkında
 * olmadan yeniden kodlanmış bir metin geçirmesine izin verirdi.
 */
export function computeWooSignature(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64')
}

/**
 * İMZA DOĞRULAMA — JSON'a BAKMADAN.
 *
 * `rawBody` gerçekten ham istek gövdesi olmalıdır. Boş gövde doğrulanmaz:
 * "imza yok ama gövde de yok" durumu sessizce geçerli sayılamaz.
 */
export function verifyWooWebhookSignature(params: {
  rawBody: unknown
  signatureHeader: unknown
  secret: unknown
}): WooSignatureResult {
  const secret = String(params.secret ?? '')
  if (secret === '') return { verified: false, rejection: 'MISSING_SECRET' }

  const signature = String(params.signatureHeader ?? '').trim()
  if (signature === '') return { verified: false, rejection: 'MISSING_SIGNATURE' }

  if (!Buffer.isBuffer(params.rawBody) || params.rawBody.length === 0) {
    return { verified: false, rejection: 'MISSING_BODY' }
  }

  // Base64 çözümü ÖNCE yapılır: `timingSafeEqual` eşit uzunluk ister ve
  // uzunluk farkında atar. Bozuk kodlama SIZINTI DEĞİL, ayrı sebeptir.
  let provided: Buffer
  try {
    provided = Buffer.from(signature, 'base64')
  } catch {
    return { verified: false, rejection: 'MALFORMED_SIGNATURE' }
  }
  if (provided.length !== EXPECTED_DIGEST_BYTES) {
    return { verified: false, rejection: 'MALFORMED_SIGNATURE' }
  }

  const expected = createHmac('sha256', secret).update(params.rawBody).digest()
  // SABİT ZAMAN: erken çıkış YOK.
  const verified = timingSafeEqual(provided, expected)
  return {
    verified,
    rejection: verified ? null : 'SIGNATURE_MISMATCH',
  }
}

/** Bu bilette İŞLENEN konular — ürün/müşteri konuları KAPSAM DIŞI. */
export const WOO_SUPPORTED_ORDER_TOPICS = [
  'order.created',
  'order.updated',
  'order.deleted',
] as const
export type WooOrderTopic = (typeof WOO_SUPPORTED_ORDER_TOPICS)[number]

export function isSupportedOrderTopic(topic: unknown): topic is WooOrderTopic {
  return (WOO_SUPPORTED_ORDER_TOPICS as readonly string[]).includes(
    String(topic ?? '').trim().toLowerCase(),
  )
}

export function normalizeTopic(topic: unknown): string {
  return String(topic ?? '').trim().toLowerCase()
}
