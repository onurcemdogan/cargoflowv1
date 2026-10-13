// HEPSIBURADA HTTP UÇ DAVRANIŞI — org kapsamlı, hesap sahipliği kanıtlı.
//
// Uçlar (index.mjs, TENANT_AUTH_PATHS arkasında):
//   GET  /api/integrations/hepsiburada/accounts             → liste (SIRSIZ)
//   POST /api/integrations/hepsiburada/accounts             → bağla/güncelle (ağ YOK)
//   POST /api/integrations/hepsiburada/accounts/disconnect  → ayır
//   POST /api/integrations/hepsiburada/accounts/test        → 1 kayıtlık okuma denemesi
//   POST /api/integrations/hepsiburada/accounts/sync        → elle okuma senkronu
//
// OTOMATİK ZAMANLAYICI YOK: senkron yalnız kullanıcı tetiklemesiyle çalışır.
//
// TEK UÇUŞ: aynı (kiracı, hesap) için eşzamanlı ikinci senkron/test REDDEDİLİR
// (409). Kayıt `finally`de HER yolda düşer — erken dönüş ve hata dahil;
// aksi hâlde hesap kalıcı olarak "çalışıyor" kalırdı.
import {
  fetchHepsiburadaPage,
  HEPSIBURADA_ERROR_COPY_TR,
  type HepsiburadaClientOptions,
} from './hepsiburadaClient.ts'
import {
  HEPSIBURADA_CONFIG_ERROR_COPY_TR,
  resolveReadFamily,
  type HepsiburadaConnectorConfig,
} from './hepsiburadaConfig.ts'
import type { MarketplaceAccount } from '../../integrations/marketplaceAccountRepository.ts'
import {
  connectHepsiburadaAccount,
  disconnectHepsiburadaAccount,
  listHepsiburadaAccounts,
  loadHepsiburadaAccount,
} from './hepsiburadaConnectionService.ts'
import { hepsiburadaHealthLabel, resolveHepsiburadaHealth } from './hepsiburadaHealth.ts'
import { persistHepsiburadaOrders } from './hepsiburadaPersistence.ts'
import { syncHepsiburadaOrdersForAccount } from './hepsiburadaOrderSync.ts'
import { getSyncState } from '../../onboarding/onboardingRepository.ts'
import { HEPSIBURADA_PACKAGE_WINDOW_MAX_MS } from '../../marketplaces/hepsiburada/hepsiburadaOrderSource.ts'
import type { LiveWriteGateResult } from '../liveWriteGate.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface HepsiburadaHandlerResponse {
  status: number
  body: Record<string, unknown>
}

const inFlight = new Set<string>()

/** Test/teşhis: süren uçuş sayısı. */
export function hepsiburadaInFlightCount(): number {
  return inFlight.size
}

async function withSingleFlight(
  key: string,
  run: () => Promise<HepsiburadaHandlerResponse>,
): Promise<HepsiburadaHandlerResponse> {
  if (inFlight.has(key)) {
    return {
      status: 409,
      body: { ok: false, code: 'HB_SYNC_IN_PROGRESS', message: 'Bu hesap için bir Hepsiburada işlemi zaten çalışıyor.' },
    }
  }
  inFlight.add(key)
  try {
    return await run()
  } finally {
    inFlight.delete(key)
  }
}

function accountIdFrom(body: unknown): string {
  return String((body as Record<string, unknown> | null)?.marketplaceAccountId ?? '').trim()
}

export async function handleHepsiburadaListAccounts(params: { db: Db; organizationId: string }): Promise<HepsiburadaHandlerResponse> {
  const accounts = await listHepsiburadaAccounts(params.db, params.organizationId)
  return {
    status: 200,
    body: {
      ok: true,
      rolloutStage: 'internal_test',
      liveVerified: false,
      accounts: accounts.map((account) => ({
        ...account,
        healthLabel: hepsiburadaHealthLabel(account.health),
      })),
    },
  }
}

export async function handleHepsiburadaConnect(params: {
  db: Db
  organizationId: string
  body: unknown
}): Promise<HepsiburadaHandlerResponse> {
  const input = (params.body ?? {}) as Record<string, unknown>
  const result = await connectHepsiburadaAccount(params.db, {
    organizationId: params.organizationId,
    merchantId: input.merchantId,
    username: input.username,
    password: input.password,
    host: input.host,
    ordersPath: input.ordersPath,
    packagesPath: input.packagesPath,
    listField: input.listField,
  })
  if (!result.ok) {
    return {
      status: 400,
      body: {
        ok: false,
        code: 'HB_CONFIG_INVALID',
        errors: result.errors,
        message: result.errors.map((code) => HEPSIBURADA_CONFIG_ERROR_COPY_TR[code]).join(' '),
      },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      marketplaceAccountId: result.marketplaceAccountId,
      message: 'Hepsiburada yapılandırması kaydedildi. Okumayı "Test Et" ile deneyin.',
    },
  }
}

export async function handleHepsiburadaDisconnect(params: {
  db: Db
  organizationId: string
  body: unknown
}): Promise<HepsiburadaHandlerResponse> {
  const marketplaceAccountId = accountIdFrom(params.body)
  const result = await disconnectHepsiburadaAccount(params.db, { organizationId: params.organizationId, marketplaceAccountId })
  if (result.outcome === 'NOT_FOUND') {
    return { status: 404, body: { ok: false, code: 'HB_ACCOUNT_NOT_FOUND', message: 'Hepsiburada hesabı bulunamadı.' } }
  }
  return { status: 200, body: { ok: true, message: 'Hepsiburada bağlantısı kaldırıldı.' } }
}

type Loaded =
  | { ok: true; account: MarketplaceAccount; config: HepsiburadaConnectorConfig }
  | { ok: false; response: HepsiburadaHandlerResponse }

