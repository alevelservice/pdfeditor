/**
 * Annotations: listing, creating (with appearance streams), editing,
 * removing, links, and flattening appearances into page content.
 */
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, PDFHexString } from 'pdf-lib';
import { mkop, name, nums, serializeOps, type Op } from './lexer';
import { rectFromPoints, apply } from './geom';
import { asDict, cloneDict, dictGet, flateStream, getName, getNumber, lookup, N, numArray, pdfDateString, rectArray, textOf } from './objects';
import { matrixOp, PageEditor } from './writer';
import type { Annotation, AnnotationKind, Matrix, Rect, RGB } from './types';

const KNOWN: AnnotationKind[] = ['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Link', 'Widget', 'Stamp', 'Redact'];

export function annotsArray(ctx: PDFContext, leaf: PDFDict): PDFArray | undefined {
  const a = lookup(ctx, leaf.get(N('Annots')));
  return a instanceof PDFArray ? a : undefined;
}

/** Replace the page /Annots with a fresh direct array (clone-on-write). */
export function writableAnnots(ctx: PDFContext, leaf: PDFDict): PDFArray {
  const old = annotsArray(ctx, leaf);
  const arr = ctx.obj([]) as PDFArray;
  if (old) for (let i = 0; i < old.size(); i++) arr.push(old.get(i));
  leaf.set(N('Annots'), arr);
  return arr;
}

function colorOf(ctx: PDFContext, d: PDFDict): RGB | null {
  const c = numArray(ctx, d.get(N('C')));
  if (c.length === 3) return { r: c[0], g: c[1], b: c[2] };
  if (c.length === 1) return { r: c[0], g: c[0], b: c[0] };
  if (c.length === 4) return { r: (1 - c[0]) * (1 - c[3]), g: (1 - c[1]) * (1 - c[3]), b: (1 - c[2]) * (1 - c[3]) };
  return null;
}

export function listAnnotations(doc: PDFDocument, leaf: PDFDict, pageRefs: PDFRef[]): Annotation[] {
  const ctx = doc.context;
  const arr = annotsArray(ctx, leaf);
  if (!arr) return [];
  const out: Annotation[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const d = asDict(lookup(ctx, arr.get(i)));
    if (!d) continue;
    const raw = getName(ctx, d, 'Subtype') ?? 'Other';
    if (raw === 'Popup') continue;
    const r = rectArray(ctx, d.get(N('Rect')), [0, 0, 0, 0]);
    const a: Annotation = {
      id: `a${i}`,
      kind: 'annotation',
      subtype: (KNOWN.includes(raw as AnnotationKind) ? raw : 'Other') as AnnotationKind,
      rawSubtype: raw,
      index: i,
      rect: { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] },
      contents: textOf(dictGet(ctx, d, 'Contents')),
      author: textOf(dictGet(ctx, d, 'T')),
      color: colorOf(ctx, d),
      hasAppearance: !!dictGet(ctx, d, 'AP'),
    };
    const qp = numArray(ctx, d.get(N('QuadPoints')));
    if (qp.length) a.quadPoints = qp;
    if (raw === 'Link') {
      const act = asDict(dictGet(ctx, d, 'A'));
      const s = getName(ctx, act, 'S');
      if (s === 'URI') a.uri = textOf(dictGet(ctx, act, 'URI'));
      let dest = dictGet(ctx, d, 'Dest') ?? (s === 'GoTo' ? dictGet(ctx, act, 'D') : undefined);
      if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) dest = resolveNamedDest(doc, textOf(dest));
      if (dest instanceof PDFArray) {
        const target = dest.get(0);
        if (target instanceof PDFRef) a.destPage = pageRefs.findIndex((p) => p.objectNumber === target.objectNumber);
        else if (target instanceof PDFNumber) a.destPage = target.asNumber();
      }
    }
    out.push(a);
  }
  return out;
}

