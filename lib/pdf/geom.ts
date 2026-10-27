import type { Matrix, Rect } from './types';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2 in PDF row-vector convention (apply m1 first, then m2). */
export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, -m[4], -m[5]];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

export function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function scale(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotateDeg(deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export function rectFromPoints(pts: [number, number][]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function transformRect(m: Matrix, r: Rect): Rect {
  return rectFromPoints([
    apply(m, r.x, r.y),
    apply(m, r.x + r.width, r.y),
    apply(m, r.x, r.y + r.height),
    apply(m, r.x + r.width, r.y + r.height),
  ]);
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function intersectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function rectContainsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

export function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function approxEq(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

export function isIdentity(m: Matrix): boolean {
  return approxEq(m[0], 1) && approxEq(m[1], 0) && approxEq(m[2], 0) && approxEq(m[3], 1) && approxEq(m[4], 0) && approxEq(m[5], 0);
}

/**
 * Replicates pdf.js PageViewport: maps PDF user space to top-left-origin
 * viewport pixels for the given view box, rotation and scale.
 */
export function viewportTransform(view: [number, number, number, number], rotation: number, scaleF: number): Matrix {
  const centerX = (view[2] + view[0]) / 2;
  const centerY = (view[3] + view[1]) / 2;
  let rA: number, rB: number, rC: number, rD: number;
  const rot = ((rotation % 360) + 360) % 360;
  switch (rot) {
    case 180: rA = -1; rB = 0; rC = 0; rD = 1; break;
    case 90: rA = 0; rB = 1; rC = 1; rD = 0; break;
    case 270: rA = 0; rB = -1; rC = -1; rD = 0; break;
    default: rA = 1; rB = 0; rC = 0; rD = -1;
  }
  let offX: number, offY: number;
  if (rA === 0) {
    offX = Math.abs(centerY - view[1]) * scaleF;
    offY = Math.abs(centerX - view[0]) * scaleF;
  } else {
    offX = Math.abs(centerX - view[0]) * scaleF;
    offY = Math.abs(centerY - view[1]) * scaleF;
  }
  return [
    rA * scaleF,
    rB * scaleF,
    rC * scaleF,
    rD * scaleF,
    offX - rA * scaleF * centerX - rC * scaleF * centerY,
    offY - rB * scaleF * centerX - rD * scaleF * centerY,
  ];
}
