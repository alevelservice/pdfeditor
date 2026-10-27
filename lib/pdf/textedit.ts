/**
 * Text editing on the object model, expressed as content-stream rewrites.
 *
 * Strategy per edit:
 *  1. Same style and every glyph exists in the embedded font -> the show
 *     operator's string is re-encoded in place and a TJ correction keeps
 *     following text exactly where it was.
 *  2. Otherwise the run is replaced by an isolated text object
 *     (ET q BT ... ET Q BT) using a matched/embedded font, and the text
 *     matrix is restored afterwards.
 */
import { mkop, nums, type Op } from './lexer';
import { mul } from './geom';
import { FontManager, type LayoutResult } from './fonts';
import { scriptOf } from './shaping';
import { effectiveFontSize } from './layout';
import {
  blankRunOps,
  buildShowOps,
  fillColorOps,
  fontOp,
  isolatedAtRun,
  matrixOp,
  PageEditor,
  plainShowOp,
  restoreOps,
  runPrefix,
  transformedTm,
  withActualText,
} from './writer';
import type { InternalTextRun } from './parser';
import type { FontWarning, Matrix, Rect, RGB, TextBlock, TextLine, TextStyle } from './types';

export interface TextEditEnv {
  editor: PageEditor;
  fonts: FontManager;
  runs: Map<string, InternalTextRun>;
  warnings: FontWarning[];
}

const hasStyle = (s?: TextStyle) =>
  !!s && (s.fontFamily !== undefined || s.fontSize !== undefined || s.color !== undefined || s.bold !== undefined || s.italic !== undefined || s.charSpacing !== undefined || s.lineHeight !== undefined || s.align !== undefined);

/** Style properties that require a different font. */
const changesFont = (s?: TextStyle) => !!s && (s.fontFamily !== undefined || s.bold !== undefined || s.italic !== undefined);

function scaleOf(run: InternalTextRun): { sx: number; sy: number; M: Matrix } {
  const M = mul(run.textMatrix, run.ctm);
  return { sx: Math.hypot(M[0], M[1]) || 1, sy: Math.hypot(M[2], M[3]) || 1, M };
}

/** Tf size producing the requested effective (page-space) size. */
function tfSizeFor(run: InternalTextRun, effective?: number): number {
  if (effective === undefined) return run.fontSize;
  const eff = effectiveFontSize(run) || run.fontSize;
  return run.fontSize * (effective / eff);
}

async function layoutFor(env: TextEditEnv, run: InternalTextRun, text: string, style?: TextStyle): Promise<LayoutResult> {
  const reuse = !changesFont(style) && run.pdfFont ? { font: run.pdfFont, resName: run.fontResName } : null;
  const res = await env.fonts.layout({
    text,
    existing: reuse,
    family: style?.fontFamily && style.fontFamily !== 'Original' ? style.fontFamily : undefined,
    bold: style?.bold,
    italic: style?.italic,
  });
  if (!reuse && run.pdfFont && changesFont(style)) {
    // Explicit font change requested: not a warning.
    res.warnings = res.warnings.filter((w) => w.original !== run.pdfFont!.baseFont);
  }
  env.warnings.push(...res.warnings);
  return res;
}

/** Ops for shaped segments (with Tf for each font switch). */
function segmentOps(env: TextEditEnv, layout: LayoutResult, tf: number, run: Pick<InternalTextRun, 'charSpacing' | 'wordSpacing' | 'horizontalScale' | 'rise'>, Tc: number, spaceExtra = 0): { ops: Op[]; advance: number } {
  const ops: Op[] = [];
  let advance = 0;
  for (const seg of layout.segments) {
    const resName = seg.font.kind === 'existing' ? seg.font.resName : env.editor.addResource('Font', 'FE', seg.font.ref);
    ops.push(fontOp(resName, tf));
    const r = buildShowOps(seg.glyphs, { fontSize: tf, Tc, Tw: run.wordSpacing, Th: run.horizontalScale / 100, baseRise: run.rise, spaceExtra });
    ops.push(...r.ops);
    advance += r.advance;
  }
  return { ops: withActualText(ops, layout.actualText), advance };
}

function styleOps(run: InternalTextRun, style?: TextStyle): { ops: Op[]; Tc: number } {
  const ops: Op[] = [];
  let Tc = run.charSpacing;
  if (style?.color) ops.push(...fillColorOps(style.color));
  if (style?.charSpacing !== undefined) {
    // UI letter spacing is in page points; convert to unscaled text space.
    Tc = style.charSpacing / scaleOf(run).sx;
    ops.push(nums('Tc', Tc));
  }
  return { ops, Tc };
}

