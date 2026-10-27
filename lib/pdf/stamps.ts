/**
 * Page decorations written as real page content: watermark (text/image),
 * header/footer, page numbers and Bates numbering. Also the OCR text layer.
 */
import { invert, mul, viewportTransform } from './geom';
import { mkop, name, nums, type Op } from './lexer';
import { FontManager } from './fonts';
import { insertImageOps } from './images';
import { fillColorOps, fontOp, buildShowOps, matrixOp, PageEditor, withActualText } from './writer';
import type { Matrix, OcrPageResult, PageInfo, Rect, RGB, StampOptions } from './types';
import type { PDFRef } from 'pdf-lib';

/** Display space: origin bottom-left of the page as shown (after /Rotate), y up, points. */
export function displayToUser(info: Pick<PageInfo, 'view' | 'rotation' | 'height'>): Matrix {
  const V = viewportTransform(info.view, info.rotation, 1);
  const F: Matrix = [1, 0, 0, -1, 0, info.height];
  return invert(mul(V, F));
}

export interface TextLineSpec {
  text: string;
  family?: string;
  bold?: boolean;
  italic?: boolean;
  fontSize: number;
}

/** BT..ET ops drawing one line at (x, y) (baseline) in the current space. */
export async function textLineOps(editor: PageEditor, fonts: FontManager, spec: TextLineSpec, x: number, y: number, opts: { renderMode?: number; hScale?: number } = {}): Promise<{ ops: Op[]; width: number }> {
  const layout = await fonts.layout({ text: spec.text, family: spec.family ?? 'Arimo', bold: spec.bold ?? false, italic: spec.italic ?? false });
  const Th = (opts.hScale ?? 100) / 100;
  const ops: Op[] = [mkop('BT'), nums('Tr', opts.renderMode ?? 0), nums('Tz', opts.hScale ?? 100), nums('Tc', 0), nums('Tw', 0), matrixOp('Tm', [1, 0, 0, 1, x, y])];
  const show: Op[] = [];
  let width = 0;
  for (const seg of layout.segments) {
    const resName = seg.font.kind === 'existing' ? seg.font.resName : editor.addResource('Font', 'FS', seg.font.ref as PDFRef);
    show.push(fontOp(resName, spec.fontSize));
    const r = buildShowOps(seg.glyphs, { fontSize: spec.fontSize, Tc: 0, Tw: 0, Th, baseRise: 0 });
    show.push(...r.ops);
    width += r.advance;
  }
  ops.push(...withActualText(show, layout.actualText), mkop('ET'));
  return { ops, width };
}

export async function measureText(fonts: FontManager, spec: TextLineSpec): Promise<number> {
  const l = await fonts.layout({ text: spec.text, family: spec.family ?? 'Arimo', bold: spec.bold ?? false, italic: spec.italic ?? false });
  return (l.advance / 1000) * spec.fontSize;
}

export function expandTokens(fmt: string, page: number, total: number, extra: Record<string, string> = {}): string {
  const date = new Date().toISOString().slice(0, 10);
  return fmt
    .replace(/\{page\}/g, String(page))
    .replace(/\{total\}/g, String(total))
    .replace(/\{date\}/g, date)
    .replace(/\{(\w+)\}/g, (m, k) => extra[k] ?? m);
}

export interface StampContext {
  editor: PageEditor;
  fonts: FontManager;
  info: PageInfo;
  pageNumber: number;
  total: number;
  imageRef?: { resRef: PDFRef; width: number; height: number };
  batesNumber?: number;
}