async function loadForRead(db: Db, organizationId: string, marketplaceAccountId: string): Promise<Loaded> {
  const loaded = await loadHepsiburadaAccount(db, { organizationId, marketplaceAccountId })
  if (!loaded) {
    return { ok: false, response: { status: 404, body: { ok: false, code: 'HB_ACCOUNT_NOT_FOUND', message: 'Hepsiburada hesabı bulunamadı.' } } }
  }
  if (!loaded.account.isActive || !loaded.config) {
    return {
      ok: false,
      response: { status: 409, body: { ok: false, code: 'HB_CREDENTIALS_MISSING', message: HEPSIBURADA_ERROR_COPY_TR.CREDENTIALS_MISSING, networkCalls: 0 } },
    }
  }
  if (!resolveReadFamily(loaded.config)) {
    return {
      ok: false,
      response: {
        status: 409,
        body: {
          ok: false,
          code: 'HB_ENDPOINT_CONFIG_REQUIRED',
          healthState: 'ENDPOINT_CONFIG_REQUIRED',
          message: HEPSIBURADA_ERROR_COPY_TR.ENDPOINT_CONFIG_REQUIRED,
          networkCalls: 0,
        },
      },
    }
  }
  return { ok: true, account: loaded.account, config: loaded.config }
}

/** Bağlantı testi: son 24 saatlik pencereden 1 kayıt okumayı dener; YAZMAZ. */
export async function handleHepsiburadaTest(params: {
  db: Db
  organizationId: string
  body: unknown
  clientOptions: HepsiburadaClientOptions
  now?: () => number
}): Promise<HepsiburadaHandlerResponse> {
  const marketplaceAccountId = accountIdFrom(params.body)
  return withSingleFlight(`${params.organizationId}::${marketplaceAccountId}`, async () => {
    const result = await loadForRead(params.db, params.organizationId, marketplaceAccountId)
    if (!result.ok) return result.response
    const config = result.config
    const family = resolveReadFamily(config)
    if (!family) return { status: 409, body: { ok: false, code: 'HB_ENDPOINT_CONFIG_REQUIRED', networkCalls: 0 } }
    const nowMs = (params.now ?? Date.now)()
    const page = await fetchHepsiburadaPage(
      config,
      { family, offset: 0, limit: 1, startMs: nowMs - HEPSIBURADA_PACKAGE_WINDOW_MAX_MS, endMs: nowMs },
      params.clientOptions,
    )
    if (!page.ok) {
      return {
        status: 200,
        body: {
          ok: false,
          code: `HB_${page.errorClass}`,
          reasonCode: page.reasonCode,
          message: HEPSIBURADA_ERROR_COPY_TR[page.errorClass],
          networkCalls: page.networkCalls,
        },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        family,
        recordsRead: page.rows.length,
        networkCalls: page.networkCalls,
        message: 'Hepsiburada okuma isteği yanıt verdi. Bu iç test aşamasıdır; canlı doğrulama ayrıca yapılmalıdır.',
      },
    }
  })
}

/** Elle okuma senkronu — hesap kapsamlı, sınırlı, tek uçuş. */
export async function handleHepsiburadaSync(params: {
  db: Db
  organizationId: string
  body: unknown
  clientOptions: HepsiburadaClientOptions
  now?: () => number
  liveWriteGate?: (providerKey: string) => LiveWriteGateResult
}): Promise<HepsiburadaHandlerResponse> {
  const marketplaceAccountId = accountIdFrom(params.body)
  return withSingleFlight(`${params.organizationId}::${marketplaceAccountId}`, async () => {
    const result = await loadForRead(params.db, params.organizationId, marketplaceAccountId)
    if (!result.ok) return result.response
    const { account, config } = result
    const state = await getSyncState(params.db, params.organizationId, 'orders', account.id)
    const lastSuccess = state?.lastSuccessfulSyncAt ? new Date(String(state.lastSuccessfulSyncAt)).getTime() : null
    const upperBoundMs = (params.now ?? Date.now)()
    const sync = await syncHepsiburadaOrdersForAccount(
      params.db,
      {
        organizationId: params.organizationId,
        marketplaceAccountId: account.id,
        config,
        fromMs: Number.isFinite(lastSuccess) ? lastSuccess : null,
        upperBoundMs,
        liveWriteGate: params.liveWriteGate,
        persistCanonical: (orders) =>
          persistHepsiburadaOrders(params.db, {
            organizationId: params.organizationId,
            marketplaceAccountId: account.id,
            orders,
          }),
      },
      params.clientOptions,
    )
    const health = resolveHepsiburadaHealth({
      hasEndpointPath: true,
      credentialsComplete: true,
      syncState: await getSyncState(params.db, params.organizationId, 'orders', account.id),
    })
    const writeNote = sync.canonicalWrite === 'ALLOWED'
      ? null
      : 'İç test aşaması: okunan siparişler canlı sipariş, kargo ve etiket akışına aktarılmadı.'
    return {
      status: 200,
      body: {
        ok: sync.outcome !== 'FAILED',
        outcome: sync.outcome,
        healthState: health.state,
        healthLabel: hepsiburadaHealthLabel(health),
        family: sync.family,
        fetched: sync.fetchedCount,
        normalized: sync.normalizedCount,
        pages: sync.pagesFetched,
        networkCalls: sync.networkCalls,
        moreRemaining: sync.moreRemaining,
        canonicalWrite: sync.canonicalWrite,
        persisted: sync.persistResult,
        message: sync.errorClass
          ? HEPSIBURADA_ERROR_COPY_TR[sync.errorClass]
          : writeNote ?? 'Hepsiburada okuma senkronu tamamlandı.',
        note: writeNote,
      },
    }
  })
}
