/**
 * True redaction: content under the redaction areas is removed from the
 * content stream (glyph by glyph), image pixels are overwritten, covered
 * vector paths and annotations are deleted. Form XObjects that contain
 * redacted content are copied (copy-on-write) so other pages that share
 * them are not affected.
 */
import { PDFContext, PDFDict, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import { arr, mkop, name, num, nums, str, type Op, type PdfValue } from './lexer';
import { intersectArea, rectsIntersect } from './geom';
import { FontCache } from './fontinfo';
import { inlineToStream, paintImageRegions, pageRectToPixels, type ImageCodec } from './images';
import { asDict, dictGet, flateStream, lookup, N, streamBytes } from './objects';
import { PageInterpreter, type InternalTextRun, type ParsedPage, type RunGlyph } from './parser';
import { PageEditor, runPrefix } from './writer';
import type { Rect, RGB } from './types';

export interface RedactOptions {
  fill: RGB | null;
  codec?: ImageCodec | null;
  /** Remove paths whose area is covered at least this much (0..1). */
  pathThreshold?: number;
}

export interface RedactStats {
  glyphs: number;
  images: number;
  imagesRemoved: number;
  paths: number;
  forms: number;
  warnings: string[];
}

function glyphHit(g: RunGlyph, rects: Rect[]): boolean {
  const b = g.bbox;
  const area = b.width * b.height;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  for (const r of rects) {
    if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) return true;
    if (area > 0 && intersectArea(b, r) / area >= 0.3) return true;
  }
  return false;
}

/** Rebuild a show operator without the redacted glyphs, keeping positions of the others. */
function redactRunOps(run: InternalTextRun, original: Op, rects: Rect[]): { ops: Op[]; removed: number } | null {
  const hits = run.runGlyphs.filter((g) => !g.virtual && glyphHit(g, rects));
  if (!hits.length) return null;
  const fsTh = run.fontSize * (run.horizontalScale / 100);
  const strArg = run.opType === '"' ? original.args[2] : original.args[0];
  const parts: PdfValue[] = run.opType === 'TJ' ? (strArg?.t === 'arr' ? strArg.v : []) : strArg ? [strArg] : [];
  const items: PdfValue[] = [];
  let pending: number[] = [];
  const flush = () => {
    if (pending.length) items.push(str(Uint8Array.from(pending)));
    pending = [];
  };
  const pushNum = (n: number) => {
    flush();
    const last = items[items.length - 1];
    if (last && last.t === 'num') last.v += n;
    else items.push(num(n));
  };
  const hitSet = new Set(hits);
  parts.forEach((part, pi) => {
    if (part.t === 'num') {
      pushNum(part.v);
      return;
    }
    if (part.t !== 'str') return;
    const gl = run.runGlyphs.filter((g) => g.part === pi && !g.virtual).sort((a, b) => a.byteOffset - b.byteOffset);
    for (const g of gl) {
      if (hitSet.has(g)) {
        if (Math.abs(fsTh) > 1e-9) pushNum((-g.adv * 1000) / fsTh);
      } else {
        for (let k = 0; k < g.len; k++) pending.push(part.v[g.byteOffset + k]);
      }
    }
  });
  flush();
  const rounded = items.map((it) => (it.t === 'num' ? num(Math.round(it.v * 1000) / 1000) : it));
  return { ops: [...runPrefix(run, original), mkop('TJ', arr(rounded))], removed: hits.length };
}

