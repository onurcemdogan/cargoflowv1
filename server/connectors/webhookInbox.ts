// DAYANIKLI WEBHOOK GELEN KUTUSU — SAĞLAYICI-NÖTR.
//
// ═══ NEDEN "ÖNCE KALICI YAZIM, SONRA 2xx" ════════════════════════════════
//
// WooCommerce sözleşmesi (RETRY_MODEL): ARDIŞIK 5 başarısız teslimden sonra
// webhook DISABLED olur ve REST ile yeniden açılması gerekir.
//
// Bu yüzden şu sıra YASAKTIR:
//   doğrula → uzun senkron işlemi → sonra 2xx
// Yavaş/başarısız işleme, teslim hatası sayılır ve 5 kez üst üste olursa
// mağaza sessizce akışı KAPATIR.
//
// Doğru sıra:
//   ham gövde → imza doğrulama → KALICI YAZIM → 2xx → işleme (ayrı).
//
// ═══ KALICI YAZIM BAŞARISIZSA 2xx YOK ════════════════════════════════════
//
// "Aldım" demek, VERİYİ TUTUYORUM demektir. Yazamadıysak teslim başarısızdır
// ve sağlayıcının tekrar denemesi DOĞRUDUR. Sahte başarı, veri kaybıdır.
//
// ═══ PII ŞİFRELİ ═════════════════════════════════════════════════════════
//
// Gövde müşteri adı/adresi/telefonu taşır. Düz metin SAKLANMAZ; mevcut
// AES-256-GCM zarfı kullanılır (ikinci kriptografi YOK).
import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import { connectorWebhookInbox } from '../db/schema.ts'
import {
  decryptCredentialPayload,
  encryptCredentialPayload,
} from '../integrations/credentialService.ts'
import { normalizeProviderKey } from './connectorKernel.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Gelen kutusu yaşam döngüsü. */
export const WEBHOOK_INBOX_STATUSES = [
  /** Kalıcı yazıldı, henüz işlenmedi. */
  'RECEIVED',
  /** İşlendi ve kapandı. */
  'PROCESSED',
  /** İşleme düştü; TEKRAR DENENEBİLİR (sağlayıcıya bağlı DEĞİL). */
  'RETRYABLE',
  /** Politika gereği işlenmeyecek (ör. desteklenmeyen konu). */
  'IGNORED',
] as const
export type WebhookInboxStatus = (typeof WEBHOOK_INBOX_STATUSES)[number]

export class WebhookInboxScopeError extends Error {}

export interface WebhookInboxRecord {
  id: string
  organizationId: string
  marketplaceAccountId: string
  providerKey: string
  deliveryId: string
  topic: string
  status: WebhookInboxStatus
  attemptCount: number
  errorCode: string | null
  receivedAt: Date | null
  verifiedAt: Date | null
  processedAt: Date | null
}

export interface WebhookInboxAcceptance {
  /** Kalıcı yazım BAŞARILI mı — 2xx kararı YALNIZ buna bakar. */
  durable: boolean
  /** Aynı teslim daha önce yazılmış mıydı. */
  duplicate: boolean
  record: WebhookInboxRecord | null
}

function requireScope(params: {
  organizationId: unknown
  marketplaceAccountId: unknown
  deliveryId: unknown
}): { organizationId: string; marketplaceAccountId: string; deliveryId: string } {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  const deliveryId = String(params.deliveryId ?? '').trim()
  if (organizationId === '') throw new WebhookInboxScopeError('organizationId zorunludur.')
  if (marketplaceAccountId === '') {
    throw new WebhookInboxScopeError('marketplaceAccountId zorunludur.')
  }
  if (deliveryId === '') throw new WebhookInboxScopeError('deliveryId zorunludur.')
  return { organizationId, marketplaceAccountId, deliveryId }
}

