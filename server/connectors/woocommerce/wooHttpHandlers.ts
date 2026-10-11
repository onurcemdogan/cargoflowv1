// WOOCOMMERCE HTTP UÇ DAVRANIŞI — TEK GERÇEK.
//
// ═══ NEDEN AYRI MODÜL ════════════════════════════════════════════════════
//
// Uç davranışı (durum kodu eşlemesi dahil) `server/index.mjs` içinde satır
// içi kaldığı sürece YALNIZ depo yardımcıları test edilebiliyordu. Depo
// testleri yeşilken ÜRÜN UCU yanlış davranabiliyordu — bu tam olarak bu
// kapanışın düzelttiği kusur sınıfıdır.
//
// Artık uç mantığı BURADADIR; `index.mjs` yalnız kiracı kapsamını çözer ve
// buraya devreder (kaynak taramasıyla kilitli: ikinci bir uygulama YOK).
//
// Yanıtlar KARARLI KODLAR taşır: ham WordPress/PHP metni, sağlayıcı hatası,
// uç nokta ya da kimlik bilgisi ASLA dışarı çıkmaz.
import {
  disconnectWooStore,
  resolveWooWebhookAccount,
} from './wooConnectionService.ts'
import { ingestWooWebhook } from './wooWebhookIngest.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface WooHandlerResponse {
  httpStatus: number
  body: Record<string, unknown>
}

/**
 * WEBHOOK TESLİMİ.
 *
 * Kimlik doğrulama İMZADIR, oturum değil: WooCommerce çerez göndermez. Bu
 * yüzden kiracı/hesap kimliği YOLDAN gelir ve yetki HESABIN KENDİ secret'ı
 * üzerinden kanıtlanır.
 *
 * `rawBody` BUFFER olmak zorundadır: imza HAM BAYTLAR üzerinden doğrulanır,
 * yeniden serileştirilmiş bir gövde ASLA aynı baytları vermez.
 */
export async function handleWooWebhookDelivery(params: {
  db: Db
  organizationId: string
  marketplaceAccountId: string
  rawBody: Buffer
  headers: Record<string, string | undefined>
}): Promise<WooHandlerResponse> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  const resolved = await resolveWooWebhookAccount(params.db, {
    organizationId,
    marketplaceAccountId,
  })
  const result = await ingestWooWebhook(params.db, {
    organizationId,
    marketplaceAccountId,
    webhookSecret: resolved?.webhookSecret ?? null,
    request: {
      rawBody: Buffer.isBuffer(params.rawBody) ? params.rawBody : Buffer.alloc(0),
      headers: params.headers ?? {},
    },
  })
  return {
    httpStatus: result.httpStatus,
    body: {
      ok: result.httpStatus >= 200 && result.httpStatus <= 299,
      outcome: result.outcome,
    },
  }
}

/**
 * MAĞAZA AYIRMA.
 *
 * Sağlayıcı kapsamı servis katmanında FAIL-CLOSED kanıtlanır; burada yalnız
 * sonuç HTTP'ye çevrilir. `NOT_FOUND` → 404 ve HİÇBİR mutasyon yapılmamıştır.
 */
export async function handleWooDisconnect(params: {
  db: Db
  organizationId: string
  marketplaceAccountId: string
}): Promise<WooHandlerResponse> {
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (marketplaceAccountId === '') {
    return {
      httpStatus: 400,
      body: { ok: false, outcome: 'MISSING_ACCOUNT_ID' },
    }
  }
  const result = await disconnectWooStore(params.db, {
    organizationId: String(params.organizationId ?? '').trim(),
    marketplaceAccountId,
  })
  if (result.outcome !== 'DISCONNECTED') {
    return {
      httpStatus: 404,
      body: {
        ok: false,
        outcome: result.outcome,
        message: 'WooCommerce mağazası bulunamadı.',
      },
    }
  }
  return {
    httpStatus: 200,
    body: { ok: true, outcome: result.outcome, marketplaceAccountId },
  }
}
