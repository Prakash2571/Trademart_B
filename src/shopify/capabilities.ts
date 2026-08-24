/**
 * Centralised Shopify scope + capability definitions.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Scope knowledge used to be scattered across a dozen places: a hardcoded
 * default list in env.validation.ts, prose in JSDoc headers, a `requiredScope`
 * string literal in themes.controller.ts, another in automation.controller.ts.
 * Nothing tied a scope to the operation that actually needs it, so the default
 * scope list drifted behind the code (it still requested read-only access long
 * after product/inventory writes shipped).
 *
 * Every scope Trademart needs is now derived from THIS catalogue:
 *   - DEFAULT_SHOPIFY_SCOPES (config) is computed from the implemented features
 *   - GET /api/shopify/capabilities reports the catalogue against what Shopify
 *     actually granted
 *
 * THE DISTINCTION THAT MATTERS
 * ----------------------------
 * A feature can be unavailable for two completely different reasons, and
 * conflating them sends the operator to the wrong place:
 *
 *   SCOPE_MISSING     the code exists; re-install/re-authorise the app with the
 *                     scope. Operator action: Partner Dashboard / SHOPIFY_SCOPES.
 *   NOT_IMPLEMENTED   Trademart has no code for this. Granting a scope changes
 *                     nothing. Operator action: none, wait for the feature.
 *
 * `write_themes` is the motivating example: granting it would NOT enable theme
 * editing here, because no theme-write code exists (and Shopify additionally
 * gates themeFilesUpsert behind a per-app exemption). Reporting that as
 * "scope missing" would be a lie that costs someone an afternoon.
 */

/**
 * Granting write access to a resource also grants read access to it, so
 * `write_products` alone is enough to read products.
 *
 * This is not a guess. The reference deployment's granted scope list contains
 * `write_products` and `write_inventory` but neither `read_products` nor
 * `read_inventory`, and product and inventory reads work against it.
 *
 * Treating write as implying read is also the safe direction of error: the
 * alternative would report `products.read: false` on a deployment where reading
 * demonstrably works, and send the operator off to add a scope they do not
 * need. If Shopify ever changes this, the cost is one over-optimistic line in a
 * diagnostics payload — the real request path still surfaces the truth as
 * SHOPIFY_SCOPE_MISSING.
 */
export function impliedScopes(granted: readonly string[]): Set<string> {
  const set = new Set(granted);
  for (const scope of granted) {
        if (scope.startsWith('write_')) set.add(`read_${scope.slice('write_'.length)}`);
  }
  return set;
}

export type CapabilityStatus =
  /** Implemented and every required scope is granted. */
  | 'AVAILABLE'
  /** Implemented, but Shopify has not granted a required scope. */
  | 'SCOPE_MISSING'
  /** No implementation exists. Granting scopes will not help. */
  | 'NOT_IMPLEMENTED'
  /** Implemented, but the granted scope list is unknown (static token). */
  | 'SCOPES_UNKNOWN';

export interface FeatureDefinition {
  /** Stable identifier, `group.action`. */
  readonly key: string;
  readonly group: string;
  readonly action: string;
  readonly title: string;
  /** Scopes that must be granted. Empty means no scope gates this. */
  readonly requiredScopes: readonly string[];
  /** Whether Trademart has code for this at all. */
  readonly implemented: boolean;
  /** Admin API operations performed, so a scope can be traced to a call. */
  readonly operations: readonly string[];
  /** HTTP surface exposing it. */
  readonly routes: readonly string[];
  readonly note?: string;
}

/**
 * Every Shopify-touching capability, implemented or not.
 *
 * Derived by auditing the GraphQL documents in ./graphql against the routes in
 * app.ts. Add an entry here when you add an operation — do not sprinkle scope
 * strings through controllers.
 */
