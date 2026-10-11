// TANITIM SAYFASI HAREKET SİSTEMİ — CSS + IntersectionObserver.
//
// Hareket dili referans tasarım sisteminden alınır: tek easing
// (cubic-bezier(.16, 1, .3, 1)), 1 sn'lik reveal (opacity + translate),
// durum değişimleriyle ilerleyen ürün sahneleri. Sürekli (sonsuz) CSS
// animasyonu YOKTUR: sahneler yalnız GÖRÜNÜRKEN, zamanlayıcıyla durum
// değiştirir; ekran dışında ve `prefers-reduced-motion` altında durur.
import { useEffect, useRef, useState, type RefObject } from 'react'

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Kök altındaki `.landing-reveal` öğelerine görünür olduklarında `is-in` ekler. */
export function useRevealRoot(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current
    if (!element) return
    const targets = [...element.querySelectorAll<HTMLElement>('.landing-reveal')]
    if (typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) {
      for (const target of targets) target.classList.add('is-in')
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in')
            observer.unobserve(entry.target)
          }
        }
      },
      // Eşik 0: uzun (mobil) sahneler de görünür alana girer girmez açılır.
      { rootMargin: '0px 0px -10% 0px', threshold: 0 },
    )
    for (const target of targets) observer.observe(target)
    return () => observer.disconnect()
  }, [root])
}

/** Öğe ekrandayken `true`. IntersectionObserver yoksa hiç canlanmaz. */
export function useInView<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: '-15% 0px -15% 0px',
      threshold: 0,
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, inView]
}

/**
 * Ürün sahnesinin durum döngüsü. Görünürken `durations[i]` ms sonra bir
 * sonraki duruma geçer ve başa döner. Hareket azaltma tercihinde ya da
 * görünmezken `restingStep` (sahnenin anlatım açısından tam hâli) gösterilir.
 */
export function useSceneCycle(durations: readonly number[], active: boolean, restingStep: number) {
  const [step, setStep] = useState(0)
  const [reduced] = useState(prefersReducedMotion)
  const running = active && !reduced
  const stepRef = useRef(0)

  useEffect(() => {
    if (!running) return
    let timer = 0
    // Durum YALNIZ zamanlayıcı geri çağrısında değişir; görünürlüğe dönünce
    // sahne kaldığı adımdan devam eder.
    const schedule = (index: number) => {
      timer = window.setTimeout(() => {
        const next = (index + 1) % durations.length
        stepRef.current = next
        setStep(next)
        schedule(next)
      }, durations[index])
    }
    schedule(stepRef.current)
    return () => window.clearTimeout(timer)
  }, [running, durations])

  return running ? step : restingStep
}

/**
 * Kaydırmaya bağlı kelime aydınlatma: bölüm görünür alanda ilerledikçe
 * yanan kelime sayısı. Hareket azaltma tercihinde tümü yanar.
 */
export function useScrollWords<T extends HTMLElement>(wordCount: number): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [lit, setLit] = useState(() =>
    typeof IntersectionObserver === 'undefined' || prefersReducedMotion() ? wordCount : 0,
  )
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) return
    let frame = 0
    const measure = () => {
      frame = 0
      const rect = element.getBoundingClientRect()
      const viewport = window.innerHeight || 1
      // Paragraf görünür alanın %85'ine girince başlar, %35'ine gelince biter.
      const progress = (viewport * 0.85 - rect.top) / (viewport * 0.5 + rect.height * 0.5)
      setLit(Math.max(0, Math.min(wordCount, Math.round(progress * wordCount))))
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        window.addEventListener('scroll', onScroll, { passive: true })
        measure()
      } else {
        window.removeEventListener('scroll', onScroll)
      }
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [wordCount])
  return [ref, lit]
}
