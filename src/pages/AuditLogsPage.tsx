import { Trash2 } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import type { AuditLog } from '../types/cargoflow'
import { formatDebugDateTime } from '../utils/formatters'

interface AuditLogsPageProps {
  logs: AuditLog[]
  onClearLogs: () => void
}

export function AuditLogsPage({ logs, onClearLogs }: AuditLogsPageProps) {
  return (
    <>
      <PageHeader
        title="İşlem Logları"
        description="Bağlantı testi, sipariş/ürün çekme, Sürat gönderisi, etiket üretimi ve ZPL indirme işlemlerini izle."
        actions={
          <button
            type="button"
            className="secondary-button danger"
            onClick={onClearLogs}
            disabled={logs.length === 0}
          >
            <Trash2 size={18} />
            Logları Temizle
          </button>
        }
      />

      <section className="panel">
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>Zaman</th>
                <th>Seviye</th>
                <th>İşlem</th>
                <th>Sipariş</th>
                <th>Detay</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{formatDebugDateTime(log.createdAt)}</td>
                  <td>
                    <StatusBadge status={log.level} />
                  </td>
                  <td>
                    <strong>{log.action}</strong>
                  </td>
                  <td>{log.orderNumber ?? '-'}</td>
                  <td>{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 ? (
            <p className="empty-state">Henüz işlem logu yok.</p>
          ) : null}
        </div>
      </section>
    </>
  )
}
