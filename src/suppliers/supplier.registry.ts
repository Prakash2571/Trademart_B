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

export interface SupplierCostSupport {
  providerName: string;
  /** Whether an authoritative supplier cost feed exists. */
  supplierCostApi: boolean;
  /** Whether products arrive via the supplier's own Shopify app. */
  shopifyIntegration: boolean;
  /** Why supplierCostApi is false, when it is. */
  limitation: string | null;
}

/**
 * Per-provider cost-feed truth, for /api/automation/status.
 *
 * Reads the provider's DECLARED capabilities rather than probing for method
 * existence, so a method that exists only to return null cannot be reported as
 * a working integration.
 */
export function describeSupplierCostSupport(): SupplierCostSupport[] {
  return providers.map((provider) => ({
    providerName: provider.providerName,
    supplierCostApi: provider.capabilities.getSupplierCost,
    shopifyIntegration: provider.capabilities.shopifyIntegration,
    limitation: provider.capabilities.getSupplierCost
      ? null
      : (provider.limitations?.getSupplierCost ??
        'This provider does not expose a supplier cost API.'),
  }));
}

/** True when ANY registered provider has a real supplier cost feed. */
export function anySupplierCostApiAvailable(): boolean {
  return providers.some((provider) => provider.capabilities.getSupplierCost);
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
