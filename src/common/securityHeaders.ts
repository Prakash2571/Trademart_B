/**
 * Helmet configuration for the API.
 *
 * SCOPE NOTE: this backend serves JSON, not HTML. A Content-Security-Policy on a
 * JSON response does almost nothing - CSP governs how a *document* may load
 * subresources, and there is no document here. The meaningful CSP for this
 * product belongs on the Next.js frontend and on the nginx responses that serve
 * it, which is where it has been added.
 *
 * What IS worth setting here are the directives that still apply to a non-HTML
 * origin, and the ones that matter if a browser is ever pointed directly at an
 * API response:
 *
 *   default-src 'none'    an API response should pull in nothing at all
 *   frame-ancestors 'none' this origin must never be framed - it holds the
 *                          session cookie, so framing it invites clickjacking
 *                          against any HTML it might ever return
 *   base-uri / form-action / object-src  closed off for the same reason
 *
 * Deliberately NOT set: img-src and connect-src allowances for Shopify CDNs.
 * Those exist because the FRONTEND renders Shopify product images, so they belong
 * in the frontend's policy. Putting them here would suggest this origin serves
 * that content, which it does not.
 */

export interface HelmetOptions {
  contentSecurityPolicy: {
    useDefaults: false;
    directives: Record<string, string[]>;
  };
  crossOriginResourcePolicy: { policy: 'same-site' };
  referrerPolicy: { policy: 'no-referrer' };
  hsts:
    | false
    | { maxAge: number; includeSubDomains: boolean; preload: boolean };
}

export function helmetOptions(): HelmetOptions {
  return {
    contentSecurityPolicy: {
      // useDefaults would add script-src/style-src allowances that only make
      // sense for an HTML app; this policy is written out explicitly instead.
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'object-src': ["'none'"],
        // JSON error pages are the only thing that could ever be rendered from
        // this origin, and they need no connect target.
        'connect-src': ["'none'"],
        'img-src': ["'none'"],
        'style-src': ["'none'"],
        'script-src': ["'none'"],
      },
    },
    // Stops another site embedding responses from this origin as a resource.
    crossOriginResourcePolicy: { policy: 'same-site' },
    // A Shopify GID or a query string must not leak to a third party via Referer.
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS is terminated at nginx, which owns TLS. Setting it here as well is
    // harmless but nginx's value is the one that reaches the browser, so this is
    // left to helmet's default rather than duplicating a max-age that could drift.
    hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
  };
}
