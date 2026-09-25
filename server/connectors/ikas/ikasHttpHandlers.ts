// IKAS HTTP UÇ DAVRANIŞI — TEK GERÇEK (index.mjs yalnız kiracıyı çözer).
//
// Yanıtlar KARARLI KODLAR ve güvenli metin taşır: ham GraphQL hatası, sır,
// belirteç, Authorization başlığı veya sipariş kişisel verisi ASLA çıkmaz.
// Sipariş okuma testi yalnız SAYILAR döndürür.
//
// WEBHOOK UCU YOKTUR: ikas imza sözleşmesi belgelenmemiştir.
import { getSyncState } from '../../onboarding/onboardingRepository.ts'
import { BOOTSTRAP_WINDOW_MS } from '../../orders/syncWindowPolicy.ts'
import { ikasSafeMessage, type IkasClientOptions } from './ikasClient.ts'
import {
  connectIkasStore,
  disconnectIkasStore,
  listIkasStores,
  loadIkasCredentials,
} from './ikasConnectionService.ts'
import { IKAS_PROVIDER_KEY, syncIkasOrdersForAccount } from './ikasOrderSync.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface IkasHandlerResponse {
  httpStatus: number
  body: Record<string, unknown>
}

export async function handleIkasListStores(params: {
  db: Db
  organizationId: string
}): Promise<IkasHandlerResponse> {
  const stores = await listIkasStores(params.db, params.organizationId)
  return { httpStatus: 200, body: { ok: true, rolloutStage: 'internal_test', stores } }
}

export async function handleIkasConnect(params: {
  db: Db
  organizationId: string
  body: Record<string, unknown>
  options: IkasClientOptions
}): Promise<IkasHandlerResponse> {
  const result = await connectIkasStore(
    params.db,
    {
      organizationId: params.organizationId,
      storeName: String(params.body?.storeName ?? ''),
      clientId: String(params.body?.clientId ?? ''),
      clientSecret: String(params.body?.clientSecret ?? ''),
    },
    params.options,
  )
  if (result.outcome !== 'CONNECTED') {
    return {
      httpStatus: result.outcome === 'STORE_NAME_REJECTED' ? 400 : 422,
      body: {
        ok: false,
        outcome: result.outcome,
        errorClass: result.errorClass,
        message: result.message,
      },
    }
  }
  return {
    httpStatus: 200,
    body: {
      ok: true,
      outcome: result.outcome,
      marketplaceAccountId: result.marketplaceAccountId,
      providerAccountId: result.providerAccountId,
      message: result.message,
    },
  }
}

export async function handleIkasDisconnect(params: {
  db: Db
  organizationId: string
  marketplaceAccountId: string
}): Promise<IkasHandlerResponse> {
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (marketplaceAccountId === '') {
    return { httpStatus: 400, body: { ok: false, outcome: 'MISSING_ACCOUNT_ID' } }
  }
  const result = await disconnectIkasStore(params.db, {
    organizationId: params.organizationId,
    marketplaceAccountId,
  })
  if (result.outcome !== 'DISCONNECTED') {
    return {
      httpStatus: 404,
      body: { ok: false, outcome: result.outcome, message: 'ikas mağazası bulunamadı.' },
    }
  }
  return { httpStatus: 200, body: { ok: true, outcome: result.outcome, marketplaceAccountId } }
}

/**
 * SİPARİŞ OKUMA TESTİ — açık kullanıcı aksiyonu, iç test.
 *
 * Pencere: son başarılı imleç (yoksa önyükleme penceresi) → koşu başında
 * SABİTLENEN üst sınır. Kanonik yazım aşama kapısıyla KAPALIDIR.
 */
export async function handleIkasOrdersReadTest(params: {
  db: Db
  organizationId: string
  marketplaceAccountId: string
  options: IkasClientOptions & { pageLimit?: number; maxPages?: number }
  nowMs?: number
}): Promise<IkasHandlerResponse> {
  const loaded = await loadIkasCredentials(params.db, {
    organizationId: params.organizationId,
    marketplaceAccountId: params.marketplaceAccountId,
  })
  if (!loaded) {
    return {
      httpStatus: 404,
      body: { ok: false, outcome: 'NOT_FOUND', message: 'ikas mağazası bulunamadı.' },
    }
  }
  const upperBoundMs = Math.trunc(params.nowMs ?? Date.now())
  const state = await getSyncState(
    params.db,
    String(params.organizationId).trim(),
    'orders',
    loaded.account.id,
  )
  const checkpoint = state?.lastSuccessfulSyncAt ? new Date(String(state.lastSuccessfulSyncAt)) : null
  const checkpointMs =
    checkpoint && Number.isFinite(checkpoint.getTime()) && state?.provider === IKAS_PROVIDER_KEY
      ? checkpoint.getTime()
      : null
  const result = await syncIkasOrdersForAccount(
    params.db,
    {
      organizationId: params.organizationId,
      marketplaceAccountId: loaded.account.id,
      merchantId: loaded.account.providerAccountId,
      credentials: loaded.credentials,
      window: {
        fromMs: checkpointMs ?? upperBoundMs - BOOTSTRAP_WINDOW_MS,
        upperBoundMs,
      },
    },
    params.options,
  )
  const withPackages = result.normalization.orders.filter(
    (order) => order.packageIdentity === 'PROVIDER_PACKAGES',
  ).length
  return {
    httpStatus: result.outcome === 'FAILED' ? 502 : 200,
    body: {
      ok: result.outcome === 'SUCCESS',
      outcome: result.outcome,
      errorClass: result.errorClass,
      message:
        result.outcome === 'SUCCESS'
          ? 'Sipariş okuma testi tamamlandı (iç test — canlı iş akışına YAZILMADI).'
          : ikasSafeMessage(result.errorClass ?? 'PROVIDER_ERROR'),
      ordersRead: result.normalization.orders.length,
      ordersWithProviderPackages: withPackages,
      ordersWithoutProviderPackage: result.normalization.orders.length - withPackages,
      rejectedCount: result.normalization.rejected.length,
      pagesFetched: result.pagesFetched,
      checkpointAdvanced: result.checkpointAdvanced,
      canonicalPersisted: result.canonicalPersisted,
      liveWriteReason: result.liveWriteReason,
    },
  }
}
