/**
 * Reading and writing the store's dropshipping settings.
 *
 * The IMPURE half: config and Mongo. The rules live in dropshipping.settings.ts, which is
 * pure and tested.
 *
 * PRECEDENCE, and why it is this way round
 * ---------------------------------------
 *   stored document  >  environment overrides  >  documented defaults
 *
 * The stored document wins because it is what the operator set through the UI, and a
 * setting that silently loses to an environment variable would be maddening: they change
 * a fee rate, the screen shows the old value, and nothing explains why. Environment
 * variables remain useful for bootstrapping a deployment before anyone has signed in.
 *
 * Reads DEGRADE rather than throw. Without a database the whole dropshipping view still
 * works on documented defaults, which is far more useful than a 503 on every screen.
 * Writes require a database, because a setting that appears to save and then vanishes is
 * worse than one that refuses.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import {
  DropshippingSettingsModel,
  type DropshippingSettingsDocument,
} from '../database/models/DropshippingSettings';
import type { PricingPolicy } from '../pricing/recommendation';
import {
  DEFAULT_DROPSHIP_COST_CONFIG,
  DEFAULT_SHIPPING_SLA,
  type DropshipCostConfig,
  type ShippingSla,
} from './dropshipping.types';
import {
  mergeDropshipSettings,
  validateDropshipSettings,
  type DropshipSettingsPatch,
  type DropshipSettingsRecord,
} from './dropshipping.settings';

/**
 * Settings from configuration alone - no database read.
 *
 * The synchronous fallback, and the base the stored document is layered onto. Kept
 * exported because the pure composition path needs a settings object without awaiting
 * anything.
 */
export function configuredSettings(): DropshipSettingsRecord {
  const overrides = (
    config as { dropshipping?: { cost?: Partial<DropshipCostConfig>; sla?: Partial<ShippingSla> } }
  ).dropshipping;

  return {
    cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, ...(overrides?.cost ?? {}) },
    sla: { ...DEFAULT_SHIPPING_SLA, ...(overrides?.sla ?? {}) },
    pricing: {},
  };
}

/** Reads the stored document, or null when there is none or no database. */
async function storedSettings(): Promise<DropshippingSettingsDocument | null> {
  if (getDatabaseStatus().status !== 'connected') return null;

  try {
    const row = await DropshippingSettingsModel.findOne({
      shopDomain: config.shopify.storeDomain,
    }).lean();
    return row === null ? null : (row as unknown as DropshippingSettingsDocument);
  } catch (error) {
    // A settings read failure must not blank the dashboard. The documented defaults are
    // still a coherent configuration, and the fallback is logged rather than silent.
    logger.warn('Could not read stored dropshipping settings; using configuration.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

export interface EffectiveSettings extends DropshipSettingsRecord {
  /** True when a stored document contributed. False means defaults or env only. */
  stored: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The settings every figure should be computed with.
 *
 * One function so the order view, the dashboard, the analytics and Research cannot
 * disagree about what the thresholds are.
 */
export async function loadSettings(): Promise<EffectiveSettings> {
  const base = configuredSettings();
  const row = await storedSettings();

  if (row === null) {
    return { ...base, stored: false, updatedAt: null, updatedBy: null };
  }

  const merged = mergeDropshipSettings(base, {
    ...(row.cost == null ? {} : { cost: row.cost as Partial<DropshipCostConfig> }),
    ...(row.sla == null ? {} : { sla: row.sla as Partial<ShippingSla> }),
    ...(row.pricing == null ? {} : { pricing: row.pricing as Partial<PricingPolicy> }),
  });

  // A stored document that no longer validates - because a later release tightened a
  // rule, say - is reported and IGNORED rather than used. Silently applying an invalid
  // configuration would produce figures that cannot be reproduced from the settings
  // screen, which is the specific failure the validator exists to prevent.
  const problems = validateDropshipSettings(merged);
  if (problems.length > 0) {
    logger.warn('Stored dropshipping settings are invalid and were ignored.', {
      problems,
    });
    return { ...base, stored: false, updatedAt: null, updatedBy: null };
  }

  return {
    ...merged,
    stored: true,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
    updatedBy: row.updatedBy ?? null,
  };
}

export interface SaveSettingsResult {
  settings: EffectiveSettings;
  /** What actually changed, for the audit trail. */
  changed: string[];
}

/**
 * Applies a patch and stores the result.
 *
 * Validates the MERGED record rather than the patch, because every interesting failure is
 * a combination: a target margin below a floor set in a previous request, or three
 * individually reasonable percentages that total 100. Validating the patch alone would
 * accept each half of a broken pair.
 */
export async function saveSettings(
  patch: DropshipSettingsPatch,
  actor: string | null = null,
): Promise<SaveSettingsResult> {
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'Saving dropshipping settings needs MongoDB. Set MONGODB_URI - without it the settings would appear to save and then vanish on the next request.',
    );
  }

  const current = await loadSettings();
  const merged = mergeDropshipSettings(current, patch);

  const problems = validateDropshipSettings(merged);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'These settings cannot be saved.', {
      details: { problems },
    });
  }

  const changed = describeChanges(current, merged);
  if (changed.length === 0) {
    // Nothing to write. Reported so the caller can skip an audit entry for a no-op
    // rather than filling the trail with saves that changed nothing.
    return { settings: current, changed: [] };
  }

  await DropshippingSettingsModel.updateOne(
    { shopDomain: config.shopify.storeDomain },
    {
      $set: {
        shopDomain: config.shopify.storeDomain,
        cost: merged.cost,
        sla: merged.sla,
        pricing: merged.pricing,
        updatedBy: actor,
      },
    },
    { upsert: true },
  );

  logger.info('Dropshipping settings updated.', { changed, actor });

  // Re-read through the same path every other caller uses, so the returned shape comes
  // from one place.
  return { settings: await loadSettings(), changed };
}

/**
 * Field-level diff, as `section.field: before -> after`.
 *
 * Recorded rather than storing the whole before/after document, so an audit entry reads as
 * a change instead of two blobs a human has to compare by eye.
 */
function describeChanges(
  before: DropshipSettingsRecord,
  after: DropshipSettingsRecord,
): string[] {
  const changes: string[] = [];

  for (const section of ['cost', 'sla', 'pricing'] as const) {
    const from = before[section] as Record<string, unknown>;
    const to = after[section] as Record<string, unknown>;
    const keys = new Set([...Object.keys(from), ...Object.keys(to)]);

    for (const key of [...keys].sort()) {
      if (from[key] === to[key]) continue;
      changes.push(`${section}.${key}: ${String(from[key] ?? 'unset')} -> ${String(to[key] ?? 'unset')}`);
    }
  }

  return changes;
}
