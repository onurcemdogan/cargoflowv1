export type IntegrationCategory =
  | 'marketplaces'
  | 'commerceSites'
  | 'carriers'
  | 'invoiceIntegrators'
  | 'otherServices'
  | 'systemSettings'

export type TrendyolDetailTab =
  | 'general'
  | 'api'
  | 'store'
  | 'orders'
  | 'products'
  | 'stock'
  | 'logs'

export type SuratDetailTab =
  | 'general'
  | 'account'
  | 'agreement'
  | 'commonBarcode'
  | 'label'
  | 'sync'
  | 'logs'

export const integrationCategoryTabs: Array<{
  key: IntegrationCategory
  label: string
}> = [
  { key: 'marketplaces', label: 'Pazaryerleri' },
  { key: 'commerceSites', label: 'E-Ticaret Siteleri' },
  { key: 'carriers', label: 'Kargo Firmaları' },
  { key: 'invoiceIntegrators', label: 'Fatura Entegratörleri' },
  { key: 'otherServices', label: 'Diğer Servisler' },
  { key: 'systemSettings', label: 'Sistem Ayarları' },
]

export const trendyolDetailTabs: Array<{
  key: TrendyolDetailTab
  label: string
}> = [
  { key: 'general', label: 'Genel Ayarlar' },
  { key: 'api', label: 'API Bilgileri' },
  { key: 'store', label: 'Mağaza' },
  { key: 'orders', label: 'Sipariş Ayarları' },
  { key: 'products', label: 'Ürün Ayarları' },
  { key: 'stock', label: 'Stok Ayarları' },
  { key: 'logs', label: 'Loglar' },
]

export const suratDetailTabs: Array<{
  key: SuratDetailTab
  label: string
}> = [
  { key: 'general', label: 'Genel' },
  { key: 'account', label: 'Hesap' },
  { key: 'agreement', label: 'Anlaşmalı Kargo' },
  { key: 'commonBarcode', label: 'Ortak Barkod' },
  { key: 'label', label: 'Etiket' },
  { key: 'sync', label: 'Senkronizasyon' },
  { key: 'logs', label: 'Loglar' },
]