function resolveNamedDest(doc: PDFDocument, nm: string): PDFArray | undefined {
  const ctx = doc.context;
  const dests = asDict(dictGet(ctx, doc.catalog, 'Dests'));
  const d = dests ? lookup(ctx, dests.get(N(nm))) : undefined;
  if (d instanceof PDFArray) return d;
  if (d instanceof PDFDict) {
    const x = lookup(ctx, d.get(N('D')));
    if (x instanceof PDFArray) return x;
  }
  // Name tree
  const names = asDict(dictGet(ctx, doc.catalog, 'Names'));
  const tree = asDict(dictGet(ctx, names, 'Dests'));
  const search = (node: PDFDict | undefined, depth: number): PDFArray | undefined => {
    if (!node || depth > 32) return undefined;
    const n = lookup(ctx, node.get(N('Names')));
    if (n instanceof PDFArray) {
      for (let i = 0; i + 1 < n.size(); i += 2) {
        if (textOf(lookup(ctx, n.get(i))) === nm) {
          const v = lookup(ctx, n.get(i + 1));
          if (v instanceof PDFArray) return v;
          if (v instanceof PDFDict) {
            const x = lookup(ctx, v.get(N('D')));
            if (x instanceof PDFArray) return x;
          }
        }
      }
    }
    const kids = lookup(ctx, node.get(N('Kids')));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) {
      const r = search(asDict(lookup(ctx, kids.get(i))), depth + 1);
      if (r) return r;
    }
    return undefined;
  };
  return search(tree, 0);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface AnnotationSpec {
  type: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly' | 'Text' | 'FreeText' | 'Ink' | 'Square' | 'Circle' | 'Link';
  /** For markup: one rect per line of text. For others: [rect]. */
  rects: Rect[];
  color?: RGB;
  contents?: string;
  author?: string;
  opacity?: number;
  /** Ink strokes in page space. */
  ink?: number[][];
  lineWidth?: number;
  fontSize?: number;
  uri?: string;
  destPage?: number;
}

function formXObject(ctx: PDFContext, bbox: Rect, ops: Op[], resources?: PDFDict): PDFRef {
  const bytes = serializeOps(ops);
  const s = flateStream(ctx, bytes, {
    Type: N('XObject'),
    Subtype: N('Form'),
    BBox: ctx.obj([bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height]),
  });
  if (resources) s.dict.set(N('Resources'), resources);
  return ctx.register(s);
}

function quadsFromRects(rects: Rect[]): number[] {
  const q: number[] = [];
  for (const r of rects) q.push(r.x, r.y + r.height, r.x + r.width, r.y + r.height, r.x, r.y, r.x + r.width, r.y);
  return q;
}

function unionRects(rects: Rect[]): Rect {
  return rectFromPoints(rects.flatMap((r) => [[r.x, r.y], [r.x + r.width, r.y + r.height]] as [number, number][]));
}

export interface TextAppearanceProvider {
  /** Returns font resource dict and ops to draw a single line of text at (x, y). */
  (text: string, fontSize: number, x: number, y: number): Promise<{ fontRef: PDFRef; resName: string; ops: Op[] }>;
}

