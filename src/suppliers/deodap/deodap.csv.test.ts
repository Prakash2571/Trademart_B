/**
 * The CSV reader: the spreadsheet cases that break naive split(',') parsing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import { CSV_LIMITS, detectDelimiter, parseCsv } from './deodap.csv';

function isValidationError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'VALIDATION_ERROR';
}

describe('parseCsv', () => {
  it('reads a header and rows', () => {
    const table = parseCsv('Title,SKU,Price\nBottle,DD-1,199\nJar,DD-2,99\n');
    assert.deepEqual(table.headers, ['Title', 'SKU', 'Price']);
    assert.deepEqual(
      table.records.map((record) => record.cells),
      [
        ['Bottle', 'DD-1', '199'],
        ['Jar', 'DD-2', '99'],
      ],
    );
  });

  it('keeps delimiters, doubled quotes and line breaks inside quoted values', () => {
    const table = parseCsv('Title,Description\n"Bottle, steel","Holds 1 ""litre""\nDishwasher safe"\n');
    assert.deepEqual(table.records[0]?.cells, ['Bottle, steel', 'Holds 1 "litre"\nDishwasher safe']);
  });

  it('reports line numbers as a spreadsheet shows them, even after a multi-line value', () => {
    const table = parseCsv('Title,Notes\nA,"one\ntwo"\nB,x\n');
    assert.deepEqual(
      table.records.map((record) => record.line),
      [2, 4],
    );
  });

  it('accepts CRLF and lone CR line endings', () => {
    assert.equal(parseCsv('Title\r\nA\r\nB').records.length, 2);
    assert.equal(parseCsv('Title\rA\rB').records.length, 2);
  });

  it('removes the byte order mark Excel adds', () => {
    assert.deepEqual(parseCsv('\uFEFFTitle,SKU\nA,1').headers, ['Title', 'SKU']);
  });

  it('skips blank lines and pads short rows', () => {
    const table = parseCsv('Title,SKU,Price\n\nA,1\n , , \nB,2,3\n');
    assert.deepEqual(
      table.records.map((record) => record.cells),
      [
        ['A', '1', ''],
        ['B', '2', '3'],
      ],
    );
  });

  it('names blank headers and keeps duplicate headers distinguishable', () => {
    assert.deepEqual(parseCsv('Image,,Image\n1,2,3').headers, ['Image', 'Column 2', 'Image (2)']);
  });

  it('keeps a stray quote in an unquoted value as a character', () => {
    assert.equal(parseCsv('Title\n5" screen').records[0]?.cells[0], '5" screen');
  });

  it('refuses an unclosed quote and says where it starts', () => {
    assert.throws(
      () => parseCsv('Title\nA\n"never closed\nB'),
      (error: unknown) => isValidationError(error) && /line 3/.test((error as Error).message),
    );
  });

  it('refuses an empty file and a header with no rows', () => {
    assert.throws(() => parseCsv(''), isValidationError);
    assert.throws(() => parseCsv('Title,SKU\n'), isValidationError);
  });

  it('refuses a file over the size limit before reading it', () => {
    assert.throws(() => parseCsv('x'.repeat(CSV_LIMITS.maxChars + 1)), isValidationError);
  });
});

describe('detectDelimiter', () => {
  it('detects semicolons and tabs, and prefers commas on a tie', () => {
    assert.equal(detectDelimiter('Title;SKU;Price\nA;1;2'), ';');
    assert.equal(detectDelimiter('Title\tSKU\tPrice'), '\t');
    assert.equal(detectDelimiter('Title,SKU;Price'), ',');
    assert.equal(detectDelimiter('Title'), ',');
  });

  it('ignores delimiters inside quoted headers', () => {
    assert.equal(detectDelimiter('"Name, full";SKU;Price'), ';');
  });

  it('parses a semicolon file', () => {
    assert.deepEqual(parseCsv('Title;Price\nA;1,50').records[0]?.cells, ['A', '1,50']);
  });
});
