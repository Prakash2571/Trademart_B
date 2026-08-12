/**
 * Supplier registry + classification.
 *
 * Adding CJdropshipping / AliExpress-compatible / direct manufacturer
 * providers later means appending to `providers` - no changes elsewhere.
 */

import { collectTradelleEvidence, tradelleProvider } from './tradelle/tradelle.provider';
import type {
  IdentificationResult,
  ProductIdentitySignals,
  SupplierProvider,
} from './supplier.types';

export const providers: SupplierProvider[] = [tradelleProvider];

export function getProvider(name: string): SupplierProvider | undefined {
  return providers.find(
    (provider) => provider.providerName.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * Classifies a product's supplier from Shopify data only.
 *
 *  - TRADELLE : a provider positively identified it with concrete evidence.
 *  - OTHER    : no provider matched, but a vendor is set, so the product has a
 *               known non-Tradelle source.
 *  - UNKNOWN  : not enough information to say anything.
 *
 * Pure and side-effect free, so it is directly unit testable.
 */
export function classifySupplier(signals: ProductIdentitySignals): IdentificationResult {
  const tradelleEvidence = collectTradelleEvidence(signals);
  if (tradelleEvidence.length > 0) {
    return { supplier: 'TRADELLE', evidence: tradelleEvidence };
  }

  const vendor = (signals.vendor ?? '').trim();
  if (vendor.length > 0) {
    return { supplier: 'OTHER', evidence: [`vendor="${vendor}"`] };
  }

  return { supplier: 'UNKNOWN', evidence: [] };
}
