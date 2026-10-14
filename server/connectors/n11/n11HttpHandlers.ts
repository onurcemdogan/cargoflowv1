// N11 HTTP İŞLEYİCİLERİ — `index.mjs` yalnız kiracı kapsamını çözer ve buraya
// devreder (kiracı GÖVDEDEN alınmaz). Her işleyici { status, body } döner.
//
//   · Tek uçuş: (kiracı, hesap) anahtarı; `finally`de HER yolda bırakılır.
//   · Sahiplik/kimlik ağdan ÖNCE: yabancı hesap → 404, kimlik yok → 409;
//     her ikisinde de n11'e çağrı 0.
//   · Save/Test Et: tek GET (Created, page 0, size 1), kalıcı hesap doğrulaması.
//   · Senkronize Et: sınırlı okuma; kanonik yazım DB hesap kanıtıyla.
//   · Yanıtlarda appSecret ve tam appKey YOKTUR.
import { getSyncState } from '../../onboarding/onboardingRepository.ts'
import { recordAccountReadProbe } from '../accountReadVerification.ts'
import { accountOrdersReadPayload } from '../accountOrdersReadGate.ts'
import { credentialFingerprint } from '../../integrations/credentialService.ts'
import { N11_WINDOW_MS } from '../../marketplaces/n11/n11Contract.ts'
import { N11_EPOCH_VERIFICATION } from '../../marketplaces/n11/n11EpochSemantics.ts'
import type { LiveWriteGateResult } from '../liveWriteGate.ts'
import { fetchN11Page, N11_ERROR_COPY_TR, type N11ClientOptions } from './n11Client.ts'
import { N11_CONFIG_ERROR_COPY_TR, configToStoredPayload, N11_PROVIDER_KEY, type N11ConnectorConfig } from './n11Config.ts'
import {
  connectN11Account,
  disconnectN11Account,
  listN11Accounts,
  loadN11Account,
  bindN11Seller,
  findN11SellerConflict,
} from './n11ConnectionService.ts'
import {
  N11_DENSE_WINDOW_UNSPLITTABLE,
  N11_REQUEST_BUDGET_EXHAUSTED,
  n11HealthLabel,
  resolveN11Health,
} from './n11Health.ts'
import { persistN11Orders } from './n11Persistence.ts'
import { syncN11OrdersForAccount } from './n11OrderSync.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface N11HandlerResponse {
  status: number
  body: Record<string, unknown>
}

const inFlight = new Set<string>()

/** Test/teşhis: askıda uçuş kalmadığını kanıtlamak için. */
export function n11InFlightCount(): number {
  return inFlight.size
}

async function withSingleFlight(key: string, run: () => Promise<N11HandlerResponse>): Promise<N11HandlerResponse> {
  if (inFlight.has(key)) {
    return { status: 409, body: { ok: false, code: 'N11_SYNC_IN_PROGRESS', message: 'Bu hesap için bir n11 işlemi zaten çalışıyor.' } }
  }
  inFlight.add(key)
  try {
    return await run()
  } finally {
    inFlight.delete(key)
  }
}

const accountIdFrom = (body: unknown): string =>
  String((body as Record<string, unknown> | null | undefined)?.marketplaceAccountId ?? '').trim()

export async function handleN11ListAccounts(params: { db: Db; organizationId: string }): Promise<N11HandlerResponse> {
  const accounts = await listN11Accounts(params.db, params.organizationId)
  return {
    status: 200,
    body: {
      ok: true,
      rolloutStage: 'internal_test',
      liveVerified: false,
      marketplaceWritesEnabled: false,
      accounts: accounts.map((account) => ({ ...account, healthLabel: n11HealthLabel(account.health) })),
    },
  }
}

export async function handleN11Connect(params: { db: Db; organizationId: string; body: unknown; clientOptions: N11ClientOptions; now?: () => number }): Promise<N11HandlerResponse> {
  const body = (params.body ?? {}) as Record<string, unknown>
  const result = await connectN11Account(params.db, {
    organizationId: params.organizationId,
    marketplaceAccountId: body.marketplaceAccountId,
    appKey: body.appKey,
    appSecret: body.appSecret,
  })
  if (!result.ok) {
    if (result.errors.includes('N11_ACCOUNT_NOT_FOUND')) {
      return { status: 404, body: { ok: false, code: 'N11_ACCOUNT_NOT_FOUND', message: 'n11 hesabı bulunamadı.' } }
    }
    const messages = result.errors
      .filter((code): code is keyof typeof N11_CONFIG_ERROR_COPY_TR => code in N11_CONFIG_ERROR_COPY_TR)
      .map((code) => N11_CONFIG_ERROR_COPY_TR[code])
    return { status: 400, body: { ok: false, code: 'N11_CONFIG_INVALID', errors: result.errors, message: messages.join(' ') } }
  }
  const probe = await handleN11Test({ ...params, body: { marketplaceAccountId: result.marketplaceAccountId } })
  return {
    status: 200,
    body: {
      ...probe.body, ok: true, credentialsSaved: true, verificationOk: probe.body.ok === true,
      marketplaceAccountId: result.marketplaceAccountId,
      message: `n11 API bilgileri kaydedildi. ${String(probe.body.message ?? '')}`.trim(),
    },
  }
}

