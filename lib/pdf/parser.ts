/**
 * Content stream interpreter: turns a page's operators into an object model
 * (text runs, images, vector paths) while tracking the graphics state.
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import { parseContentStream, inlineDictGet, type ContentStream, type Op, type PdfValue } from './lexer';
import { apply, IDENTITY, invert, mul, rectFromPoints, transformRect, unionRect } from './geom';
import { FontCache, PdfFont, type DecodedGlyph } from './fontinfo';
import { asDict, dictGet, getName, getNumber, lookup, N, numArray, streamBytes } from './objects';
import type { ColorInfo, GlyphBox, ImageObject, Matrix, Rect, TextRun, VectorPath } from './types';

export interface RunGlyph extends DecodedGlyph {
  /** Text-space x offset (unscaled) from run start where this glyph starts. */
  x: number;
  /** Advance in unscaled text space. */
  adv: number;
  bbox: Rect;
  /** Index into the operator's TJ array element (for TJ) or 0. */
  part: number;
  /** Byte offset inside that string. */
  byteOffset: number;
  virtual?: boolean;
}

export interface InternalTextRun extends TextRun {
  pdfFont: PdfFont | null;
  fontResName: string;
  opType: string;
  runGlyphs: RunGlyph[];
  formPath: number[];
}

export interface InternalImage extends ImageObject {
  ref?: PDFRef;
  stream?: PDFStream;
  formPath: number[];
}

export interface InternalPath extends VectorPath {
  formPath: number[];
}

export interface FormUse {
  opIndex: number;
  name: string;
  ref?: PDFRef;
  matrix: Matrix;
  bbox: Rect;
  formPath: number[];
}

export interface ParsedPage {
  stream: ContentStream;
  texts: InternalTextRun[];
  images: InternalImage[];
  paths: InternalPath[];
  forms: FormUse[];
  end: { depth: number; ctm: Matrix };
  warnings: string[];
  degraded: boolean;
}

interface GState {
  ctm: Matrix;
  fillCS: string;
  strokeCS: string;
  fill: ColorInfo;
  stroke: ColorInfo;
  lineWidth: number;
  font: PdfFont | null;
  fontName: string;
  fontSize: number;
  Tc: number;
  Tw: number;
  Th: number;
  TL: number;
  Tr: number;
  Ts: number;
  fillAlpha: number;
}

const black = (): ColorInfo => ({ space: 'gray', comps: [0], rgb: { r: 0, g: 0, b: 0 } });

function initialState(ctm: Matrix): GState {
  return {
    ctm,
    fillCS: 'DeviceGray',
    strokeCS: 'DeviceGray',
    fill: black(),
    stroke: black(),
    lineWidth: 1,
    font: null,
    fontName: '',
    fontSize: 0,
    Tc: 0,
    Tw: 0,
    Th: 1,
    TL: 0,
    Tr: 0,
    Ts: 0,
    fillAlpha: 1,
  };
}

const cloneState = (g: GState): GState => ({ ...g, fill: { ...g.fill }, stroke: { ...g.stroke } });

const n = (v: PdfValue | undefined): number => (v && v.t === 'num' ? v.v : 0);

export function colorFrom(space: string, comps: number[]): ColorInfo {
  const c = comps.map((x) => Math.max(0, Math.min(1, x)));
  if (space === 'gray' || (space === 'other' && c.length === 1)) {
    const v = c[0] ?? 0;
    return { space: space as ColorInfo['space'], comps, rgb: { r: v, g: v, b: v } };
  }
  if (space === 'rgb' || (space === 'other' && c.length === 3)) {
    return { space: space as ColorInfo['space'], comps, rgb: { r: c[0], g: c[1], b: c[2] } };
  }
  if (space === 'cmyk' || (space === 'other' && c.length === 4)) {
    const [cc, m, y, k] = c;
    return { space: space as ColorInfo['space'], comps, rgb: { r: (1 - cc) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) } };
  }
  return { space: 'other', comps, rgb: null };
}

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿऀ-෿一-鿿]/;

export function isRtlText(s: string): boolean {
  let r = 0, l = 0;
  for (const ch of s) {
    if (RTL_RE.test(ch)) r++;
    else if (LTR_RE.test(ch)) l++;
  }
  return r > l;
}

