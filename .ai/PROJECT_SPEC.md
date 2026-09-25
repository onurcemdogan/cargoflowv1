# CargoFlow project specification

CargoFlow is an e-commerce operations product for Turkish merchants. The current proven production-facing core is Trendyol order/product operations plus Sürat Kargo shipment, barcode, label and print workflows.

Durable principles:
- Server-side tenant authority.
- Provider contracts are never guessed.
- Provider/account identity is separate from credentials.
- Live fulfillment is gated by connector rollout stage.
- Reprints use persisted immutable artifacts; printing does not refetch providers.
- Integration Health, Onboarding, Catalog, Product Tour and public Landing remain separate concerns.
- Account-scoped providers never bleed credentials, sync state or data across sibling stores.