export const SHOPIFY_FEATURES: readonly FeatureDefinition[] = Object.freeze([
  {
    key: 'shop.read',
    group: 'shop',
    action: 'read',
    title: 'Read shop profile',
    // The `shop` root field needs no scope; individual fields do. email and
    // billingAddress are withheld without approved protected-data access, which
    // is why getShop falls back to a reduced document and reports `degraded`.
    requiredScopes: [],
    implemented: true,
    operations: ['query TrademartShopInfo', 'query TrademartShopInfoBasic'],
    routes: ['GET /api/shopify/shop', 'GET /api/shopify/status'],
    note: 'shop.email and shop.country require approved protected customer data access; when withheld the reduced query is used and ShopDto.degraded lists the fields.',
  },
  {
    key: 'products.read',
    group: 'products',
    action: 'read',
    title: 'Read products and variants',
    requiredScopes: ['read_products'],
    implemented: true,
    operations: [
      'query TrademartProducts',
      'query TrademartProduct',
      'query TrademartCounts',
    ],
    routes: ['GET /api/shopify/products', 'GET /api/shopify/products/:id'],
  },
  {
    key: 'products.write',
    group: 'products',
    action: 'write',
    title: 'Edit products (title, description, vendor, type, status, tags, prices)',
    requiredScopes: ['write_products'],
    implemented: true,
    operations: [
      'mutation TrademartProductUpdate',
      'mutation TrademartProductStatusUpdate',
      'mutation TrademartTagsAdd',
      'mutation TrademartTagsRemove',
      'mutation TrademartVariantPriceUpdate',
    ],
    routes: ['PATCH /api/shopify/products/:id'],
  },
  {
    key: 'products.create',
    group: 'products',
    action: 'create',
    title: 'Create products with options, variants and media',
    requiredScopes: ['write_products'],
    implemented: true,
    operations: [
      'mutation TrademartProductCreate',
      'mutation TrademartVariantsBulkCreate',
    ],
    routes: ['POST /api/shopify/products'],
    note: 'Creates as DRAFT unless the caller explicitly asks otherwise. DRAFT/ACTIVE is not the same as published - see products.publish.',
  },
  {
    key: 'products.publish',
    group: 'products',
    action: 'publish',
    title: 'Publish a product to a sales channel (e.g. Online Store)',
    requiredScopes: ['write_publications'],
    implemented: true,
    operations: ['mutation TrademartPublishablePublish'],
    routes: ['POST /api/shopify/products/:id/publish'],
    note: "A product's ACTIVE status only clears the draft flag; it does not make the product visible. Publishing to the Online Store publication is what makes it purchasable. The publication id is discovered per shop, never hardcoded.",
  },
  {
    key: 'products.unpublish',
    group: 'products',
    action: 'unpublish',
    title: 'Remove a product from a sales channel',
    requiredScopes: ['write_publications'],
    implemented: true,
    operations: ['mutation TrademartPublishableUnpublish'],
    routes: ['POST /api/shopify/products/:id/unpublish'],
  },
  {
    key: 'publications.read',
    group: 'publications',
    action: 'read',
    title: 'List sales channels and a product\u2019s publication state',
    requiredScopes: ['read_publications'],
    implemented: true,
    operations: ['query TrademartPublications', 'query TrademartProductPublications'],
    routes: [
      'GET /api/shopify/publications',
      'GET /api/shopify/products/:id/publications',
    ],
  },
  {
    key: 'inventory.read',
    group: 'inventory',
    action: 'read',
    title: 'Read stock levels and unit cost',
    requiredScopes: ['read_inventory'],
    implemented: true,
    operations: ['query TrademartInventory', 'query TrademartInventoryItemProduct'],
    routes: ['GET /api/shopify/inventory'],
    note: 'Also gates variant.inventoryItem.unitCost, the SHOPIFY_UNIT_COST tier of the cost hierarchy.',
  },
  {
    key: 'inventory.write',
    group: 'inventory',
    action: 'write',
    title: 'Set stock quantities',
    // read_locations too: a quantity is meaningless without a location, and the
    // caller picks one from GET /api/shopify/locations.
    requiredScopes: ['write_inventory', 'read_locations'],
    implemented: true,
    operations: ['mutation TrademartInventorySet'],
    routes: ['POST /api/shopify/inventory/set'],
  },
  {
    key: 'locations.read',
    group: 'locations',
    action: 'read',
    title: 'List inventory locations',
    requiredScopes: ['read_locations'],
    implemented: true,
    operations: ['query TrademartLocations'],
    routes: ['GET /api/shopify/locations'],
  },
  {
    key: 'orders.read',
    group: 'orders',
    action: 'read',
    title: 'Read orders and fulfillments',
    requiredScopes: ['read_orders'],
    implemented: true,
    operations: ['query TrademartOrders', 'query TrademartOrder'],
    routes: ['GET /api/shopify/orders', 'GET /api/shopify/orders/:id'],
  },
  {
    key: 'customers.read',
    group: 'customers',
    action: 'read',
    title: 'Read customers',
    requiredScopes: ['read_customers'],
    implemented: true,
    operations: ['query TrademartCustomers', 'query TrademartCustomersCount'],
    routes: ['GET /api/shopify/customers'],
    note: 'read_customers alone is not always sufficient: customer PII additionally requires approved protected customer data access in the Partner Dashboard, which surfaces as "Access denied for customers field" even when the scope is granted.',
  },
  {
    key: 'themes.read',
    group: 'themes',
    action: 'read',
    title: 'List themes, identify the live theme, read theme files',
    requiredScopes: ['read_themes'],
    implemented: true,
    operations: ['query TrademartThemes', 'query TrademartThemeFiles'],
    routes: [
      'GET /api/shopify/themes',
      'GET /api/shopify/themes/:id/files',
      'GET /api/storefront/status',
    ],
  },
  {
    key: 'themes.write',
    group: 'themes',
    action: 'write',
    title: 'Edit or publish themes',
    requiredScopes: ['write_themes'],
    // The important false. Granting write_themes does NOT enable this.
    implemented: false,
    operations: [],
    routes: [],
    note: 'NOT IMPLEMENTED, and deliberately not requested. themeFilesUpsert and themeDuplicate require write_themes PLUS a Shopify-granted exemption, so requesting the scope would add install friction and still not work. Trademart never modifies the live theme.',
  },
  {
    key: 'webhooks.manage',
    group: 'webhooks',
    action: 'manage',
    title: 'Register and inspect webhook subscriptions',
    // There is no read_webhooks/write_webhooks scope. An app may always manage
    // its OWN subscriptions; what each topic needs is the read scope for the
    // data it carries (PRODUCTS_* -> read_products, ORDERS_* -> read_orders).
    requiredScopes: [],
    implemented: true,
    operations: [
      'query TrademartWebhookSubscriptions',
      'mutation TrademartWebhookSubscriptionCreate',
      'mutation TrademartWebhookSubscriptionUpdate',
      'mutation TrademartWebhookSubscriptionDelete',
    ],
    routes: ['POST /api/webhooks/register', 'GET /api/webhooks/subscriptions'],
    note: 'write_webhooks does not exist as a Shopify scope. Each subscribed topic instead requires the read scope covering its payload.',
  },

  // ---- Dropshipping operations -------------------------------------------
  //
  // These are Trademart features built ON Shopify reads, so they appear here for
  // the same reason the others do: the operator needs to know whether a screen
  // will work, and why not when it will not. Their required scopes are the scopes
  // of the Shopify data they normalise - there is no separate "dropshipping"
  // permission to grant.
  {
    key: 'dropshipping.orders.read',
    group: 'dropshipping',
    action: 'orders.read',
    title: 'Dropshipping order book',
    requiredScopes: ['read_orders'],
    implemented: true,
    operations: ['query TrademartOrders', 'query TrademartOrder'],
    routes: ['GET /api/dropshipping/orders', 'GET /api/dropshipping/orders/:id'],
    note: 'A normalised VIEW of Shopify orders. Nothing is duplicated into Trademart, and there is no write surface - fulfilling and refunding stay in Shopify.',
  },
  {
    key: 'dropshipping.fulfillment.read',
    group: 'dropshipping',
    action: 'fulfillment.read',
    title: 'Normalised fulfillment state',
    requiredScopes: ['read_orders'],
    implemented: true,
    operations: ['query TrademartOrders (fulfillments.displayStatus)'],
    routes: ['GET /api/dropshipping/orders', 'GET /api/dropshipping/dashboard'],
    note: "Collapses Shopify's three overlapping fulfillment fields into one progress state, always retaining the raw values.",
  },
  {
    key: 'dropshipping.tracking.read',
    group: 'dropshipping',
    action: 'tracking.read',
    title: 'Carrier tracking and delivery estimates',
    requiredScopes: ['read_orders'],
    implemented: true,
    operations: ['query TrademartOrders (fulfillments.trackingInfo, events)'],
    routes: ['GET /api/dropshipping/orders/:id'],
    note: 'Every parcel of a split shipment, plus carrier scan history and Shopify\u2019s own delivery estimate. Trademart never contacts a carrier directly.',
  },
  {
    key: 'dropshipping.analytics',
    group: 'dropshipping',
    action: 'analytics',
    title: 'Order economics, profit and supplier capital exposure',
    // read_inventory is what exposes inventoryItem.unitCost - Shopify's "cost per
    // item" - which is the only per-order supplier cost signal available. Without
    // it, every order's cost is honestly reported as UNKNOWN rather than guessed.
    requiredScopes: ['read_orders', 'read_inventory'],
    implemented: true,
    operations: ['query TrademartOrders (variant.inventoryItem.unitCost)'],
    routes: ['GET /api/dropshipping/dashboard'],
    note: 'Landed cost (owed to the supplier) is kept separate from commercial cost (landed + fees + allowances). Without read_inventory the screen still loads and reports costs as UNKNOWN - never as zero.',
  },
  {
    key: 'dropshipping.pricing',
    group: 'dropshipping',
    action: 'pricing',
    title: 'Dropshipping pricing settings and price recommendation',
    // No scope: this is arithmetic over costs Trademart already holds. It writes nothing
    // to Shopify, so there is no permission to grant.
    requiredScopes: [],
    implemented: true,
    operations: [],
    routes: [
      'GET /api/dropshipping/settings',
      'PUT /api/dropshipping/settings',
      'POST /api/intelligence/candidates/:id/analyze',
    ],
    note: 'Target-margin, markup and fixed-uplift strategies with Conservative/Balanced/Premium scenarios and per-candidate overrides. Enforces a minimum margin and a minimum contribution: a breaching scenario is shown as computed and marked not viable, alongside the price that would clear both floors, rather than being silently raised. Recommends only - it never changes a price in Shopify.',
  },
  {
    key: 'dropshipping.settings.write',
    group: 'dropshipping',
    action: 'settings.write',
    title: 'Edit dropshipping cost, SLA and pricing settings',
    requiredScopes: [],
    implemented: true,
    operations: [],
    routes: ['PUT /api/dropshipping/settings'],
    note: 'Persisted per shop in MongoDB, so a fee rate change does not need a redeploy. Requires a database: without one the settings would appear to save and vanish on the next request. Changes which orders are flagged and what price is recommended, never a price in Shopify.',
  },
  // ---- Product research / merchandising ----------------------------------
  //
  // The honest summary of this group: Trademart can measure what THIS STORE has done,
  // and it cannot measure the market. Store performance and fulfillment history come
  // from Shopify orders and are real. Demand, trend, competition and seasonality come
  // only from figures an operator reads elsewhere and types in, because Tradelle
  // publishes no API and the keyword integrations are not built.
  //
  // The two unbuilt entries are declared here rather than omitted, so
  // GET /api/shopify/capabilities reports them as NOT_IMPLEMENTED. An absent entry would
  // leave the UI free to imply a capability that does not exist.
  {
    key: 'research.candidates',
    group: 'research',
    action: 'candidates',
    title: 'Record and score product candidates',
    // Persistence is Trademart's own; nothing about a candidate touches Shopify until it
    // is pushed.
    requiredScopes: [],
    implemented: true,
    operations: [],
    routes: [
      'GET /api/intelligence/candidates',
      'POST /api/intelligence/candidates',
      'POST /api/intelligence/candidates/:id/analyze',
    ],
    note: 'Deterministic scoring over eight factors with published band tables - no model and no learned weights, so any score can be reproduced by hand. Requires MongoDB: a candidate does not exist in Shopify, so this is the one collection Trademart is the system of record for.',
  },
  {
    key: 'research.storeFit',
    group: 'research',
    action: 'storeFit',
    title: 'Judge a candidate against this store\u2019s own trading history',
    // read_orders for what sold and how it delivered; read_products to map a sale to its
    // category, since an order line carries no productType.
    requiredScopes: ['read_orders', 'read_products'],
    implemented: true,
    operations: ['query TrademartOrders', 'query TrademartProducts'],
    routes: ['POST /api/intelligence/candidates/:id/analyze'],
    note: 'The only MEASURED research signal, and what makes this more than a generic product-research tool. Measured delivery performance on comparable products LOWERS store fit, closing the loop from fulfillment back into research. Without these scopes store fit is reported as unscored - never as zero.',
  },
  {
    key: 'research.pushDraft',
    group: 'research',
    action: 'pushDraft',
    title: 'Create a Shopify DRAFT product from a candidate',
    requiredScopes: ['write_products'],
    implemented: true,
    operations: [
      'mutation TrademartProductCreate',
      'mutation TrademartVariantsBulkCreate',
    ],
    routes: ['POST /api/intelligence/candidates/:id/push'],
    note: 'Always a DRAFT. There is no publish parameter and no auto-publish: status DRAFT and publish false are hard-coded and asserted, and the created product is re-checked afterwards. Publishing remains a separate deliberate action through products.publish. Reuses the existing product create path rather than a second implementation, and records the candidate\u2019s supplier cost against the new variant so the margin is not entered twice.',
  },
  {
    key: 'research.duplicateDetection',
    group: 'research',
    action: 'duplicateDetection',
    title: 'Detect duplicates before pushing',
    requiredScopes: ['read_products'],
    implemented: true,
    operations: ['query TrademartProducts'],
    routes: ['GET /api/intelligence/candidates/:id/duplicates'],
    note: 'Exact identifiers, then exact normalised titles, then title-word overlap. Deliberately no stemming or fuzzy matching: a false positive blocks a legitimate push, and an operator who learns to click through a block stops reading it. Only exact matches block, and an archived product never does.',
  },
  {
    key: 'research.marketDemand',
    group: 'research',
    action: 'marketDemand',
    title: 'Measured search volume, trend and competition',
    // Would need the Google Ads keyword planning API. Declared with no scopes because a
    // SHOPIFY scope is not what is missing - this is a different vendor entirely.
    requiredScopes: [],
    // The important false. Demand IS scored today, but only from a figure an operator
    // typed in. Claiming this capability would imply Trademart measures the market.
    implemented: false,
    operations: [],
    routes: [],
    note: 'NOT IMPLEMENTED as a measurement. Demand, trend, competition and seasonality are scored only from figures an operator records by hand, and the score reports that as ESTIMATED confidence with the operator named as the source. Google Ads keyword planning would provide real volumes and is not built; Google Trends has no official public API at all. No Shopify scope affects this.',
  },
  {
    key: 'merchandising.recommendations',
    group: 'merchandising',
    action: 'recommendations',
    title: 'Automatic collection and merchandising recommendations',
    requiredScopes: [],
    implemented: false,
    operations: [],
    routes: [],
    note: 'Not implemented. Research recommends whether to STOCK a product; it does not recommend how to merchandise the existing catalogue (collection membership, bundling, cross-sells). Granting a scope would not enable it.',
  },

  {
    key: 'dropshipping.deposit',
    group: 'dropshipping',
    action: 'deposit',
    title: 'Partial payment / deposit orders',
    requiredScopes: [],
    // Deliberately false. Deposits need Shopify payment terms or checkout payment
    // customisation, which are plan- and API-gated. The brief is explicit that this
    // must be capability-driven and must NOT be simulated by changing a product
    // price - so it is declared unavailable rather than faked.
    implemented: false,
    operations: [],
    routes: [],
    note: 'Not implemented, and gated by the Shopify plan even once it is. Deposits will never be simulated by altering a product price; until real payment-terms support exists this reports as unavailable.',
  },
]);

