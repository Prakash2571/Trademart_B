# DeoDap

DeoDap is an Indian wholesale and dropshipping supplier. This integration lets Trademart
recognise DeoDap products, import them into Shopify from a DeoDap product file, keep
their supplier costs current, and track the orders placed with DeoDap.

**Nothing is sent to DeoDap automatically.** DeoDap has not published an API that could
be verified, so Trademart does not call one. The flows below use files you upload and
details you record. Where an API client would plug in is described at the end.

## What works today

| Feature | How |
| --- | --- |
| Recognise DeoDap products | Vendor or tag "DeoDap", or a SKU prefix you configure |
| Store your DeoDap login or API key | Encrypted with `TOKEN_ENCRYPTION_KEY`, never returned by any route |
| Import products | Upload a DeoDap CSV, preview the prices, create Shopify **drafts** |
| Record supplier costs | Each imported variant's DeoDap cost becomes its manual cost |
| Update costs | Upload a newer price list; changed costs are shown before anything is saved |
| Orders | List Shopify orders with DeoDap products; record the DeoDap order number, status and tracking |

Not available until DeoDap provides an API: catalogue search, live stock, automatic
order placement, and automatic tracking. Tracking recorded in Trademart is **not** pushed
to Shopify yet, so fulfil the order in Shopify with the same tracking number.

## Using it

1. **Settings** (`/suppliers/deodap` in the console). Currency DeoDap charges in (INR),
   default markup and rounding, the vendor name to write on imported products, and any
   SKU prefixes that identify DeoDap products.
2. **Import** (`/suppliers/deodap/import`). Choose a DeoDap CSV. Both a flat file (one
   row per product) and a Shopify-style export (rows grouped by `Handle`, variants via
   `Option1 Value`, extra image rows) are read. Check the column mapping. The DeoDap cost
   column matters most; a column called just "Price" is used only as a flagged guess.
   Choose the products and import them. They are created as drafts with the DeoDap tag
   and appear in the review queue.
3. **Cost sync** (`/suppliers/deodap/sync`). Upload a newer price list. Rows are matched
   to imported products by product reference, then SKU. Pick the changes to save. Only
   Trademart's recorded supplier cost changes. The Shopify selling price does not.
4. **Orders** (`/suppliers/deodap/orders`). Orders that still need placing with DeoDap
   are flagged. Place the order with DeoDap, then record the DeoDap order number, and
   later the tracking details.

## How the pieces fit

```
src/suppliers/deodap/
  deodap.identify.ts     pure  vendor / tag / fulfillment service / SKU prefix evidence
  deodap.provider.ts     pure  SupplierProvider: identification only, every gap explained
  deodap.api.ts          pure  the API seam: DeodapApiClient contract, returns null today
  deodap.settings.ts     pure  settings + credential validation, masking
  deodap.csv.ts          pure  RFC 4180 CSV reader
  deodap.description.ts  pure  storefront-safe description HTML
  deodap.catalog.ts      pure  column mapping, rows to products, blocking issues
  deodap.pricing.ts      pure  markup / MRP pricing through common/money
  deodap.import.ts       pure  preview, drafts, import batch validation
  deodap.sync.ts         pure  price list vs import ledger
  deodap.orders.ts       pure  DeoDap lines, supplier cost, what needs placing
  deodap.service.ts            MongoDB, Shopify, encryption
  deodap.controller.ts         routes under /api/suppliers/deodap
```

Collections:

- `supplier_connections`: one per shop and provider. Settings, plus encrypted credentials.
- `supplier_imports`: the import ledger. There is one row per DeoDap product, with a
  unique index on `(shopDomain, provider, refKey)`. The import inserts a `CLAIMED` row
  **before** its first Shopify write, so two imports of one product cannot both proceed.
- `supplier_orders`: one per Shopify order. Holds DeoDap's order number, status and
  tracking. No customer data.

Costs are stored where every other manual cost is (`supplier_products`, `costSource:
MANUAL`, `provider: DEODAP`), so pricing, automation and the dropshipping view use them
without any DeoDap-specific code.

## Safety properties

- Every product is created as a **DRAFT**. Publishing stays in the review queue.
- A missing or unreadable cost blocks a product. Nothing is ever priced from zero.
- A selling price below the DeoDap cost is refused.
- An import batch (max 10 products) is validated in full before the first Shopify
  write. `Idempotency-Key` replays a lost response. The ledger claim and a Shopify SKU
  check stop duplicates across retries.
- Descriptions are sanitised. Scripts, event handlers and `javascript:` addresses are
  removed, and links are dropped so the supplier's site is not advertised. Images are
  kept only with an https `src`.
- The store currency must match the DeoDap cost currency. Trademart does not convert.
- Credentials are validated without echoing them, encrypted with AES-256-GCM, and never
  logged, audited or returned. The UI and audit trail see only the kind, your label and
  a masked identifier.
- Every route requires an operator, reads included.

## Adding the DeoDap API later

When DeoDap provides API documentation and access:

1. Implement `DeodapApiClient` in `deodap.api.ts` against the documented endpoints, and
   return it from `createDeodapApiClient()`. Decrypt credentials with
   `decryptSecret(row.credentialsEncrypted, decodeEncryptionKey(TOKEN_ENCRYPTION_KEY))`.
2. Set `DEODAP_API_AVAILABILITY.available` to `true`, and flip the capabilities it
   really supports in `deodap.provider.ts`. Keep a limitation for anything it does not.
3. Stock and cost: feed `getStock()` results into `planCostSync()`, the same planner the
   CSV sync uses.
4. Orders: build a `DeodapOrderRequest` from `extractDeodapLines()`. Read the shipping
   address from Shopify at the moment of placing, and do not store it. Write the result
   to `supplier_orders` with `placedVia: API`.
5. Add the routes to `docs/ROUTE_SECURITY.md` (the route inventory test enforces it).
