/**
 * Shared shape for external platform integrations.
 *
 * Defined now so Meta/Google can be added later without reshaping the backend.
 * No implementation beyond Shopify exists in this milestone.
 */

export type IntegrationStatus = 'IMPLEMENTED' | 'PLACEHOLDER';

export interface IntegrationDescriptor {
  key: string;
  displayName: string;
  status: IntegrationStatus;
  /** Env var names required before the integration can be enabled. */
  requiredEnv: string[];
  documentation: string;
}

export interface AdPlatformProvider {
  descriptor: IntegrationDescriptor;
  /** Always false until real credentials and an implementation exist. */
  isConfigured(): boolean;
}
