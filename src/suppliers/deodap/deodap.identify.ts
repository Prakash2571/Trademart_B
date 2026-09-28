/**
 * DeoDap product identification - pure.
 *
 * WHAT COUNTS AS EVIDENCE
 * -----------------------
 * Only signals that someone deliberately wrote into Shopify. The title is never used.
 *
 *   vendor               Trademart's DeoDap importer sets the vendor to "DeoDap".
 *   tag                  The importer also adds the tag "DeoDap".
 *   fulfillment service  In case a DeoDap fulfillment service is ever routed to.
 *   SKU prefix           Only prefixes the operator configured on the DeoDap page.
 *                        There is no built-in list, because DeoDap does not publish
 *                        a SKU format and a guessed prefix would misattribute
 *                        products from other suppliers.
 *
 * Matching ignores case, spaces, dots, dashes and underscores, so "Deo Dap" and
 * "deo-dap" both count.
 *
 * WHY THE SKU PREFIXES ARE MODULE STATE
 * -------------------------------------
 * classifySupplier() is pure and synchronous, and it runs inside the Shopify mappers
 * for every product and order line. It cannot read MongoDB. The prefixes are stored
 * with the DeoDap settings, loaded here once at startup, and replaced whenever the
 * settings are saved (deodap.service.ts). That is correct for this deployment, which
 * is a single process by design (see automation.lock.ts). Tests pass prefixes in
 * explicitly instead of relying on this state.
 */

import type { ProductIdentitySignals } from '../supplier.types';

/** The vendor Trademart writes on every product it imports from DeoDap. */
export const DEODAP_VENDOR = 'DeoDap';

/** The tag Trademart writes on every product it imports from DeoDap. */
export const DEODAP_TAG = 'DeoDap';

/** At most this many SKU prefixes. More than a handful is a sign of a mistake. */
export const MAX_SKU_PREFIXES = 10;
export const MAX_SKU_PREFIX_LENGTH = 20;

/**
 * Letters and digits first, then letters, digits, dot, dash, underscore or slash.
 * Starting with a letter or digit rules out a prefix of "-" matching everything that
 * happens to start with a dash.
 */
export const SKU_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const MARKER = 'deodap';

/** Lowercased, with spaces, dots, dashes and underscores removed. */
function compact(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s._-]+/g, '');
}

/**
 * Cleans a prefix list: trimmed, invalid entries dropped, duplicates removed
 * case-insensitively, capped at MAX_SKU_PREFIXES. Order is kept.
 *
 * Rejecting bad input with a message is deodap.settings.ts's job. This only makes
 * sure nothing unusable reaches the matcher.
 */
export function normaliseSkuPrefixes(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const prefix = entry.trim();
    if (prefix.length === 0 || prefix.length > MAX_SKU_PREFIX_LENGTH) continue;
    if (!SKU_PREFIX_PATTERN.test(prefix)) continue;
    const key = prefix.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(prefix);
    if (out.length === MAX_SKU_PREFIXES) break;
  }
  return out;
}

let configuredSkuPrefixes: readonly string[] = Object.freeze([]);

/** Replaces the prefixes classifySupplier() matches against. */
export function setDeodapSkuPrefixes(prefixes: readonly string[]): void {
  configuredSkuPrefixes = Object.freeze(normaliseSkuPrefixes(prefixes));
}

/** The prefixes currently in effect. */
export function getDeodapSkuPrefixes(): readonly string[] {
  return configuredSkuPrefixes;
}

/**
 * The reasons a product or order line is attributed to DeoDap. An empty list means
 * no match.
 *
 * `skuPrefixes` defaults to the configured prefixes. Tests pass their own.
 */
export function collectDeodapEvidence(
  signals: ProductIdentitySignals,
  skuPrefixes: readonly string[] = configuredSkuPrefixes,
): string[] {
  const evidence: string[] = [];

  if (compact(signals.vendor).includes(MARKER)) {
    evidence.push(`vendor="${signals.vendor ?? ''}"`);
  }

  for (const tag of signals.tags ?? []) {
    if (compact(tag).includes(MARKER)) evidence.push(`tag="${tag}"`);
  }

  for (const service of signals.fulfillmentServices ?? []) {
    if (service && compact(service).includes(MARKER)) {
      evidence.push(`fulfillmentService="${service}"`);
    }
  }

  const prefixes = normaliseSkuPrefixes(skuPrefixes);
  if (prefixes.length > 0) {
    const lowered = prefixes.map((prefix) => prefix.toLowerCase());
    // Only the first matching SKU is reported. A product with twenty matching
    // variants is not twenty times as much evidence.
    for (const sku of signals.skus ?? []) {
      const value = (sku ?? '').trim();
      if (value.length === 0) continue;
      const index = lowered.findIndex((prefix) => value.toLowerCase().startsWith(prefix));
      if (index !== -1) {
        evidence.push(`sku="${value}" matches prefix "${prefixes[index] ?? ''}"`);
        break;
      }
    }
  }

  return evidence;
}
