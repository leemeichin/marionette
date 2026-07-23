/** "Did you mean" suggestions shared by the validator and the CLI. */

/** Nearest name by edit distance (≤2), or null when nothing is close. */
export function nearest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const candidate of candidates) {
    const d = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDist) { bestDist = d; best = candidate; }
  }
  return best;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length; const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[n];
}