export async function handleN11Disconnect(params: { db: Db; organizationId: string; body: unknown }): Promise<N11HandlerResponse> {
  const marketplaceAccountId = accountIdFrom(params.body)
  return withSingleFlight(`${params.organizationId}::${marketplaceAccountId}`, async () => {
    const result = await disconnectN11Account(params.db, { organizationId: params.organizationId, marketplaceAccountId })
    if (result.outcome === 'NOT_FOUND') {
      return { status: 404, body: { ok: false, code: 'N11_ACCOUNT_NOT_FOUND', message: 'n11 hesabı bulunamadı.' } }
    }
    return { status: 200, body: { ok: true, message: 'n11 bağlantısı kaldırıldı.' } }
  })
}

type Loaded =
  | { ok: true; account: { id: string }; config: N11ConnectorConfig }
  | { ok: false; response: N11HandlerResponse }

async function loadForRead(db: Db, organizationId: string, marketplaceAccountId: string): Promise<Loaded> {
  const loaded = await loadN11Account(db, { organizationId, marketplaceAccountId })
  if (!loaded) {
    return { ok: false, response: { status: 404, body: { ok: false, code: 'N11_ACCOUNT_NOT_FOUND', message: 'n11 hesabı bulunamadı.', networkCalls: 0 } } }
  }
  if (!loaded.account.isActive || !loaded.config) {
    return {
      ok: false,
      response: { status: 409, body: { ok: false, code: 'N11_CREDENTIALS_MISSING', message: N11_ERROR_COPY_TR.CREDENTIALS_MISSING, networkCalls: 0 } },
    }
  }
  return { ok: true, account: loaded.account, config: loaded.config }
}

/** One bounded GET; persists only account verification, never the order cursor. */
export async function handleN11Test(params: {
  db: Db
  organizationId: string
  body: unknown
  clientOptions: N11ClientOptions
  now?: () => number
}): Promise<N11HandlerResponse> {
  const marketplaceAccountId = accountIdFrom(params.body)
  return withSingleFlight(`${params.organizationId}::${marketplaceAccountId}`, async () => {
    const loaded = await loadForRead(params.db, params.organizationId, marketplaceAccountId)
    if (!loaded.ok) return loaded.response
    const nowMs = (params.now ?? Date.now)()
    let page = await fetchN11Page(
      loaded.config,
      { status: 'Created', page: 0, size: 1, startMs: nowMs - N11_WINDOW_MS, endMs: nowMs },
      { ...params.clientOptions, retryDelaysMs: [] },
    )
    let sellerToBind: string | null = null
    if (page.ok && !page.entries.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry))) {
      page = { ok: false, errorClass: 'RESPONSE_SHAPE_UNVERIFIED', reasonCode: 'N11_RESPONSE_SHAPE_UNVERIFIED', httpStatus: page.httpStatus, networkCalls: page.networkCalls }
    }
    if (page.ok) {
      const sellers = [...new Set(page.entries.flatMap((entry) => {
        const seller = (entry as { sellerId?: unknown } | null)?.sellerId
        return seller == null || String(seller).trim() === '' ? [] : [String(seller).trim()]
      }))]
      const sellerId = sellers[0]
      const mismatch = sellers.length > 1 || (sellerId && loaded.config.boundSellerId && sellerId !== loaded.config.boundSellerId)
      const conflict = sellerId && await findN11SellerConflict(params.db, { organizationId: params.organizationId, marketplaceAccountId, sellerId })
      if (mismatch || conflict) {
        page = { ok: false, errorClass: 'REQUEST_REJECTED', reasonCode: conflict ? 'N11_SELLER_ALREADY_CONNECTED' : 'N11_SELLER_MISMATCH', httpStatus: page.httpStatus, networkCalls: page.networkCalls }
      } else if (sellerId) {
        sellerToBind = sellerId
      }
    }
    const verification = await recordAccountReadProbe(params.db, {
      organizationId: params.organizationId, marketplaceAccountId, providerKey: N11_PROVIDER_KEY,
    }, configToStoredPayload(loaded.config), page, new Date(nowMs))
    if (!verification.recorded) return { status: 200, body: { ok: false, verificationStatus: 'unverified', reasonCode: 'ACCOUNT_CREDENTIALS_CHANGED', message: 'API bilgileri değişti; yeniden test edin.', networkCalls: page.networkCalls } }
    if (sellerToBind) {
      const binding = await bindN11Seller(params.db, {
        organizationId: params.organizationId, marketplaceAccountId, sellerId: sellerToBind,
        expectedFingerprint: credentialFingerprint(accountOrdersReadPayload(N11_PROVIDER_KEY, configToStoredPayload(loaded.config))),
      })
      if (!binding.ok) return { status: 200, body: { ok: false, verificationStatus: 'unverified', reasonCode: binding.reasonCode, message: binding.reasonCode === 'N11_SELLER_ALREADY_CONNECTED' ? 'Bu satıcı başka bir n11 hesabına bağlı.' : 'API bilgileri değişti; yeniden test edin.', networkCalls: page.networkCalls } }
    }
    if (!page.ok) {
      return {
        status: 200,
        body: { ok: false, ...verification, code: `N11_${page.errorClass}`, reasonCode: page.reasonCode, message: N11_ERROR_COPY_TR[page.errorClass], networkCalls: page.networkCalls },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        ...verification,
        recordsRead: page.entries.length,
        networkCalls: page.networkCalls,
        message: 'Hesap doğrulandı. Sipariş okuma aktif.',
      },
    }
  })
}