/**
 * Scopes Trademart should request: the union required by IMPLEMENTED features.
 *
 * Unimplemented features are excluded on purpose — asking for permission you
 * cannot use costs install friction and merchant trust for nothing.
 */
export const REQUIRED_SCOPES: readonly string[] = Object.freeze(
  [
    ...new Set(
      SHOPIFY_FEATURES.filter((feature) => feature.implemented).flatMap(
        (feature) => feature.requiredScopes,
      ),
    ),
  ].sort(),
);

export interface FeatureReport extends FeatureDefinition {
  status: CapabilityStatus;
  /** True only when implemented AND every required scope is granted. */
  available: boolean;
  /** Required scopes Shopify did not grant. Empty when nothing is missing. */
  missingScopes: string[];
}

export interface CapabilityReport {
  /**
   * Compact view, `group -> action -> granted`.
   *
   * `null` means undeterminable rather than false: a static access token does
   * not report its scopes, and claiming `false` there would invent a problem.
   */
  capabilities: Record<string, Record<string, boolean | null>>;
  features: FeatureReport[];
  scopes: {
    /** What this build needs, derived from the feature catalogue. */
    required: readonly string[];
    /** What config asks for (SHOPIFY_SCOPES or the default list). */
    requested: readonly string[];
    /** What Shopify actually granted. Null when the strategy cannot report it. */
    granted: readonly string[] | null;
    /** Required but not granted. Empty when nothing is missing. */
    missing: readonly string[];
    /** Required but absent from the requested list — a config bug. */
    notRequested: readonly string[];
    /** Granted but unused by any implemented feature. */
    unused: readonly string[];
  };
}

