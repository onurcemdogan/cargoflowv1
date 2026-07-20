// Platform admin paneli (/admin). Sade, AppShell'den AYRI kabuk. Organization
// hesaplarını yönetir; integration secret veya raw müşteri/sipariş verisi
// GÖSTERMEZ. İşlemler backend requirePlatformAdmin ile korunur.
import { useCallback, useEffect, useState } from 'react'
import {
  adminLogout,
  fetchOrganizations,
  fetchSummary,
  resetUserPassword,
  revokeUserSessions,
  setOrganizationStatus,
  setUserStatus,
  type AdminSummary,
  type AdminUser,
  type OrganizationRow,
} from './adminApiService'
import { NewOrganizationModal } from './NewOrganizationModal'

export function AdminDashboard({
  admin,
  onLoggedOut,
}: {
  admin: AdminUser
  onLoggedOut: () => void
}) {
  const [summary, setSummary] = useState<AdminSummary | null>(null)
  const [rows, setRows] = useState<OrganizationRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const pageSize = 25

  const applyOrgData = useCallback(
    (
      summaryData: AdminSummary,
      orgData: { organizations: OrganizationRow[]; total: number; page: number },
    ) => {
      setSummary(summaryData)
      setRows(orgData.organizations)
      setTotal(orgData.total)
      setPage(orgData.page)
      setLoading(false)
    },
    [],
  )

  // Kullanıcı tetikli yükleme (arama/sayfalama/aksiyon sonrası). setLoading
  // burada olay işleyicisi bağlamında çağrılır (effect gövdesinde değil).
  const load = useCallback(
    async (nextPage: number, nextSearch: string) => {
      setLoading(true)
      const [summaryData, orgData] = await Promise.all([
        fetchSummary(),
        fetchOrganizations({ page: nextPage, pageSize, search: nextSearch }),
      ])
      applyOrgData(summaryData, orgData)
    },
    [applyOrgData],
  )

  // İlk yükleme: setState yalnız async .then içinde (effect gövdesinde senkron
  // setState yok).
  useEffect(() => {
    let active = true
    Promise.all([
      fetchSummary(),
      fetchOrganizations({ page: 1, pageSize, search: '' }),
    ])
      .then(([summaryData, orgData]) => {
        if (active) applyOrgData(summaryData, orgData)
      })
      .catch(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applyOrgData])

  async function guardedAction(id: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    if (busyId) return
    setBusyId(id)
    setNotice(null)
    try {
      const result = await fn()
      setNotice(result.ok ? 'İşlem tamamlandı.' : result.message ?? 'İşlem başarısız.')
      if (result.ok) await load(page, search)
    } finally {
      setBusyId(null)
    }
  }

  async function toggleOrg(row: OrganizationRow) {
    const next = row.status === 'active' ? 'SUSPENDED' : 'ACTIVE'
    await guardedAction(`org:${row.organizationId}`, () =>
      setOrganizationStatus(row.organizationId, next),
    )
  }

  async function toggleUser(row: OrganizationRow) {
    if (!row.userId) return
    const next = row.userStatus === 'active' ? 'DISABLED' : 'ACTIVE'
    await guardedAction(`user:${row.userId}`, () => setUserStatus(row.userId!, next))
  }

  async function doResetPassword(row: OrganizationRow) {
    if (!row.userId) return
    const value = window.prompt(
      `${row.name} kullanıcısı için yeni geçici parola girin (en az 6 karakter). ` +
        'Bu parola kaydedilmez; müşteriye siz iletmelisiniz:',
    )
    if (!value) return
    await guardedAction(`reset:${row.userId}`, () => resetUserPassword(row.userId!, value))
  }

  async function doRevoke(row: OrganizationRow) {
    if (!row.userId) return
    await guardedAction(`revoke:${row.userId}`, () => revokeUserSessions(row.userId!))
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-brand">
          <span className="admin-brand-mark">CF</span>
          <div>
            <strong>CargoFlow Platform Yönetimi</strong>
            <span className="admin-muted">{admin.username}</span>
          </div>
        </div>
        <button
          type="button"
          className="admin-secondary"
          onClick={async () => {
            await adminLogout()
            onLoggedOut()
          }}
        >
          Çıkış Yap
        </button>
      </header>

      <section className="admin-cards">
        <SummaryCard label="Toplam Şirket" value={summary?.totalOrganizations ?? 0} />
        <SummaryCard label="Aktif Şirket" value={summary?.activeOrganizations ?? 0} />
        <SummaryCard label="Onboarding Tamamlanan" value={summary?.onboardingCompleted ?? 0} />
        <SummaryCard label="Entegrasyonu Eksik" value={summary?.integrationIncomplete ?? 0} />
      </section>

      <section className="admin-toolbar">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void load(1, search)
          }}
        >
          <input
            placeholder="Şirket / kullanıcı ara…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="submit" className="admin-secondary">
            Ara
          </button>
        </form>
        <button type="button" onClick={() => setShowNew(true)}>
          + Yeni Şirket Oluştur
        </button>
      </section>

      {notice && <p className="admin-notice">{notice}</p>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Şirket</th>
              <th>Kullanıcı</th>
              <th>Durum</th>
              <th>Onboarding</th>
              <th>Trendyol</th>
              <th>Sürat</th>
              <th>Sipariş</th>
              <th>Ürün</th>
              <th>Son Giriş</th>
              <th>İşlemler</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10}>Yükleniyor…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={10}>Kayıt yok.</td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => (
                <tr key={row.organizationId}>
                  <td>
                    <strong>{row.name}</strong>
                    <span className="admin-muted">{row.slug}</span>
                  </td>
                  <td>{row.username ?? '—'}</td>
                  <td>
                    <span className={`admin-badge ${row.status === 'active' ? 'is-on' : 'is-off'}`}>
                      {row.status === 'active' ? 'Aktif' : 'Pasif'}
                    </span>
                    {row.userStatus && row.userStatus !== 'active' && (
                      <span className="admin-badge is-off">Kullanıcı Pasif</span>
                    )}
                  </td>
                  <td>{row.onboardingCompleted ? '✓' : '—'}</td>
                  <td>{row.trendyolConfigured ? '✓' : '—'}</td>
                  <td>{row.suratConfigured ? '✓' : '—'}</td>
                  <td>{row.orderCount}</td>
                  <td>{row.productCount}</td>
                  <td>{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString('tr-TR') : '—'}</td>
                  <td className="admin-actions-cell">
                    <button type="button" onClick={() => void toggleOrg(row)} disabled={busyId != null}>
                      {row.status === 'active' ? 'Pasifleştir' : 'Aktifleştir'}
                    </button>
                    <button type="button" onClick={() => void toggleUser(row)} disabled={busyId != null || !row.userId}>
                      {row.userStatus === 'active' ? 'Kullanıcı Kapat' : 'Kullanıcı Aç'}
                    </button>
                    <button type="button" onClick={() => void doResetPassword(row)} disabled={busyId != null || !row.userId}>
                      Parola Sıfırla
                    </button>
                    <button type="button" onClick={() => void doRevoke(row)} disabled={busyId != null || !row.userId}>
                      Oturumları Kapat ({row.activeSessionCount})
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="admin-pagination">
        <button
          type="button"
          className="admin-secondary"
          disabled={page <= 1}
          onClick={() => void load(page - 1, search)}
        >
          Önceki
        </button>
        <span>
          {page} / {totalPages} · {total} şirket
        </span>
        <button
          type="button"
          className="admin-secondary"
          disabled={page >= totalPages}
          onClick={() => void load(page + 1, search)}
        >
          Sonraki
        </button>
      </div>

      {showNew && (
        <NewOrganizationModal
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setNotice('Şirket oluşturuldu. Kullanıcı adı/parolayı müşteriye iletin.')
            void load(1, '')
          }}
        />
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-card">
      <span className="admin-card-value">{value}</span>
      <span className="admin-card-label">{label}</span>
    </div>
  )
}
