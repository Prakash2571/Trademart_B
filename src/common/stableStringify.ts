/**
 * Deterministic JSON, with object keys sorted.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * objects built by different code paths can serialise differently. Anything that
 * HASHES a structure therefore needs this instead - otherwise a purely cosmetic
 * key-order change (a round trip through the API, a different spread order)
 * produces a different hash and looks like a real difference.
 *
 * Two callers depend on that property, and both are safety mechanisms:
 *
 *   - the automation preview's rulesHash/planHash, where a spurious mismatch
 *     would reject a perfectly good apply as PREVIEW_STALE;
 *   - the Idempotency-Key request hash, where a spurious mismatch would reject a
 *     legitimate retry as IDEMPOTENCY_CONFLICT.
 *
 * Lives in common/ with no imports so both can share ONE implementation. Two
 * copies of a hashing primitive is how they drift apart.
 *
 * Array order IS preserved: in a list, order is meaningful data, not formatting.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      // `undefined` members are dropped so { a: 1 } and { a: 1, b: undefined }
      // agree - JSON.stringify omits them too, so keeping them would be a
      // difference that no consumer can observe.
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
