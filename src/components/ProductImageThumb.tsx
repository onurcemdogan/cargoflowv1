import { useState } from 'react'

// Tüm görünümlerin ortak ürün görseli: sıralı aday listesini dener,
// onError'da bir SONRAKİ adaya geçer (sonsuz döngü yok — liste tekil ve
// index yalnız ileri gider), aday kalmazsa sade placeholder gösterir.
// Görsel yüklenememesi hiçbir operasyonel akışı (create/print) etkilemez.
interface ProductImageThumbProps {
  candidates: string[]
  alt: string
  className?: string
  placeholderClassName?: string
  placeholderText?: string
}

export function ProductImageThumb({
  candidates,
  alt,
  className,
  placeholderClassName = 'order-image-placeholder',
  placeholderText = 'Görsel yok',
}: ProductImageThumbProps) {
  const candidatesKey = candidates.join('|')
  // Aday listesi değişince index'i render sırasında sıfırla (React'in
  // önerdiği "adjust state during render" deseni; effect'e gerek yok).
  const [imageState, setImageState] = useState({
    key: candidatesKey,
    index: 0,
  })
  if (imageState.key !== candidatesKey) {
    setImageState({ key: candidatesKey, index: 0 })
  }
  const candidateIndex =
    imageState.key === candidatesKey ? imageState.index : 0
  const src = candidates[candidateIndex]
  if (!src) {
    return (
      <span
        className={placeholderClassName}
        title={placeholderText}
        data-image-state="placeholder"
        data-image-load-error="true"
      >
        {placeholderText}
      </span>
    )
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      data-image-state="loaded-candidate"
      data-image-load-error="false"
      data-image-candidate-index={candidateIndex}
      onError={() =>
        setImageState((state) => ({
          key: candidatesKey,
          index: state.index + 1,
        }))
      }
    />
  )
}