export async function applyStamp(sc: StampContext, o: StampOptions): Promise<void> {
  const { editor, fonts, info } = sc;
  const W = info.width;
  const H = info.height;
  const margin = o.margin ?? 36;
  const color: RGB = o.color ?? (o.kind === 'watermark' ? { r: 0.6, g: 0.6, b: 0.6 } : { r: 0, g: 0, b: 0 });
  const fontSize = o.fontSize ?? (o.kind === 'watermark' ? 60 : 10);
  const opacity = o.opacity ?? (o.kind === 'watermark' ? 0.3 : 1);
  const d2u = displayToUser(info);
  const ops: Op[] = [mkop('q'), matrixOp('cm', d2u)];
  if (opacity < 1) ops.push(mkop('gs', name(editor.alphaState(opacity))));

  if (o.kind === 'watermark' && sc.imageRef) {
    const iw = W * 0.5;
    const ih = (iw * sc.imageRef.height) / sc.imageRef.width;
    const resName = editor.addResource('XObject', 'WmI', sc.imageRef.resRef);
    const rect: Rect = { x: (W - iw) / 2, y: (H - ih) / 2, width: iw, height: ih };
    ops.push(...insertImageOps(resName, rect, o.rotation ?? 0));
  } else {
    let text = o.text ?? '';
    if (o.kind === 'pageNumbers') text = expandTokens(o.format ?? 'Page {page} of {total}', sc.pageNumber, sc.total);
    else if (o.kind === 'bates') text = `${o.prefix ?? ''}${String(sc.batesNumber ?? 1).padStart(o.digits ?? 6, '0')}${o.suffix ?? ''}`;
    else text = expandTokens(text, sc.pageNumber, sc.total);
    if (!text) return;
    const spec: TextLineSpec = { text, family: o.fontFamily, fontSize };
    const width = await measureText(fonts, spec);
    ops.push(...fillColorOps(color));
    if (o.kind === 'watermark') {
      const rot = ((o.rotation ?? 45) * Math.PI) / 180;
      const c = Math.cos(rot), s = Math.sin(rot);
      // Rotate about the page centre, then centre the text on its own midpoint.
      ops.push(nums('cm', c, s, -s, c, W / 2, H / 2));
      const { ops: t } = await textLineOps(editor, fonts, spec, -width / 2, -fontSize * 0.35);
      ops.push(...t);
    } else {
      const top = o.kind === 'header';
      const pos = o.position ?? (o.kind === 'bates' ? 'right' : o.kind === 'pageNumbers' ? 'center' : 'center');
      const x = pos === 'left' ? margin : pos === 'right' ? W - margin - width : (W - width) / 2;
      const y = top ? H - margin - fontSize * 0.8 : margin;
      const { ops: t } = await textLineOps(editor, fonts, spec, x, y);
      ops.push(...t);
    }
  }
  ops.push(mkop('Q'));
  if (o.behind) editor.prepend(ops);
  else editor.append(ops);
}

/** Write an OCR text layer in display space. Invisible (searchable) or visible (editable). */
export async function ocrTextOps(editor: PageEditor, fonts: FontManager, info: PageInfo, res: OcrPageResult, visible: boolean): Promise<{ ops: Op[]; wordRects: Rect[] }> {
  const sx = info.width / res.imageWidth;
  const sy = info.height / res.imageHeight;
  const d2u = displayToUser(info);
  const ops: Op[] = [mkop('q'), matrixOp('cm', d2u)];
  if (visible) ops.push(nums('rg', 0, 0, 0));
  const wordRects: Rect[] = [];
  for (const w of res.words) {
    const text = w.text.trim();
    if (!text) continue;
    const x = w.x0 * sx;
    const yb = info.height - w.y1 * sy;
    const h = (w.y1 - w.y0) * sy;
    const bw = (w.x1 - w.x0) * sx;
    if (h <= 0 || bw <= 0) continue;
    const fontSize = Math.max(1, h * 0.92);
    const natural = await measureText(fonts, { text, fontSize });
    const hScale = natural > 0 ? Math.max(20, Math.min(400, (bw / natural) * 100)) : 100;
    const { ops: t } = await textLineOps(editor, fonts, { text, fontSize }, x, yb + h * 0.2, { renderMode: visible ? 0 : 3, hScale });
    ops.push(...t);
    // Word rect in user space for image clean-up
    const p0 = [x * d2u[0] + yb * d2u[2] + d2u[4], x * d2u[1] + yb * d2u[3] + d2u[5]];
    const p1 = [(x + bw) * d2u[0] + (yb + h) * d2u[2] + d2u[4], (x + bw) * d2u[1] + (yb + h) * d2u[3] + d2u[5]];
    wordRects.push({ x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]), width: Math.abs(p1[0] - p0[0]), height: Math.abs(p1[1] - p0[1]) });
  }
  ops.push(mkop('Q'));
  return { ops, wordRects };
}