function toRecord(row: Record<string, unknown>): WebhookInboxRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organizationId),
    marketplaceAccountId: String(row.marketplaceAccountId),
    providerKey: String(row.providerKey),
    deliveryId: String(row.deliveryId),
    topic: String(row.topic),
    status: String(row.status) as WebhookInboxStatus,
    attemptCount: Number(row.attemptCount ?? 0),
    errorCode: (row.errorCode as string | null) ?? null,
    receivedAt: (row.receivedAt as Date | null) ?? null,
    verifiedAt: (row.verifiedAt as Date | null) ?? null,
    processedAt: (row.processedAt as Date | null) ?? null,
  }
}

/**
 * DOĞRULANMIŞ teslimi KALICI olarak kabul eder.
 *
 * Yalnız imzası doğrulanmış istekler buraya gelir: `verifiedAt` her zaman
 * yazılır. Doğrulanmamış istek bu fonksiyona HİÇ ULAŞMAZ (çağıran onu
 * doğrulamadan önce reddeder).
 *
 * Tekrar eden teslim: aynı (org, hesap, sağlayıcı, deliveryId) → İKİNCİ
 * SATIR AÇILMAZ, mevcut kayıt döner ve `duplicate: true` olur. Çağıran yine
 * 2xx döner (sağlayıcı tekrarı normaldir) ama işleme TEKRAR ÇALIŞMAZ.
 */
export async function acceptVerifiedDelivery(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    providerKey: string
    deliveryId: string
    topic: string
    rawBody: Buffer
    status?: WebhookInboxStatus
    verifiedAt?: Date
  },
): Promise<WebhookInboxAcceptance> {
  const scope = requireScope(params)
  const providerKey = normalizeProviderKey(params.providerKey)
  const now = new Date()

  // Gövde ŞİFRELİ saklanır. Base64 ham baytı korur: yeniden serileştirme
  // YOK, böylece imza ileride yeniden doğrulanabilir.
  const { encryptedPayload, keyVersion } = encryptCredentialPayload({
    bodyBase64: Buffer.isBuffer(params.rawBody)
      ? params.rawBody.toString('base64')
      : '',
  })

  const existing = await db
    .select()
    .from(connectorWebhookInbox)
    .where(
      and(
        eq(connectorWebhookInbox.organizationId, scope.organizationId),
        eq(connectorWebhookInbox.marketplaceAccountId, scope.marketplaceAccountId),
        eq(connectorWebhookInbox.providerKey, providerKey),
        eq(connectorWebhookInbox.deliveryId, scope.deliveryId),
      ),
    )
    .limit(1)
  if (existing[0]) {
    return {
      durable: true,
      duplicate: true,
      record: toRecord(existing[0] as Record<string, unknown>),
    }
  }

  const inserted = await db
    .insert(connectorWebhookInbox)
    .values({
      organizationId: scope.organizationId,
      marketplaceAccountId: scope.marketplaceAccountId,
      providerKey,
      deliveryId: scope.deliveryId,
      topic: String(params.topic ?? ''),
      status: params.status ?? 'RECEIVED',
      verifiedAt: params.verifiedAt ?? now,
      encryptedPayload,
      keyVersion,
      updatedAt: now,
    })
    // Yarış: iki teslim aynı anda gelirse ikinci satır AÇILMAZ.
    .onConflictDoNothing({
      target: [
        connectorWebhookInbox.organizationId,
        connectorWebhookInbox.marketplaceAccountId,
        connectorWebhookInbox.providerKey,
        connectorWebhookInbox.deliveryId,
      ],
    })
    .returning()

  if (inserted[0]) {
    return {
      durable: true,
      duplicate: false,
      record: toRecord(inserted[0] as Record<string, unknown>),
    }
  }

  // Çakışma oldu → satır BAŞKASI tarafından yazıldı; yine dayanıklıdır.
  const after = await db
    .select()
    .from(connectorWebhookInbox)
    .where(
      and(
        eq(connectorWebhookInbox.organizationId, scope.organizationId),
        eq(connectorWebhookInbox.marketplaceAccountId, scope.marketplaceAccountId),
        eq(connectorWebhookInbox.providerKey, providerKey),
        eq(connectorWebhookInbox.deliveryId, scope.deliveryId),
      ),
    )
    .limit(1)
  return {
    durable: Boolean(after[0]),
    duplicate: true,
    record: after[0] ? toRecord(after[0] as Record<string, unknown>) : null,
  }
}

