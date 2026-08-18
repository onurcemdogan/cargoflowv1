import { useMemo, useState } from 'react'
import {
  TRACE_STORAGE_KEY, type StoredTrace, selectCurrentTrace,
  selectValidTraces, sortTracesNewestFirst,
} from '../services/suratTraceDebugStore'
import {
  LIVE_DEBUG_TABS, buildLiveDebugViewModel, buildTraceableUserError,
  describeWireWhoPaysForDisplay,
} from '../debug/suratLiveDebugViewModel'

// FAZ D — Canlı Debug.
//
// Tek kaynak Trace V2'dir. Bu bileşen ilgisiz shipment_operations satırlarını,
// eski JSON loglarını veya localStorage v1 kayıtlarını BİRLEŞTİRMEZ.

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
  const source = traces ?? readStoredTraces()
  const [tab, setTab] = useState<(typeof LIVE_DEBUG_TABS)[number]>('Son Deneme')
  const [selectedId, setSelectedId] = useState<string | null>(null)

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