/** Elle okuma senkronu — hesap kapsamlı, sınırlı, tek uçuş. */
export async function handleN11Sync(params: {
  db: Db
  organizationId: string
  body: unknown
  clientOptions: N11ClientOptions
  now?: () => number
  liveWriteGate?: (providerKey: string) => LiveWriteGateResult
}): Promise<N11HandlerResponse> {
  const marketplaceAccountId = accountIdFrom(params.body)
  return withSingleFlight(`${params.organizationId}::${marketplaceAccountId}`, async () => {
    const loaded = await loadForRead(params.db, params.organizationId, marketplaceAccountId)
    if (!loaded.ok) return loaded.response
    const { account, config } = loaded
    const state = await getSyncState(params.db, params.organizationId, 'orders', account.id)
    const lastSuccess = state?.lastSuccessfulSyncAt ? new Date(String(state.lastSuccessfulSyncAt)).getTime() : null
    const sync = await syncN11OrdersForAccount(
      params.db,
      {
        organizationId: params.organizationId,
        marketplaceAccountId: account.id,
        config,
        fromMs: Number.isFinite(lastSuccess) ? lastSuccess : null,
        upperBoundMs: (params.now ?? Date.now)(),
        liveWriteGate: params.liveWriteGate,
        persistCanonical: (orders) =>
          persistN11Orders(params.db, { organizationId: params.organizationId, marketplaceAccountId: account.id, orders }),
      },
      params.clientOptions,
    )
    const health = resolveN11Health({
      credentialsComplete: true,
      syncState: await getSyncState(params.db, params.organizationId, 'orders', account.id),
    })
    const writeNote = sync.canonicalWrite === 'ALLOWED'
      ? null
      : 'Hesap doğrulanmadı; siparişler sisteme yazılmadı, imleç ilerlemedi.'
    const incompleteNote = sync.durabilityReasonCode && sync.canonicalWrite === 'ALLOWED' && !sync.errorClass
      ? 'Okuma tamamlandı ancak bazı kayıtlar sisteme eksiksiz yazılamadı; aralık bir sonraki senkronda yeniden okunacak.'
      : null
    return {
      status: 200,
      body: {
        ok: sync.outcome !== 'FAILED',
        outcome: sync.outcome,
        healthState: health.state,
        healthLabel: n11HealthLabel(health),
        fetched: sync.fetchedCount,
        normalized: sync.normalizedCount,
        duplicates: sync.duplicateRemovedCount,
        invalidIdentity: sync.invalidIdentityCount,
        sellerMismatch: sync.sellerMismatchCount,
        unpersistable: sync.unpersistable,
        pages: sync.pagesFetched,
        splits: sync.splitCount,
        networkCalls: sync.networkCalls,
        windowsProcessed: sync.windowsProcessed,
        windowsDurable: sync.windowsDurable,
        moreRemaining: sync.moreRemaining,
        canonicalWrite: sync.canonicalWrite,
        ordersReadReasonCode: sync.ordersReadReasonCode,
        persisted: sync.persisted,
        checkpointAdvanced: sync.checkpointAdvanced,
        epochVerification: N11_EPOCH_VERIFICATION,
        durabilityReasonCode: sync.durabilityReasonCode,
        message: sync.durabilityReasonCode === N11_EPOCH_VERIFICATION.reasonCode
          ? 'Okuma tamamlandı; n11 tarih parametrelerinin saat dönüşümü doğrulanmadığı için imleç ilerlemedi.'
          : sync.reasonCode === N11_DENSE_WINDOW_UNSPLITTABLE
          ? 'Bir aralıkta aynı zaman diliminde tek sayfaya sığmayan sayıda kayıt var; aralık güvenle bölünemedi, imleç o pencerede durdu.'
          : sync.reasonCode === N11_REQUEST_BUDGET_EXHAUSTED
          ? 'Bu koşunun istek bütçesi doldu; imleç son tamamlanan pencerede durdu. Kalan aralık için yeniden senkronize edin.'
          : sync.errorClass
          ? N11_ERROR_COPY_TR[sync.errorClass]
          : incompleteNote ?? writeNote ?? (sync.moreRemaining
            ? 'n11 okuma senkronu bu koşu için tamamlandı; kalan aralık için yeniden senkronize edin.'
            : 'n11 okuma senkronu tamamlandı.'),
        note: writeNote,
      },
    }
  })
}