/** Kalıcı gövdeyi ham baytlara geri çözer. */
export async function readInboxRawBody(
  db: Db,
  params: { organizationId: string; inboxId: string },
): Promise<Buffer | null> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') throw new WebhookInboxScopeError('organizationId zorunludur.')
  const rows = await db
    .select()
    .from(connectorWebhookInbox)
    .where(
      and(
        eq(connectorWebhookInbox.organizationId, organizationId),
        eq(connectorWebhookInbox.id, String(params.inboxId)),
      ),
    )
    .limit(1)
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  const payload = decryptCredentialPayload(String(row.encryptedPayload))
  return Buffer.from(String(payload.bodyBase64 ?? ''), 'base64')
}

/**
 * İşleme sonucunu yazar.
 *
 * İşleme ACK'ten SONRA çalışır; düşerse sağlayıcıya YENİDEN GÖNDER denmez
 * (bu webhook'u kapatırdı) — kayıt `RETRYABLE` kalır ve İÇERİDE tekrar
 * denenir.
 */
export async function markInboxProcessing(
  db: Db,
  params: {
    organizationId: string
    inboxId: string
    status: WebhookInboxStatus
    errorCode?: string | null
    processedAt?: Date | null
    /**
     * Deneme sayacını BU çağrı mı artırsın.
     *
     * `false`: sayaç ZATEN `claimInboxDelivery` ile artırıldı. Tüketici
     * önce SAHİPLENİR (atomik artış) sonra sonucu yazar; ikisi de artırsaydı
     * tek işleme denemesi sayacı İKİ artırır ve bütçe yalan söylerdi.
     */
    incrementAttempt?: boolean
  },
): Promise<void> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') throw new WebhookInboxScopeError('organizationId zorunludur.')
  const rows = await db
    .select({ attemptCount: connectorWebhookInbox.attemptCount })
    .from(connectorWebhookInbox)
    .where(
      and(
        eq(connectorWebhookInbox.organizationId, organizationId),
        eq(connectorWebhookInbox.id, String(params.inboxId)),
      ),
    )
    .limit(1)
  const currentAttempts = Number((rows[0] as Record<string, unknown>)?.attemptCount ?? 0)
  const attemptCount =
    params.incrementAttempt === false ? currentAttempts : currentAttempts + 1
  await db
    .update(connectorWebhookInbox)
    .set({
      status: params.status,
      attemptCount,
      errorCode: params.errorCode ?? null,
      processedAt:
        params.processedAt === undefined
          ? params.status === 'PROCESSED'
            ? new Date()
            : null
          : params.processedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectorWebhookInbox.organizationId, organizationId),
        eq(connectorWebhookInbox.id, String(params.inboxId)),
      ),
    )
}

/** Kiracı + hesap kapsamlı listeleme (tanı/işleme kuyruğu için). */
export async function listInbox(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId?: string
    providerKey?: string
    status?: WebhookInboxStatus
  },
): Promise<WebhookInboxRecord[]> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') throw new WebhookInboxScopeError('organizationId zorunludur.')
  const conditions = [eq(connectorWebhookInbox.organizationId, organizationId)]
  if (params.marketplaceAccountId) {
    conditions.push(
      eq(connectorWebhookInbox.marketplaceAccountId, String(params.marketplaceAccountId)),
    )
  }
  if (params.providerKey) {
    conditions.push(
      eq(connectorWebhookInbox.providerKey, normalizeProviderKey(params.providerKey)),
    )
  }
  if (params.status) conditions.push(eq(connectorWebhookInbox.status, params.status))
  const rows = await db
    .select()
    .from(connectorWebhookInbox)
    .where(and(...conditions))
  return rows.map((row: Record<string, unknown>) => toRecord(row))
}

