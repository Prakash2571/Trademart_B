/**
 * Operational readiness of the CUSTOM HEADLESS storefront, as a pure function.
 *
 * WHAT AN OPERATOR ACTUALLY NEEDS TO KNOW
 * ---------------------------------------
 * "Is the headless store working?" decomposes into questions with different fixes,
 * and collapsing them into one boolean sends someone to the wrong place:
 *
 *   channelConfigured   Has anyone TOLD Trademart which publication is the custom
 *                       store? Fix: set SHOPIFY_HEADLESS_PUBLICATION_ID.
 *   channelResolved     Does that publication actually exist and is it visible to
 *                       this app? Fix: correct the id, or grant read_publications.
 *   canPublish          Does the app hold write_publications? Fix: reinstall with
 *                       the scope.
 *
 * Deliberately reports what it can VERIFY and stays silent about the rest. The
 * Storefront API access token lives in the storefront application, not in this
 * backend, so this module cannot claim the storefront can reach Shopify - it can
 * only report the publication precondition that must hold first. Claiming more
 * would be a green light that means nothing.
 *
 * Pure and dependency-free so it is exhaustively testable: the service that feeds it
 * imports the Shopify client and therefore the config singleton, which calls
 * process.exit(1) on invalid env.
 */

import type { Publication, SalesChannelSelector } from './publications.types';

export interface HeadlessChannelStatus {
  /** An operator has named the channel in configuration. */
  channelConfigured: boolean;
  /** How it was named - the id when present, otherwise the name. Never a secret. */
  configuredAs: string | null;
  /** Shopify confirmed a publication matching the configuration. */
  channelResolved: boolean;
  /** The resolved channel. Null when unconfigured or not found. */
  channel: Publication | null;
  /** The app holds write_publications, so an operator can publish from here. */
  canPublish: boolean;
  /** The app holds read_publications, without which nothing can be confirmed. */
  canReadPublications: boolean;
  /**
   * Every precondition Trademart can verify is satisfied. NOT a promise that the
   * storefront app is deployed or that its Storefront API token works - those live
   * outside this backend and are not checked here.
   */
  publicationReady: boolean;
  /** Always populated, and names the next action when something is missing. */
  reason: string;
}

export function resolveHeadlessChannelStatus(input: {
  selector: SalesChannelSelector | null;
  resolved: Publication | null;
  canReadPublications: boolean;
  canPublish: boolean;
}): HeadlessChannelStatus {
  const { selector, resolved, canReadPublications, canPublish } = input;

  const configuredAs =
    selector === null
      ? null
      : (selector.publicationId?.trim() || selector.name?.trim() || null);
  const channelConfigured = configuredAs !== null;
  const channelResolved = resolved !== null;
  const publicationReady = channelConfigured && channelResolved && canReadPublications;

  let reason: string;
  if (!channelConfigured) {
    reason =
      'No headless sales channel is configured, so no product can be reported as sellable on a custom storefront. Set SHOPIFY_HEADLESS_PUBLICATION_ID (preferred) or SHOPIFY_HEADLESS_CHANNEL_NAME.';
  } else if (!canReadPublications) {
    // Checked before "not found": without the scope, "not found" is meaningless.
    reason =
      'read_publications is not granted, so publication state cannot be confirmed for any channel. Reinstall the app with read_publications.';
  } else if (!channelResolved) {
    reason = `No publication matching ${configuredAs} exists on this shop, or it is not visible to this app. Check the value against GET /api/shopify/publications.`;
  } else if (!canPublish) {
    reason = `The headless channel ${resolved.name} is configured and found, but write_publications is not granted, so publication state can be READ here and not changed. Reinstall the app with write_publications.`;
  } else {
    reason = `The headless channel ${resolved.name} is configured, found, readable and writable. Publication can be controlled from here. This does not verify the storefront application's own Storefront API token, which lives outside this backend.`;
  }

  return {
    channelConfigured,
    configuredAs,
    channelResolved,
    channel: resolved,
    canPublish,
    canReadPublications,
    publicationReady,
    reason,
  };
}
