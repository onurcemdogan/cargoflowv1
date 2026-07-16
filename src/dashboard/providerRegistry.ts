export interface ProviderRegistryEntry {
  providerKey: string
  providerName: string
  aliases: string[]
  enabled: boolean
}

export const marketplaceProviderRegistry: Record<
  string,
  ProviderRegistryEntry
> = {
  trendyol: {
    providerKey: 'trendyol',
    providerName: 'Trendyol',
    aliases: ['trendyol'],
    enabled: true,
  },
  hepsiburada: {
    providerKey: 'hepsiburada',
    providerName: 'Hepsiburada',
    aliases: ['hepsiburada'],
    enabled: false,
  },
  n11: {
    providerKey: 'n11',
    providerName: 'N11',
    aliases: ['n11'],
    enabled: false,
  },
  amazon: {
    providerKey: 'amazon',
    providerName: 'Amazon',
    aliases: ['amazon'],
    enabled: false,
  },
  ciceksepeti: {
    providerKey: 'ciceksepeti',
    providerName: 'ÇiçekSepeti',
    aliases: ['çiçeksepeti', 'ciceksepeti'],
    enabled: false,
  },
  pazarama: {
    providerKey: 'pazarama',
    providerName: 'Pazarama',
    aliases: ['pazarama'],
    enabled: false,
  },
  shopify: {
    providerKey: 'shopify',
    providerName: 'Shopify',
    aliases: ['shopify'],
    enabled: false,
  },
  woocommerce: {
    providerKey: 'woocommerce',
    providerName: 'WooCommerce',
    aliases: ['woocommerce', 'woo commerce'],
    enabled: false,
  },
}

export const carrierProviderRegistry: Record<string, ProviderRegistryEntry> = {
  surat: {
    providerKey: 'surat',
    providerName: 'Sürat Kargo',
    aliases: [
      'sürat',
      'surat',
      'surat-kargo',
      'sürat kargo',
      'sürat kargo marketplace',
      'surat kargo marketplace',
    ],
    enabled: true,
  },
  yurtici: {
    providerKey: 'yurtici',
    providerName: 'Yurtiçi Kargo',
    aliases: ['yurtiçi', 'yurtici'],
    enabled: false,
  },
  mng: {
    providerKey: 'mng',
    providerName: 'MNG Kargo',
    aliases: ['mng'],
    enabled: false,
  },
  aras: {
    providerKey: 'aras',
    providerName: 'Aras Kargo',
    aliases: ['aras'],
    enabled: false,
  },
  hepsijet: {
    providerKey: 'hepsijet',
    providerName: 'Hepsijet',
    aliases: ['hepsijet'],
    enabled: false,
  },
  trendyolExpress: {
    providerKey: 'trendyolExpress',
    providerName: 'Trendyol Express',
    aliases: ['trendyol express', 'trendyolexpress'],
    enabled: false,
  },
  ptt: {
    providerKey: 'ptt',
    providerName: 'PTT Kargo',
    aliases: ['ptt'],
    enabled: false,
  },
  ups: {
    providerKey: 'ups',
    providerName: 'UPS',
    aliases: ['ups'],
    enabled: false,
  },
  dhl: {
    providerKey: 'dhl',
    providerName: 'DHL',
    aliases: ['dhl'],
    enabled: false,
  },
}

export function resolveMarketplaceProvider(value: unknown): ProviderRegistryEntry {
  return resolveProvider(
    marketplaceProviderRegistry,
    value,
    'unknown-marketplace',
    'Bilinmeyen Pazaryeri',
  )
}

export function resolveCarrierProvider(value: unknown): ProviderRegistryEntry {
  return resolveProvider(
    carrierProviderRegistry,
    value,
    'unknown-carrier',
    'Bilinmeyen Kargo',
  )
}

function resolveProvider(
  registry: Record<string, ProviderRegistryEntry>,
  value: unknown,
  fallbackKey: string,
  fallbackName: string,
): ProviderRegistryEntry {
  const normalized = normalize(value)
  const found = Object.values(registry).find(
    (provider) =>
      normalize(provider.providerKey) === normalized ||
      provider.aliases.some((alias) => normalize(alias) === normalized),
  )
  if (found) return found

  return {
    providerKey: normalized || fallbackKey,
    providerName: fallbackName,
    aliases: normalized ? [normalized] : [],
    enabled: true,
  }
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, '')
}
