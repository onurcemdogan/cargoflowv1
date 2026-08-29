// ROTA İSKELETİ — YEREL, GLOBAL DEĞİL.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
// Rota kodu talep üzerine geldiğinde ekranın TAMAMI boşalmamalıdır. Global
// bir "yükleniyor" katmanı, uygulama kabuğunu ve gezinmeyi de gizler ve
// algılanan hız DAHA KÖTÜ olur.
//
// Bu iskelet YALNIZ içerik alanını kaplar: kabuk, menü ve başlık görünür
// kalır; kullanıcı nerede olduğunu KAYBETMEZ.

export function RouteSkeleton() {
  return (
    <section className="route-skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">Sayfa yükleniyor…</span>
      <div className="route-skeleton-bar route-skeleton-title" />
      <div className="route-skeleton-grid">
        <div className="route-skeleton-card" />
        <div className="route-skeleton-card" />
        <div className="route-skeleton-card" />
      </div>
      <div className="route-skeleton-bar" />
      <div className="route-skeleton-bar" />
      <div className="route-skeleton-bar route-skeleton-short" />
    </section>
  )
}