export async function createAnnotation(doc: PDFDocument, pageRef: PDFRef, spec: AnnotationSpec, textAp?: TextAppearanceProvider): Promise<PDFRef> {
  const ctx = doc.context;
  const c = spec.color ?? (spec.type === 'Highlight' ? { r: 1, g: 0.92, b: 0.23 } : spec.type === 'Text' ? { r: 1, g: 0.85, b: 0.2 } : { r: 0.9, g: 0.1, b: 0.1 });
  const lw = spec.lineWidth ?? 1.5;
  let rect = unionRects(spec.rects);
  const d = ctx.obj({
    Type: 'Annot',
    Subtype: spec.type,
    F: 4,
  }) as PDFDict;
  d.set(N('P'), pageRef);
  d.set(N('M'), PDFString.of(pdfDateString(new Date())));
  d.set(N('NM'), PDFString.of(`pdfeditor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`));
  if (spec.contents) d.set(N('Contents'), PDFHexString.fromText(spec.contents));
  if (spec.author) d.set(N('T'), PDFHexString.fromText(spec.author));
  if (spec.type !== 'Link') d.set(N('C'), ctx.obj([c.r, c.g, c.b]));
  if (spec.opacity !== undefined) d.set(N('CA'), PDFNumber.of(spec.opacity));
  let ap: Op[] = [];
  let resources: PDFDict | undefined;

  switch (spec.type) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      d.set(N('QuadPoints'), ctx.obj(quadsFromRects(spec.rects)));
      if (spec.type === 'Highlight') {
        const gs = ctx.obj({ Type: 'ExtGState', BM: 'Multiply', ca: spec.opacity ?? 1, CA: spec.opacity ?? 1 });
        resources = ctx.obj({ ExtGState: { GSh: gs } }) as PDFDict;
        ap.push(mkop('gs', name('GSh')), nums('rg', c.r, c.g, c.b));
        for (const r of spec.rects) ap.push(nums('re', r.x, r.y, r.width, r.height));
        ap.push(mkop('f'));
      } else {
        ap.push(nums('RG', c.r, c.g, c.b));
        for (const r of spec.rects) {
          const t = Math.max(0.5, r.height / 14);
          ap.push(nums('w', t));
          if (spec.type === 'Underline') ap.push(nums('m', r.x, r.y + t), nums('l', r.x + r.width, r.y + t));
          else if (spec.type === 'StrikeOut') ap.push(nums('m', r.x, r.y + r.height / 2), nums('l', r.x + r.width, r.y + r.height / 2));
          else {
            const step = Math.max(2, r.height / 6);
            ap.push(nums('m', r.x, r.y + t));
            for (let x = r.x, up = true; x < r.x + r.width; x += step, up = !up) ap.push(nums('l', Math.min(x + step, r.x + r.width), r.y + t + (up ? step / 2 : 0)));
          }
          ap.push(mkop('S'));
        }
      }
      break;
    }
    case 'Text': {
      const r0 = spec.rects[0];
      rect = { x: r0.x, y: r0.y, width: 20, height: 20 };
      d.set(N('Name'), N('Comment'));
      d.set(N('Open'), ctx.obj(false));
      ap.push(nums('rg', c.r, c.g, c.b), nums('RG', 0.3, 0.3, 0.3), nums('w', 1), nums('re', rect.x + 1, rect.y + 4, 18, 15), nums('m', rect.x + 5, rect.y + 4), nums('l', rect.x + 4, rect.y), nums('l', rect.x + 10, rect.y + 4), mkop('h'), mkop('B'));
      ap.push(nums('w', 0.8));
      for (let k = 0; k < 3; k++) ap.push(nums('m', rect.x + 4, rect.y + 15 - k * 3.5), nums('l', rect.x + 16, rect.y + 15 - k * 3.5));
      ap.push(mkop('S'));
      break;
    }
    case 'FreeText': {
      const fs = spec.fontSize ?? 12;
      d.set(N('DA'), PDFString.of(`/Helv ${fs} Tf ${c.r} ${c.g} ${c.b} rg`));
      ap.push(nums('RG', c.r, c.g, c.b), nums('w', 0.75), nums('re', rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1), mkop('S'));
      if (spec.contents && textAp) {
        const lines = spec.contents.split('\n');
        const fontRes = ctx.obj({}) as PDFDict;
        for (let k = 0; k < lines.length; k++) {
          if (!lines[k]) continue;
          const t = await textAp(lines[k], fs, rect.x + 3, rect.y + rect.height - fs - 2 - k * fs * 1.2);
          fontRes.set(N(t.resName), t.fontRef);
          ap.push(mkop('q'), nums('rg', c.r, c.g, c.b), ...t.ops, mkop('Q'));
        }
        resources = ctx.obj({}) as PDFDict;
        resources.set(N('Font'), fontRes);
      }
      break;
    }
    case 'Ink': {
      const strokes = spec.ink ?? [];
      d.set(N('InkList'), ctx.obj(strokes));
      d.set(N('BS'), ctx.obj({ W: lw }));
      const pts = strokes.flatMap((s) => s.reduce<[number, number][]>((acc, v, i) => (i % 2 ? (acc[acc.length - 1][1] = v, acc) : (acc.push([v, 0]), acc)), []));
      const bb = rectFromPoints(pts);
      rect = { x: bb.x - lw, y: bb.y - lw, width: bb.width + 2 * lw, height: bb.height + 2 * lw };
      ap.push(nums('RG', c.r, c.g, c.b), nums('w', lw), nums('J', 1), nums('j', 1));
      for (const s of strokes) {
        if (s.length < 2) continue;
        ap.push(nums('m', s[0], s[1]));
        for (let i = 2; i + 1 < s.length; i += 2) ap.push(nums('l', s[i], s[i + 1]));
        ap.push(mkop('S'));
      }
      break;
    }
    case 'Square':
    case 'Circle': {
      d.set(N('BS'), ctx.obj({ W: lw }));
      const r = rect;
      ap.push(nums('RG', c.r, c.g, c.b), nums('w', lw));
      if (spec.type === 'Square') ap.push(nums('re', r.x + lw / 2, r.y + lw / 2, r.width - lw, r.height - lw), mkop('S'));
      else {
        const K = 0.5523;
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2, rx = (r.width - lw) / 2, ry = (r.height - lw) / 2;
        ap.push(nums('m', cx + rx, cy), nums('c', cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry), nums('c', cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy), nums('c', cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry), nums('c', cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy), mkop('S'));
      }
      break;
    }
    case 'Link': {
      d.set(N('Border'), ctx.obj([0, 0, 0]));
      setLinkTarget(doc, d, spec);
      ap = [];
      break;
    }
  }
  d.set(N('Rect'), ctx.obj([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]));
  if (ap.length) {
    const apRef = formXObject(ctx, rect, ap, resources);
    d.set(N('AP'), ctx.obj({ N: apRef }));
  }
  return ctx.register(d);
}

