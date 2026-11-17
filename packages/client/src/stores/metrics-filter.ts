/**
 * Facet-filter edits shared by the Usage, Runtime and Tokens stores. Each used
 * to carry its own copy of `toggleFilter`/`clearFilter`, and only two of the
 * three kept the comment explaining the empty-array rule below. That rule is
 * the one that matters.
 */
type DimFilter<D extends string> = Partial<Record<D, string[]>>;

/**
 * Add `value` to `dim`'s list, or take it out if it is already there.
 *
 * A list that empties is DELETED, not stored as `[]`. The server reads an
 * empty list as "match nothing", but what the user did was clear the filter,
 * which means "match everything".
 */
export function toggleFilterValue<D extends string>(
  filter: DimFilter<D>,
  dim: D,
  value: string,
): DimFilter<D> {
  const current = filter[dim] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const out = { ...filter };
  if (next.length) out[dim] = next;
  else delete out[dim];
  return out;
}

/** Drop one dimension's filter, or every filter when `dim` is omitted. */
export function clearFilterDim<D extends string>(filter: DimFilter<D>, dim?: D): DimFilter<D> {
  if (!dim) return {};
  const out = { ...filter };
  delete out[dim];
  return out;
}