/** Re-set the text of a single run. */
export async function editRun(env: TextEditEnv, run: InternalTextRun, newText: string, style?: TextStyle): Promise<void> {
  const { editor } = env;
  const original = editor.ops[run.opIndex];
  if (!newText.length) {
    editor.replace(run.opIndex, blankRunOps(run, original, editor.warnings));
    return;
  }
  const layout = await layoutFor(env, run, newText, style);
  if (!hasStyle(style) && layout.usedExisting) {
    const show = buildShowOps(layout.segments[0].glyphs, {
      fontSize: run.fontSize,
      Tc: run.charSpacing,
      Tw: run.wordSpacing,
      Th: run.horizontalScale / 100,
      baseRise: run.rise,
    });
    const fsTh = run.fontSize * (run.horizontalScale / 100);
    const ops = [...runPrefix(run, original), ...show.ops];
    const delta = show.advance - run.advance;
    if (Math.abs(delta) > 1e-6 && Math.abs(fsTh) > 1e-9) ops.push(mkop('TJ', { t: 'arr', v: [{ t: 'num', v: Math.round(((delta * 1000) / fsTh) * 1000) / 1000 }] }));
    editor.replace(run.opIndex, ops);
    return;
  }
  const tf = tfSizeFor(run, style?.fontSize);
  const st = styleOps(run, style);
  const seg = segmentOps(env, layout, tf, run, st.Tc);
  editor.replace(run.opIndex, isolatedAtRun(run, original, [...st.ops, matrixOp('Tm', run.textMatrix), ...seg.ops], editor.warnings));
}

function leftmostRun(env: TextEditEnv, line: TextLine): InternalTextRun {
  const runs = line.runIds.map((id) => env.runs.get(id)!).filter(Boolean);
  const a = (line.rotation * Math.PI) / 180;
  const u = (r: InternalTextRun) => r.origin.x * Math.cos(a) + r.origin.y * Math.sin(a);
  return runs.reduce((best, r) => (u(r) < u(best) ? r : best), runs[0]);
}

/** Replace a whole line of text (possibly spanning several runs). */
export async function editLine(env: TextEditEnv, line: TextLine, newText: string, style?: TextStyle): Promise<void> {
  const runs = line.runIds.map((id) => env.runs.get(id)).filter((r): r is InternalTextRun => !!r);
  if (!runs.length) return;
  const locked = runs.find((r) => !r.editable);
  if (locked) throw new Error(`Text is not editable: ${locked.readOnlyReason ?? 'unsupported'}`);
  if (newText === line.text && !hasStyle(style)) return;

  if (!hasStyle(style) && !runs.some((r) => r.actualText)) {
    // Minimal diff: if the change falls inside one run, edit only that run.
    const old = line.text;
    let p = 0;
    while (p < old.length && p < newText.length && old[p] === newText[p]) p++;
    let s = 0;
    while (s < old.length - p && s < newText.length - p && old[old.length - 1 - s] === newText[newText.length - 1 - s]) s++;
    const oldEnd = old.length - s;
    const inserted = newText.slice(p, newText.length - s);
    const span = line.runSpans.find((sp) => sp.start <= p && oldEnd <= sp.end && (p < sp.end || p === sp.end));
    if (span) {
      const run = env.runs.get(span.runId)!;
      const local = run.text.slice(0, p - span.start) + inserted + run.text.slice(oldEnd - span.start);
      await editRun(env, run, local);
      return;
    }
  }

  // Rewrite the whole line anchored at its leftmost run.
  const anchor = leftmostRun(env, line);
  for (const r of runs) {
    if (r === anchor) continue;
    env.editor.replace(r.opIndex, blankRunOps(r, env.editor.ops[r.opIndex], env.editor.warnings));
  }
  if (!newText.length) {
    env.editor.replace(anchor.opIndex, blankRunOps(anchor, env.editor.ops[anchor.opIndex], env.editor.warnings));
    return;
  }
  const layout = await layoutFor(env, anchor, newText, style);
  if (!hasStyle(style) && layout.usedExisting && runs.length === 1 && !anchor.actualText) {
    await editRun(env, anchor, newText);
    return;
  }
  const tf = tfSizeFor(anchor, style?.fontSize);
  const st = styleOps(anchor, style);
  const seg = segmentOps(env, layout, tf, anchor, st.Tc);
  const original = env.editor.ops[anchor.opIndex];
  env.editor.replace(anchor.opIndex, isolatedAtRun(anchor, original, [...st.ops, matrixOp('Tm', anchor.textMatrix), ...seg.ops], env.editor.warnings));
}