export function setLinkTarget(doc: PDFDocument, d: PDFDict, spec: { uri?: string; destPage?: number }) {
  const ctx = doc.context;
  d.delete(N('A'));
  d.delete(N('Dest'));
  if (spec.uri) {
    d.set(N('A'), ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(spec.uri) }));
  } else if (spec.destPage !== undefined) {
    const target = doc.getPage(Math.max(0, Math.min(doc.getPageCount() - 1, spec.destPage)));
    d.set(N('Dest'), ctx.obj([target.ref, N('Fit')]));
  }
}

export interface AnnotationPatch {
  rect?: Rect;
  color?: RGB;
  contents?: string;
  uri?: string;
  destPage?: number;
}

/** Clone-on-write update of an annotation (geometry, colour, text, link target). */
export function updateAnnotation(doc: PDFDocument, leaf: PDFDict, index: number, patch: AnnotationPatch): PDFRef {
  const ctx = doc.context;
  const arr = writableAnnots(ctx, leaf);
  const oldRef = arr.get(index);
  const old = asDict(lookup(ctx, oldRef));
  if (!old) throw new Error('Annotation not found');
  const d = cloneDict(ctx, old);
  const oldRect = rectArray(ctx, old.get(N('Rect')), [0, 0, 0, 0]);
  if (patch.contents !== undefined) d.set(N('Contents'), PDFHexString.fromText(patch.contents));
  if (patch.color) d.set(N('C'), ctx.obj([patch.color.r, patch.color.g, patch.color.b]));
  if (patch.uri !== undefined || patch.destPage !== undefined) setLinkTarget(doc, d, patch);
  if (patch.rect) {
    const r = patch.rect;
    d.set(N('Rect'), ctx.obj([r.x, r.y, r.x + r.width, r.y + r.height]));
    // Move/scale QuadPoints and InkList along with the rect.
    const sx = (oldRect[2] - oldRect[0]) ? r.width / (oldRect[2] - oldRect[0]) : 1;
    const sy = (oldRect[3] - oldRect[1]) ? r.height / (oldRect[3] - oldRect[1]) : 1;
    const map = (x: number, y: number): [number, number] => [r.x + (x - oldRect[0]) * sx, r.y + (y - oldRect[1]) * sy];
    const qp = numArray(ctx, old.get(N('QuadPoints')));
    if (qp.length) {
      const out: number[] = [];
      for (let i = 0; i + 1 < qp.length; i += 2) out.push(...map(qp[i], qp[i + 1]));
      d.set(N('QuadPoints'), ctx.obj(out));
    }
    const ink = lookup(ctx, old.get(N('InkList')));
    if (ink instanceof PDFArray) {
      const strokes: number[][] = [];
      for (let i = 0; i < ink.size(); i++) {
        const s = numArray(ctx, ink.get(i));
        const o: number[] = [];
        for (let k = 0; k + 1 < s.length; k += 2) o.push(...map(s[k], s[k + 1]));
        strokes.push(o);
      }
      d.set(N('InkList'), ctx.obj(strokes));
    }
    // Keep the existing appearance, re-mapped through its Matrix by the viewer (BBox -> Rect).
  }
  if (patch.color && !patch.rect) {
    // Colour change requires a new appearance for markup we generated; drop AP so viewers regenerate,
    // or rebuild for simple markup types.
    rebuildSimpleAppearance(ctx, d);
  }
  const newRef = ctx.register(d);
  arr.set(index, newRef);
  return newRef;
}