export class PageInterpreter {
  private texts: InternalTextRun[] = [];
  private images: InternalImage[] = [];
  private paths: InternalPath[] = [];
  private forms: FormUse[] = [];
  private warnings: string[] = [];
  private degraded = false;
  private formDepth = 0;

  constructor(private ctx: PDFContext, private fonts: FontCache) {}

  parsePage(contentBytes: Uint8Array, resources: PDFDict, baseCtm: Matrix = IDENTITY): ParsedPage {
    const stream = parseContentStream(contentBytes);
    this.warnings.push(...stream.warnings);
    const end = this.run(stream.ops, resources, baseCtm, []);
    return {
      stream,
      texts: this.texts,
      images: this.images,
      paths: this.paths,
      forms: this.forms,
      end,
      warnings: this.warnings,
      degraded: this.degraded,
    };
  }

  private colorSpaceKind(name: string, resources: PDFDict): { kind: ColorInfo['space']; n: number } {
    switch (name) {
      case 'DeviceGray': case 'G': case 'CalGray': return { kind: 'gray', n: 1 };
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return { kind: 'rgb', n: 3 };
      case 'DeviceCMYK': case 'CMYK': return { kind: 'cmyk', n: 4 };
      case 'Pattern': return { kind: 'pattern', n: 0 };
    }
    const csDict = asDict(dictGet(this.ctx, resources, 'ColorSpace'));
    const cs = dictGet(this.ctx, csDict, name);
    return this.csObjKind(cs);
  }

  private csObjKind(cs: unknown): { kind: ColorInfo['space']; n: number } {
    if (cs instanceof PDFName) return this.colorSpaceKind(cs.decodeText(), this.ctx.obj({}) as PDFDict);
    if (cs instanceof PDFArray) {
      const fam = lookup(this.ctx, cs.get(0));
      const f = fam instanceof PDFName ? fam.decodeText() : '';
      if (f === 'ICCBased') {
        const s = lookup(this.ctx, cs.get(1));
        const nn = s instanceof PDFStream ? getNumber(this.ctx, s.dict, 'N', 3) : 3;
        return { kind: nn === 1 ? 'gray' : nn === 4 ? 'cmyk' : 'rgb', n: nn };
      }
      if (f === 'CalRGB' || f === 'Lab') return { kind: 'rgb', n: 3 };
      if (f === 'CalGray') return { kind: 'gray', n: 1 };
      if (f === 'Pattern') return { kind: 'pattern', n: 0 };
      if (f === 'Separation') return { kind: 'other', n: 1 };
      if (f === 'DeviceN') {
        const names = lookup(this.ctx, cs.get(1));
        return { kind: 'other', n: names instanceof PDFArray ? names.size() : 1 };
      }
      if (f === 'Indexed') return { kind: 'other', n: 1 };
    }
    return { kind: 'other', n: 1 };
  }

  private setColor(g: GState, stroke: boolean, op: string, args: PdfValue[], resources: PDFDict) {
    const comps = args.filter((a) => a.t === 'num').map((a) => (a as { v: number }).v);
    let c: ColorInfo;
    switch (op.toLowerCase()) {
      case 'g': c = colorFrom('gray', comps); if (stroke) g.strokeCS = 'DeviceGray'; else g.fillCS = 'DeviceGray'; break;
      case 'rg': c = colorFrom('rgb', comps); if (stroke) g.strokeCS = 'DeviceRGB'; else g.fillCS = 'DeviceRGB'; break;
      case 'k': c = colorFrom('cmyk', comps); if (stroke) g.strokeCS = 'DeviceCMYK'; else g.fillCS = 'DeviceCMYK'; break;
      default: {
        const kind = this.colorSpaceKind(stroke ? g.strokeCS : g.fillCS, resources);
        if (kind.kind === 'pattern' || (args.length && args[args.length - 1].t === 'name')) c = { space: 'pattern', comps, rgb: null };
        else if (kind.kind === 'other' && comps.length === 1) {
          // Separation tint: approximate as darkness.
          const t = comps[0];
          c = { space: 'other', comps, rgb: { r: 1 - t, g: 1 - t, b: 1 - t } };
        } else c = colorFrom(kind.kind, comps);
      }
    }
    if (stroke) g.stroke = c;
    else g.fill = c;
  }

