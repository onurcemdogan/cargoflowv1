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
import { Alert, Badge, Card, Field } from '../ui/primitives'
import { IntegrationLoading } from './IntegrationConnection'
import { useCallback, useEffect, useState } from 'react'
import { authenticatedApiRequest } from '../services/authenticatedApiRequest'
import { PAYER_OPTIONS, type ShippingPayerValue } from '../shipping/shippingPayerCopy'
import { isCurrentMarketplaceAccount, marketplaceAccountLabel } from './marketplaceAccountVisibility'

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
      setRows(accounts.filter(isCurrentMarketplaceAccount))
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
      <Card
        title="Kargo ücreti ödeyeni"
        labelledBy="shipping-payer-title"
        className="integration-shared-card"
      >
        <IntegrationLoading />
      </Card>
    )
  }
  return (
    <Card
      title="Kargo ücreti ödeyeni"
      labelledBy="shipping-payer-title"
      className="integration-shared-card"
      subtitle="Etiket ve kargo oluşturma yöntemi bu sözleşme tipine göre değişebilir. Bu ayar CargoFlow aboneliğinden bağımsızdır."
    >
      {loadError ? (
        <Alert tone="danger" role="alert">
          {loadError}
        </Alert>
      ) : null}
      {!loadError && rows.length === 0 ? (
        <p className="integration-connection-empty">
          Bağlı pazaryeri hesabı yok.
        </p>
      ) : null}
      <ul className="integration-setting-rows">
        {rows.map((row) => {
          const status = rowStatus[row.marketplaceAccountId] ?? 'idle'
          const label = marketplaceAccountLabel({
            ...row, displayName: row.displayName ?? row.marketplaceAccountId.slice(0, 8),
          })
          const selectId = `payer-${row.marketplaceAccountId}`
          return (
            <li
              key={row.marketplaceAccountId}
              className="integration-setting-row"
            >
              <h3>{label}</h3>
              {row.configurable ? (
                <>
                  <Field label="Kargo ücretini kim ödüyor?" htmlFor={selectId}>
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
                  </Field>
                  {status === 'saving' ? (
                    <span role="status">
                      <Badge tone="info">Kaydediliyor…</Badge>
                    </span>
                  ) : null}
                  {status === 'saved' ? (
                    <span role="status">
                      <Badge tone="info">Kaydedildi</Badge>
                    </span>
                  ) : null}
                  {status === 'error' ? (
                    <Alert tone="danger" role="alert">
                      Kaydedilemedi
                    </Alert>
                  ) : null}
                </>
              ) : (
                <Badge tone="neutral">
                  Sipariş verisinden okunuyor — elle ayarlanamaz
                </Badge>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