function rebuildSimpleAppearance(ctx: PDFContext, d: PDFDict) {
  const st = getName(ctx, d, 'Subtype');
  const c = numArray(ctx, d.get(N('C')));
  if (c.length !== 3) return;
  const qp = numArray(ctx, d.get(N('QuadPoints')));
  const r = rectArray(ctx, d.get(N('Rect')), [0, 0, 0, 0]);
  const rect = { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] };
  const rects: Rect[] = [];
  for (let i = 0; i + 7 < qp.length; i += 8) {
    const xs = [qp[i], qp[i + 2], qp[i + 4], qp[i + 6]], ys = [qp[i + 1], qp[i + 3], qp[i + 5], qp[i + 7]];
    rects.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  }
  const ops: Op[] = [];
  let resources: PDFDict | undefined;
  if (st === 'Highlight') {
    resources = ctx.obj({ ExtGState: { GSh: ctx.obj({ Type: 'ExtGState', BM: 'Multiply' }) } }) as PDFDict;
    ops.push(mkop('gs', name('GSh')), nums('rg', c[0], c[1], c[2]));
    for (const q of rects) ops.push(nums('re', q.x, q.y, q.width, q.height));
    ops.push(mkop('f'));
  } else if (st === 'Underline' || st === 'StrikeOut') {
    ops.push(nums('RG', c[0], c[1], c[2]));
    for (const q of rects) {
      const t = Math.max(0.5, q.height / 14);
      const y = st === 'Underline' ? q.y + t : q.y + q.height / 2;
      ops.push(nums('w', t), nums('m', q.x, y), nums('l', q.x + q.width, y), mkop('S'));
    }
  } else if (st === 'Square') {
    ops.push(nums('RG', c[0], c[1], c[2]), nums('w', 1.5), nums('re', rect.x + 0.75, rect.y + 0.75, rect.width - 1.5, rect.height - 1.5), mkop('S'));
  } else return;
  d.set(N('AP'), ctx.obj({ N: formXObject(ctx, rect, ops, resources) }));
}

