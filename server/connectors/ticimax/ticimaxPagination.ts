// TICIMAX SAYFALAMA SEMANTİĞİ — SOAP SERİLEŞTİRME YOK.
//
// WebSiparisSayfalama alan adları fieldLevelVerified=false olduğu için
// XML/QName ÜRETİLMEZ. Bu modül yalnız:
//   · sınırlı sayfa gezintisi
//   · ilerlemeyen / tekrarlayan sayfa sonlandırması
//   · SiparisID ile tekilleştirme
// semantiğini sağlar. Sayfa içeriği enjekte `pageFetcher` ile gelir.

export const TICIMAX_DEFAULT_MAX_PAGES = 50
export const TICIMAX_DEFAULT_PAGE_SIZE = 50

export type TicimaxFetchOutcome = 'SUCCESS' | 'PARTIAL' | 'FAILED'

export interface TicimaxPageRequest {
  /** 1-tabanlı mantıksal sayfa indeksi (SOAP alanı DEĞİL). */
  pageIndex: number
  pageSize: number
}

export interface TicimaxPagePayload {
  /** Ham sipariş nesneleri (SelectSiparis satırları). */
  orders: unknown[]
  /** Daha fazla sayfa var mı — sağlayıcı/fetcher bildirimi. */
  hasMore: boolean
}

export type TicimaxPageFetcher = (
  request: TicimaxPageRequest,
) => Promise<
  | { ok: true; page: TicimaxPagePayload }
  | { ok: false; errorClass: string }
>

export interface TicimaxPaginatedFetchResult {
  outcome: TicimaxFetchOutcome
  rawOrders: unknown[]
  pagesFetched: number
  errorClass: string | null
  /** Tekrarlayan / ilerlemeyen sayfa yüzünden mi durdu. */
  terminatedForNonProgress: boolean
}

function orderIdOf(raw: unknown): string {
  const record = (raw ?? {}) as Record<string, unknown>
  return String(record.SiparisID ?? '').trim()
}

/**
 * Sınırlı sayfa gezintisi.
 *
 * Durma:
 *   · hasMore=false → SUCCESS
 *   · boş sayfa ve hasMore=false → SUCCESS
 *   · hasMore=true ama yeni SiparisID yok (tekrar / ilerleme yok) → PARTIAL
 *   · maxPages → PARTIAL
 *   · fetcher hatası → FAILED (hiç sayfa) veya PARTIAL
 */
export async function fetchTicimaxOrderPages(
  pageFetcher: TicimaxPageFetcher,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<TicimaxPaginatedFetchResult> {
  const maxPages = Math.max(1, Number(options.maxPages ?? TICIMAX_DEFAULT_MAX_PAGES))
  const pageSize = Math.max(1, Number(options.pageSize ?? TICIMAX_DEFAULT_PAGE_SIZE))
  const rawOrders: unknown[] = []
  const seen = new Set<string>()
  let pagesFetched = 0

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    const result = await pageFetcher({ pageIndex, pageSize })
    if (!result.ok) {
      return {
        outcome: pagesFetched === 0 ? 'FAILED' : 'PARTIAL',
        rawOrders,
        pagesFetched,
        errorClass: result.errorClass,
        terminatedForNonProgress: false,
      }
    }

    pagesFetched += 1
    let fresh = 0
    for (const row of result.page.orders) {
      const id = orderIdOf(row)
      if (id !== '' && seen.has(id)) continue
      if (id !== '') seen.add(id)
      rawOrders.push(row)
      if (id !== '') fresh += 1
      else fresh += 1 // kimliksiz satır da "içerik" sayılır; normalleştirici reddeder
    }

    if (!result.page.hasMore) {
      return {
        outcome: 'SUCCESS',
        rawOrders,
        pagesFetched,
        errorClass: null,
        terminatedForNonProgress: false,
      }
    }

    // Devam var dendi ama sayfa İLERLEMEDİ (boş veya yalnız tekrar).
    if (fresh === 0 || result.page.orders.length === 0) {
      return {
        outcome: 'PARTIAL',
        rawOrders,
        pagesFetched,
        errorClass: 'NON_PROGRESSING_PAGE',
        terminatedForNonProgress: true,
      }
    }
  }

  return {
    outcome: 'PARTIAL',
    rawOrders,
    pagesFetched,
    errorClass: 'MAX_PAGES_REACHED',
    terminatedForNonProgress: false,
  }
}
