import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LEGACY_DEBUG_STORAGE_KEY,
  TRACE_STORAGE_KEY, type StoredTrace, selectCurrentTrace,
  selectValidTraces, sortTracesNewestFirst,
} from '../services/suratTraceDebugStore'
import {
  LIVE_DEBUG_TABS, buildLiveDebugViewModel, buildTraceableUserError,
  describeWireWhoPaysForDisplay,
} from '../debug/suratLiveDebugViewModel'

// CANLI DEBUG V3.
//
// Tek kaynak Trace V2'dir. Bu bileşen ilgisiz shipment_operations satırlarını,
// eski JSON loglarını veya localStorage v1 kayıtlarını BİRLEŞTİRMEZ.
//
// ÖLÇÜLEN KUSUR: iz eskiden YALNIZ localStorage'da aranıyordu ama oraya HİÇ
// yazılmıyordu (yazıcının çağıranı yoktu). Gerçek bir denemeden sonra bile
// ekran boştu. Artık kaynak SUNUCUDUR; sayfa yenilense de deneme durur.
// localStorage yalnız GERİYE DÖNÜK okuma için kalır, tek doğru kaynak DEĞİL.

const TRACES_ENDPOINT = '/api/debug/surat-traces'

/** Sunucudaki kiracı kapsamlı iz geçmişi. */
async function fetchServerTraces(): Promise<unknown> {
  try {
    const response = await fetch(TRACES_ENDPOINT, { credentials: 'include' })
    if (!response.ok) return []
    const body = await response.json()
    return Array.isArray(body?.traces) ? body.traces : []
  } catch {
    return []
  }
}