export function removeAnnotation(ctx: PDFContext, leaf: PDFDict, index: number) {
  const arr = writableAnnots(ctx, leaf);
  const removed = asDict(lookup(ctx, arr.get(index)));
  arr.remove(index);
  // Remove its popup too.
  const popup = removed?.get(N('Popup'));
  if (popup) {
    for (let i = arr.size() - 1; i >= 0; i--) if (arr.get(i) === popup) arr.remove(i);
  }
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

function appearanceStream(ctx: PDFContext, annot: PDFDict): PDFStream | undefined {
  const ap = asDict(dictGet(ctx, annot, 'AP'));
  const n = lookup(ctx, ap?.get(N('N')));
  if (n instanceof PDFStream) return n;
  if (n instanceof PDFDict) {
    const as = getName(ctx, annot, 'AS');
    const s = as ? lookup(ctx, n.get(N(as))) : undefined;
    if (s instanceof PDFStream) return s;
  }
  return undefined;
}

/** Matrix mapping the appearance BBox (after its /Matrix) onto the annotation Rect. */
export function appearanceMatrix(ctx: PDFContext, annot: PDFDict, ap: PDFStream): Matrix {
  const rect = rectArray(ctx, annot.get(N('Rect')), [0, 0, 0, 0]);
  const bboxA = numArray(ctx, ap.dict.get(N('BBox')));
  const bbox = bboxA.length === 4 ? bboxA : [0, 0, rect[2] - rect[0], rect[3] - rect[1]];
  const mA = numArray(ctx, ap.dict.get(N('Matrix')));
  const M: Matrix = mA.length === 6 ? (mA as Matrix) : [1, 0, 0, 1, 0, 0];
  const tb = rectFromPoints([apply(M, bbox[0], bbox[1]), apply(M, bbox[2], bbox[1]), apply(M, bbox[0], bbox[3]), apply(M, bbox[2], bbox[3])]);
  const sx = tb.width ? (rect[2] - rect[0]) / tb.width : 1;
  const sy = tb.height ? (rect[3] - rect[1]) / tb.height : 1;
  // The form's own /Matrix is applied by the Do operator; only A is needed here.
  return [sx, 0, 0, sy, rect[0] - tb.x * sx, rect[1] - tb.y * sy];
}

export interface FlattenOptions {
  /** Which subtypes to flatten (default: everything except Link and Popup). */
  include?: (subtype: string) => boolean;
}

/**
 * Draw annotation appearances into the page content and remove the
 * annotations. Returns the number of flattened annotations.
 */
export function flattenAnnotations(ctx: PDFContext, leaf: PDFDict, editor: PageEditor, opts: FlattenOptions = {}): number {
  const arr = annotsArray(ctx, leaf);
  if (!arr) return 0;
  const include = opts.include ?? ((s: string) => s !== 'Link' && s !== 'Popup');
  const keep = ctx.obj([]) as PDFArray;
  const draw: Op[] = [];
  let count = 0;
  for (let i = 0; i < arr.size(); i++) {
    const ref = arr.get(i);
    const a = asDict(lookup(ctx, ref));
    if (!a) continue;
    const st = getName(ctx, a, 'Subtype') ?? '';
    if (!include(st)) {
      keep.push(ref);
      continue;
    }
    const flags = getNumber(ctx, a, 'F', 0);
    const hidden = (flags & 2) !== 0 || (flags & 32) !== 0;
    const ap = appearanceStream(ctx, a);
    count++;
    if (hidden || !ap) continue;
    let apRef = (() => {
      const apd = asDict(dictGet(ctx, a, 'AP'));
      const n = apd?.get(N('N'));
      if (n instanceof PDFRef && lookup(ctx, n) === ap) return n;
      if (n) {
        const nd = asDict(lookup(ctx, n));
        const as = getName(ctx, a, 'AS');
        const s = as ? nd?.get(N(as)) : undefined;
        if (s instanceof PDFRef) return s;
      }
      return ctx.register(ap);
    })();
    if (getName(ctx, ap.dict, 'Subtype') !== 'Form') {
      const copy = ctx.obj({}) as PDFDict;
      for (const [k, v] of ap.dict.entries()) copy.set(k, v);
      copy.set(N('Subtype'), N('Form'));
      copy.set(N('Type'), N('XObject'));
      const contents = ap instanceof PDFRawStream ? ap.contents : ap.getContents();
      apRef = ctx.register(PDFRawStream.of(copy, contents));
    }
    const nm = editor.addResource('XObject', 'FlatAP', apRef);
    const ca = dictGet(ctx, a, 'CA');
    const ops: Op[] = [mkop('q')];
    if (ca instanceof PDFNumber && ca.asNumber() < 1) ops.push(mkop('gs', name(editor.alphaState(ca.asNumber()))));
    ops.push(matrixOp('cm', appearanceMatrix(ctx, a, ap)), mkop('Do', name(nm)), mkop('Q'));
    draw.push(...ops);
  }
  if (draw.length) editor.append(draw);
  if (keep.size()) leaf.set(N('Annots'), keep);
  else leaf.delete(N('Annots'));
  return count;
}

