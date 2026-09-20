// KARGO ÜCRETİNİ KİM ÖDER — GERÇEK AYAR YÜZEYİ.
//
// ═══ ABONELİKLE KARIŞTIRILMAMALI ═════════════════════════════════════════
//
// Bu bölüm GÖNDERİ ÜCRETİNİN ödeyenidir; CargoFlow ABONELİĞİ
// (`/api/subscription/status`) ile İLGİSİ YOKTUR.
//
// ═══ OTOMATİK SEÇİM YOK ══════════════════════════════════════════════════
//
// Taşıyıcıya bakıp ön seçim YAPILMAZ. Yanlış ön seçim operatör tarafından
// onaylanıp geçilir ve YANLIŞ CARİYE FATURA doğurur.
//
// ═══ TRENDYOL DÜZENLENEMEZ ═══════════════════════════════════════════════
//
// Trendyol'da ödeyen SİPARİŞ SÖZLEŞMESİNDEN okunur. Alan burada kilitlidir;
// sunucu tarafında da yazma REDDEDİLİR (yalnız UI gizlemek yetmez).
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'
import { PAYER_OPTIONS, type ShippingPayerValue } from '../shipping/shippingPayerCopy'

export const SHIPPING_PAYER_ENDPOINT = '/api/shipping/payer'

export interface AccountPayerRow {
  marketplaceAccountId: string
  marketplace: string
  displayName: string | null
  isActive: boolean
  evidenceClass: 'CAN_DERIVE_FROM_ORDER' | 'ACCOUNT_CONFIG_REQUIRED' | 'NOT_VERIFIED'
  configurable: boolean
  payer: ShippingPayerValue
}

type RowStatus = 'idle' | 'saving' | 'saved' | 'error'

export function ShippingPayerSection() {
  const [rows, setRows] = useState<AccountPayerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({})

  // IO DURUMDAN AYRI: `load` yalnız ağdan veri getirir, setState YAPMAZ.
  // Durum güncellemeleri `await`ten SONRA, çağıran tarafta yapılır — böylece
  // efekt gövdesinde SENKRON setState olmaz (lint kuralı bunu yakaladı ve
  // ayrım zaten daha doğru bir tasarım).
  const load = useCallback(async (): Promise<AccountPayerRow[] | null> => {
    try {
      const response = await authenticatedApiRequest(SHIPPING_PAYER_ENDPOINT)
      const body = (await response.json()) as {
        ok?: boolean
        accounts?: AccountPayerRow[]
      }
      if (!response.ok || !body?.ok) return null
      return Array.isArray(body.accounts) ? body.accounts : []
    } catch {
      return null
    }
  }, [])

  const applyLoad = useCallback(
    (accounts: AccountPayerRow[] | null) => {
      if (accounts === null) {
        setLoadError('Ödeyen ayarları okunamadı.')
        setRows([])
        return
      }
      setLoadError(null)
      setRows(accounts)
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    async function run() {
      const accounts = await load()
      if (cancelled) return
      applyLoad(accounts)
      setLoading(false)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [load, applyLoad])

  async function save(row: AccountPayerRow, payer: ShippingPayerValue) {
    const id = row.marketplaceAccountId
    setRowStatus((current) => ({ ...current, [id]: 'saving' }))
    // İyimser gösterim YOK: değer ancak sunucu KABUL EDİNCE yazılır.
    try {
      const response = await authenticatedApiRequest(SHIPPING_PAYER_ENDPOINT, {
        method: 'POST',
        json: { marketplaceAccountId: id, payer },
      })
      const body = (await response.json()) as { ok?: boolean }
      if (!response.ok || !body?.ok) {
        setRowStatus((current) => ({ ...current, [id]: 'error' }))
        return
      }
      setRowStatus((current) => ({ ...current, [id]: 'saved' }))
      // GİDİŞ-DÖNÜŞ: kaydedilen değer SUNUCUDAN yeniden okunur.
      applyLoad(await load())
    } catch {
      setRowStatus((current) => ({ ...current, [id]: 'error' }))
    }
  }

  if (loading) {
    return (
      <section aria-labelledby="shipping-payer-title">
        <h3 id="shipping-payer-title">Kargo ücreti ödeyeni</h3>
        <p role="status">Yükleniyor…</p>
      </section>
    )
  }

  return (
    <section aria-labelledby="shipping-payer-title">
      <h3 id="shipping-payer-title">Kargo ücreti ödeyeni</h3>
      <p>Etiket ve kargo oluşturma yöntemi bu sözleşme tipine göre değişebilir.</p>

      {loadError ? <p role="alert">{loadError}</p> : null}

      {!loadError && rows.length === 0 ? (
        <p>Bağlı pazaryeri hesabı yok.</p>
      ) : null}

      <ul>
        {rows.map((row) => {
          const status = rowStatus[row.marketplaceAccountId] ?? 'idle'
          const label = row.displayName
            ? `${row.marketplace} · ${row.displayName}`
            : `${row.marketplace} · ${row.marketplaceAccountId.slice(0, 8)}`
          const selectId = `payer-${row.marketplaceAccountId}`
          return (
            <li key={row.marketplaceAccountId}>
              <span>{label}</span>
              {row.configurable ? (
                <>
                  <label htmlFor={selectId}>Kargo ücretini kim ödüyor?</label>
                  <select
                    id={selectId}
                    value={row.payer}
                    disabled={status === 'saving'}
                    onChange={(event) =>
                      void save(row, event.target.value as ShippingPayerValue)
                    }
                  >
                    {PAYER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {status === 'saving' ? <span role="status">Kaydediliyor…</span> : null}
                  {status === 'saved' ? <span role="status">Kaydedildi</span> : null}
                  {status === 'error' ? <span role="alert">Kaydedilemedi</span> : null}
                </>
              ) : (
                <span>Sipariş verisinden okunuyor — elle ayarlanamaz</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