// ═══ KURTARMA / TEKRAR DENEME — DAYANIKLI KUTUNUN TÜKETİCİ TARAFI ════════
//
// ÖLÇÜLEN EKSİK: kutu DAYANIKLIYDI ama TÜKETİCİSİ YOKTU. Kabul edilen her
// teslim `RECEIVED` olarak SONSUZA KADAR duruyordu. Dayanıklılığın anlamı
// "sonra işlenecek"tir; işleyen yoksa kutu sadece bir mezarlıktır.
//
// Uygunluk kaynağı VERİTABANIDIR: yeniden başlatma sonrası aday satırlar
// aynı sorguyla YENİDEN bulunur. Bellekteki hiçbir kuyruk hayatta kalmak
// zorunda değildir — ve kalmamalıdır.

/** Tekrar deneme bütçesi. Sınırsız tekrar YOKTUR. */
export interface InboxRetryPolicy {
  /** Bu sayıya ULAŞAN kayıt BİR DAHA seçilmez (sonsuz döngü yok). */
  maxAttempts: number
  /** İlk gecikme; sonrakiler ikiye katlanır. */
  retryBaseMs: number
  /** Üst sınır — geri çekilme sonsuza büyümez. */
  retryCapMs: number
}

export const DEFAULT_INBOX_RETRY_POLICY: InboxRetryPolicy = {
  maxAttempts: 5,
  retryBaseMs: 60_000,
  retryCapMs: 30 * 60_000,
}

/**
 * ÜSTEL GERİ ÇEKİLME.
 *
 * Sıkı döngü YASAK: bozuk bir yük, her turda yeniden denenirse hem CPU hem
 * log yakar ve gerçek işleri geciktirir.
 */
export function nextRetryDelayMs(
  attemptCount: number,
  policy: InboxRetryPolicy = DEFAULT_INBOX_RETRY_POLICY,
): number {
  const attempts = Math.max(0, Math.floor(Number(attemptCount) || 0))
  if (attempts <= 0) return 0
  const raw = policy.retryBaseMs * 2 ** (attempts - 1)
  return Math.min(policy.retryCapMs, raw)
}

/** Kayıt ŞİMDİ işlenebilir mi (bütçe + geri çekilme). */
export function isInboxDeliveryDue(
  record: {
    status: WebhookInboxStatus
    attemptCount: number
    /** Son dokunuş anı — geri çekilme BURADAN ölçülür. */
    updatedAt?: Date | null
  },
  nowMs: number,
  policy: InboxRetryPolicy = DEFAULT_INBOX_RETRY_POLICY,
): boolean {
  if (record.status !== 'RECEIVED' && record.status !== 'RETRYABLE') return false
  const attempts = Number(record.attemptCount ?? 0)
  // BÜTÇE BİTTİ: kayıt DURUR (veri kaybolmaz) ama tekrar SEÇİLMEZ.
  if (attempts >= policy.maxAttempts) return false
  if (attempts <= 0) return true
  const last = record.updatedAt instanceof Date ? record.updatedAt.getTime() : null
  if (last === null) return true
  return nowMs - last >= nextRetryDelayMs(attempts, policy)
}

export interface DueInboxRecord extends WebhookInboxRecord {
  updatedAt: Date | null
}

/**
 * İŞLENMEYİ BEKLEYEN teslimler.
 *
 * ═══ NEDEN KİRACI FİLTRESİ ZORUNLU DEĞİL ═══════════════════════════════
 *
 * Bu SİSTEM düzeyinde bir kurtarma taramasıdır: arka plan tüketicisi bir
 * kiracı adına DEĞİL, süreç adına çalışır. İzolasyon KAYBOLMAZ — dönen her
 * satır KENDİ `organizationId`sini taşır ve sonraki HER okuma/yazma o
 * kimlikle KAPSANIR (gövde çözme, sonuç yazma, hesap çözümleme).
 *
 * Tek kiracıyı taramak için `organizationId` verilebilir (tanı/test).
 *
 * `PROCESSED` ve `IGNORED` ASLA seçilmez: işlenmiş teslim yeniden
 * işlenmez, politika gereği yok sayılan teslim tekrar tekrar denenmez.
 */
