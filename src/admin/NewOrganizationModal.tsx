// Yeni şirket oluşturma modalı. Başarı sonrası: kullanıcı otomatik login OLMAZ,
// oluşturulan parola TEKRAR GÖSTERİLMEZ (admin bilgileri müşteriye kendi iletir).
import { useState } from 'react'
import { createOrganization } from './adminApiService'
import { MIN_PASSWORD_LENGTH } from '../auth/passwordPolicy'

export function NewOrganizationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [organizationName, setOrganizationName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (password !== passwordConfirm) {
      setError('Parolalar eşleşmiyor.')
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Parola en az ${MIN_PASSWORD_LENGTH} karakter olmalı.`)
      return
    }
    setBusy(true)
    try {
      const result = await createOrganization({
        organizationName: organizationName.trim(),
        username: username.trim(),
        password,
      })
      if (result.ok) {
        // Parola tekrar gösterilmez; form kapanır.
        onCreated()
        onClose()
        return
      }
      setError(result.message ?? 'Şirket oluşturulamadı.')
    } catch {
      setError('Şirket oluşturulamadı. Bağlantıyı kontrol edin.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
      <form className="admin-modal" onSubmit={submit}>
        <h2>Yeni Şirket Oluştur</h2>
        <label>
          Şirket Adı
          <input
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            required
          />
        </label>
        <label>
          Kullanıcı Adı
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          Geçici Parola
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <label>
          Parola Tekrarı
          <input
            type="password"
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
            required
          />
        </label>
        <p className="admin-note">
          Oluşturulan parola bir daha gösterilmez. Kullanıcı adı ve parolayı
          müşteriye siz iletin. Kullanıcı otomatik giriş yapmaz.
        </p>
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        <div className="admin-modal-actions">
          <button type="button" className="admin-secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Oluşturuluyor…' : 'Oluştur'}
          </button>
        </div>
      </form>
    </div>
  )
}
