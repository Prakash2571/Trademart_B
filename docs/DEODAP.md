# DeoDap

DeoDap is an Indian wholesale and dropshipping supplier. Trademart works with it the same
way it works with Tradelle. DeoDap has no public API, so **Trademart never calls DeoDap**.
Instead, DeoDap's own Shopify app is the bridge:

```
Trademart -> Shopify API -> Shopify store -> DeoDap Shopify app -> DeoDap fulfilment
```

DeoDap's app brings products into Shopify and picks up the Shopify orders for them.
Trademart manages those products and watches the orders move, all through Shopify.

## The two order flows

Set on the DeoDap page (`orderFlow` in the DeoDap settings):

| Flow | Who sends orders to DeoDap | What Trademart does |
| --- | --- | --- |
| **`SHOPIFY_APP`** (default, the Tradelle model) | DeoDap's Shopify app, for the products it imported | Shows each order's progress and tracking from Shopify, and flags orders that have not been dispatched within the dropshipping processing SLA |
| `MANUAL` | You, on DeoDap | Flags orders not yet placed; you record DeoDap's order number, status and tracking |

Products created by Trademart's **CSV import** are unknown to DeoDap's app, so their
orders are always treated as manual, whichever flow is set. The import page and the
orders page both say so.

## What Trademart does with DeoDap

| Feature | How |
| --- | --- |
| Recognise DeoDap products and order lines | Vendor, tag or fulfillment service containing "DeoDap", or a SKU prefix you configure. Never the title. |
| Manage products | Prices, publishing, the review queue and automation all work through Shopify. Automation can target DeoDap products with the vendor or tag selection. |
| Costs | Shopify's cost per item (if DeoDap's app writes it). Otherwise a manual cost, or for CSV-imported products a DeoDap price list. |
| Orders | `/suppliers/deodap/orders` lists orders with DeoDap products, with Shopify's progress and tracking, and flags what needs you. |
| Research | Candidates can be recorded as researched on DeoDap and verified as available in DeoDap, as for Tradelle. |
| DeoDap account (optional) | Stored encrypted with `TOKEN_ENCRYPTION_KEY` and never returned. It is unused until DeoDap offers an API. |
| CSV import and cost sync | For products you bring in from a DeoDap file instead of through the app. |

## Setting it up

1. Install DeoDap's app from the Shopify App Store and import products through it.
2. Open an imported product in Trademart's Products page. If it does not show as
   **DEODAP**, check what the app wrote. If the vendor and tags don't mention DeoDap,
   add the app's SKU prefix on the DeoDap page, or bulk-add the tag `DeoDap` in Shopify.
3. Place a test order and confirm DeoDap's app picks it up. Then check that tracking
   appears on the Shopify order when DeoDap ships.
4. If DeoDap's app keeps prices or stock updated in Shopify, don't also change them from
   Trademart, or the app's next update will overwrite them. Exclude DeoDap products
   from price automation with the selection rules.

## Without the app: file-based flow

1. **Import** (`/suppliers/deodap/import`). Choose a DeoDap CSV. Two shapes are read:
   - a flat file, with one row per product;
   - a Shopify-style export, with rows grouped by `Handle`, variants via
     `Option1 Value`, and extra image rows.

   Check the column mapping. The DeoDap cost column matters most, and a column called
   just "Price" is used only as a flagged guess. Products are created as drafts with the
   DeoDap tag.
2. **Cost sync** (`/suppliers/deodap/sync`). Upload a newer price list to update the
   recorded costs of products imported this way. Shopify selling prices are not changed.
3. **Orders.** Place each order with DeoDap, then record DeoDap's order number and
   tracking. Tracking recorded in Trademart is not pushed to Shopify: fulfil the order
   in Shopify with the same number. The orders page flags it until you do.

## How the pieces fit

```
src/suppliers/deodap/
  deodap.identify.ts     pure  vendor / tag / fulfillment service / SKU prefix evidence
  deodap.provider.ts     pure  SupplierProvider: identification + Shopify bridge, like Tradelle
  deodap.api.ts          pure  the API seam: DeodapApiClient contract, returns null today
  deodap.settings.ts     pure  order flow, settings + credential validation, masking
  deodap.csv.ts          pure  RFC 4180 CSV reader
  deodap.description.ts  pure  storefront-safe description HTML
  deodap.catalog.ts      pure  column mapping, rows to products, blocking issues
  deodap.pricing.ts      pure  markup / MRP pricing through common/money
  deodap.import.ts       pure  preview, drafts, import batch validation
  deodap.sync.ts         pure  price list vs import ledger
  deodap.orders.ts       pure  DeoDap lines, route per line, progress + attention
  deodap.service.ts            MongoDB, Shopify, encryption
  deodap.controller.ts         routes under /api/suppliers/deodap
src/intelligence/providers/deodap.provider.ts   research source, every capability false
```

Order progress uses `resolveShipment` from the dropshipping module, and "late" uses the
dropshipping SLA settings. So the DeoDap orders page and the dropshipping dashboard
always agree about an order.

### Collections

- **`supplier_connections`**: one per shop and provider. Holds the settings and the
  encrypted credentials.
- **`supplier_imports`**: the CSV import ledger, one row per product, with a unique index
  on `(shopDomain, provider, refKey)`. The row is claimed **before** the first Shopify
  write.
- **`supplier_orders`**: one per Shopify order. Holds DeoDap's order number, status and
  tracking. No customer data.

Costs are stored where every other manual cost is: `supplier_products`, with
`costSource: MANUAL` and `provider: DEODAP`.

## Safety properties

- **Imports:**
  - Every product is created as a **DRAFT**.
  - A missing or unreadable cost blocks a product. A price below the DeoDap cost is refused.
  - An import batch is validated in full before the first Shopify write.
  - `Idempotency-Key`, the ledger claim and a Shopify SKU check stop duplicates.
- **Orders:** an order DeoDap's app never picks up still surfaces, because it breaches the
  processing SLA. That includes cash-on-delivery orders, which the paid-only dashboard
  SLA would miss.
- **Descriptions** are sanitised: no scripts, event handlers, `javascript:` or links.
- **Currency:** the store currency must match the DeoDap currency. Trademart does not convert.
- **Credentials:** encrypted with AES-256-GCM, and never logged, audited or returned.
- **Access:** every route requires an operator, reads included.

## Adding a DeoDap API later

If DeoDap provides API documentation and access:

1. Implement `DeodapApiClient` in `deodap.api.ts` and return it from
   `createDeodapApiClient()`. Decrypt credentials with
   `decryptSecret(row.credentialsEncrypted, decodeEncryptionKey(TOKEN_ENCRYPTION_KEY))`.
2. Set `DEODAP_API_AVAILABILITY.available` to `true`. Flip only the capabilities it
   really supports, in `deodap.provider.ts` and `intelligence/providers/deodap.provider.ts`.
3. Feed `getStock()` into `planCostSync()`. Place orders from `extractDeodapLines()`,
   reading the address from Shopify at that moment and never storing it. Record the
   result with `placedVia: API`.
4. List new routes in `docs/ROUTE_SECURITY.md`. The route inventory test enforces this.
