// TICIMAX SİPARİŞ SENKRONU — TEL KAPISI + HERMETİK pageFetcher.
//
// Canlı SelectSiparis yokken senkron FAIL-CLOSED'tır. Hermetik testler
// `pageFetcher` enjekte ederek sayfalama / imleç / canlı yazma kapısını
// SOAP uydurmadan kanıtlar.
//
// İmleç yalnız TAM başarıda `recordSyncState` ile ilerler.
// Kanonik kalıcılaştırma `liveWriteGate` ile aşamaya bağlıdır (ticimax=off).
import { recordSyncState } from '../../onboarding/onboardingRepository.ts'
import { canPersistCanonicalOrders } from '../liveWriteGate.ts'
import { TICIMAX_PROVIDER_KEY } from './ticimaxEndpoint.ts'
import {
  assertSelectSiparisWireReady,
  TicimaxWireContractError,
} from './ticimaxWireGate.ts'
import {
  fetchTicimaxOrderPages,
  type TicimaxFetchOutcome,
  type TicimaxPageFetcher,
} from './ticimaxPagination.ts'
import {
  normalizeTicimaxOrders,
  type TicimaxBatchNormalization,
} from './ticimaxOrderNormalizer.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export { TICIMAX_PROVIDER_KEY }

export type TicimaxCanonicalPersister = (
  normalization: TicimaxBatchNormalization,
) => Promise<void>

export interface TicimaxSyncResult {
  outcome: TicimaxFetchOutcome
  normalization: TicimaxBatchNormalization
  checkpointAdvanced: boolean
  canonicalPersisted: boolean
  liveWriteReason: string
  pagesFetched: number
  errorClass: string | null
  terminatedForNonProgress: boolean
}

const STATUS: Record<TicimaxFetchOutcome, 'success' | 'partial' | 'failed'> = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
}

/**
 * Bir Ticimax hesabının sipariş mutabakatı.
 *
 * `pageFetcher` YOKSA tel kapısı zorunlu (SOAP yok → DEFERRED).
 * `pageFetcher` VARSA hermetik koşu: canlı tel gerekmez.
 */
export async function syncTicimaxOrdersForAccount(
  db: Db,
  params: {
    organizationId: string
    marketplaceAccountId: string
    /** Hermetik test enjeksiyonu — yoksa tel kapısı fail-closed. */
    pageFetcher?: TicimaxPageFetcher
    upperBoundMs: number
    persistCanonical?: TicimaxCanonicalPersister
    maxPages?: number
    pageSize?: number
  },
): Promise<TicimaxSyncResult> {
  const organizationId = String(params.organizationId ?? '').trim()
  const marketplaceAccountId = String(params.marketplaceAccountId ?? '').trim()
  if (organizationId === '' || marketplaceAccountId === '') {
    throw new Error('organizationId ve marketplaceAccountId zorunludur.')
  }
  if (!Number.isSafeInteger(params.upperBoundMs) || params.upperBoundMs <= 0) {
    throw new Error('upperBoundMs geçerli bir epoch milisaniye olmalıdır.')
  }

  if (!params.pageFetcher) {
    try {
      assertSelectSiparisWireReady()
    } catch (error) {
      if (error instanceof TicimaxWireContractError) {
        const normalization = normalizeTicimaxOrders([])
        const gate = canPersistCanonicalOrders(TICIMAX_PROVIDER_KEY)
        await recordSyncState(db, organizationId, {
          provider: TICIMAX_PROVIDER_KEY,
          resource: 'orders',
          status: 'failed',
          fetchedCount: 0,
          errorCode: error.code,
          marketplaceAccountId,
          successfulSyncAt: null,
        })
        return {
          outcome: 'FAILED',
          normalization,
          checkpointAdvanced: false,
          canonicalPersisted: false,
          liveWriteReason: gate.reasonCode,
          pagesFetched: 0,
          errorClass: error.code,
          terminatedForNonProgress: false,
        }
      }
      throw error
    }
    // Tel verified ama adaptör yok — yine fail-closed (SOAP uydurulmaz).
    const normalization = normalizeTicimaxOrders([])
    const gate = canPersistCanonicalOrders(TICIMAX_PROVIDER_KEY)
    await recordSyncState(db, organizationId, {
      provider: TICIMAX_PROVIDER_KEY,
      resource: 'orders',
      status: 'failed',
      fetchedCount: 0,
      errorCode: 'SOAP_ADAPTER_NOT_IMPLEMENTED',
      marketplaceAccountId,
      successfulSyncAt: null,
    })
    return {
      outcome: 'FAILED',
      normalization,
      checkpointAdvanced: false,
      canonicalPersisted: false,
      liveWriteReason: gate.reasonCode,
      pagesFetched: 0,
      errorClass: 'SOAP_ADAPTER_NOT_IMPLEMENTED',
      terminatedForNonProgress: false,
    }
  }

  const fetched = await fetchTicimaxOrderPages(params.pageFetcher, {
    maxPages: params.maxPages,
    pageSize: params.pageSize,
  })
  const normalization = normalizeTicimaxOrders(fetched.rawOrders)

  const gate = canPersistCanonicalOrders(TICIMAX_PROVIDER_KEY)
  let canonicalPersisted = false
  if (
    gate.decision === 'ALLOWED' &&
    fetched.outcome === 'SUCCESS' &&
    params.persistCanonical
  ) {
    await params.persistCanonical(normalization)
    canonicalPersisted = true
  }

  const status = STATUS[fetched.outcome]
  const checkpointAdvanced = status === 'success'
  await recordSyncState(db, organizationId, {
    provider: TICIMAX_PROVIDER_KEY,
    resource: 'orders',
    status,
    fetchedCount: normalization.orders.length,
    errorCode: fetched.errorClass,
    marketplaceAccountId,
    successfulSyncAt: checkpointAdvanced ? new Date(params.upperBoundMs) : null,
  })

  return {
    outcome: fetched.outcome,
    normalization,
    checkpointAdvanced,
    canonicalPersisted,
    liveWriteReason: gate.reasonCode,
    pagesFetched: fetched.pagesFetched,
    errorClass: fetched.errorClass,
    terminatedForNonProgress: fetched.terminatedForNonProgress,
  }
}
