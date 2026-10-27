/**
 * Groups text runs into lines (shared baseline) and blocks (paragraphs).
 */
import { mul, unionRect } from './geom';
import type { Rect, TextBlock, TextLine, TextRun } from './types';

interface RunGeo {
  run: TextRun;
  angle: number;
  u0: number;
  u1: number;
  v: number;
  size: number;
}

interface LineGeo {
  id: string;
  runs: RunGeo[];
  angle: number;
  u0: number;
  u1: number;
  v: number;
  size: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function geo(run: TextRun): RunGeo {
  const m = mul(run.textMatrix, run.ctm);
  const scaleX = Math.hypot(m[0], m[1]);
  const scaleY = Math.hypot(m[2], m[3]);
  const angle = Math.round(run.rotation / 2) * 2;
  const c = Math.cos(rad(angle));
  const s = Math.sin(rad(angle));
  const u = run.origin.x * c + run.origin.y * s;
  const v = -run.origin.x * s + run.origin.y * c;
  const len = run.advance * scaleX;
  return { run, angle, u0: Math.min(u, u + len), u1: Math.max(u, u + len), v, size: Math.abs(run.fontSize * scaleY) || 1 };
}

export function effectiveFontSize(run: TextRun): number {
  const m = mul(run.textMatrix, run.ctm);
  return Math.abs(run.fontSize * Math.hypot(m[2], m[3])) || run.fontSize;
}

export function groupLines(runs: TextRun[]): TextLine[] {
  const geos = runs.filter((r) => r.text.length > 0 || (r.actualText && r.glyphs.length > 0)).map(geo);
  geos.sort((a, b) => a.angle - b.angle || b.v - a.v || a.u0 - b.u0);
  const lines: LineGeo[] = [];
  for (const g of geos) {
    let best: LineGeo | null = null;
    let bestGap = Infinity;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 40; k--) {
      const L = lines[k];
      if (L.angle !== g.angle) continue;
      const tol = 0.35 * Math.max(L.size, g.size);
      if (Math.abs(L.v - g.v) > tol) continue;
      const sizeRatio = g.size / L.size;
      if (sizeRatio > 2.5 || sizeRatio < 0.4) continue;
      const gap = g.u0 - L.u1;
      const gapBefore = L.u0 - g.u1;
      const maxGap = 1.6 * Math.max(L.size, g.size);
      const ok = (gap <= maxGap && gap >= -0.6 * g.size) || (gapBefore <= maxGap && gapBefore >= -0.6 * g.size) || (g.u0 >= L.u0 && g.u1 <= L.u1);
      if (!ok) continue;
      const d = Math.abs(gap);
      if (d < bestGap) {
        best = L;
        bestGap = d;
      }
    }
    if (best) {
      best.runs.push(g);
      best.u0 = Math.min(best.u0, g.u0);
      best.u1 = Math.max(best.u1, g.u1);
      best.size = Math.max(best.size, g.size);
    } else {
      lines.push({ id: '', runs: [g], angle: g.angle, u0: g.u0, u1: g.u1, v: g.v, size: g.size });
    }
  }
  // Order lines top-to-bottom, left-to-right in their own frame.
  lines.sort((a, b) => a.angle - b.angle || b.v - a.v || a.u0 - b.u0);
  return lines.map((L, idx) => {
    const rtlCount = L.runs.filter((r) => r.run.rtl).length;
    const rtl = rtlCount > L.runs.length / 2;
    L.runs.sort((a, b) => (rtl ? b.u0 - a.u0 : a.u0 - b.u0));
    let text = '';
    const spans: { runId: string; start: number; end: number }[] = [];
    let bbox: Rect | null = null;
    let prev: RunGeo | null = null;
    for (const g of L.runs) {
      if (prev) {
        const gap = rtl ? prev.u0 - g.u1 : g.u0 - prev.u1;
        const needSpace = gap > 0.18 * L.size && !/\s$/.test(text) && !/^\s/.test(g.run.text);
        if (needSpace) text += ' ';
      }
      const start = text.length;
      text += g.run.text;
      spans.push({ runId: g.run.id, start, end: text.length });
      bbox = unionRect(bbox, g.run.bbox);
      prev = g;
    }
    return {
      id: `l${idx}`,
      runIds: L.runs.map((g) => g.run.id),
      text,
      bbox: bbox!,
      runSpans: spans,
      baselineY: L.v,
      rotation: L.angle,
      fontSize: L.size,
    };
  });
}