// ---------------------------------------------------------------------------
// Paragraph editing with reflow
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  // Words separated by spaces; CJK characters break anywhere.
  const tokens: string[] = [];
  let cur = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === ' ') {
      if (cur) tokens.push(cur);
      tokens.push(' ');
      cur = '';
    } else if (scriptOf(cp) === 'cjk') {
      if (cur) tokens.push(cur);
      tokens.push(ch);
      cur = '';
    } else cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export async function wrapText(text: string, maxWidth: number, measure: (s: string) => Promise<number>): Promise<string[]> {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const tokens = tokenize(para);
    let line = '';
    for (const tok of tokens) {
      const candidate = line + tok;
      if (!line || tok === ' ' || (await measure(candidate.trimEnd())) <= maxWidth + 0.01) {
        line = candidate;
        continue;
      }
      out.push(line.trimEnd());
      line = tok;
      // Break overlong single tokens by characters.
      while ((await measure(line)) > maxWidth && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && (await measure(line.slice(0, k))) > maxWidth) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Edit a paragraph. If the number of lines is unchanged and no style is
 * applied, each line is edited individually (layout preserved). Otherwise
 * the paragraph is reflowed into its original width.
 */
export async function editBlock(env: TextEditEnv, block: TextBlock, lines: TextLine[], newText: string, style?: TextStyle, forceReflow = false): Promise<void> {
  const newLines = newText.split('\n');
  if (!forceReflow && !hasStyle(style) && newLines.length === lines.length) {
    for (let i = 0; i < lines.length; i++) if (newLines[i] !== lines[i].text) await editLine(env, lines[i], newLines[i]);
    return;
  }
  const allRuns = lines.flatMap((l) => l.runIds.map((id) => env.runs.get(id)!)).filter(Boolean);
  const locked = allRuns.find((r) => !r.editable);
  if (locked) throw new Error(`Text is not editable: ${locked.readOnlyReason ?? 'unsupported'}`);
  const anchor = leftmostRun(env, lines[0]);
  for (const r of allRuns) if (r !== anchor) env.editor.replace(r.opIndex, blankRunOps(r, env.editor.ops[r.opIndex], env.editor.warnings));

  const effOld = lines[0].fontSize || effectiveFontSize(anchor);
  const effNew = style?.fontSize ?? effOld;
  const tf = tfSizeFor(anchor, effNew);
  const { sx, sy } = scaleOf(anchor);
  const ratio = effNew / effOld;
  const lhPage = style?.lineHeight ? style.lineHeight * effNew : block.lineHeight * ratio;
  const lhText = lhPage / sy;
  const angle = (lines[0].rotation * Math.PI) / 180;
  const proj = (x: number, y: number) => x * Math.cos(angle) + y * Math.sin(angle);
  // Block extents along the baseline direction (page units).
  const corners: [number, number][] = [
    [block.bbox.x, block.bbox.y], [block.bbox.x + block.bbox.width, block.bbox.y],
    [block.bbox.x, block.bbox.y + block.bbox.height], [block.bbox.x + block.bbox.width, block.bbox.y + block.bbox.height],
  ];
  const us = corners.map(([x, y]) => proj(x, y));
  const blockLeft = Math.min(...us);
  const blockWidthPage = Math.max(...us) - blockLeft;
  const anchorU = proj(anchor.origin.x, anchor.origin.y);
  const leftOffsetText = (blockLeft - anchorU) / sx;
  const widthText = Math.max(blockWidthPage / sx, 1);
  const st = styleOps(anchor, style);
  const Th = anchor.horizontalScale / 100;

  const cache = new Map<string, LayoutResult>();
  const layoutOf = async (s: string) => {
    let l = cache.get(s);
    if (!l) {
      l = await env.fonts.layout({
        text: s,
        existing: !changesFont(style) && anchor.pdfFont ? { font: anchor.pdfFont, resName: anchor.fontResName } : null,
        family: style?.fontFamily && style.fontFamily !== 'Original' ? style.fontFamily : undefined,
        bold: style?.bold,
        italic: style?.italic,
      });
      cache.set(s, l);
    }
    return l;
  };
  const advOf = (l: LayoutResult, s: string) => ((l.advance / 1000) * tf + st.Tc * Array.from(s).length) * Th;
  const measure = async (s: string) => advOf(await layoutOf(s), s);
  const wrapped = await wrapText(newText, widthText, measure);
  const align = style?.align ?? block.align;

  const inner: Op[] = [...st.ops];
  for (let k = 0; k < wrapped.length; k++) {
    const text = wrapped[k];
    if (!text) continue;
    const l = await layoutOf(text);
    env.warnings.push(...l.warnings.filter((w) => !env.warnings.some((x) => x.substitute === w.substitute && x.original === w.original)));
    const adv = advOf(l, text);
    let x = k === 0 && Math.abs(leftOffsetText) < 0.5 * tf ? 0 : leftOffsetText;
    let spaceExtra = 0;
    if (align === 'center') x = leftOffsetText + (widthText - adv) / 2;
    else if (align === 'right') x = leftOffsetText + (widthText - adv);
    else if (align === 'justify' && k < wrapped.length - 1) {
      const spaces = (text.match(/ /g) ?? []).length;
      if (spaces) spaceExtra = (((widthText - adv) / spaces) * 1000) / (tf * Th);
    }
    const Tm = mul([1, 0, 0, 1, x, -k * lhText], anchor.textMatrix);
    inner.push(matrixOp('Tm', Tm));
    inner.push(...segmentOps(env, l, tf, anchor, st.Tc, spaceExtra).ops);
  }
  const original = env.editor.ops[anchor.opIndex];
  env.editor.replace(anchor.opIndex, isolatedAtRun(anchor, original, inner, env.editor.warnings));
}

// ---------------------------------------------------------------------------
// Move / transform / delete
// ---------------------------------------------------------------------------

export function transformRuns(env: TextEditEnv, runs: InternalTextRun[], D: Matrix) {
  for (const run of runs) {
    if (!run.editable) throw new Error(`Text is not editable: ${run.readOnlyReason}`);
    const original = env.editor.ops[run.opIndex];
    env.editor.replace(run.opIndex, isolatedAtRun(run, original, [matrixOp('Tm', transformedTm(run, D)), plainShowOp(run, original)], env.editor.warnings));
  }
}

export function deleteRuns(env: TextEditEnv, runs: InternalTextRun[]) {
  for (const run of runs) {
    if (!run.editable) throw new Error(`Text is not editable: ${run.readOnlyReason}`);
    env.editor.replace(run.opIndex, blankRunOps(run, env.editor.ops[run.opIndex], env.editor.warnings));
  }
}

/** Re-colour runs without changing anything else. */
export function recolorRuns(env: TextEditEnv, runs: InternalTextRun[], color: RGB) {
  for (const run of runs) {
    const original = env.editor.ops[run.opIndex];
    env.editor.replace(run.opIndex, isolatedAtRun(run, original, [...fillColorOps(color), matrixOp('Tm', run.textMatrix), plainShowOp(run, original)], env.editor.warnings));
  }
}

// ---------------------------------------------------------------------------
// New text boxes
// ---------------------------------------------------------------------------

export interface NewTextBox {
  /** Top-left of the box in page space (y up). */
  x: number;
  y: number;
  width: number;
  text: string;
  style: Required<Pick<TextStyle, 'fontSize'>> & TextStyle;
}

export async function addTextBox(env: TextEditEnv, box: NewTextBox): Promise<Rect> {
  const fs = box.style.fontSize;
  const family = box.style.fontFamily && box.style.fontFamily !== 'Original' ? box.style.fontFamily : 'Arimo';
  const lh = (box.style.lineHeight ?? 1.2) * fs;
  const Tc = box.style.charSpacing ?? 0;
  const state = { charSpacing: Tc, wordSpacing: 0, horizontalScale: 100, rise: 0 };
  const cache = new Map<string, LayoutResult>();
  const layoutOf = async (s: string) => {
    let l = cache.get(s);
    if (!l) {
      l = await env.fonts.layout({ text: s, family, bold: box.style.bold ?? false, italic: box.style.italic ?? false });
      cache.set(s, l);
    }
    return l;
  };
  const measure = async (s: string) => ((await layoutOf(s)).advance / 1000) * fs + Tc * Array.from(s).length;
  const lines = box.width > 0 ? await wrapText(box.text, box.width, measure) : box.text.split('\n');
  const ops: Op[] = [mkop('q'), mkop('BT'), ...fillColorOps(box.style.color ?? { r: 0, g: 0, b: 0 }), nums('Tc', Tc), nums('Tw', 0), nums('Tz', 100), nums('Tr', 0), nums('Ts', 0)];
  let maxW = 0;
  const align = box.style.align ?? 'left';
  for (let k = 0; k < lines.length; k++) {
    const text = lines[k];
    if (!text) continue;
    const l = await layoutOf(text);
    env.warnings.push(...l.warnings);
    const w = await measure(text);
    maxW = Math.max(maxW, w);
    let dx = 0;
    if (box.width > 0 && align === 'center') dx = (box.width - w) / 2;
    else if (box.width > 0 && align === 'right') dx = box.width - w;
    let spaceExtra = 0;
    if (box.width > 0 && align === 'justify' && k < lines.length - 1) {
      const spaces = (text.match(/ /g) ?? []).length;
      if (spaces) spaceExtra = (((box.width - w) / spaces) * 1000) / fs;
    }
    ops.push(matrixOp('Tm', [1, 0, 0, 1, box.x + dx, box.y - fs * 0.8 - k * lh]));
    ops.push(...segmentOps(env, l, fs, state, Tc, spaceExtra).ops);
  }
  ops.push(mkop('ET'), mkop('Q'));
  env.editor.append(ops);
  const height = Math.max(1, lines.length) * lh;
  return { x: box.x, y: box.y - height, width: box.width > 0 ? box.width : maxW, height };
}

export { restoreOps };