function Rows({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data)
  if (entries.length === 0) {
    return <p className="integration-hint">Kayıt yok.</p>
  }
  return (
    <dl className="surat-debug-rows">
      {entries.map(([key, value]) => (
        <div key={key} className="surat-debug-row">
          <dt>{key}</dt>
          <dd>{typeof value === 'object' && value !== null
            ? JSON.stringify(value)
            : String(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Depodan okur; test/kontrollü kullanımda `traces` doğrudan verilebilir. */
function readStoredTraces(): unknown {
  try {
    return JSON.parse(
      globalThis.localStorage?.getItem(TRACE_STORAGE_KEY) ?? '[]',
    )
  } catch {
    return []
  }
}

export function SuratLiveDebugPanel({ traces }: { traces?: unknown }) {
  const [serverTraces, setServerTraces] = useState<unknown | null>(null)
  const [clearing, setClearing] = useState(false)
  // Testler/kontrollü kullanım `traces` verebilir; aksi hâlde SUNUCU okunur ve
  // sunucu boşsa geriye dönük olarak yerel depo denenir.
  const source = traces ?? serverTraces ?? readStoredTraces()
  const [tab, setTab] = useState<(typeof LIVE_DEBUG_TABS)[number]>('Son Deneme')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (traces !== undefined) return
    let cancelled = false
    void fetchServerTraces().then((loaded) => {
      if (!cancelled) setServerTraces(loaded)
    })
    return () => { cancelled = true }
  }, [traces])

  // TÜM DEBUG GEÇMİŞİNİ SİL — yalnız debug verisi.
  const clearAll = useCallback(async () => {
    const confirmed = globalThis.confirm?.(
      'Yalnızca debug kayıtları silinecek. '
      + 'Sipariş, gönderi, barkod ve operasyon kayıtları etkilenmeyecek.',
    )
    if (!confirmed) return
    setClearing(true)
    try {
      await fetch(TRACES_ENDPOINT, { method: 'DELETE', credentials: 'include' })
      // Doğrulanmış debug-only yerel anahtarlar da temizlenir.
      globalThis.localStorage?.removeItem(TRACE_STORAGE_KEY)
      globalThis.localStorage?.removeItem(LEGACY_DEBUG_STORAGE_KEY)
      setServerTraces([])
      setSelectedId(null)
    } finally {
      setClearing(false)
    }
  }, [])

  const clearButton = (
    <button
      type="button"
      className="surat-debug-clear"
      onClick={() => { void clearAll() }}
      disabled={clearing}
    >
      Tüm Debug Geçmişini Sil
    </button>
  )

  const history = useMemo(
    () => sortTracesNewestFirst(selectValidTraces(source)), [source],
  )
  // Seçim yapılmadıysa EN YENİ geçerli v2 izi gösterilir. Eski v1 kaydın
  // zaman damgası daha yeni olsa bile aday DEĞİLDİR.
  const active: StoredTrace | null = useMemo(() => {
    if (selectedId) {
      return history.find((item) => item.traceId === selectedId) ?? null
    }
    return selectCurrentTrace(source)
  }, [history, selectedId, source])

  const model = useMemo(() => buildLiveDebugViewModel(active), [active])

  if (!model) {
    return (
      <section className="surat-debug">
        <h3 className="integration-subheading">Canlı Debug</h3>
        <p className="integration-hint">
          Henüz bir Sürat gönderi denemesi kaydedilmedi.
        </p>
        {clearButton}
      </section>
    )
  }

  const wireWhoPays = describeWireWhoPaysForDisplay(model)
  const userError = buildTraceableUserError(model)

  return (
    <section className="surat-debug">
      <h3 className="integration-subheading">Canlı Debug</h3>
      <p className="integration-hint">
        Trace ID: <strong>{model.traceId}</strong> · {model.createdAt}
      </p>
      {clearButton}
      {userError ? (
        <p className="integration-hint integration-hint--warning">{userError}</p>
      ) : null}

      <div className="surat-debug-tabs" role="tablist">
        {LIVE_DEBUG_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? 'is-active' : undefined}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {tab === 'Son Deneme' ? (
        <>
          <h4>Beklenen / Semantik</h4>
          <Rows data={model.expected} />
          <h4>Telde Giden / Gerçek</h4>
          <p className="integration-hint">
            Wire WhoPays: <strong>{wireWhoPays.label}</strong>
            {wireWhoPays.reason ? ` · ${wireWhoPays.reason}` : ''}
          </p>
          {/* Bu bir hata DEĞİLDİR: kanonik sözleşmede WhoPays alanı yoktur. */}
          <Rows data={model.wire} />
          <h4>Preflight</h4>
          <p className="integration-hint">
            {model.preflight.passed ? 'PASS' : 'BLOCK'}
            {model.preflight.failures.length > 0
              ? ` · ${model.preflight.failures.join(', ')}` : ''}
          </p>
          <p className="integration-hint">
            Taşıyıcı çağrıldı: {model.carrierCalled ? 'evet' : 'hayır'}
          </p>
        </>
      ) : null}

      {tab === 'Karar / Mapping' ? (
        <>
          {/* Üç bağımsız alan AYRI gösterilir; biri diğerini türetmez. */}
          <h4>Fatura Tarafı</h4>
          <Rows data={model.decision.billing} />
          <h4>Ödeme</h4>
          <Rows data={model.decision.payment} />
          <h4>Kapıda Ödeme</h4>
          <Rows data={model.decision.cod} />
          <h4>Kimlik Yönlendirme</h4>
          <Rows data={model.decision.credential} />
        </>
      ) : null}

      {tab === 'Request' ? <Rows data={model.request} /> : null}

      {tab === 'Response' ? (
        <>
          <Rows data={model.response} />
          <h4>Doğrulama</h4>
          <Rows data={model.verification} />
          <h4>Sonuç</h4>
          <Rows data={model.finalResult} />
        </>
      ) : null}

      {tab === 'Geçmiş' ? (
        <ul className="surat-debug-history">
          {history.map((item) => (
            <li key={item.traceId}>
              <button type="button" onClick={() => setSelectedId(item.traceId)}>
                {item.traceId} · {item.createdAt}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
