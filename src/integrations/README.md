# Integrations

Placeholder structure only. Shopify is the first and currently the only
implemented integration.

```
integrations/
├── shopify/   -> implemented; see ../shopify
├── meta/      -> placeholder (Meta Ads API, NOT implemented)
└── google/    -> placeholder (Google Ads API, NOT implemented)
```

Nothing in `meta/` or `google/` performs network calls. They exist so ad
platforms can be added later without restructuring the backend.

Target once (and only once) Shopify is complete:

```
Meta Ads / Google Ads -> Trademart -> Shopify -> Supplier
```
