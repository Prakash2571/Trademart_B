/**
 * Makes a supplier's product description safe to put on a storefront - pure.
 *
 * WHY THIS EXISTS
 * ---------------
 * A description from a supplier file is third-party HTML. Shopify stores
 * descriptionHtml as given and themes render it on the product page, so a <script>,
 * an onclick attribute or a javascript: link in a CSV would run in customers'
 * browsers. The operator did not write it and cannot review hundreds of rows by eye.
 *
 * WHAT IS KEPT
 * ------------
 * An allow-list of formatting tags, emitted with NO attributes, plus <img> with an
 * https src and nothing else. Every other tag is dropped but its text is kept.
 * Scripts, styles, frames, embeds and forms are dropped together with their content.
 * Any "<" or ">" that is not part of a tag we emitted is escaped, so the output
 * contains no markup this function did not write itself.
 *
 * Links (<a>) are dropped and their text kept. A supplier description often links
 * back to the supplier's own site, which a dropshipping store does not want to show.
 *
 * Plain text (no tags at all) is escaped and its blank-line paragraphs wrapped in <p>.
 */

export const MAX_DESCRIPTION_CHARS = 20_000;

/** Tags kept, always without attributes. */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'sub',
  'sup',
]);

/** Elements removed together with everything inside them. */
const DROPPED_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'svg',
  'math',
  'form',
  'textarea',
  'select',
  'button',
  'head',
  'title',
];

const VOID_TAGS = new Set(['br', 'hr', 'img']);

export interface SanitisedDescription {
  /** Null when there was no description. */
  html: string | null;
  /** Human-readable notes on what was removed, for the import preview. */
  removed: string[];
  truncated: boolean;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The https src of an <img> tag, or null. */
function imageSource(tag: string): string | null {
  const match = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  if (!/^https:\/\/[^\s"'<>]+$/i.test(raw)) return null;
  return raw;
}

/** Plain text: escaped, blank-line paragraphs in <p>, single line breaks as <br>. */
function fromPlainText(input: string): string {
  return input
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${escapeText(paragraph).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

function fromHtml(input: string, removed: Set<string>): string {
  let text = input.replace(/<!--[\s\S]*?-->/g, '');

  for (const tag of DROPPED_WITH_CONTENT) {
    const element = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    const before = text;
    text = text.replace(element, '');
    if (text !== before) removed.add('scripts, styles or embedded content');
  }

  // Walk the text. A sticky regex matches one tag exactly at the cursor, so this is
  // linear in the input size however many angle brackets it contains.
  const tagAt = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^<>]*>/y;
  let out = '';
  let index = 0;
  while (index < text.length) {
    const ch = text.charAt(index);
    if (ch === '<') {
      tagAt.lastIndex = index;
      const match = tagAt.exec(text);
      if (match !== null) {
        const closing = match[1] === '/';
        const name = (match[2] ?? '').toLowerCase();
        index += match[0].length;

        if (name === 'img') {
          if (closing) continue;
          const src = imageSource(match[0]);
          if (src === null) {
            removed.add('images without an https address');
            continue;
          }
          out += `<img src="${escapeAttribute(src)}" alt="">`;
          continue;
        }
        if (name === 'a') {
          removed.add('links');
          continue;
        }
        if ((DROPPED_WITH_CONTENT as readonly string[]).includes(name)) {
          // An unclosed <script> and the like: the tag goes, and its text is escaped
          // below like any other text.
          removed.add('scripts, styles or embedded content');
          continue;
        }
        if (/\son[a-z]+\s*=/i.test(match[0]) || /javascript:/i.test(match[0])) {
          removed.add('event handlers or javascript: addresses');
        }
        if (!ALLOWED_TAGS.has(name)) continue;
        if (VOID_TAGS.has(name)) {
          if (!closing) out += `<${name}>`;
          continue;
        }
        out += closing ? `</${name}>` : `<${name}>`;
        continue;
      }
      out += '&lt;';
      index += 1;
      continue;
    }
    if (ch === '>') {
      out += '&gt;';
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out.trim();
}

/** Turns a supplier description into storefront-safe HTML. */
export function sanitiseDescription(raw: string): SanitisedDescription {
  const input = raw.trim();
  if (input.length === 0) return { html: null, removed: [], truncated: false };

  const removed = new Set<string>();
  const looksLikeHtml = /<\/?[a-zA-Z][^<>]*>/.test(input);
  let html = looksLikeHtml ? fromHtml(input, removed) : fromPlainText(input);

  let truncated = false;
  if (html.length > MAX_DESCRIPTION_CHARS) {
    truncated = true;
    // Cut, then drop a tag the cut may have split in half.
    html = html.slice(0, MAX_DESCRIPTION_CHARS).replace(/<[^>]*$/, '');
  }

  // Formatting with no words in it is not a description.
  const visibleText = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (visibleText.length === 0 && !html.includes('<img')) {
    return { html: null, removed: [...removed], truncated };
  }

  return { html, removed: [...removed], truncated };
}
