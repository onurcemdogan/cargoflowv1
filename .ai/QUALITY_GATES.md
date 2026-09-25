# CargoFlow quality gates

Run all applicable commands:

```bash
npx tsc -b --force
npm run lint
npm run build
npm run test:ui
npm run test:dashboard
npm run test:label-editor:acceptance
npm run test:performance:acceptance
npm run test:auto-label:acceptance
npm run test:connector-kernel
npm run test:contract-packs
npm run test:integration-health
npm run test:subscription
npm run test:billing-party
npm run test:woocommerce
npm run test:print-platform
npm run test:onboarding
npm run test:catalog
npm run test:product-tour
npm run test:landing
npm run test:ikas
npm run test:surat
```

No skip/todo/weakened assertions. Mutation proof when the active ticket requires it.
