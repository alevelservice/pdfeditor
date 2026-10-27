/** Parse "1-3,5,8-" (1-based, "all" or empty = every page) into 0-based indices. */
export function parseRange(spec: string, count: number): number[] {
  const out: number[] = [];
  const s = spec.trim();
  if (!s || s === 'all') return Array.from({ length: count }, (_, i) => i);
  for (const part of s.split(',')) {
    const m = /^\s*(\d*)\s*(-)?\s*(\d*)\s*$/.exec(part);
    if (!m) throw new Error(`Invalid page range "${part}"`);
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : count) : a;
    for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.push(i - 1);
  }
  return Array.from(new Set(out));
}
