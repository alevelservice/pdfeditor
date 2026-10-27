/**
 * Object model -> content stream rewrite.
 *
 * A PageEditor collects operator replacements (by top-level operator index)
 * and appended operators, then serializes a new content stream. Operators
 * that were not touched are copied byte-for-byte from the original stream.
 */
import { PDFContext, PDFDict, PDFObject, PDFRef } from 'pdf-lib';
import { arr, fmtNum, mkop, name, num, nums, serializeOps, str, type Op, type PdfValue } from './lexer';
import { invert, isIdentity, mul } from './geom';
import type { ShapedGlyph } from './fonts';
import { asDict, cloneDict, lookup, N, pageResources, setPageContent, uniqueResourceName } from './objects';
import type { InternalTextRun, ParsedPage } from './parser';
import type { Matrix, RGB } from './types';

export class PageEditor {
  private replacements = new Map<number, Op[]>();
  private appended: Op[] = [];
  private prepended: Op[] = [];
  private resources: PDFDict | null = null;
  private categories = new Map<string, PDFDict>();
  warnings: string[] = [];

  constructor(public ctx: PDFContext, public leaf: PDFDict, public parsed: ParsedPage) {}

  get dirty(): boolean {
    return this.replacements.size > 0 || this.appended.length > 0 || this.prepended.length > 0;
  }

  get ops(): Op[] {
    return this.parsed.stream.ops;
  }

  replace(index: number, ops: Op[]) {
    if (this.replacements.has(index)) this.warnings.push(`Operator ${index} edited twice; last edit wins`);
    this.replacements.set(index, ops);
  }

  remove(index: number) {
    this.replace(index, []);
  }

  removeRange(start: number, end: number) {
    for (let i = start; i <= end; i++) this.replace(i, []);
  }

  isReplaced(index: number): boolean {
    return this.replacements.has(index);
  }

  append(ops: Op[]) {
    this.appended.push(...ops);
  }

  /** Insert operators before all existing content (drawn behind it). */
  prepend(ops: Op[]) {
    this.prepended.push(...ops);
  }

  private category(cat: string): PDFDict {
    let c = this.categories.get(cat);
    if (c) return c;
    if (!this.resources) {
      this.resources = cloneDict(this.ctx, pageResources(this.ctx, this.leaf));
      this.leaf.set(N('Resources'), this.resources);
    }
    const existing = asDict(lookup(this.ctx, this.resources.get(N(cat))));
    c = existing ? cloneDict(this.ctx, existing) : (this.ctx.obj({}) as PDFDict);
    this.resources.set(N(cat), c);
    this.categories.set(cat, c);
    return c;
  }

  /** Add a resource (clone-on-write) and return its name. Reuses an existing entry for the same ref. */
  addResource(cat: 'Font' | 'XObject' | 'ExtGState' | 'ColorSpace' | 'Pattern' | 'Shading' | 'Properties', prefix: string, obj: PDFObject): string {
    // Look in the current (possibly inherited) resources without cloning first.
    const current = this.categories.get(cat) ?? asDict(lookup(this.ctx, pageResources(this.ctx, this.leaf).get(N(cat))));
    if (current && obj instanceof PDFRef) {
      for (const [k, v] of current.entries()) if (v instanceof PDFRef && v === obj) return k.decodeText();
    }
    const c = this.category(cat);
    const nm = uniqueResourceName(c, prefix);
    c.set(N(nm), obj);
    return nm;
  }

  /** Replace a resource entry by name (e.g. swapping an image XObject). */
  setResource(cat: string, resName: string, obj: PDFObject) {
    this.category(cat).set(N(resName), obj);
  }

  /** Create an ExtGState with the given fill/stroke alpha and return its name. */
  alphaState(alpha: number): string {
    const gs = this.ctx.obj({ Type: 'ExtGState', ca: alpha, CA: alpha });
    return this.addResource('ExtGState', 'GSa', this.ctx.register(gs));
  }

