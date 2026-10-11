// TANITIM SAYFASI ÜRÜN SAHNELERİ — CargoFlow arayüz + illüstrasyon hibriti.
//
// Her sahne süs niteliğindedir (`aria-hidden`); anlam metinde taşınır. Tüm
// sipariş, kişi, adres ve gönderi numaraları TEMSİLİDİR. Sahneler
// `useSceneCycle` ile YALNIZ görünürken durum değiştirir; hareket azaltma
// tercihinde anlatımın tam hâli (son adım) durağan gösterilir.
import type { CSSProperties, ReactNode } from 'react'
import {
  Bell,
  Check,
  ClipboardList,
  Image,
  LayoutDashboard,
  Minus,
  Package,
  PackageSearch,
  Plug,
  QrCode,
  ScanBarcode,
  Tag,
  Truck,
  Type,
  UserRound,
} from 'lucide-react'
import { INTEGRATION_STATUS_LABEL, LANDING_INTEGRATIONS, type IntegrationStatus } from './landingContent'
import { useInView, useSceneCycle } from './landingMotion'

/* ═══ ORTAK PARÇALAR ═══════════════════════════════════════════════════ */

type Tone = 'success' | 'info' | 'warning' | 'label' | 'error' | 'neutral'

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <i className={`landing-pill tone-${tone}`}>{children}</i>
}

function Spinner() {
  return <i className="landing-spinner" />
}

/** Belirlenimci barkod çubukları (aynı tohum → aynı desen). */
function barWidths(seed: string, count: number): number[] {
  let state = 0
  for (const char of seed) state = (state * 31 + char.charCodeAt(0)) >>> 0
  const widths: number[] = []
  for (let i = 0; i < count; i += 1) {
    state = (state * 1103515245 + 12345) >>> 0
    widths.push(1 + (state % 3))
  }
  return widths
}

function barLayout(seed: string, count: number): { rects: { x: number; w: number; i: number }[]; width: number } {
  const rects: { x: number; w: number; i: number }[] = []
  let x = 0
  barWidths(seed, count).forEach((w, i) => {
    rects.push({ x, w, i })
    x += w + (i % 2 === 0 ? 1 : 2)
  })
  return { rects, width: x }
}

function Barcode({ seed, bars = 46, revealed }: { seed: string; bars?: number; revealed: boolean }) {
  const { rects, width } = barLayout(seed, bars)
  return (
    <svg
      className={revealed ? 'landing-barcode is-on' : 'landing-barcode'}
      viewBox={`0 0 ${width} 40`}
      preserveAspectRatio="none"
    >
      {rects.map((r) => (
        <rect key={r.i} x={r.x} y="0" width={r.w} height="40" style={{ transitionDelay: `${r.i * 18}ms` }} />
      ))}
    </svg>
  )
}

const SCENE_NAV = [
  { icon: LayoutDashboard, label: 'Dashboard' },
  { icon: ClipboardList, label: 'Siparişler', active: true },
  { icon: PackageSearch, label: 'Ürünler' },
  { icon: Truck, label: 'Kargo İşlemleri' },
  { icon: Tag, label: 'Etiket Şablonları' },
  { icon: Plug, label: 'Entegrasyonlar' },
] as const

const TIMELINE = ['Sipariş Alındı', 'Etiket Hazır', 'Kargoya Verildi', 'Transferde', 'Teslim Edildi'] as const

/* ═══ HERO — Siparişler penceresi + yaşayan parçalar ═══════════════════ */

// 0 yeni sipariş geliyor · 1 senkronize · 2 gönderi oluşturuluyor ·
// 3 gönderi oluştu + barkod · 4 etiket hazır · 5 kargoya verildi ·
// 6 transferde · 7 teslim edildi
const HERO_STEPS = [1500, 1500, 2100, 1700, 1700, 1500, 1500, 2600] as const
const HERO_REST = 7

const HERO_ROWS: ReadonlyArray<{ ref: string; name: string; status: string; tone: Tone }> = [
  { ref: '#TY123456', name: 'Ayşe Yılmaz', status: 'Barkod Bekliyor', tone: 'warning' },
  { ref: '#TY123457', name: 'Mehmet Demir', status: 'Etiket Hazır', tone: 'label' },
  { ref: '#TY123458', name: 'Zeynep Kaya', status: 'Kargoya Verildi', tone: 'success' },
]

