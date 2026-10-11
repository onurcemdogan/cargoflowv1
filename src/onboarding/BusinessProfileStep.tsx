// "İşletmenizi oluşturun" — firma adı, iletişim telefonu ve adres.
// Tamamlanma ön yüzde tutulmaz: kaydettikten sonra durum sunucudan yenilenir.
import { useEffect, useState, type FormEvent } from 'react'
import {
  fetchOrganizationProfile,
  saveOrganizationProfile,
  type OrganizationProfile,
} from '../services/organizationProfileService'

const EMPTY: OrganizationProfile = { name: '', contactPhone: '', addressLine: '', city: '', district: '' }

export function BusinessProfileStep({
  done,
  fallbackName,
  onSaved,
}: {
  done: boolean
  fallbackName: string
  onSaved: () => Promise<void> | void
}) {
  const [form, setForm] = useState<OrganizationProfile>({ ...EMPTY, name: fallbackName })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  useEffect(() => {
    let active = true
    fetchOrganizationProfile()
      .then((result) => {
        if (!active) return
        if (result) {
          setForm({
            name: result.profile.name ?? fallbackName,
            contactPhone: result.profile.contactPhone ?? '',
            addressLine: result.profile.addressLine ?? '',
            city: result.profile.city ?? '',
            district: result.profile.district ?? '',
          })
        }
        setLoaded(true)
      })
      .catch(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [fallbackName])

  const field = (key: keyof OrganizationProfile) => ({
    value: form[key] ?? '',
    onChange: (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value })),
    disabled: busy || !loaded,
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await saveOrganizationProfile(form)
      setMessage(
        result.complete
          ? { tone: 'ok', text: 'İşletme bilgileri kaydedildi.' }
          : { tone: 'warn', text: 'Kaydedildi; adımın tamamlanması için tüm alanları doldurun.' },
      )
      await onSaved()
    } catch (error) {
      setMessage({ tone: 'warn', text: error instanceof Error ? error.message : 'İşletme bilgileri kaydedilemedi.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="onboarding-card" onSubmit={submit} aria-busy={busy}>
      <h2>İşletme Bilgileri</h2>
      <p>Firmanızın adı ve iletişim bilgileri çalışma alanınızda kullanılır.</p>
      <label>
        Firma adı
        <input autoComplete="organization" required {...field('name')} />
      </label>
      <label>
        İletişim telefonu
        <input type="tel" autoComplete="tel" placeholder="0212 555 00 00" required {...field('contactPhone')} />
      </label>
      <label>
        Adres
        <input autoComplete="street-address" required {...field('addressLine')} />
      </label>
      <label>
        İl
        <input autoComplete="address-level1" required {...field('city')} />
      </label>
      <label>
        İlçe
        <input autoComplete="address-level2" required {...field('district')} />
      </label>
      {message ? (
        <p className={message.tone === 'ok' ? 'onboarding-ok' : 'onboarding-warn'} role="status">
          {message.text}
        </p>
      ) : done ? (
        <p className="onboarding-ok">İşletme bilgileri tamam.</p>
      ) : null}
      <button type="submit" disabled={busy || !loaded}>
        {busy ? 'Kaydediliyor…' : 'İşletme Bilgilerini Kaydet'}
      </button>
    </form>
  )
}
