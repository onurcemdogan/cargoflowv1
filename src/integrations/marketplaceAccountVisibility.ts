/** Current customer settings only. Historical repositories must retain all rows. */
export function isCurrentMarketplaceAccount(account: {
  marketplace?: unknown
  isActive?: unknown
}): boolean {
  return String(account.marketplace ?? '').trim().toLowerCase() !== 'trendyol'
    || account.isActive === true
}

/** Existing Trendyol labels already contain the provider; show it once. */
export function marketplaceAccountLabel(account: {
  marketplace: string
  displayName: string | null
  providerAccountId?: string
}): string {
  if (account.marketplace.trim().toLowerCase() !== 'trendyol') {
    return account.displayName ? `${account.marketplace} · ${account.displayName}` : account.marketplace
  }
  let identity = (account.displayName ?? '').trim().replace(/^(?:trendyol\s*(?:[·•:|-]\s*|$))+/i, '').trim()
  const sellerId = account.providerAccountId?.trim()
  if (sellerId && !identity.split(/\s*[·•:|]\s*/).includes(sellerId)) {
    identity = identity ? `${identity} · ${sellerId}` : sellerId
  }
  return identity ? `Trendyol · ${identity}` : 'Trendyol'
}
