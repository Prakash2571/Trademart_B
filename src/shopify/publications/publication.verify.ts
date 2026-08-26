/**
 * Does the post-write publication state match what was asked for?
 *
 * WHY A WRITE IS NOT EVIDENCE OF A WRITE
 * --------------------------------------
 * `publishablePublish` returning an empty userErrors array means Shopify ACCEPTED
 * the mutation. It does not mean the product is now published on that channel. The
 * service already re-fetched the state afterwards and returned it unexamined, so a
 * write that did not take effect was reported to the operator as success - and
 * "Trademart says published, Shopify says otherwise" is the exact failure the whole
 * publications module exists to prevent.
 *
 * Pure and dependency-free so it can be tested exhaustively: publications.service.ts
 * imports the Shopify client and therefore the config singleton, which calls
 * process.exit(1) on invalid env.
 */

import type { ProductPublicationState } from './publications.types';

export interface PublicationVerificationTarget {
  id: string;
  name: string;
}

/**
 * Returns one human-readable failure per target whose state does not match intent.
 * An empty array means the read-back confirmed the write.
 *
 * A target ABSENT from the read-back is a failure, not an unverifiable maybe: the
 * caller named a specific channel and Shopify did not confirm the outcome on it.
 */
export function verifyPublicationState(input: {
  targets: readonly PublicationVerificationTarget[];
  state: readonly ProductPublicationState[];
  expected: 'published' | 'unpublished';
}): string[] {
  const wantPublished = input.expected === 'published';
  const failures: string[] = [];

  for (const target of input.targets) {
    const entry = input.state.find((candidate) => candidate.publicationId === target.id);
    if (entry === undefined) {
      failures.push(`${target.name} is absent from the product's publication state`);
      continue;
    }
    if (entry.isPublished !== wantPublished) {
      failures.push(
        `${target.name} still reports isPublished=${String(entry.isPublished)}, expected ${String(wantPublished)}`,
      );
    }
  }

  return failures;
}