export function groupBlocks(lines: TextLine[]): TextBlock[] {
  type B = { lines: TextLine[]; u0: number; u1: number; lastV: number; size: number; spacing: number | null; angle: number };
  const blocks: B[] = [];
  const extents = (l: TextLine) => {
    const c = Math.cos(rad(l.rotation));
    const s = Math.sin(rad(l.rotation));
    const pts = [
      [l.bbox.x, l.bbox.y], [l.bbox.x + l.bbox.width, l.bbox.y],
      [l.bbox.x, l.bbox.y + l.bbox.height], [l.bbox.x + l.bbox.width, l.bbox.y + l.bbox.height],
    ].map(([x, y]) => x * c + y * s);
    return { u0: Math.min(...pts), u1: Math.max(...pts) };
  };
  for (const l of lines) {
    const { u0, u1 } = extents(l);
    let placed = false;
    for (let k = blocks.length - 1; k >= 0 && k >= blocks.length - 6; k--) {
      const b = blocks[k];
      if (b.angle !== l.rotation) continue;
      const ratio = l.fontSize / b.size;
      if (ratio > 1.2 || ratio < 0.83) continue;
      const dv = b.lastV - l.baselineY;
      if (dv < 0.7 * b.size || dv > 2.1 * b.size) continue;
      if (b.spacing !== null && Math.abs(dv - b.spacing) > 0.3 * b.size) continue;
      const overlap = Math.min(u1, b.u1) - Math.max(u0, b.u0);
      const leftAligned = Math.abs(u0 - b.u0) < 2 * b.size;
      if (overlap <= 0 && !leftAligned) continue;
      b.lines.push(l);
      b.spacing = b.spacing === null ? dv : (b.spacing * (b.lines.length - 2) + dv) / (b.lines.length - 1);
      b.lastV = l.baselineY;
      b.u0 = Math.min(b.u0, u0);
      b.u1 = Math.max(b.u1, u1);
      placed = true;
      break;
    }
    if (!placed) blocks.push({ lines: [l], u0, u1, lastV: l.baselineY, size: l.fontSize, spacing: null, angle: l.rotation });
  }
  return blocks.map((b, idx) => {
    let bbox: Rect | null = null;
    for (const l of b.lines) bbox = unionRect(bbox, l.bbox);
    const lefts = b.lines.map((l) => extents(l).u0);
    const rights = b.lines.map((l) => extents(l).u1);
    const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
    let align: TextBlock['align'] = 'left';
    if (b.lines.length > 1) {
      const ls = spread(lefts);
      const rs = spread(rights.slice(0, -1).length ? rights.slice(0, -1) : rights);
      const centers = b.lines.map((_, i) => (lefts[i] + rights[i]) / 2);
      if (ls < 1.5 && rs < 1.5 && b.lines.length > 2) align = 'justify';
      else if (ls < 1.5) align = 'left';
      else if (spread(rights) < 1.5) align = 'right';
      else if (spread(centers) < 1.5) align = 'center';
    }
    return {
      id: `b${idx}`,
      lineIds: b.lines.map((l) => l.id),
      bbox: bbox!,
      text: b.lines.map((l) => l.text).join('\n'),
      lineHeight: b.spacing ?? b.size * 1.2,
      align,
      fontSize: b.size,
    };
  });
}