async function redactParsed(
  ctx: PDFContext,
  editor: PageEditor,
  parsed: ParsedPage,
  rects: Rect[],
  opts: RedactOptions,
  stats: RedactStats,
  resources: PDFDict,
  depth: number,
): Promise<void> {
  // Text
  for (const run of parsed.texts) {
    if (run.formPath.length) continue;
    if (!rects.some((r) => rectsIntersect(r, run.bbox))) continue;
    const res = redactRunOps(run, editor.ops[run.opIndex], rects);
    if (res) {
      editor.replace(run.opIndex, res.ops);
      stats.glyphs += res.removed;
    }
  }
  // Images
  for (const img of parsed.images) {
    if (img.formPath.length) continue;
    const hit = rects.filter((r) => rectsIntersect(r, img.bbox));
    if (!hit.length) continue;
    const regions = hit.map((r) => pageRectToPixels(img, r)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!regions.length) continue;
    let stream: PDFStream | undefined = img.stream;
    const op = editor.ops[img.opIndex];
    if (img.inline && op.inline) stream = inlineToStream(ctx, op.inline.dict, op.inline.data);
    const painted = stream ? await paintImageRegions(ctx, stream, regions.map((r) => ({ ...r, rgb: opts.fill ? [opts.fill.r * 255, opts.fill.g * 255, opts.fill.b * 255] as [number, number, number] : [0, 0, 0] })), opts.codec) : null;
    if (painted) {
      const ref = ctx.register(painted);
      const nm = editor.addResource('XObject', 'ImR', ref);
      editor.replace(img.opIndex, [mkop('Do', name(nm))]);
      stats.images++;
    } else {
      editor.replace(img.opIndex, []);
      stats.imagesRemoved++;
      stats.warnings.push(`Image ${img.name ?? 'inline'} (${img.filter || 'raw'}) could not be edited pixel-wise and was removed entirely.`);
    }
  }
  // Vector paths
  const threshold = opts.pathThreshold ?? 0.5;
  for (const p of parsed.paths) {
    if (p.formPath.length || p.clip) continue;
    const area = p.bbox.width * p.bbox.height;
    let covered = 0;
    for (const r of rects) covered += intersectArea(p.bbox, r);
    const thin = area < 1 && rects.some((r) => rectsIntersect(r, p.bbox));
    if (thin || (area > 0 && covered / area >= threshold)) {
      editor.removeRange(p.opStart, p.opEnd);
      stats.paths++;
    }
  }
  // Form XObjects (copy-on-write)
  if (depth > 8) return;
  const xobjs = asDict(dictGet(ctx, resources, 'XObject'));
  for (const f of parsed.forms) {
    if (f.formPath.length) continue;
    if (!rects.some((r) => rectsIntersect(r, f.bbox))) continue;
    const raw = xobjs?.get(N(f.name));
    const xo = lookup(ctx, raw);
    if (!(xo instanceof PDFStream)) continue;
    const newRef = await redactForm(ctx, xo, f.matrix, rects, opts, stats, depth + 1);
    if (newRef) {
      const nm = editor.addResource('XObject', 'FmR', newRef);
      editor.replace(f.opIndex, [mkop('Do', name(nm))]);
      stats.forms++;
    }
  }
}

async function redactForm(ctx: PDFContext, form: PDFStream, ctm: [number, number, number, number, number, number], rects: Rect[], opts: RedactOptions, stats: RedactStats, depth: number): Promise<PDFRef | null> {
  const resources = asDict(dictGet(ctx, form.dict, 'Resources')) ?? (ctx.obj({}) as PDFDict);
  const fonts = new FontCache(ctx);
  const interp = new PageInterpreter(ctx, fonts);
  const parsed = interp.parsePage(streamBytes(form), resources, ctm);
  // Form editor uses a detached dict as its "leaf" (Resources only).
  const holder = ctx.obj({}) as PDFDict;
  holder.set(N('Resources'), resources);
  const editor = new PageEditor(ctx, holder, parsed);
  await redactParsed(ctx, editor, parsed, rects, opts, stats, resources, depth);
  if (!editor.dirty) return null;
  const bytes = editor.buildBytes();
  const s = flateStream(ctx, bytes);
  for (const [k, v] of form.dict.entries()) {
    const key = k.decodeText();
    if (['Filter', 'DecodeParms', 'Length'].includes(key)) continue;
    s.dict.set(k, v);
  }
  const newRes = holder.get(N('Resources'));
  if (newRes) s.dict.set(N('Resources'), newRes);
  return ctx.register(s as PDFRawStream);
}

export async function redactPage(ctx: PDFContext, editor: PageEditor, resources: PDFDict, rects: Rect[], opts: RedactOptions): Promise<RedactStats> {
  const stats: RedactStats = { glyphs: 0, images: 0, imagesRemoved: 0, paths: 0, forms: 0, warnings: [] };
  await redactParsed(ctx, editor, editor.parsed, rects, opts, stats, resources, 0);
  if (opts.fill) {
    const ops: Op[] = [mkop('q'), nums('rg', opts.fill.r, opts.fill.g, opts.fill.b)];
    for (const r of rects) ops.push(nums('re', r.x, r.y, r.width, r.height));
    ops.push(mkop('f'), mkop('Q'));
    editor.append(ops);
  }
  return stats;
}