function heroNewRowStatus(step: number): { status: string; tone: Tone } {
  if (step <= 1) return { status: 'Hazırlanıyor', tone: 'neutral' }
  if (step <= 3) return { status: 'Barkod Bekliyor', tone: 'warning' }
  if (step === 4) return { status: 'Etiket Hazır', tone: 'label' }
  return { status: 'Kargoya Verildi', tone: 'success' }
}

export function HeroScene() {
  const [ref, inView] = useInView<HTMLElement>()
  const step = useSceneCycle(HERO_STEPS, inView, HERO_REST)
  const timelineIndex = step <= 3 ? 0 : step - 3
  const newRow = heroNewRowStatus(step)

  return (
    <figure className="landing-scene landing-reveal d3" ref={ref}>
      <div className="landing-scene-window" aria-hidden="true">
        <div className="landing-app">
          <div className="landing-app-side">
            <div className="landing-app-brand">
              <img src="/favicon.png" alt="" width={22} height={22} />
              <b>CargoFlow</b>
            </div>
            {SCENE_NAV.map((item) => (
              <div key={item.label} className={'active' in item ? 'landing-app-nav is-active' : 'landing-app-nav'}>
                <item.icon size={15} strokeWidth={1.9} aria-hidden />
                {item.label}
              </div>
            ))}
          </div>
          <div className="landing-app-main">
            <div className="landing-app-head">
              <span>
                <b>Siparişler</b>
                <small>Trendyol · bugün</small>
              </span>
              <i className="landing-badge landing-badge-market">Trendyol</i>
            </div>
            <div className="landing-app-tabs">
              <span className="is-active">Tümü</span>
              <span>Barkod Bekliyor</span>
              <span>Etiket Hazır</span>
              <span>Kargoya Verildi</span>
            </div>
            <div className="landing-app-rows">
              {HERO_ROWS.map((row, index) => (
                <div key={row.ref} className={index === 0 ? 'landing-app-row is-selected' : 'landing-app-row'}>
                  <span className="landing-avatar">{row.name.charAt(0)}</span>
                  <span className="landing-app-order">
                    <b>{row.name}</b>
                    <small>{row.ref}</small>
                  </span>
                  <i className="landing-badge landing-badge-market">Trendyol</i>
                  <Pill tone={row.tone}>{row.status}</Pill>
                  <i className="landing-badge landing-badge-carrier">Sürat Kargo</i>
                </div>
              ))}
              <div className={step >= 1 ? 'landing-app-row is-new is-on' : 'landing-app-row is-new'}>
                <span className="landing-avatar">E</span>
                <span className="landing-app-order">
                  <b>Elif Şahin</b>
                  <small>#TY123459</small>
                </span>
                <i className="landing-badge landing-badge-market">Trendyol</i>
                <Pill tone={newRow.tone}>{newRow.status}</Pill>
                <i className="landing-badge landing-badge-carrier">Sürat Kargo</i>
              </div>
            </div>
            <div className="landing-app-foot">
              <span>1 sipariş seçili</span>
              <i className="landing-btn-ui is-primary">Gönderi Oluştur</i>
            </div>
          </div>
        </div>

        {/* A — yeni sipariş bildirimi */}
        <div className="landing-float landing-float-order">
          <span className="landing-float-icon is-blue">
            <Bell size={15} strokeWidth={2} aria-hidden />
          </span>
          <span className="landing-float-text">
            <b>Yeni sipariş</b>
            <small>#TY123459 · Trendyol</small>
          </span>
          {step === 0 ? (
            <span className="landing-state">
              <Spinner />
              Alınıyor…
            </span>
          ) : (
            <span className="landing-state is-done">
              <Check size={13} strokeWidth={2.6} aria-hidden />
              Senkronize edildi
            </span>
          )}
        </div>

        {/* B — gönderi oluşturuluyor */}
        <div className="landing-float landing-float-ship">
          <div className="landing-float-row">
            <span className="landing-float-icon">
              <Truck size={15} strokeWidth={2} aria-hidden />
            </span>
            <b>Sürat Kargo</b>
          </div>
          {step < 3 ? (
            <>
              <small>{step === 2 ? 'Gönderi oluşturuluyor…' : 'Gönderi sırada'}</small>
              <div className="landing-progress">
                <i style={{ width: step === 2 ? '100%' : step === 1 ? '18%' : '6%' } as CSSProperties} />
              </div>
            </>
          ) : (
            <>
              <span className="landing-state is-done">
                <Check size={13} strokeWidth={2.6} aria-hidden />
                Gönderi oluşturuldu
              </span>
              <small className="landing-mono">SRT-4821-7730</small>
            </>
          )}
        </div>

        {/* C — barkod / etiket */}
        <div className="landing-float landing-float-label">
          <div className="landing-mini-label">
            <div className="landing-mini-label-head">
              <b>SÜRAT KARGO</b>
              <span>100×100</span>
            </div>
            {step < 3 ? (
              <div className="landing-barcode-wait">Barkod hazırlanıyor</div>
            ) : (
              <Barcode seed="TY123459" bars={38} revealed />
            )}
            <span className="landing-mono">#TY123459</span>
          </div>
          {step >= 4 ? <Pill tone="label">Etiket Hazır</Pill> : <Pill tone="neutral">Etiket bekleniyor</Pill>}
        </div>

        {/* D — takip */}
        <div className="landing-float landing-float-track">
          <small className="landing-caps">Takip · #TY123459</small>
          <ol className="landing-mini-timeline">
            {TIMELINE.map((label, index) => (
              <li
                key={label}
                className={index < timelineIndex ? 'is-done' : index === timelineIndex ? 'is-current' : undefined}
              >
                {label}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <figcaption>Temsili ekran · örnek veriler</figcaption>
    </figure>
  )
}

/* ═══ 1 — SİPARİŞ SENKRONİZASYONU ═══════════════════════════════════════ */

const SYNC_STEPS = [1300, 1300, 1300, 2600] as const
const SYNC_ROWS = [
  { ref: '#TY123456', name: 'Ayşe Yılmaz', items: '2 ürün' },
  { ref: '#TY123457', name: 'Mehmet Demir', items: '1 ürün' },
  { ref: '#TY123458', name: 'Zeynep Kaya', items: '3 ürün' },
] as const

function SyncScene({ step }: { step: number }) {
  return (
    <div className="landing-stage landing-stage-sync">
      <div className="landing-source">
        <span className="landing-source-mark">T</span>
        <span>
          <b>Trendyol</b>
          <small>Mağaza hesabı</small>
        </span>
      </div>
      <svg className="landing-wire" viewBox="0 0 120 80" preserveAspectRatio="none">
        <path d="M0 40 C 50 40, 70 40, 120 40" className="landing-wire-base" />
        <path d="M0 40 C 50 40, 70 40, 120 40" className={step < 3 ? 'landing-wire-flow is-on' : 'landing-wire-flow'} key={step} />
      </svg>
      <div className="landing-card landing-card-sync">
        <div className="landing-card-head">
          <span>
            <b>Yeni siparişler</b>
            <small>CargoFlow · Siparişler</small>
          </span>
          <Pill tone="info">{Math.min(step + 1, 3)} / 3</Pill>
        </div>
        {SYNC_ROWS.map((row, index) => {
          const done = index < step
          const busy = index === step
          return (
            <div key={row.ref} className={done ? 'landing-sync-row is-done' : 'landing-sync-row'}>
              <span className="landing-avatar">{row.name.charAt(0)}</span>
              <span className="landing-app-order">
                <b>{row.ref}</b>
                <small>
                  {row.name} · {row.items}
                </small>
              </span>
              {done ? (
                <span className="landing-state is-done">
                  <Check size={13} strokeWidth={2.6} aria-hidden />
                  Senkronize edildi
                </span>
              ) : busy ? (
                <span className="landing-state">
                  <Spinner />
                  Alınıyor…
                </span>
              ) : (
                <span className="landing-state is-idle">Sırada</span>
              )}
            </div>
          )
        })}
      </div>
      <div className={step >= 3 ? 'landing-chip-float is-on' : 'landing-chip-float'}>
        <Check size={13} strokeWidth={2.6} aria-hidden />3 sipariş kargoya hazır
      </div>
    </div>
  )
}

/* ═══ 2 — KARGO İŞLEMLERİ ═══════════════════════════════════════════════ */

const CARGO_STEPS = [1500, 1700, 2800] as const

function PackageArt({ labelled }: { labelled: boolean }) {
  return (
    <svg className="landing-package" viewBox="0 0 220 200">
      <polygon points="110,20 200,62 110,104 20,62" className="landing-box-top" />
      <polygon points="20,62 110,104 110,190 20,148" className="landing-box-left" />
      <polygon points="200,62 110,104 110,190 200,148" className="landing-box-right" />
      <polygon points="65,41 155,83 155,96 65,54" className="landing-box-tape" />
      <g className={labelled ? 'landing-box-label is-on' : 'landing-box-label'}>
        <polygon points="125,118 185,90 185,130 125,158" />
        <line x1="133" y1="126" x2="177" y2="106" />
        <line x1="133" y1="134" x2="177" y2="114" />
        <line x1="133" y1="142" x2="165" y2="127" />
      </g>
    </svg>
  )
}

function CargoScene({ step }: { step: number }) {
  return (
    <div className="landing-stage landing-stage-cargo">
      <div className="landing-backplate" />
      <PackageArt labelled={step >= 2} />
      <div className="landing-card landing-card-form">
        <div className="landing-card-head">
          <span>
            <b>Gönderi oluştur</b>
            <small>#TY123456</small>
          </span>
          <i className="landing-badge landing-badge-carrier">Sürat Kargo</i>
        </div>
        <dl className="landing-fields">
          <div>
            <dt>Alıcı</dt>
            <dd>Ayşe Yılmaz</dd>
          </div>
          <div>
            <dt>Adres</dt>
            <dd>Kadıköy / İstanbul</dd>
          </div>
          <div>
            <dt>Desi</dt>
            <dd>2</dd>
          </div>
        </dl>
        <i className={`landing-btn-ui is-primary is-wide${step === 1 ? ' is-busy' : ''}${step === 2 ? ' is-ok' : ''}`}>
          {step === 0 ? 'Gönderi Oluştur' : null}
          {step === 1 ? (
            <>
              <Spinner />
              Oluşturuluyor…
            </>
          ) : null}
          {step === 2 ? (
            <>
              <Check size={14} strokeWidth={2.6} aria-hidden />
              Gönderi oluşturuldu
            </>
          ) : null}
        </i>
      </div>
      <div className={step >= 2 ? 'landing-chip-float is-on landing-chip-ship' : 'landing-chip-float landing-chip-ship'}>
        Gönderi No <b className="landing-mono">SRT-4821-7730</b>
      </div>
    </div>
  )
}

/* ═══ 3 — BARKOD / ETİKET ═══════════════════════════════════════════════ */

const LABEL_STEPS = [1100, 1900, 2800] as const

function LabelScene({ step }: { step: number }) {
  const meta = [
    { key: 'order', label: 'Sipariş No', value: '#TY123456' },
    { key: 'ship', label: 'Gönderi No', value: 'SRT-4821-7730' },
    { key: 'name', label: 'Alıcı', value: 'Ayşe Yılmaz' },
    { key: 'addr', label: 'Adres', value: 'Kadıköy / İstanbul' },
  ]
  return (
    <div className="landing-stage landing-stage-label">
      <div className="landing-label-big">
        <div className="landing-mini-label-head">
          <b>SÜRAT KARGO</b>
          <span>100×100</span>
        </div>
        <div className="landing-label-barcode">
          {step === 0 ? <div className="landing-barcode-wait">Barkod hazırlanıyor</div> : <Barcode seed="SRT48217730" bars={58} revealed={step >= 1} />}
          <span className="landing-mono">SRT-4821-7730</span>
        </div>
        <dl className="landing-label-fields">
          {meta.map((item) => (
            <div key={item.key}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
        <div className="landing-label-foot">
          <span>Desi 2</span>
          <span>1/1</span>
        </div>
      </div>
      {meta.map((item, index) => (
        <div
          key={item.key}
          className={step >= 1 ? `landing-meta landing-meta-${item.key} is-on` : `landing-meta landing-meta-${item.key}`}
          style={{ transitionDelay: `${index * 120}ms` } as CSSProperties}
        >
          <small>{item.label}</small>
          <b>{item.value}</b>
        </div>
      ))}
      <div className={step >= 2 ? 'landing-chip-float is-on landing-chip-label' : 'landing-chip-float landing-chip-label'}>
        <Check size={13} strokeWidth={2.6} aria-hidden />
        Etiket Hazır
      </div>
    </div>
  )
}

/* ═══ 4 — ETİKET ŞABLONLARI ═════════════════════════════════════════════ */

const TEMPLATE_STEPS = [1800, 1800, 1600, 1600] as const
const TEMPLATE_TOOLS = [
  { key: 'text', label: 'Metin', icon: Type },
  { key: 'barcode', label: 'Barkod', icon: ScanBarcode },
  { key: 'qr', label: 'QR Kod', icon: QrCode },
  { key: 'line', label: 'Çizgi', icon: Minus },
  { key: 'logo', label: 'Logo', icon: Image },
  { key: 'recipient', label: 'Alıcı Bilgisi', icon: UserRound },
] as const
const TEMPLATE_ORDER = ['barcode', 'recipient', 'qr', 'text'] as const
const TEMPLATE_PROPS: Record<string, { name: string; a: string; b: string }> = {
  barcode: { name: 'Barkod', a: 'Code 128', b: 'Gönderi No' },
  recipient: { name: 'Alıcı Bilgisi', a: 'Ad · Adres', b: '11 pt' },
  qr: { name: 'QR Kod', a: 'Takip bağlantısı', b: '22 mm' },
  text: { name: 'Metin', a: 'Sipariş No', b: '12 pt' },
}

function TemplateScene({ step }: { step: number }) {
  const selected = TEMPLATE_ORDER[step]
  const props = TEMPLATE_PROPS[selected]
  const sel = (key: string) => (selected === key ? ' is-selected' : '')
  return (
    <div className="landing-stage landing-stage-templates">
      <div className="landing-card landing-card-editor">
        <div className="landing-toolbar">
          {TEMPLATE_TOOLS.map((tool) => (
            <span key={tool.key} className={selected === tool.key ? 'is-active' : undefined}>
              <tool.icon size={14} strokeWidth={2} aria-hidden />
              {tool.label}
            </span>
          ))}
        </div>
        <div className="landing-editor-body">
          <div className="landing-canvas">
            <div className="landing-canvas-label">
              <div className={`landing-el landing-el-logo${sel('logo')}`}>
                <Package size={14} strokeWidth={2} aria-hidden />
                MAĞAZA
              </div>
              <div className={`landing-el landing-el-text${sel('text')}`}>#TY123456</div>
              <div className={`landing-el landing-el-line${sel('line')}`} />
              <div className={`landing-el landing-el-barcode${sel('barcode')}`}>
                <Barcode seed="TEMPLATE" bars={40} revealed />
              </div>
              <div className={`landing-el landing-el-qr${sel('qr')}`}>
                <QrCode size={34} strokeWidth={1.6} aria-hidden />
              </div>
              <div className={`landing-el landing-el-recipient${sel('recipient')}`}>
                <b>Ayşe Yılmaz</b>
                <span>Kadıköy / İstanbul</span>
              </div>
            </div>
          </div>
          <div className="landing-props">
            <small className="landing-caps">Seçili alan</small>
            <b>{props.name}</b>
            <p>
              <span>Kaynak</span>
              {props.a}
            </p>
            <p>
              <span>Ayar</span>
              {props.b}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ═══ 5 — TAKİP ═════════════════════════════════════════════════════════ */

const TRACK_STEPS = [1400, 1400, 1400, 1400, 2800] as const
const TRACK_NODES = [
  { label: 'Etiket Hazır', x: 8, y: 74 },
  { label: 'Kargoya Verildi', x: 30, y: 38 },
  { label: 'Transfer Sürecinde', x: 52, y: 62 },
  { label: 'Dağıtımda', x: 74, y: 28 },
  { label: 'Teslim Edildi', x: 92, y: 50 },
] as const
const TRACK_PATH = 'M8 74 C 18 74, 20 38, 30 38 S 44 62, 52 62 S 66 28, 74 28 S 86 50, 92 50'

function TrackingScene({ step }: { step: number }) {
  const node = TRACK_NODES[step]
  return (
    <div className="landing-stage landing-stage-track">
      <div className="landing-card landing-card-track">
        <div className="landing-card-head">
          <span>
            <b>#TY123456 · Ayşe Yılmaz</b>
            <small className="landing-mono">SRT-4821-7730</small>
          </span>
          <Pill tone={step === 4 ? 'success' : 'info'}>{TRACK_NODES[step].label}</Pill>
        </div>
        <div className="landing-route">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <path d={TRACK_PATH} className="landing-route-base" />
            <path
              d={TRACK_PATH}
              className="landing-route-done"
              pathLength={100}
              style={{ strokeDashoffset: 100 - step * 25 } as CSSProperties}
            />
          </svg>
          {TRACK_NODES.map((item, index) => (
            <span
              key={item.label}
              className={index <= step ? 'landing-route-node is-done' : 'landing-route-node'}
              style={{ left: `${item.x}%`, top: `${item.y}%` } as CSSProperties}
            >
              <em>{item.label}</em>
            </span>
          ))}
          <span className="landing-route-package" style={{ left: `${node.x}%`, top: `${node.y}%` } as CSSProperties}>
            <Package size={14} strokeWidth={2.2} aria-hidden />
          </span>
        </div>
        <ol className="landing-timeline">
          {TRACK_NODES.map((item, index) => (
            <li key={item.label} className={index < step ? 'is-done' : index === step ? 'is-current' : undefined}>
              <i />
              <span>{item.label}</span>
              <small>{index <= step ? ['09:12', '11:40', '18:05', '08:31', '13:47'][index] : '—'}</small>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

/* ═══ 6 — BAĞLANTI SAĞLIĞI ══════════════════════════════════════════════ */

const HEALTH_STEPS = [1200, 1200, 1200, 2800] as const
const HEALTH_NAMES = ['Trendyol', 'Sürat Kargo', 'WooCommerce', 'Aras Kargo'] as const
const HEALTH_ACTIVITY = [
  { time: '09:42', text: 'Sipariş senkronizasyonu tamamlandı' },
  { time: '09:43', text: '12 sipariş alındı' },
  { time: '09:44', text: 'Sürat Kargo bağlantısı kontrol edildi' },
] as const

const STATUS_TONE: Record<IntegrationStatus, Tone> = {
  live: 'success',
  internal_test: 'warning',
  in_development: 'neutral',
}

function integrationStatus(name: string): IntegrationStatus {
  return LANDING_INTEGRATIONS.find((item) => item.name === name)?.status ?? 'in_development'
}

function HealthScene({ step }: { step: number }) {
  return (
    <div className="landing-stage landing-stage-health">
      <div className="landing-card landing-card-health">
        <div className="landing-card-head">
          <span>
            <b>Bağlantı sağlığı</b>
            <small>Hesap bazında durum</small>
          </span>
        </div>
        {HEALTH_NAMES.map((name) => {
          const status = integrationStatus(name)
          return (
            <div key={name} className="landing-health-row" data-integration={name} data-status={status}>
              <span className="landing-source-mark is-small">{name.charAt(0).toUpperCase()}</span>
              <b>{name}</b>
              <span className={`landing-status tone-${STATUS_TONE[status]}`}>
                {status === 'live' ? <i className="landing-ping" key={step} /> : null}
                {INTEGRATION_STATUS_LABEL[status]}
              </span>
            </div>
          )
        })}
      </div>
      <div className="landing-card landing-card-activity">
        <small className="landing-caps">Etkinlik</small>
        {HEALTH_ACTIVITY.map((item, index) => (
          <p key={item.time} className={index < step ? 'is-on' : undefined}>
            <span className="landing-mono">{item.time}</span>
            {item.text}
          </p>
        ))}
      </div>
    </div>
  )
}

/* ═══ ÖZELLİK SAHNESİ SEÇİCİ ════════════════════════════════════════════ */

const SCENES = {
  sync: { steps: SYNC_STEPS, rest: 3, Component: SyncScene },
  cargo: { steps: CARGO_STEPS, rest: 2, Component: CargoScene },
  label: { steps: LABEL_STEPS, rest: 2, Component: LabelScene },
  templates: { steps: TEMPLATE_STEPS, rest: 0, Component: TemplateScene },
  tracking: { steps: TRACK_STEPS, rest: 4, Component: TrackingScene },
  health: { steps: HEALTH_STEPS, rest: 3, Component: HealthScene },
} as const

export function FeatureScene({ scene }: { scene: keyof typeof SCENES }) {
  const [ref, inView] = useInView<HTMLDivElement>()
  const { steps, rest, Component } = SCENES[scene]
  const step = useSceneCycle(steps, inView, rest)
  return (
    <div className="landing-feature-visual landing-reveal d2" ref={ref} aria-hidden="true">
      <Component step={step} />
    </div>
  )
}

/* ═══ GÜVENİLİRLİK — belirsizlikte durur ════════════════════════════════ */

const GUARD_STEPS = [1200, 1200, 1500, 3200] as const
const GUARD_FLOW = ['Sipariş', 'Doğrulama', 'Hata tespit edildi', 'Akış durduruldu'] as const

export function GuardScene() {
  const [ref, inView] = useInView<HTMLDivElement>()
  const step = useSceneCycle(GUARD_STEPS, inView, 3)
  return (
    <div className="landing-feature-visual landing-reveal d2" ref={ref} aria-hidden="true">
      <div className="landing-stage landing-stage-guard">
        <div className="landing-guard-bg">
          {[
            ['#TY123456', 'Etiket Hazır', 'label'],
            ['#TY123457', 'Kargoya Verildi', 'success'],
            ['#TY123458', 'Etiket Basıldı', 'info'],
          ].map(([ref2, status, tone]) => (
            <div key={ref2} className="landing-guard-row">
              <span className="landing-mono">{ref2}</span>
              <Pill tone={tone as Tone}>{status}</Pill>
            </div>
          ))}
        </div>
        <ol className="landing-flow">
          {GUARD_FLOW.map((label, index) => (
            <li
              key={label}
              className={
                index > step
                  ? undefined
                  : index >= 2
                    ? 'is-error'
                    : 'is-done'
              }
            >
              <i />
              {label}
            </li>
          ))}
        </ol>
        <div className={step >= 2 ? 'landing-alert is-on' : 'landing-alert'}>
          <div className="landing-alert-head">
            <b>Gönderi oluşturulmadı</b>
            <Pill tone="error">Kontrol Gerekli</Pill>
          </div>
          <dl className="landing-fields">
            <div>
              <dt>Sipariş</dt>
              <dd>#TY123459</dd>
            </div>
            <div>
              <dt>Sorun</dt>
              <dd>Adres bilgisi eksik.</dd>
            </div>
          </dl>
          <i className="landing-btn-ui is-dark">Kontrol Et</i>
        </div>
      </div>
    </div>
  )
}

/* ═══ ENTEGRASYON MERKEZİ ═══════════════════════════════════════════════ */

const HUB_STEPS = [1400, 1400, 2400] as const
const HUB_LAYOUT: Record<string, { x: number; y: number }> = {
  Trendyol: { x: 18, y: 24 },
  'Sürat Kargo': { x: 82, y: 24 },
  WooCommerce: { x: 14, y: 60 },
  'Aras Kargo': { x: 50, y: 96 },
  Hepsiburada: { x: 22, y: 84 },
  n11: { x: 78, y: 84 },
  Ticimax: { x: 50, y: 8 },
}

export function IntegrationHub() {
  const [ref, inView] = useInView<HTMLDivElement>()
  const step = useSceneCycle(HUB_STEPS, inView, 2)
  return (
    <div className="landing-hub landing-reveal d2" ref={ref} aria-hidden="true">
      <svg className="landing-hub-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        {LANDING_INTEGRATIONS.map((item) => {
          const at = HUB_LAYOUT[item.name]
          return <line key={item.name} x1="50" y1="50" x2={at.x} y2={at.y} className={`landing-hub-line status-${item.status}`} />
        })}
      </svg>
      {LANDING_INTEGRATIONS.filter((item) => item.status === 'live').map((item) => {
        const at = HUB_LAYOUT[item.name]
        return (
          <i
            key={item.name}
            className={step >= 1 ? 'landing-hub-pulse is-on' : 'landing-hub-pulse'}
            style={{ '--from-x': `${at.x}%`, '--from-y': `${at.y}%` } as CSSProperties}
          />
        )
      })}
      <div className="landing-hub-core">
        <img src="/favicon.png" alt="" width={40} height={40} />
        <b>CargoFlow</b>
      </div>
      {LANDING_INTEGRATIONS.map((item) => {
        const at = HUB_LAYOUT[item.name]
        return (
          <div
            key={item.name}
            className={`landing-hub-node status-${item.status}`}
            style={{ left: `${at.x}%`, top: `${at.y}%` } as CSSProperties}
            data-integration={item.name}
            data-status={item.status}
          >
            <b>{item.name}</b>
            <span className={`landing-status tone-${STATUS_TONE[item.status]}`}>{INTEGRATION_STATUS_LABEL[item.status]}</span>
          </div>
        )
      })}
    </div>
  )
}
