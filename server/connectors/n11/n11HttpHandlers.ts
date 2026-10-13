// N11 HTTP İŞLEYİCİLERİ — `index.mjs` yalnız kiracı kapsamını çözer ve buraya
// devreder (kiracı GÖVDEDEN alınmaz). Her işleyici { status, body } döner.
//
//   · Tek uçuş: (kiracı, hesap) anahtarı; `finally`de HER yolda bırakılır.
//   · Sahiplik/kimlik ağdan ÖNCE: yabancı hesap → 404, kimlik yok → 409;
//     her ikisinde de n11'e çağrı 0.
//   · Test Et: tek GET (Created statüsü, page 0, size 1, son 15 gün); YAZMAZ.
//   · Senkronize Et: sınırlı okuma; kanonik yazım `liveWriteGate` kararıyla.
//   · Yanıtlarda appSecret ve tam appKey YOKTUR.
import { getSyncState } from '../../onboarding/onboardingRepository.ts'
import { N11_WINDOW_MS } from '../../marketplaces/n11/n11Contract.ts'
import type { LiveWriteGateResult } from '../liveWriteGate.ts'
import { fetchN11Page, N11_ERROR_COPY_TR, type N11ClientOptions } from './n11Client.ts'
import { N11_CONFIG_ERROR_COPY_TR, type N11ConnectorConfig } from './n11Config.ts'
import {
  connectN11Account,
  disconnectN11Account,
  listN11Accounts,
  loadN11Account,
} from './n11ConnectionService.ts'
import { N11_PAGE_LIMIT_REACHED, n11HealthLabel, resolveN11Health } from './n11Health.ts'
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

export async function handleN11Connect(params: { db: Db; organizationId: string; body: unknown }): Promise<N11HandlerResponse> {
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
  return {
    status: 200,
    body: { ok: true, marketplaceAccountId: result.marketplaceAccountId, message: 'n11 API bilgileri kaydedildi. Okumayı "Test Et" ile deneyin.' },
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

/** Bağlantı testi: tek GET, YAZMAZ, imleç/durum değiştirmez. */
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
    const page = await fetchN11Page(
      loaded.config,
      { status: 'Created', page: 0, size: 1, startMs: nowMs - N11_WINDOW_MS, endMs: nowMs },
      params.clientOptions,
    )
    if (!page.ok) {
      return {
        status: 200,
        body: { ok: false, code: `N11_${page.errorClass}`, reasonCode: page.reasonCode, message: N11_ERROR_COPY_TR[page.errorClass], networkCalls: page.networkCalls },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        recordsRead: page.entries.length,
        networkCalls: page.networkCalls,
        message: 'n11 okuma isteği yanıt verdi. Bu iç test aşamasıdır; canlı doğrulama ayrıca yapılmalıdır.',
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
      : 'İç test aşaması: okunan siparişler canlı sipariş, kargo ve etiket akışına aktarılmadı; imleç ilerlemedi.'
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
        networkCalls: sync.networkCalls,
        windowsProcessed: sync.windowsProcessed,
        windowsDurable: sync.windowsDurable,
        moreRemaining: sync.moreRemaining,
        canonicalWrite: sync.canonicalWrite,
        persisted: sync.persisted,
        checkpointAdvanced: sync.checkpointAdvanced,
        durabilityReasonCode: sync.durabilityReasonCode,
        message: sync.reasonCode === N11_PAGE_LIMIT_REACHED
          ? 'Bir pencerede sayfa tavanına ulaşıldı; imleç o pencerede durdu ve kalan kayıtlar okunmadı.'
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
