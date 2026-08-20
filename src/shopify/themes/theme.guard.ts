/**
 * The single rule that makes storefront editing safe: NEVER modify the live
 * theme directly.
 *
 * Pure, and deliberately its own module so the rule is impossible to miss and
 * trivial to test. Any future write path (theme file upsert, settings change)
 * MUST route through assertThemeWritable first. The safe workflow is:
 *
 *   live (MAIN) theme  ->  duplicate to an UNPUBLISHED copy  ->  edit the copy
 *   ->  preview  ->  explicit publish
 *
 * so a mistake is confined to a draft the merchant chooses to publish, never
 * pushed straight to what customers see.
 */

import { AppError } from '../../common/errors';
import type { ThemeRole } from './theme.types';

/** Roles a write may target. MAIN (live) and locked/demo themes are excluded. */
const WRITABLE_ROLES: readonly ThemeRole[] = ['UNPUBLISHED', 'DEVELOPMENT'];

export function isLiveTheme(role: ThemeRole): boolean {
  return role === 'MAIN';
}

export function isWritableRole(role: ThemeRole): boolean {
  return (WRITABLE_ROLES as readonly string[]).includes(role);
}

/**
 * Throws unless the theme is safe to modify. Called before ANY theme write.
 *
 * The message is explicit about the safe path rather than a bare "forbidden",
 * so an operator understands why and what to do instead.
 */
export function assertThemeWritable(role: ThemeRole): void {
  if (isLiveTheme(role)) {
    throw new AppError(
      'THEME_PROTECTED',
      'Refusing to modify the LIVE (MAIN) theme directly. Duplicate it to an unpublished copy, edit and preview that, then publish deliberately.',
    );
  }
  if (!isWritableRole(role)) {
    throw new AppError(
      'THEME_PROTECTED',
      `Theme role ${role} is not editable via the API (it may be a demo, locked, or archived theme).`,
    );
  }
}
