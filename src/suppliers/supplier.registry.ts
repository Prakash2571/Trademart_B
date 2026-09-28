/**
 * Supplier registry + classification.
 *
 * Adding CJdropshipping / AliExpress-compatible / direct manufacturer
 * providers later means appending to `providers` - no changes elsewhere.
 */

import { collectDeodapEvidence } from './deodap/deodap.identify';
import { deodapProvider } from './deodap/deodap.provider';
import { collectTradelleEvidence, tradelleProvider } from './tradelle/tradelle.provider';
import type {
  IdentificationResult,
  ProductIdentitySignals,
  SupplierProvider,
} from './supplier.types';

export const providers: SupplierProvider[] = [tradelleProvider, deodapProvider];

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
 *  - TRADELLE : the Tradelle provider positively identified it with concrete evidence.
 *  - DEODAP   : the DeoDap provider did (vendor, tag, fulfillment service or a
 *               configured SKU prefix). Checked after Tradelle, so a product carrying
 *               both markers keeps the classification it had before DeoDap existed.
 *  - OTHER    : no provider matched, but a vendor is set, so the product has a
 *               known source that is not a registered provider.
 *  - UNKNOWN  : not enough information to say anything.
 *
 * Side-effect free. The only state it reads is the DeoDap SKU prefix list, which is
 * configuration held in memory (see deodap.identify.ts).
 */
export function classifySupplier(signals: ProductIdentitySignals): IdentificationResult {
  const tradelleEvidence = collectTradelleEvidence(signals);
  if (tradelleEvidence.length > 0) {
    return { supplier: 'TRADELLE', evidence: tradelleEvidence };
  }

  const deodapEvidence = collectDeodapEvidence(signals);
  if (deodapEvidence.length > 0) {
    return { supplier: 'DEODAP', evidence: deodapEvidence };
  }

  const vendor = (signals.vendor ?? '').trim();
  if (vendor.length > 0) {
    return { supplier: 'OTHER', evidence: [`vendor="${vendor}"`] };
  }

  return { supplier: 'UNKNOWN', evidence: [] };
}
