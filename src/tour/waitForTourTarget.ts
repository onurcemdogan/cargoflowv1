// SINIRLI HEDEF BEKLEME.
//
// Sayfalar tembel (lazy) yüklenir: navigasyondan hemen sonra hedef DOM'da
// olmayabilir. Hedef `MutationObserver` ile beklenir ve bekleme SÜRE
// SINIRLIDIR — sonsuz yoklama, kalıcı `setInterval` veya meşgul döngü YOKTUR.
// Hedef bulunamazsa `null` döner (tur yumuşak şekilde devam eder).

export const TOUR_TARGET_TIMEOUT_MS = 4000

export function waitForTourTarget(
  selector: string,
  options: { timeoutMs?: number; signal?: AbortSignal; root?: Document } = {},
): Promise<Element | null> {
  const root = options.root ?? document
  const timeoutMs = options.timeoutMs ?? TOUR_TARGET_TIMEOUT_MS
  const immediate = root.querySelector(selector)
  if (immediate) return Promise.resolve(immediate)
  if (options.signal?.aborted) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    const finish = (element: Element | null) => {
      if (settled) return
      settled = true
      observer.disconnect()
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(element)
    }
    const onAbort = () => finish(null)
    const observer = new MutationObserver(() => {
      const found = root.querySelector(selector)
      if (found) finish(found)
    })
    observer.observe(root.body ?? root.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-tour'],
    })
    const timer = setTimeout(() => finish(root.querySelector(selector)), timeoutMs)
    options.signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Elle başlatmayı ENGELLEYEN durumlar: açık kalıcı pencere/çekmece veya
 * kaydedilmemiş düzenleyici. Tur sayfa değiştirir; açık bir düzenleyiciyi
 * SESSİZCE kapatmamak için bu durumlarda başlatma REDDEDİLİR.
 */
export const TOUR_START_BLOCKER_SELECTOR =
  '[aria-modal="true"], .drawer-backdrop, [data-unsaved-changes="true"]'

export function findTourStartBlocker(root: Document = document): Element | null {
  return root.querySelector(TOUR_START_BLOCKER_SELECTOR)
}
