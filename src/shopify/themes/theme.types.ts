/**
 * Theme DTOs and roles.
 *
 * Kept separate from the queries/service so the pure mapper and guard can be
 * unit tested without a network.
 */

export type ThemeRole = 'MAIN' | 'UNPUBLISHED' | 'DEMO' | 'DEVELOPMENT' | 'ARCHIVED' | 'LOCKED';

export interface ThemeDto {
  id: string;
  name: string;
  role: ThemeRole;
  /** True while Shopify is still processing an upload; not safe to edit yet. */
  processing: boolean;
  /** True for the theme currently live on the storefront (role MAIN). */
  live: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ThemeFileDto {
  filename: string;
  contentType: string | null;
  size: number | null;
  /** Text content when the file is text; null for binary/url-only bodies. */
  content: string | null;
  /** Set for binary assets served by URL rather than inline. */
  url: string | null;
}
