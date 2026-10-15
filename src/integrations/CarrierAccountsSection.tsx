// KARGO HESAPLARI + SATIŞ HESABI EŞLEMESİ (PHASE2-C).
//
// Kullanıcının kendi kargo hesapları ve doğrulama durumları; her satış
// hesabının siparişinin hangi kargo hesabıyla gönderileceği. "Otomatik",
// organizasyonda o kargo firmasının TEK hesabı varsa onu kullanır; birden
// çok hesap varsa seçim yapılmadan gönderi OLUŞTURULMAZ. Sır gösterilmez.
import { Alert, Badge, Card, Field } from '../ui/primitives'
import {
  IntegrationAccountCard,
  IntegrationLoading,
} from './IntegrationConnection'
import { useCallback, useEffect, useState } from 'react'
import { isCurrentMarketplaceAccount, marketplaceAccountLabel } from './marketplaceAccountVisibility'

interface CarrierAccount {
  id: string
  provider: string
  displayName: string
  externalAccountRef: string | null
  verificationStatus: string
  lastVerifiedAt: string | null
  enabled: boolean
}

interface MarketplaceAccountRow {
  id: string
  marketplace: string
  displayName: string | null
  isActive: boolean
  resolution: { ok: true; account: CarrierAccount; source: string } | { ok: false; code: string }
}

interface Payload {
  accounts: CarrierAccount[]
  mappings: Array<{ marketplaceAccountId: string; carrierAccountId: string }>
  marketplaceAccounts: MarketplaceAccountRow[]
}

const VERIFICATION_LABELS: Record<string, string> = {
  verified: 'Doğrulandı',
  unverified: 'Doğrulanmadı',
  auth_failed: 'Kimlik reddedildi',
  permission_denied: 'Yetki yok',
  provider_unavailable: 'Servise ulaşılamadı',
  rate_limited: 'İstek sınırı',
}

const RESOLUTION_ERRORS: Record<string, string> = {
  CARRIER_ACCOUNT_NOT_CONFIGURED: 'Kargo hesabı yok — gönderi oluşturulamaz',
  CARRIER_ACCOUNT_DISABLED: 'Seçili hesap kapalı — gönderi oluşturulamaz',
  CARRIER_MAPPING_PROVIDER_MISMATCH: 'Seçili hesap başka bir kargo firmasına ait',
  CARRIER_ACCOUNT_AMBIGUOUS: 'Birden çok hesap var — bir hesap seçin',
}

const PROVIDER_NAMES: Record<string, string> = { surat: 'Sürat Kargo', aras: 'Aras Kargo' }

function maskRef(value: string | null): string {
  if (!value) return ''
  return value.length <= 4 ? value : `••••${value.slice(-4)}`
}

export function CarrierAccountsSection() {
  const [data, setData] = useState<Payload | null>(null)
  const [available, setAvailable] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/carrier-accounts', { credentials: 'include' })
      if (!response.ok) {
        setAvailable(false)
        return
      }
      const body = (await response.json()) as Payload & { ok?: boolean }
      setData({ accounts: body.accounts ?? [], mappings: body.mappings ?? [], marketplaceAccounts: body.marketplaceAccounts ?? [] })
    } catch {
      setAvailable(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/carrier-accounts', { credentials: 'include' })
      .then(async (response) => {
        if (!active) return
        if (!response.ok) {
          setAvailable(false)
          return
        }
        const body = (await response.json()) as Payload
        if (active) setData({ accounts: body.accounts ?? [], mappings: body.mappings ?? [], marketplaceAccounts: body.marketplaceAccounts ?? [] })
      })
      .catch(() => {
        if (active) setAvailable(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function changeMapping(marketplaceAccountId: string, carrierAccountId: string) {
    setSaving(marketplaceAccountId)
    setError(null)
    try {
      const response = await fetch('/api/carrier-accounts/mappings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplaceAccountId, carrierAccountId: carrierAccountId || null }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null
        setError(body?.message ?? 'Eşleme kaydedilemedi.')
      }
      await load()
    } finally {
      setSaving(null)
    }
  }

  if (!available) return null

  return (
    <Card
      title="Kargo hesapları"
      labelledBy="carrier-accounts-title"
      className="integration-shared-card"
      subtitle="Gönderiler kendi kargo hesabınızla ve anlaşmalı tarifenizle oluşturulur. Hangi satış hesabının hangi kargo hesabını kullanacağı kesin değilse gönderi oluşturulmaz."
    >
      {!data ? (
        <IntegrationLoading />
      ) : (
        <>
          {data.accounts.length === 0 ? (
            <p className="integration-connection-empty">
              Henüz kargo hesabı yok. Kargo Firmaları sekmesinden hesabınızı
              bağlayın.
            </p>
          ) : (
            <ul className="integration-connection-accounts">
              {data.accounts.map((account) => (
                <IntegrationAccountCard
                  key={account.id}
                  title={account.displayName}
                  state={
                    <Badge
                      tone={
                        !account.enabled
                          ? 'neutral'
                          : account.verificationStatus === 'verified'
                            ? 'success'
                            : 'warning'
                      }
                    >
                      {account.enabled
                        ? (VERIFICATION_LABELS[account.verificationStatus] ??
                          account.verificationStatus)
                        : 'Kapalı'}
                    </Badge>
                  }
                  facts={[
                    [
                      'Kargo firması',
                      PROVIDER_NAMES[account.provider] ?? account.provider,
                    ],
                    ...(account.externalAccountRef
                      ? [
                          [
                            'Hesap kodu',
                            `Müşteri kodu ${maskRef(account.externalAccountRef)}`,
                          ] as [string, string],
                        ]
                      : []),
                    ...(account.lastVerifiedAt
                      ? [
                          ['Son doğrulama', account.lastVerifiedAt] as [
                            string,
                            string,
                          ],
                        ]
                      : []),
                  ]}
                />
              ))}
            </ul>
          )}
          {data.marketplaceAccounts.some(isCurrentMarketplaceAccount) ? (
            <div className="integration-routing-settings">
              <h3>Satış hesabı → kargo hesabı</h3>
              <div className="integration-connection-fields">
                {data.marketplaceAccounts.filter(isCurrentMarketplaceAccount).map((row) => {
                  const mapping = data.mappings.find(
                    (entry) => entry.marketplaceAccountId === row.id,
                  )
                  const selectId = `carrier-mapping-${row.id}`
                  return (
                    <Field
                      key={row.id}
                      htmlFor={selectId}
                      label={`${row.marketplace.trim().toLowerCase() === 'trendyol' ? marketplaceAccountLabel(row) : row.displayName ?? row.marketplace} siparişleri`}
                    >
                      <select
                        id={selectId}
                        value={mapping?.carrierAccountId ?? ''}
                        disabled={saving === row.id}
                        onChange={(event) =>
                          void changeMapping(row.id, event.target.value)
                        }
                      >
                        <option value="">Otomatik (tek kargo hesabı)</option>
                        {data.accounts
                          .filter((account) => account.enabled)
                          .map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.displayName}
                            </option>
                          ))}
                      </select>
                      <small
                        className={
                          row.resolution.ok
                            ? 'onboarding-ok'
                            : 'onboarding-warn'
                        }
                      >
                        {row.resolution.ok
                          ? `Gönderiler ${row.resolution.account.displayName} hesabıyla oluşturulur.`
                          : (RESOLUTION_ERRORS[row.resolution.code] ??
                            'Kargo hesabı çözülemedi.')}
                      </small>
                    </Field>
                  )
                })}
              </div>
            </div>
          ) : null}
          {error ? (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          ) : null}
        </>
      )}
    </Card>
  )
}