  private setColorSpace(g: GState, stroke: boolean, csName: string, resources: PDFDict) {
    const kind = this.colorSpaceKind(csName, resources);
    const initial: ColorInfo =
      kind.kind === 'cmyk' ? colorFrom('cmyk', [0, 0, 0, 1]) : kind.kind === 'rgb' ? colorFrom('rgb', [0, 0, 0]) : kind.kind === 'pattern' ? { space: 'pattern', comps: [], rgb: null } : colorFrom(kind.kind === 'other' ? 'other' : 'gray', [kind.kind === 'other' ? 1 : 0]);
    if (stroke) {
      g.strokeCS = csName;
      g.stroke = initial;
    } else {
      g.fillCS = csName;
      g.fill = initial;
    }
  }

  /** Runs operators; returns the final q-depth and CTM (for append safety). */
  private run(ops: Op[], resources: PDFDict, baseCtm: Matrix, formPath: number[], init?: GState): { depth: number; ctm: Matrix } {
    const ctx = this.ctx;
    let g = init ? { ...cloneState(init), ctm: baseCtm } : initialState(baseCtm);
    const stack: GState[] = [];
    let Tm: Matrix = IDENTITY;
    let Tlm: Matrix = IDENTITY;
    let inText = false;
    // Path state
    let pathStart = -1;
    let pathPts: [number, number][] = [];
    let pathOps: string[] = [];
    let svg = '';
    let cur: [number, number] = [0, 0];
    let subStart: [number, number] = [0, 0];
    let clipPending = false;
    const fontsDict = asDict(dictGet(ctx, resources, 'Font'));
    const xobjDict = asDict(dictGet(ctx, resources, 'XObject'));
    const gsDict = asDict(dictGet(ctx, resources, 'ExtGState'));
    const inForm = formPath.length > 0;
    const propsDict = asDict(dictGet(ctx, resources, 'Properties'));
    const marked: { text: string | null; used: boolean }[] = [];
    const actualFor = (): { text: string | null; used: boolean } | null => {
      for (let k = marked.length - 1; k >= 0; k--) if (marked[k].text !== null) return marked[k];
      return null;
    };

    const tp = (x: number, y: number) => apply(g.ctm, x, y);
    const svgPt = (p: [number, number]) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;

    const resetPath = () => {
      pathStart = -1;
      pathPts = [];
      pathOps = [];
      svg = '';
      clipPending = false;
    };

    for (let i = 0; i < ops.length; i++) {
      const { op, args } = ops[i];
      try {
        switch (op) {
          case 'q':
            stack.push(cloneState(g));
            break;
          case 'Q':
            if (stack.length) g = stack.pop()!;
            break;
          case 'cm':
            if (args.length >= 6) g.ctm = mul([n(args[0]), n(args[1]), n(args[2]), n(args[3]), n(args[4]), n(args[5])], g.ctm);
            break;
          case 'w':
            g.lineWidth = n(args[0]);
            break;
          case 'gs': {
            const nm = args[0]?.t === 'name' ? args[0].v : '';
            const ext = asDict(dictGet(ctx, gsDict, nm));
            if (ext) {
              const ca = dictGet(ctx, ext, 'ca');
              if (ca instanceof PDFNumber) g.fillAlpha = ca.asNumber();
              const fontArr = dictGet(ctx, ext, 'Font');
              if (fontArr instanceof PDFArray) {
                const f = fontArr.get(0);
                g.font = this.fonts.get(f, nm);
                const sz = lookup(ctx, fontArr.get(1));
                if (sz instanceof PDFNumber) g.fontSize = sz.asNumber();
              }
            }
            break;
          }
          case 'g': case 'rg': case 'k': case 'sc': case 'scn':
            this.setColor(g, false, op, args, resources);
            break;
          case 'G': case 'RG': case 'K': case 'SC': case 'SCN':
            this.setColor(g, true, op, args, resources);
            break;
          case 'cs':
            if (args[0]?.t === 'name') this.setColorSpace(g, false, args[0].v, resources);
            break;
          case 'CS':
            if (args[0]?.t === 'name') this.setColorSpace(g, true, args[0].v, resources);
            break;

          // ---- Text ---------------------------------------------------
          case 'BMC':
            marked.push({ text: null, used: false });
            break;
          case 'BDC': {
            let props: PdfValue | undefined = args[1];
            let text: string | null = null;
            if (props?.t === 'dict') {
              const at = props.v.find(([k]) => k === 'ActualText');
              if (at && at[1].t === 'str') text = decodePdfText(at[1].v);
            } else if (props?.t === 'name') {
              const pd = asDict(dictGet(ctx, propsDict, props.v));
              const at = pd ? dictGet(ctx, pd, 'ActualText') : undefined;
              if (at && 'asBytes' in (at as object)) text = decodePdfText((at as unknown as { asBytes(): Uint8Array }).asBytes());
              props = undefined;
            }
            marked.push({ text, used: false });
            break;
          }
          case 'EMC':
            marked.pop();
            break;
          case 'BT':
            inText = true;
            Tm = IDENTITY;
            Tlm = IDENTITY;
            break;
          case 'ET':
            inText = false;
            break;
          case 'Tf': {
            const nm = args[0]?.t === 'name' ? args[0].v : '';
            g.fontName = nm;
            g.fontSize = n(args[1]);
            const fobj = fontsDict?.get(N(nm));
            g.font = fobj ? this.fonts.get(fobj, nm) : null;
            if (!g.font) this.warnings.push(`Missing font resource /${nm}`);
            break;
          }
          case 'Tc': g.Tc = n(args[0]); break;
          case 'Tw': g.Tw = n(args[0]); break;
          case 'Tz': g.Th = n(args[0]) / 100; break;
          case 'TL': g.TL = n(args[0]); break;
          case 'Tr': g.Tr = n(args[0]); break;
          case 'Ts': g.Ts = n(args[0]); break;
          case 'Td':
            Tlm = mul([1, 0, 0, 1, n(args[0]), n(args[1])], Tlm);
            Tm = Tlm;
            break;
          case 'TD':
            g.TL = -n(args[1]);
            Tlm = mul([1, 0, 0, 1, n(args[0]), n(args[1])], Tlm);
            Tm = Tlm;
            break;
          case 'Tm':
            Tlm = [n(args[0]), n(args[1]), n(args[2]), n(args[3]), n(args[4]), n(args[5])];
            Tm = Tlm;
            break;
          case 'T*':
            Tlm = mul([1, 0, 0, 1, 0, -g.TL], Tlm);
            Tm = Tlm;
            break;
          case 'Tj': case 'TJ': case "'": case '"': {
            if (op === "'" || op === '"') {
              if (op === '"') {
                g.Tw = n(args[0]);
                g.Tc = n(args[1]);
              }
              Tlm = mul([1, 0, 0, 1, 0, -g.TL], Tlm);
              Tm = Tlm;
            }
            const strArg = op === '"' ? args[2] : args[0];
            const parts: PdfValue[] = op === 'TJ' ? (strArg?.t === 'arr' ? strArg.v : []) : strArg ? [strArg] : [];
            const res = this.showText(g, Tm, Tlm, parts, i, op, formPath, inText, actualFor());
            Tm = res.Tm;
            break;
          }

          // ---- XObjects / images ---------------------------------------
          case 'Do': {
            const nm = args[0]?.t === 'name' ? args[0].v : '';
            const raw = xobjDict?.get(N(nm));
            const xo = lookup(ctx, raw);
            if (!(xo instanceof PDFStream)) break;
            const st = getName(ctx, xo.dict, 'Subtype');
            if (st === 'Image') {
              this.addImage(i, nm, g.ctm, xo, raw instanceof PDFRef ? raw : undefined, formPath);
            } else if (st === 'Form') {
              const fm = numArray(ctx, xo.dict.get(N('Matrix')));
              const m: Matrix = fm.length === 6 ? (fm as Matrix) : IDENTITY;
              const bb = numArray(ctx, xo.dict.get(N('BBox')));
              const bbox: Rect = bb.length === 4 ? { x: Math.min(bb[0], bb[2]), y: Math.min(bb[1], bb[3]), width: Math.abs(bb[2] - bb[0]), height: Math.abs(bb[3] - bb[1]) } : { x: 0, y: 0, width: 0, height: 0 };
              const formCtm = mul(m, g.ctm);
              this.forms.push({ opIndex: i, name: nm, ref: raw instanceof PDFRef ? raw : undefined, matrix: formCtm, bbox: transformRect(formCtm, bbox), formPath });
              if (this.formDepth < 12) {
                this.formDepth++;
                const formRes = asDict(dictGet(ctx, xo.dict, 'Resources')) ?? resources;
                const fs = parseContentStream(streamBytes(xo));
                this.run(fs.ops, formRes, formCtm, [...formPath, i], g);
                this.formDepth--;
              }
            }
            break;
          }
          case 'BI': {
            const inl = ops[i].inline;
            if (inl) {
              const w = n(inlineDictGet(inl.dict, 'Width'));
              const h = n(inlineDictGet(inl.dict, 'Height'));
              const cs = inlineDictGet(inl.dict, 'ColorSpace');
              const f = inlineDictGet(inl.dict, 'Filter');
              this.images.push({
                id: idFor('i', formPath, i),
                kind: 'image',
                opIndex: i,
                name: null,
                inline: true,
                matrix: g.ctm,
                bbox: transformRect(g.ctm, { x: 0, y: 0, width: 1, height: 1 }),
                width: w,
                height: h,
                colorSpace: cs?.t === 'name' ? cs.v : 'Unknown',
                bitsPerComponent: n(inlineDictGet(inl.dict, 'BitsPerComponent')) || 1,
                filter: f?.t === 'name' ? f.v : f?.t === 'arr' ? f.v.map((x) => (x.t === 'name' ? x.v : '')).join(',') : '',
                hasAlpha: false,
                editable: !inForm,
                readOnlyReason: inForm ? 'Inside a Form XObject' : undefined,
                formPath,
              });
            }
            break;
          }

          // ---- Paths ----------------------------------------------------
          case 'm': {
            if (pathStart < 0) pathStart = i;
            const p = tp(n(args[0]), n(args[1]));
            cur = p;
            subStart = p;
            pathPts.push(p);
            pathOps.push('m');
            svg += `M${svgPt(p)}`;
            break;
          }
          case 'l': {
            if (pathStart < 0) pathStart = i;
            const p = tp(n(args[0]), n(args[1]));
            pathPts.push(p);
            cur = p;
            pathOps.push('l');
            svg += `L${svgPt(p)}`;
            break;
          }
          case 'c': case 'v': case 'y': {
            if (pathStart < 0) pathStart = i;
            let c1: [number, number], c2: [number, number], e: [number, number];
            if (op === 'c') {
              c1 = tp(n(args[0]), n(args[1]));
              c2 = tp(n(args[2]), n(args[3]));
              e = tp(n(args[4]), n(args[5]));
            } else if (op === 'v') {
              c1 = cur;
              c2 = tp(n(args[0]), n(args[1]));
              e = tp(n(args[2]), n(args[3]));
            } else {
              c1 = tp(n(args[0]), n(args[1]));
              e = tp(n(args[2]), n(args[3]));
              c2 = e;
            }
            pathPts.push(c1, c2, e);
            cur = e;
            pathOps.push(op);
            svg += `C${svgPt(c1)} ${svgPt(c2)} ${svgPt(e)}`;
            break;
          }
          case 'h':
            pathOps.push('h');
            svg += 'Z';
            cur = subStart;
            break;
          case 're': {
            if (pathStart < 0) pathStart = i;
            const x = n(args[0]), y = n(args[1]), w = n(args[2]), h = n(args[3]);
            const p1 = tp(x, y), p2 = tp(x + w, y), p3 = tp(x + w, y + h), p4 = tp(x, y + h);
            pathPts.push(p1, p2, p3, p4);
            pathOps.push('re');
            svg += `M${svgPt(p1)}L${svgPt(p2)}L${svgPt(p3)}L${svgPt(p4)}Z`;
            cur = p1;
            subStart = p1;
            break;
          }
          case 'W': case 'W*':
            clipPending = true;
            break;
          case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n': {
            if (pathStart >= 0 && op !== 'n') {
              const stroke = op === 'S' || op === 's' || op.startsWith('B') || op.startsWith('b');
              const fill = op !== 'S' && op !== 's';
              let bbox = rectFromPoints(pathPts);
              if (stroke) {
                const lw = Math.max(g.lineWidth, 0) * Math.sqrt(Math.abs(g.ctm[0] * g.ctm[3] - g.ctm[1] * g.ctm[2]));
                bbox = { x: bbox.x - lw / 2, y: bbox.y - lw / 2, width: bbox.width + lw, height: bbox.height + lw };
              }
              this.paths.push({
                id: idFor('p', formPath, pathStart),
                kind: 'path',
                opStart: pathStart,
                opEnd: i,
                ops: [...pathOps, op],
                fill: fill ? g.fill : null,
                stroke: stroke ? g.stroke : null,
                lineWidth: g.lineWidth,
                ctm: g.ctm,
                bbox,
                clip: clipPending,
                svg,
                editable: !inForm && !clipPending,
                readOnlyReason: inForm ? 'Inside a Form XObject' : clipPending ? 'Path is also a clipping path' : undefined,
                formPath,
              });
            }
            resetPath();
            break;
          }
          default:
            break;
        }
      } catch (e) {
        this.degraded = true;
        this.warnings.push(`Operator ${op} at ${i}: ${(e as Error).message}`);
      }
    }
    return { depth: stack.length, ctm: g.ctm };
  }

  private addImage(opIndex: number, name: string, ctm: Matrix, xo: PDFStream, ref: PDFRef | undefined, formPath: number[]) {
    const ctx = this.ctx;
    const d = xo.dict;
    const filt = dictGet(ctx, d, 'Filter');
    const filter = filt instanceof PDFName ? filt.decodeText() : filt instanceof PDFArray ? Array.from({ length: filt.size() }, (_, k) => {
      const x = lookup(ctx, filt.get(k));
      return x instanceof PDFName ? x.decodeText() : '';
    }).join(',') : '';
    const cs = dictGet(ctx, d, 'ColorSpace');
    let csName = 'Unknown';
    if (cs instanceof PDFName) csName = cs.decodeText();
    else if (cs instanceof PDFArray) {
      const f = lookup(ctx, cs.get(0));
      csName = f instanceof PDFName ? f.decodeText() : 'Array';
    } else if (getName(ctx, d, 'ImageMask') || dictGet(ctx, d, 'ImageMask')) csName = 'ImageMask';
    const inForm = formPath.length > 0;
    this.images.push({
      id: idFor('i', formPath, opIndex),
      kind: 'image',
      opIndex,
      name,
      inline: false,
      matrix: ctm,
      bbox: transformRect(ctm, { x: 0, y: 0, width: 1, height: 1 }),
      width: getNumber(ctx, d, 'Width', 0),
      height: getNumber(ctx, d, 'Height', 0),
      colorSpace: csName,
      bitsPerComponent: getNumber(ctx, d, 'BitsPerComponent', 8),
      filter,
      hasAlpha: !!dictGet(ctx, d, 'SMask'),
      editable: !inForm,
      readOnlyReason: inForm ? 'Inside a Form XObject' : undefined,
      ref,
      stream: xo,
      formPath,
    });
  }

  private showText(g: GState, Tm0: Matrix, Tlm: Matrix, parts: PdfValue[], opIndex: number, op: string, formPath: number[], inText: boolean, actual: { text: string | null; used: boolean } | null): { Tm: Matrix } {
    let Tm = Tm0;
    const font = g.font;
    const fs = g.fontSize;
    const Th = g.Th;
    const glyphs: RunGlyph[] = [];
    let x = 0;
    const asc = font ? font.ascent : 0.8;
    const desc = font ? font.descent : -0.2;
    const startMatrix = mul([fs * Th, 0, 0, fs, 0, g.Ts], mul(Tm, g.ctm));
    const glyphBox = (tm: Matrix, w: number): Rect => {
      const trm = mul([fs * Th, 0, 0, fs, 0, g.Ts], mul(tm, g.ctm));
      return rectFromPoints([apply(trm, 0, desc), apply(trm, w, desc), apply(trm, 0, asc), apply(trm, w, asc)]);
    };
    parts.forEach((part, pi) => {
      if (part.t === 'num') {
        const tx = (-part.v / 1000) * fs * Th;
        // Large negative kerning usually encodes a word space.
        if (part.v < -180 && glyphs.length && !/\s$/.test(glyphs[glyphs.length - 1].unicode)) {
          glyphs.push({
            code: -1, len: 0, unicode: ' ', width: 0, isSpace: false, x, adv: tx,
            bbox: glyphBox(Tm, Math.abs(tx / (fs * Th || 1))), part: pi, byteOffset: 0, virtual: true,
          });
        }
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        x += tx;
        return;
      }
      if (part.t !== 'str') return;
      const decoded = font ? font.decode(part.v) : Array.from(part.v).map((c) => ({ code: c, len: 1, unicode: String.fromCharCode(c), width: 500, isSpace: c === 32 }));
      let off = 0;
      for (const dg of decoded) {
        const w0 = dg.width / 1000;
        const tx = (w0 * fs + g.Tc + (dg.isSpace ? g.Tw : 0)) * Th;
        glyphs.push({ ...dg, x, adv: tx, bbox: glyphBox(Tm, w0), part: pi, byteOffset: off });
        off += dg.len;
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        x += tx;
      }
    });
    if (!glyphs.length && !parts.some((p) => p.t === 'str' && p.v.length)) return { Tm };

    let bbox: Rect | null = null;
    for (const gl of glyphs) if (!gl.virtual) bbox = unionRect(bbox, gl.bbox);
    if (!bbox) bbox = { x: startMatrix[4], y: startMatrix[5], width: 0, height: 0 };
    let text = glyphs.map((gl) => gl.unicode).join('');
    let rtl = isRtlText(text);
    let ordered = glyphs;
    if (actual && actual.text !== null) {
      // /ActualText replaces the glyph text: the first run of the span carries it.
      const at = actual.used ? '' : actual.text;
      actual.used = true;
      rtl = isRtlText(at || text);
      glyphs.forEach((gl, k) => {
        gl.unicode = k === 0 ? at : '';
      });
      text = at;
    } else if (rtl) {
      ordered = glyphs.slice().reverse();
      text = ordered.map((gl) => gl.unicode).join('');
    }
    const inForm = formPath.length > 0;
    let readOnlyReason: string | undefined;
    if (inForm) readOnlyReason = 'Inside a Form XObject (use "Make editable" to inline it)';
    else if (!inText) readOnlyReason = 'Text shown outside BT/ET';
    else if (!font) readOnlyReason = 'Font resource missing';
    else if (font.vertical) readOnlyReason = 'Vertical writing mode is not editable';
    const gb: GlyphBox[] = ordered.map((gl) => ({ text: gl.unicode, bbox: gl.bbox }));
    const run: InternalTextRun = {
      id: idFor('t', formPath, opIndex),
      kind: 'text',
      opIndex,
      text,
      font: font ? { ...font.summary(), resourceName: g.fontName } : { resourceName: g.fontName, baseFont: 'Unknown', family: 'Unknown', subtype: 'Unknown', embedded: false, bold: false, italic: false, serif: false, monospace: false, type3: false },
      fontSize: fs,
      color: g.fill,
      renderMode: g.Tr,
      charSpacing: g.Tc,
      wordSpacing: g.Tw,
      horizontalScale: Th * 100,
      rise: g.Ts,
      textMatrix: Tm0,
      lineMatrix: Tlm,
      ctm: g.ctm,
      matrix: startMatrix,
      advance: x,
      origin: { x: startMatrix[4], y: startMatrix[5] },
      rotation: (Math.atan2(startMatrix[1], startMatrix[0]) * 180) / Math.PI,
      bbox,
      glyphs: gb,
      rtl,
      actualText: actual?.text !== null && actual !== null ? true : undefined,
      editable: !readOnlyReason,
      readOnlyReason,
      pdfFont: font,
      fontResName: g.fontName,
      opType: op,
      runGlyphs: glyphs,
      formPath,
    };
    this.texts.push(run);
    return { Tm };
  }
}

/** Decode a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding ~ latin1). */
export function decodePdfText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  return String.fromCharCode(...b);
}

function idFor(prefix: string, formPath: number[], i: number): string {
  return formPath.length ? `f${formPath.join('.')}/${prefix}${i}` : `${prefix}${i}`;
}

/** Utility for consumers: the inverse CTM-relative matrix for placing content at the run's position. */
export function textSpaceToUser(run: TextRun): Matrix {
  return mul(run.textMatrix, run.ctm);
}

export function ctmInverse(m: Matrix): Matrix {
  return invert(m);
}
