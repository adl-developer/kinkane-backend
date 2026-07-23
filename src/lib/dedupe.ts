/**
 * Drops rows whose title duplicates one already kept, preserving the
 * incoming order (best match first) so the highest-ranked edition of a
 * title wins and later duplicates (different ISBN/edition, same title —
 * e.g. hardback vs paperback, or Vol. 1 vs Vol. 2) are dropped.
 */
export function dedupeByTitle<T extends { title: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = row.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

/**
 * Drops rows whose title+subtitle pair duplicates one already kept, preserving
 * the incoming order (best match first). Keyed on the pair rather than title
 * alone so distinct books that happen to share a title but differ in subtitle
 * (e.g. different anthologies) are not incorrectly collapsed.
 */
export function dedupeByTitleAndSubtitle<T extends { title: string; subtitle: string | null }>(
  rows: T[],
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = `${row.title.trim().toLowerCase()}|${row.subtitle?.trim().toLowerCase() ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}
