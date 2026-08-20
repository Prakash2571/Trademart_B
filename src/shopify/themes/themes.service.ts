/**
 * Theme reads against the Shopify Admin API.
 *
 * READ ONLY by design. There is no write path here yet: the live theme must
 * never be modified directly (see theme.guard.ts), and the safe duplicate ->
 * edit -> preview -> publish workflow is a deliberate later feature. Exposing
 * read + honest capability reporting first matches the brief's guidance to
 * prepare the architecture without opening unrestricted live-theme editing.
 *
 * Requires the read_themes scope; a missing scope surfaces as
 * SHOPIFY_SCOPE_MISSING from the shared error mapper.
 */

import { logger } from '../../common/logger';
import { THEMES_QUERY, THEME_FILES_QUERY } from '../graphql/theme.queries';
import { shopifyGraphql, type GraphqlResult } from '../shopify.client';
import { mapTheme, mapThemeFile } from './theme.mappers';
import type { ThemeDto, ThemeFileDto } from './theme.types';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
/** Cap on files returned in one read, so a broad request can't pull a whole theme. */
const MAX_FILES = 25;

interface ThemesResponse {
  themes: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: Record<string, unknown> }[];
  } | null;
}

/** Lists all themes, newest pages last. */
export async function listThemes(): Promise<ThemeDto[]> {
  const all: ThemeDto[] = [];
  let after: string | null = null;
  let page = 0;

  while (page < MAX_PAGES) {
    page += 1;
    const result: GraphqlResult<ThemesResponse> = await shopifyGraphql<ThemesResponse>(
      THEMES_QUERY,
      { first: PAGE_SIZE, after },
      { operation: 'listThemes' },
    );
    const connection = result.data.themes;
    if (connection === null || connection === undefined) break;
    for (const edge of connection.edges) all.push(mapTheme(edge.node));
    if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) break;
    after = connection.pageInfo.endCursor;
  }
  return all;
}

/** The live (MAIN) theme, or null when none is reported. */
export async function getLiveTheme(): Promise<ThemeDto | null> {
  const themes = await listThemes();
  return themes.find((theme) => theme.live) ?? null;
}

interface ThemeFilesResponse {
  theme: {
    id: string;
    name: string;
    role: string;
    files: { edges: { node: Record<string, unknown> }[] } | null;
  } | null;
}

/**
 * Reads specific files from a theme by exact filename. Filenames are required so
 * this never bulk-downloads a theme; the count is capped regardless.
 */
export async function readThemeFiles(
  themeGid: string,
  filenames: string[],
): Promise<{ theme: ThemeDto | null; files: ThemeFileDto[] }> {
  const result = await shopifyGraphql<ThemeFilesResponse>(
    THEME_FILES_QUERY,
    { id: themeGid, filenames: filenames.slice(0, MAX_FILES), first: MAX_FILES },
    { operation: 'readThemeFiles' },
  );

  const raw = result.data.theme;
  if (raw === null || raw === undefined) return { theme: null, files: [] };

  const theme = mapTheme(raw);
  const files = (raw.files?.edges ?? []).map((edge) => mapThemeFile(edge.node));
  logger.info('Read theme files.', { themeId: theme.id, count: files.length });
  return { theme, files };
}