export async function listDueInboxDeliveries(
  db: Db,
  params: {
    providerKey: string
    nowMs: number
    policy?: InboxRetryPolicy
    limit?: number
    organizationId?: string
  },
): Promise<DueInboxRecord[]> {
  const providerKey = normalizeProviderKey(params.providerKey)
  const policy = params.policy ?? DEFAULT_INBOX_RETRY_POLICY
  const limit = Math.max(1, Math.min(200, Number(params.limit ?? 25)))
  const conditions = [
    eq(connectorWebhookInbox.providerKey, providerKey),
    inArray(connectorWebhookInbox.status, ['RECEIVED', 'RETRYABLE']),
    // Bütçesi dolmuş satır SORGUDA ELENİR.
    lt(connectorWebhookInbox.attemptCount, policy.maxAttempts),
  ]
  if (params.organizationId) {
    conditions.push(
      eq(connectorWebhookInbox.organizationId, String(params.organizationId)),
    )
  }
  const rows = await db
    .select()
    .from(connectorWebhookInbox)
    .where(and(...conditions))
    // EN ESKİ TESLİM ÖNCE: geri çekilmedeki satırlar taze teslimleri AÇ
    // BIRAKMAZ; tersi de doğrudur.
    .orderBy(asc(connectorWebhookInbox.receivedAt))
    // Geri çekilme süresi SQL'de değil burada ölçülür; bu yüzden aday
    // penceresi limitten geniş alınır ve SONRA sınırlanır.
    .limit(limit * 4)
  const due: DueInboxRecord[] = []
  for (const row of rows as Record<string, unknown>[]) {
    const record: DueInboxRecord = {
      ...toRecord(row),
      updatedAt: (row.updatedAt as Date | null) ?? null,
    }
    if (!isInboxDeliveryDue(record, params.nowMs, policy)) continue
    due.push(record)
    if (due.length >= limit) break
  }
  return due
}

/**
 * KAYDI SAHİPLEN — koşullu, atomik.
 *
 * Aynı satırı iki tüketici (iki süreç ya da örtüşen iki tur) aynı anda
 * işleyemez: sahiplenme, deneme sayacını BEKLENEN değerden bir fazlasına
 * koşullu olarak taşır. Yarışı kaybeden `null` alır ve o satıra DOKUNMAZ.
 *
 * Sayacı BURASI artırır; `markInboxProcessing` bu yüzden
 * `incrementAttempt: false` ile çağrılır.
 */
export async function claimInboxDelivery(
  db: Db,
  params: {
    organizationId: string
    inboxId: string
    expectedStatus: WebhookInboxStatus
    expectedAttemptCount: number
  },
): Promise<WebhookInboxRecord | null> {
  const organizationId = String(params.organizationId ?? '').trim()
  if (organizationId === '') throw new WebhookInboxScopeError('organizationId zorunludur.')
  const expected = Math.max(0, Number(params.expectedAttemptCount ?? 0))
  const claimed = await db
    .update(connectorWebhookInbox)
    .set({ attemptCount: expected + 1, updatedAt: new Date() })
    .where(
      and(
        // KİRACI SINIRI — istisnasız.
        eq(connectorWebhookInbox.organizationId, organizationId),
        eq(connectorWebhookInbox.id, String(params.inboxId)),
        eq(connectorWebhookInbox.status, params.expectedStatus),
        eq(connectorWebhookInbox.attemptCount, expected),
      ),
    )
    .returning()
  const row = claimed[0] as Record<string, unknown> | undefined
  return row ? toRecord(row) : null
}
