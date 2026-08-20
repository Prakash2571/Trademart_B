/**
 * Pure mappers from raw Shopify theme payloads to Trademart DTOs.
 *
 * No network, no imports beyond types, so the role/live derivation and the
 * file-body handling (text vs base64 vs url) are unit testable with recorded
 * payloads.
 */

import type { ThemeDto, ThemeFileDto, ThemeRole } from './theme.types';

const ROLES: readonly ThemeRole[] = [
  'MAIN',
  'UNPUBLISHED',
  'DEMO',
  'DEVELOPMENT',
  'ARCHIVED',
  'LOCKED',
];

interface RawTheme {
  id?: string;
  name?: string | null;
  role?: string | null;
  processing?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

function normaliseRole(raw: string | null | undefined): ThemeRole {
  const upper = (raw ?? '').toUpperCase();
  return (ROLES as readonly string[]).includes(upper) ? (upper as ThemeRole) : 'UNPUBLISHED';
}

export function mapTheme(raw: RawTheme): ThemeDto {
  const role = normaliseRole(raw.role);
  return {
    id: raw.id ?? '',
    name: raw.name ?? '(untitled theme)',
    role,
    processing: raw.processing === true,
    // The live theme is exactly the MAIN-role one - derived, never guessed.
    live: role === 'MAIN',
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

interface RawThemeFileNode {
  filename?: string;
  contentType?: string | null;
  size?: number | null;
  body?:
    | { content?: string }
    | { contentBase64?: string }
    | { url?: string }
    | null;
}

export function mapThemeFile(node: RawThemeFileNode): ThemeFileDto {
  const body = node.body ?? {};
  let content: string | null = null;
  let url: string | null = null;

  if ('content' in body && typeof body.content === 'string') {
    content = body.content;
  } else if ('contentBase64' in body && typeof body.contentBase64 === 'string') {
    // Decode text-ish assets; a binary blob stays null rather than showing junk.
    try {
      content = Buffer.from(body.contentBase64, 'base64').toString('utf8');
    } catch {
      content = null;
    }
  } else if ('url' in body && typeof body.url === 'string') {
    url = body.url;
  }

  return {
    filename: node.filename ?? '',
    contentType: node.contentType ?? null,
    size: typeof node.size === 'number' ? node.size : null,
    content,
    url,
  };
}