  build(): Op[] {
    const src = this.ops;
    const out: Op[] = [];
    if (this.prepended.length) out.push(mkop('q'), ...this.prepended, mkop('Q'));
    const needIsolation = this.appended.length > 0 && (this.parsed.end.depth !== 0 || !isIdentity(this.parsed.end.ctm));
    if (needIsolation) out.push(mkop('q'));
    for (let i = 0; i < src.length; i++) {
      const r = this.replacements.get(i);
      if (r) out.push(...r);
      else out.push(src[i]);
    }
    if (this.appended.length) {
      if (needIsolation) for (let d = 0; d <= this.parsed.end.depth; d++) out.push(mkop('Q'));
      out.push(...this.appended);
    }
    return out;
  }

  /** Serialize the edited operators without assigning them anywhere. */
  buildBytes(): Uint8Array {
    return serializeOps(this.build(), this.parsed.stream.source);
  }

  /** Serialize and assign the new content stream to the page. */
  commit(): Uint8Array {
    const bytes = this.buildBytes();
    setPageContent(this.ctx, this.leaf, bytes);
    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Operator builders
// ---------------------------------------------------------------------------

export const matrixOp = (op: 'cm' | 'Tm', m: Matrix): Op => nums(op, ...m);

export function fillColorOps(c: RGB, stroke = true): Op[] {
  const ops = [nums('rg', c.r, c.g, c.b)];
  if (stroke) ops.push(nums('RG', c.r, c.g, c.b));
  return ops;
}

export interface ShowOptions {
  fontSize: number;
  Tc: number;
  Tw: number;
  Th: number;
  baseRise: number;
  /** Extra space added after each space glyph (1000ths of font size) - used for justification. */
  spaceExtra?: number;
}

/**
 * Build TJ operators for shaped glyphs. Returns the ops and the resulting
 * advance in unscaled text space units.
 */
export function buildShowOps(glyphs: ShapedGlyph[], o: ShowOptions): { ops: Op[]; advance: number } {
  const ops: Op[] = [];
  let items: PdfValue[] = [];
  let bytes: number[] = [];
  let curDy = 0;
  let advance = 0;
  const fsTh = o.fontSize * o.Th;
  const flushStr = () => {
    if (bytes.length) {
      items.push(str(Uint8Array.from(bytes)));
      bytes = [];
    }
  };
  const pushNum = (n: number) => {
    if (Math.abs(n) < 0.01) return;
    flushStr();
    const last = items[items.length - 1];
    if (last && last.t === 'num') last.v += n;
    else items.push(num(n));
  };
  const flushTJ = () => {
    flushStr();
    if (items.length) ops.push(mkop('TJ', arr(items.map((it) => (it.t === 'num' ? num(Math.round(it.v * 1000) / 1000) : it)))));
    items = [];
  };
  for (const g of glyphs) {
    if (g.dy !== curDy && g.code >= 0) {
      flushTJ();
      ops.push(nums('Ts', o.baseRise + (g.dy / 1000) * o.fontSize));
      curDy = g.dy;
    }
    if (g.code < 0) {
      pushNum(-g.ax);
      advance += (g.ax / 1000) * fsTh;
      continue;
    }
    if (g.dx) pushNum(-g.dx);
    for (let b = g.len - 1; b >= 0; b--) bytes.push((g.code >> (8 * b)) & 0xff);
    let adj = g.dx + (g.w - g.ax);
    const isWordSpace = g.isSpace && g.len === 1;
    if (g.isSpace && o.spaceExtra) adj -= o.spaceExtra;
    pushNum(adj);
    advance += ((g.ax / 1000) * o.fontSize + o.Tc + (isWordSpace ? o.Tw : 0)) * o.Th + (g.isSpace && o.spaceExtra ? (o.spaceExtra / 1000) * fsTh : 0);
  }
  flushTJ();
  if (curDy !== 0) ops.push(nums('Ts', o.baseRise));
  return { ops, advance };
}

/** Horizontal offset (text space) of the run's Tm from its Tlm. */
export function textOffset(run: InternalTextRun): number {
  const tm = run.textMatrix;
  const tlm = run.lineMatrix;
  if (Math.abs(tlm[0]) > 1e-9) return (tm[4] - tlm[4]) / tlm[0];
  if (Math.abs(tlm[1]) > 1e-9) return (tm[5] - tlm[5]) / tlm[1];
  return 0;
}

/** Ops that must precede a replacement of a ' or " operator. */
export function runPrefix(run: InternalTextRun, original: Op): Op[] {
  if (run.opType === "'") return [mkop('T*')];
  if (run.opType === '"') return [mkop('Tw', original.args[0] ?? num(0)), mkop('Tc', original.args[1] ?? num(0)), mkop('T*')];
  return [];
}

/** Restore Tm/Tlm after a temporary ET..BT split so that following ops render unchanged. */
export function restoreOps(run: InternalTextRun, warnings: string[]): Op[] {
  const fsTh = run.fontSize * (run.horizontalScale / 100);
  const ops: Op[] = [matrixOp('Tm', run.lineMatrix)];
  const d = textOffset(run) + run.advance;
  if (Math.abs(d) > 1e-6) {
    if (Math.abs(fsTh) > 1e-9) ops.push(mkop('TJ', arr([num(Math.round((-d * 1000) / fsTh * 1000) / 1000)])));
    else warnings.push('Zero font size: subsequent text position could not be restored exactly');
  }
  return ops;
}

/** Remove a run's visible text while keeping the text position for following operators. */
export function blankRunOps(run: InternalTextRun, original: Op, warnings: string[]): Op[] {
  const fsTh = run.fontSize * (run.horizontalScale / 100);
  const ops = runPrefix(run, original);
  if (Math.abs(run.advance) < 1e-9) return ops;
  if (Math.abs(fsTh) > 1e-9) ops.push(mkop('TJ', arr([num(Math.round((-run.advance * 1000) / fsTh * 1000) / 1000)])));
  else {
    ops.push(...restoreOps({ ...run, advance: run.advance }, warnings));
  }
  return ops;
}

/** Wrap ops in an isolated text object at the run's position: ET q BT ... ET Q BT <restore>. */
export function isolatedAtRun(run: InternalTextRun, original: Op, inner: Op[], warnings: string[]): Op[] {
  return [...runPrefix(run, original), mkop('ET'), mkop('q'), mkop('BT'), ...inner, mkop('ET'), mkop('Q'), mkop('BT'), ...restoreOps(run, warnings)];
}

/** The show operator of a run, normalized to Tj/TJ (the ' and " side effects go to runPrefix). */
export function plainShowOp(run: InternalTextRun, original: Op): Op {
  if (run.opType === "'") return mkop('Tj', original.args[0]);
  if (run.opType === '"') return mkop('Tj', original.args[2]);
  return { op: original.op, args: original.args };
}

/** New Tm so that the run ends up transformed by D (page space) under the same CTM. */
export function transformedTm(run: InternalTextRun, D: Matrix): Matrix {
  return mul(mul(mul(run.textMatrix, run.ctm), D), invert(run.ctm));
}

/** Matrix X such that `X cm` applied before an object drawn with CTM `ctm` transforms it by D in page space. */
export function cmForPageTransform(ctm: Matrix, D: Matrix): Matrix {
  return mul(mul(ctm, D), invert(ctm));
}

export const fontOp = (resName: string, size: number): Op => mkop('Tf', name(resName), num(size));

/** Wrap ops in /Span <</ActualText ...>> BDC ... EMC so text extraction returns `text` exactly. */
export function withActualText(ops: Op[], text: string | undefined): Op[] {
  if (!text) return ops;
  const bytes = [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes.push(c >> 8, c & 0xff);
  }
  return [mkop('BDC', name('Span'), { t: 'dict', v: [['ActualText', str(Uint8Array.from(bytes))]] }), ...ops, mkop('EMC')];
}

export { fmtNum };
