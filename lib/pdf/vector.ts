/**
 * Vector paths: drawing new shapes, restyling / moving / deleting existing
 * paths, and z-order changes for any page object.
 */
import { mkop, name, nums, type Op } from './lexer';
import { invert } from './geom';
import { blankRunOps, cmForPageTransform, fillColorOps, fontOp, matrixOp, PageEditor, plainShowOp } from './writer';
import type { InternalImage, InternalPath, InternalTextRun, ParsedPage } from './parser';
import type { ColorInfo, Matrix, Rect, RGB, ShapeSpec } from './types';

const K = 0.5522847498;

export function shapeOps(editor: PageEditor, spec: ShapeSpec): { ops: Op[]; bbox: Rect } {
  const p = spec.points;
  const path: Op[] = [];
  let bbox: Rect = { x: 0, y: 0, width: 0, height: 0 };
  switch (spec.kind) {
    case 'rect': {
      const x = Math.min(p[0], p[2]), y = Math.min(p[1], p[3]);
      const w = Math.abs(p[2] - p[0]), h = Math.abs(p[3] - p[1]);
      path.push(nums('re', x, y, w, h));
      bbox = { x, y, width: w, height: h };
      break;
    }
    case 'ellipse': {
      const x0 = Math.min(p[0], p[2]), y0 = Math.min(p[1], p[3]);
      const rx = Math.abs(p[2] - p[0]) / 2, ry = Math.abs(p[3] - p[1]) / 2;
      const cx = x0 + rx, cy = y0 + ry;
      path.push(
        nums('m', cx + rx, cy),
        nums('c', cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry),
        nums('c', cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy),
        nums('c', cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry),
        nums('c', cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy),
        mkop('h'),
      );
      bbox = { x: x0, y: y0, width: rx * 2, height: ry * 2 };
      break;
    }
    case 'line':
    case 'arrow': {
      const [x1, y1, x2, y2] = p;
      path.push(nums('m', x1, y1), nums('l', x2, y2));
      if (spec.kind === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.max(6, spec.lineWidth * 4);
        const a1 = ang + Math.PI - Math.PI / 7;
        const a2 = ang + Math.PI + Math.PI / 7;
        path.push(nums('m', x2, y2), nums('l', x2 + len * Math.cos(a1), y2 + len * Math.sin(a1)), nums('l', x2 + len * Math.cos(a2), y2 + len * Math.sin(a2)), mkop('h'));
      }
      bbox = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      break;
    }
    case 'freehand': {
      if (p.length < 4) throw new Error('Freehand path needs at least two points');
      path.push(nums('m', p[0], p[1]));
      // Smooth with quadratic midpoints expressed as cubic curves.
      for (let i = 2; i + 3 < p.length; i += 2) {
        const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
        path.push(nums('c', p[i], p[i + 1], p[i], p[i + 1], mx, my));
      }
      path.push(nums('l', p[p.length - 2], p[p.length - 1]));
      const xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1);
      bbox = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      break;
    }
  }
  const ops: Op[] = [mkop('q')];
  if (spec.opacity !== undefined && spec.opacity < 1) ops.push(mkop('gs', name(editor.alphaState(spec.opacity))));
  const isArrow = spec.kind === 'arrow';
  const fill = isArrow ? spec.stroke : spec.kind === 'line' || spec.kind === 'freehand' ? null : spec.fill;
  if (fill) ops.push(nums('rg', fill.r, fill.g, fill.b));
  if (spec.stroke) ops.push(nums('RG', spec.stroke.r, spec.stroke.g, spec.stroke.b));
  ops.push(nums('w', spec.lineWidth), nums('J', 1), nums('j', 1));
  ops.push(...path);
  ops.push(mkop(fill && spec.stroke ? 'B' : fill ? 'f' : 'S'));
  ops.push(mkop('Q'));
  return { ops, bbox };
}

function colorOpsFor(c: ColorInfo | RGB | null, stroke: boolean): Op[] {
  if (!c) return [];
  const rgb = 'r' in c ? c : c.rgb;
  if ('comps' in c && c.space === 'gray') return [nums(stroke ? 'G' : 'g', ...c.comps)];
  if ('comps' in c && c.space === 'cmyk') return [nums(stroke ? 'K' : 'k', ...c.comps)];
  if ('comps' in c && c.space === 'rgb') return [nums(stroke ? 'RG' : 'rg', ...c.comps)];
  if (!rgb) return [];
  return [nums(stroke ? 'RG' : 'rg', rgb.r, rgb.g, rgb.b)];
}

export interface PathStyle {
  fill?: RGB | null;
  stroke?: RGB | null;
  lineWidth?: number;
}

export function stylePath(editor: PageEditor, path: InternalPath, style: PathStyle) {
  if (!path.editable) throw new Error(`Path is not editable: ${path.readOnlyReason}`);
  const paint = editor.ops[path.opEnd].op;
  const evenOdd = paint.endsWith('*');
  const hasFill = style.fill !== undefined ? style.fill !== null : path.fill !== null;
  const hasStroke = style.stroke !== undefined ? style.stroke !== null : path.stroke !== null;
  const close = paint === 's' || paint === 'b' || paint === 'b*';
  let newPaint = 'n';
  if (hasFill && hasStroke) newPaint = (close ? 'b' : 'B') + (evenOdd ? '*' : '');
  else if (hasFill) newPaint = evenOdd ? 'f*' : 'f';
  else if (hasStroke) newPaint = close ? 's' : 'S';
  const prefix: Op[] = [mkop('q')];
  if (style.fill) prefix.push(...fillColorOps(style.fill, false));
  if (style.stroke) prefix.push(nums('RG', style.stroke.r, style.stroke.g, style.stroke.b));
  if (style.lineWidth !== undefined) prefix.push(nums('w', style.lineWidth));
  const first = editor.ops[path.opStart];
  editor.replace(path.opStart, [...prefix, { op: first.op, args: first.args }]);
  editor.replace(path.opEnd, [mkop(newPaint), mkop('Q')]);
}