/**
 * Evaluates the catalogue against the granted scope list.
 *
 * @param granted Scopes Shopify granted, or null when unknown (static token).
 * @param requested Scopes this build asks for, for drift detection.
 */
export function resolveCapabilities(
  granted: readonly string[] | null,
  requested: readonly string[],
): CapabilityReport {
  const grantedSet = granted === null ? null : impliedScopes(granted);
  const requestedSet = impliedScopes(requested);

  const features: FeatureReport[] = SHOPIFY_FEATURES.map((feature) => {
    const missingScopes =
      grantedSet === null
        ? []
        : feature.requiredScopes.filter((scope) => !grantedSet.has(scope));

    let status: CapabilityStatus;
    if (!feature.implemented) {
      // Checked first: an unimplemented feature's scope state is irrelevant.
      status = 'NOT_IMPLEMENTED';
    } else if (grantedSet === null && feature.requiredScopes.length > 0) {
      status = 'SCOPES_UNKNOWN';
    } else if (missingScopes.length > 0) {
      status = 'SCOPE_MISSING';
    } else {
      status = 'AVAILABLE';
    }

    return {
      ...feature,
      status,
      available: status === 'AVAILABLE',
      missingScopes,
    };
  });

  const capabilities: Record<string, Record<string, boolean | null>> = {};
  for (const feature of features) {
    const group = (capabilities[feature.group] ??= {});
    // An unimplemented feature is a hard false, not unknown: no scope grant
    // will make it work, so `null` ("might work") would mislead.
    group[feature.action] =
      feature.status === 'SCOPES_UNKNOWN' ? null : feature.available;
  }

  const missing =
    grantedSet === null
      ? []
      : REQUIRED_SCOPES.filter((scope) => !grantedSet.has(scope));

  const notRequested = REQUIRED_SCOPES.filter((scope) => !requestedSet.has(scope));

  const unused =
    granted === null
      ? []
      : granted.filter((scope) => {
          // Compare through implication: read_products is "used" when
          // write_products is what the catalogue asked for.
          const implied = impliedScopes([scope]);
          return !REQUIRED_SCOPES.some((required) => implied.has(required));
        });

  return {
    capabilities,
    features,
    scopes: {
      required: REQUIRED_SCOPES,
      requested: [...requested],
      granted: granted === null ? null : [...granted],
      missing,
      notRequested,
      unused,
    },
  };
}
