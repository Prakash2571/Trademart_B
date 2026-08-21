/**
 * GET /api/shopify/themes            - list themes (marks the live one)
 * GET /api/shopify/themes/:id/files  - read specific files (?filenames=a,b)
 * GET /api/storefront/status         - capabilities + honest limitations
 *
 * READ ONLY. There is no theme-write endpoint yet, by design: the live theme is
 * never modified directly. /api/storefront/status states plainly what is and is
 * not supported so the frontend never shows a control that does not exist.
 */

import { Router } from 'express';

import { AppError } from '../../common/errors';
import { asyncHandler, sendSuccess } from '../../common/http';
import { parseStringParam } from '../../common/validate';
import { SHOPIFY_FEATURES } from '../capabilities';
import { getLiveTheme, listThemes, readThemeFiles } from './themes.service';

export const themesRouter = Router();

themesRouter.get(
  '/shopify/themes',
  asyncHandler(async (_req, res) => {
    const themes = await listThemes();
    const live = themes.find((theme) => theme.live) ?? null;
    sendSuccess(res, { themes }, { count: themes.length, liveThemeId: live?.id ?? null });
  }),
);

themesRouter.get(
  '/shopify/themes/:id/files',
  asyncHandler(async (req, res) => {
    const rawId = req.params.id ?? '';
    // Theme GIDs look like gid://shopify/OnlineStoreTheme/123; accept a numeric
    // id too and normalise.
    const themeGid = rawId.startsWith('gid://shopify/OnlineStoreTheme/')
      ? rawId
      : /^\d+$/.test(rawId)
        ? `gid://shopify/OnlineStoreTheme/${rawId}`
        : null;
    if (themeGid === null) {
      throw new AppError(
        'VALIDATION_ERROR',
        'id must be a theme numeric id or a gid://shopify/OnlineStoreTheme/... value.',
      );
    }

    const raw = parseStringParam(req.query['filenames'], 'filenames', { maxLength: 1000 });
    const filenames = (raw ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (filenames.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Provide filenames to read, e.g. ?filenames=config/settings_data.json,templates/product.json',
      );
    }

    const result = await readThemeFiles(themeGid, filenames);
    sendSuccess(res, result);
  }),
);

themesRouter.get(
  '/storefront/status',
  asyncHandler(async (_req, res) => {
    // Honest capability reporting: only what actually exists is advertised.
    let liveThemeError: string | null = null;
    let live = null;
    try {
      live = await getLiveTheme();
    } catch (error) {
      liveThemeError = error instanceof AppError ? `${error.code}: ${error.message}` : 'unknown';
    }

    // Scope facts come from the central catalogue rather than literals here, so
    // this endpoint and GET /api/shopify/capabilities can never disagree.
    const themeRead = SHOPIFY_FEATURES.find((f) => f.key === 'themes.read');
    const themeWrite = SHOPIFY_FEATURES.find((f) => f.key === 'themes.write');

    sendSuccess(res, {
      liveTheme: live,
      liveThemeError,
      requiredScope: themeRead?.requiredScopes[0] ?? 'read_themes',
      capabilities: {
        listThemes: themeRead?.implemented ?? false,
        readThemeFiles: themeRead?.implemented ?? false,
        // False because no implementation exists - NOT because a scope is
        // missing. Reported so the UI never renders an editing control that
        // does not exist, and so nobody tries to "fix" this by granting
        // write_themes.
        editLiveTheme: false,
        editDraftTheme: themeWrite?.implemented ?? false,
        publishTheme: themeWrite?.implemented ?? false,
      },
      writeStatus: 'NOT_IMPLEMENTED',
      note: themeWrite?.note ?? 'Storefront/theme support is read-only.',
    });
  }),
);
