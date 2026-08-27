/**
 * Minimum order quantity, read from Shopify product tags.
 *
 * WHY A TAG, AND WHY THIS IS THE ONLY SOURCE
 * ------------------------------------------
 * Kanay is a wholesale marketplace, so "how few of these may I buy" is commercial
 * information the merchant owns. Shopify has no native MOQ field, which leaves three
 * options: a metafield (needs a definition, an app scope and a migration), an admin-side
 * table in Mongo (a second place for merchandising to drift from the catalog), or a tag.
 *
 * A tag wins on one property that matters more than elegance: the merchant can set it in
 * the Shopify admin they already use, on the product they are already editing, and the
 * value travels with the product through every export, duplicate and channel. It is also
 * visible - if the storefront says MOQ 12, someone can look at the product and see why.
 *
 * FORMAT
 * ------
 *   moq:12        -> minimum order quantity of 12
 *   MOQ: 12       -> same (case and spaces around the colon are tolerated)
 *
 * Anything else is IGNORED rather than guessed at. A malformed tag (`moq:ten`,
 * `moq:0`, `moq:-5`, `moq:1e3`) yields null, which the storefront renders as "no minimum"
 * - the honest reading. Inventing a minimum from a typo would either block a legitimate
 * order or advertise a quantity rule the merchant never set.
 *
 * A DELIBERATE NON-FEATURE
 * ------------------------
 * There is no default MOQ. A product with no tag has no minimum, and the UI shows nothing
 * rather than "MOQ 1" - which is noise on every product in a catalog that mostly has no
 * minimum, and which would make a real MOQ 1 (a merchant explicitly saying "single units
 * are fine") indistinguishable from an untagged product.
 */

/**
 * Upper bound on a parsed MOQ.
 *
 * Not arbitrary: it matches MAX_LINE_QUANTITY in checkout.validation.ts. An MOQ above the
 * per-line quantity cap would be unsatisfiable - the storefront would display a minimum
 * the checkout is guaranteed to reject - so a tag claiming one is treated as malformed.
 */
export const MAX_MINIMUM_ORDER_QUANTITY = 10_000;

/** `moq:12`, `MOQ : 12`, `moq-12` are all accepted; the captured group is the number. */
const MOQ_TAG = /^\s*moq\s*[:=-]\s*(\d{1,6})\s*$/i;

/**
 * Reads the MOQ from a product's tags, or null when none is set.
 *
 * When several MOQ tags are present the LARGEST wins. That is the conservative reading: two
 * contradictory tags are a merchant mistake, and honouring the smaller one would let an
 * order through that one of the two rules forbids.
 */
export function parseMinimumOrderQuantity(tags: readonly string[] | null | undefined): number | null {
  if (!tags) return null;

  let best: number | null = null;
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const match = MOQ_TAG.exec(tag);
    if (match === null) continue;

    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) continue;
    // 0 and negatives cannot be a minimum; above the cap is unsatisfiable at checkout.
    if (value < 1 || value > MAX_MINIMUM_ORDER_QUANTITY) continue;

    if (best === null || value > best) best = value;
  }

  return best;
}

/**
 * The smallest total order value for a line, in paise, or null when either input is unknown.
 *
 * Exposed so the storefront can show "Minimum order ₹3,490" from the SAME arithmetic the
 * backend uses, instead of multiplying a formatted price string in the browser.
 */
export function minimumOrderValuePaise(
  unitPricePaise: number | null,
  minimumOrderQuantity: number | null,
): number | null {
  if (unitPricePaise === null || minimumOrderQuantity === null) return null;
  if (!Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) return null;
  const total = unitPricePaise * minimumOrderQuantity;
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Whether a requested quantity satisfies a product's minimum.
 *
 * Absent MOQ means no constraint. This is the predicate the checkout enforces server-side;
 * the storefront uses the same rule to disable the button early, but the storefront's copy
 * of it is a convenience, never the control.
 */
export function meetsMinimumOrderQuantity(
  quantity: number,
  minimumOrderQuantity: number | null,
): boolean {
  if (minimumOrderQuantity === null) return true;
  return Number.isSafeInteger(quantity) && quantity >= minimumOrderQuantity;
}
