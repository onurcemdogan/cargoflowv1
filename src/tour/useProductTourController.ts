// ÜRÜN TURU DENETLEYİCİSİ — otomatik başlatma, elle tekrar, kapanış.
//
// OTOMATİK BAŞLATMA KURALI: normal uygulama yalnız `OnboardingGate` kurulumu
// tamamlanmış gördüğünde bağlanır; bu yüzden uygulamanın bağlanmış olması
// YETERLİDİR — onboarding API'si TEKRAR ÇAĞRILMAZ, onboarding gerçeği
// KOPYALANMAZ. Kimliği doğrulanmış kullanıcı kapsamı yoksa (geliştirme
// atlatması / legacy) tur OTOMATİK AÇILMAZ.
//
// KÖKEN SAYFA: tur başlarken bulunulan sayfa hatırlanır; bitiş veya kapatmada
// kullanıcı oraya DÖNER (otomatik başlatmada köken Dashboard'dur).
import { useCallback, useState } from 'react'
import type { PageKey } from '../types/cargoflow'
import {
  readProductTourMarker,
  writeProductTourMarker,
  type ProductTourMarkerStatus,
  type ProductTourScope,
} from './productTourStorage'
import { findTourStartBlocker } from './waitForTourTarget'

export const TOUR_START_BLOCKED_NOTICE =
  'Açık bir pencere veya kaydedilmemiş bir düzenleme var. Tur, bunlar kapatıldıktan sonra başlatılabilir.'

interface TourState {
  active: boolean
  /** Her başlatmada artar → tur 1. adımdan TEMİZ başlar. */
  runId: number
  origin: PageKey
}

export interface ProductTourController {
  active: boolean
  runId: number
  notice: string | null
  start: () => boolean
  complete: () => void
  dismiss: () => void
}

export function useProductTourController(params: {
  scope: ProductTourScope | null
  currentPage: PageKey
  navigate: (page: PageKey) => void
}): ProductTourController {
  const { scope, currentPage, navigate } = params
  const [state, setState] = useState<TourState>(() => ({
    // Tembel ilk değer: bağlanma ANINDA bir kez karar verilir (efekt yok).
    active: scope !== null && readProductTourMarker(scope) === null,
    runId: 1,
    origin: currentPage,
  }))
  const [notice, setNotice] = useState<string | null>(null)

  const start = useCallback(() => {
    if (findTourStartBlocker()) {
      setNotice(TOUR_START_BLOCKED_NOTICE)
      return false
    }
    setNotice(null)
    // Elle tekrar: tamamlanmış/kapatılmış olsa BİLE başlar, 1. adımdan.
    setState((current) => ({ active: true, runId: current.runId + 1, origin: currentPage }))
    return true
  }, [currentPage])

  const close = useCallback(
    (status: ProductTourMarkerStatus) => {
      // Onboarding tamamlama ÇAĞRILMAZ; yalnız sunum tercihi yazılır.
      if (scope) writeProductTourMarker(scope, status)
      setState((current) => ({ ...current, active: false }))
      if (state.origin !== currentPage) navigate(state.origin)
    },
    [scope, state.origin, currentPage, navigate],
  )

  return {
    active: state.active,
    runId: state.runId,
    notice,
    start,
    complete: useCallback(() => close('completed'), [close]),
    dismiss: useCallback(() => close('dismissed'), [close]),
  }
}
