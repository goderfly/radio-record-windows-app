/**
 * Lightweight subsequence fuzzy match, in the spirit of fzf/sublime.
 * Returns a score (higher is better) or -1 when the needle cannot be found.
 * Cyrillic works because we operate on code points, not bytes.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  const exactIndex = h.indexOf(n);
  if (exactIndex === 0) return 1000 - haystack.length * 0.1;
  if (exactIndex > 0) return 700 - exactIndex - haystack.length * 0.1;

  let score = 0;
  let hi = 0;
  let streak = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found < 0) return -1;
    if (found === hi) {
      streak += 1;
      score += 12 + streak * 4;
    } else {
      streak = 0;
      score += 4;
    }
    hi = found + 1;
  }
  // Prefer shorter haystacks and matches near the start of the title.
  return score - haystack.length * 0.25 - (hi / Math.max(1, h.length)) * 20;
}

/** Best score across a station's searchable fields. */
export function scoreStation(
  station: { title: string; prefix: string; tooltip: string; genres: Array<{ name: string }> },
  query: string,
): number {
  const title = fuzzyScore(station.title, query);
  if (title >= 0) return title + 60;
  const genres = station.genres.map((g) => fuzzyScore(g.name, query)).filter((s) => s >= 0);
  const tooltip = fuzzyScore(station.tooltip, query);
  const prefix = fuzzyScore(station.prefix, query);
  const bestGenre = genres.length ? Math.max(...genres) : -1;
  return Math.max(bestGenre, tooltip * 0.5, prefix * 0.6);
}
