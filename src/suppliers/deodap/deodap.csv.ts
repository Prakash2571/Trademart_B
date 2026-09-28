/**
 * A small CSV reader - pure, no dependencies.
 *
 * Follows RFC 4180 where it matters for spreadsheet exports:
 *   - quoted fields may contain the delimiter, line breaks and doubled quotes ("")
 *   - CRLF, LF and lone CR line endings are all accepted
 *   - a UTF-8 byte order mark (Excel adds one) is removed
 *   - blank lines are skipped
 *
 * And it is lenient where spreadsheets are sloppy: a stray quote inside an unquoted
 * field is kept as a character, and a short row is padded with empty cells.
 *
 * The delimiter is detected from the header line (comma, semicolon or tab), because
 * spreadsheet software in some locales saves "CSV" with semicolons.
 *
 * Line numbers are reported as a spreadsheet shows them (the header is line 1), so a
 * preview can say "line 14" and the operator can find it.
 */

import { AppError } from '../../common/errors';

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvRecord {
  /** The line this record starts on, counting the header as line 1. */
  line: number;
  cells: string[];
}

export interface CsvTable {
  delimiter: CsvDelimiter;
  headers: string[];
  /** Data records, blank lines removed, each padded to the header width. */
  records: CsvRecord[];
}

export const CSV_LIMITS = Object.freeze({
  /** Characters. Keeps an upload comfortably under the API's 1 MB JSON body limit. */
  maxChars: 950_000,
  /** Data rows, header excluded. */
  maxRecords: 5_000,
  maxColumns: 250,
});

function fail(message: string): never {
  throw new AppError('VALIDATION_ERROR', message);
}

/**
 * Picks the delimiter that occurs most often on the header line, outside quotes.
 * Comma wins ties, since it is by far the most common.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') break;
    if (ch === ',') commas += 1;
    else if (ch === ';') semicolons += 1;
    else if (ch === '\t') tabs += 1;
  }
  if (semicolons > commas && semicolons >= tabs) return ';';
  if (tabs > commas && tabs > semicolons) return '\t';
  return ',';
}

/** Makes header names unique, so two columns called "Image" stay distinguishable. */
function uniqueHeaders(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}

/**
 * Parses CSV text into a header row and data records.
 *
 * Throws VALIDATION_ERROR for an empty file, a file with no data rows, a quoted value
 * that is never closed, or a file over the size limits.
 */
export function parseCsv(input: string): CsvTable {
  if (input.length > CSV_LIMITS.maxChars) {
    fail(
      `The file is too large to read in one go (${input.length.toLocaleString('en-US')} characters; the limit is ${CSV_LIMITS.maxChars.toLocaleString('en-US')}). Split it into smaller files and upload them one at a time.`,
    );
  }

  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);

  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordStart = 1;
  let quoteOpenedOn = 0;

  const endRecord = (): void => {
    cells.push(field);
    field = '';
    if (cells.some((cell) => cell.trim().length > 0)) {
      if (cells.length > CSV_LIMITS.maxColumns) {
        fail(
          `Line ${recordStart} has ${cells.length} columns; at most ${CSV_LIMITS.maxColumns} are supported.`,
        );
      }
      // +1 for the header row.
      if (records.length >= CSV_LIMITS.maxRecords + 1) {
        fail(
          `The file has more than ${CSV_LIMITS.maxRecords.toLocaleString('en-US')} rows. Split it into smaller files and upload them one at a time.`,
        );
      }
      records.push({ line: recordStart, cells });
    }
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);

    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(index + 1) === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r') {
        // CRLF or a lone CR inside a quoted value is one line break.
        if (text.charAt(index + 1) === '\n') index += 1;
        field += '\n';
        line += 1;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      quoteOpenedOn = line;
      continue;
    }
    if (ch === delimiter) {
      cells.push(field);
      field = '';
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text.charAt(index + 1) === '\n') index += 1;
      endRecord();
      line += 1;
      recordStart = line;
      continue;
    }
    field += ch;
  }

  if (inQuotes) {
    fail(
      `A quoted value starting on line ${quoteOpenedOn} is never closed. Check that line for a stray " character.`,
    );
  }
  if (field.length > 0 || cells.length > 0) endRecord();

  const [header, ...data] = records;
  if (header === undefined) fail('The file is empty.');
  if (data.length === 0) {
    fail('The file has a header row but no product rows.');
  }

  const headers = uniqueHeaders(
    header.cells.map((cell, index) => {
      const name = cell.trim();
      return name.length > 0 ? name : `Column ${index + 1}`;
    }),
  );

  return {
    delimiter,
    headers,
    records: data.map((record) => {
      const padded = record.cells.slice(0, headers.length);
      while (padded.length < headers.length) padded.push('');
      return { line: record.line, cells: padded };
    }),
  };
}