export function transformPath(editor: PageEditor, path: InternalPath, D: Matrix) {
  if (!path.editable) throw new Error(`Path is not editable: ${path.readOnlyReason}`);
  const first = editor.ops[path.opStart];
  const last = editor.ops[path.opEnd];
  editor.replace(path.opStart, [mkop('q'), matrixOp('cm', cmForPageTransform(path.ctm, D)), { op: first.op, args: first.args }]);
  editor.replace(path.opEnd, [{ op: last.op, args: last.args }, mkop('Q')]);
}

export function deletePath(editor: PageEditor, path: InternalPath) {
  if (!path.editable) throw new Error(`Path is not editable: ${path.readOnlyReason}`);
  editor.removeRange(path.opStart, path.opEnd);
}

// ---------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------

type AnyObj = InternalTextRun | InternalImage | InternalPath;

/** Absolute (identity-CTM, default state) operators that redraw an object. */
function reconstruct(editor: PageEditor, obj: AnyObj): Op[] {
  const ops = editor.ops;
  if (obj.kind === 'image') {
    const o = ops[obj.opIndex];
    return [mkop('q'), matrixOp('cm', obj.matrix), o.op === 'BI' ? { op: 'BI', args: [], inline: o.inline } : { op: o.op, args: o.args }, mkop('Q')];
  }
  if (obj.kind === 'path') {
    const out: Op[] = [mkop('q'), matrixOp('cm', obj.ctm), ...colorOpsFor(obj.fill, false), ...colorOpsFor(obj.stroke, true), nums('w', obj.lineWidth)];
    for (let i = obj.opStart; i <= obj.opEnd; i++) out.push({ op: ops[i].op, args: ops[i].args });
    out.push(mkop('Q'));
    return out;
  }
  const run = obj;
  const o = ops[run.opIndex];
  return [
    mkop('q'), matrixOp('cm', run.ctm), mkop('BT'),
    fontOp(run.fontResName, run.fontSize),
    nums('Tc', run.charSpacing), nums('Tw', run.wordSpacing), nums('Tz', run.horizontalScale), nums('Tr', run.renderMode), nums('Ts', run.rise),
    ...colorOpsFor(run.color, false), ...colorOpsFor(run.color, true),
    matrixOp('Tm', run.textMatrix), plainShowOp(run, o), mkop('ET'), mkop('Q'),
  ];
}

function removeAt(editor: PageEditor, obj: AnyObj) {
  if (obj.kind === 'image') editor.replace(obj.opIndex, []);
  else if (obj.kind === 'path') editor.removeRange(obj.opStart, obj.opEnd);
  else editor.replace(obj.opIndex, blankRunOps(obj, editor.ops[obj.opIndex], editor.warnings));
}

const endIndex = (o: AnyObj) => (o.kind === 'path' ? o.opEnd : o.opIndex);
const startIndex = (o: AnyObj) => (o.kind === 'path' ? o.opStart : o.opIndex);
const ctmOf = (o: AnyObj): Matrix => (o.kind === 'image' ? o.matrix : o.ctm);

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Change the paint order of an object. 'front'/'back' move it to the end /
 * start of the page stream; 'forward'/'backward' move it past the next /
 * previous overlapping object.
 */
export function reorderObject(editor: PageEditor, parsed: ParsedPage, obj: AnyObj, where: 'front' | 'back' | 'forward' | 'backward') {
  if (!obj.editable) throw new Error(`Object is not editable: ${obj.readOnlyReason}`);
  const redraw = reconstruct(editor, obj);
  if (where === 'front') {
    removeAt(editor, obj);
    editor.append(redraw);
    return;
  }
  const all: AnyObj[] = [...parsed.texts, ...parsed.images, ...parsed.paths].filter((o) => o.formPath.length === 0 && o !== obj);
  if (where === 'back') {
    removeAt(editor, obj);
    const first = editor.ops[0];
    editor.replace(0, [...redraw, ...(editor.isReplaced(0) ? [] : [first])]);
    return;
  }
  const me = startIndex(obj);
  const cands = all
    .filter((o) => overlaps(o.bbox, obj.bbox))
    .filter((o) => (where === 'forward' ? startIndex(o) > endIndex(obj) : endIndex(o) < me))
    .sort((a, b) => (where === 'forward' ? startIndex(a) - startIndex(b) : startIndex(b) - startIndex(a)));
  const target = cands[0];
  if (!target) return;
  // Insert after (forward) or before (backward) the target, resetting the CTM there.
  let at = where === 'forward' ? endIndex(target) : startIndex(target);
  if (target.kind === 'text') {
    // Cannot insert inside a text object: move to its BT/ET boundary.
    const ops = editor.ops;
    if (where === 'forward') while (at < ops.length - 1 && ops[at].op !== 'ET') at++;
    else while (at > 0 && ops[at].op !== 'BT') at--;
  }
  const reset: Op[] = [mkop('q'), matrixOp('cm', invert(ctmOf(target))), ...redraw, mkop('Q')];
  removeAt(editor, obj);
  const existing = editor.isReplaced(at) ? null : editor.ops[at];
  if (where === 'forward') editor.replace(at, [...(existing ? [existing] : []), ...reset]);
  else editor.replace(at, [...reset, ...(existing ? [existing] : [])]);
}
