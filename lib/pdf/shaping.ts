/**
 * Text shaping (harfbuzzjs primary, fontkit fallback) and bidi handling.
 */
import bidiFactory from 'bidi-js';

export interface RawShapedGlyph {
  gid: number;
  /** Cluster start (UTF-16 index into the shaped string). */
  cluster: number;
  /** Advances / offsets in font units. */
  ax: number;
  dx: number;
  dy: number;
}

interface HbFont {
  destroy(): void;
}

interface HbApi {
  createBlob(bytes: Uint8Array): { destroy(): void };
  createFace(blob: unknown, index: number): { destroy(): void };
  createFont(face: unknown): HbFont;
  createBuffer(): {
    addText(t: string): void;
    guessSegmentProperties(): void;
    setDirection(d: string): void;
    json(): { g: number; cl: number; ax: number; dx: number; dy: number }[];
    destroy(): void;
  };
  shape(font: unknown, buffer: unknown, features?: string): void;
}

export interface Shaper {
  name: string;
  shape(fontKey: string, fontBytes: Uint8Array, text: string, rtl: boolean): RawShapedGlyph[] | null;
}

/** HarfBuzz-backed shaper. `wasm` is the hb.wasm binary. */
export async function createHarfBuzzShaper(wasm: Uint8Array): Promise<Shaper> {
  const [{ default: createHB }, { default: hbjs }] = await Promise.all([
    import('harfbuzzjs/hb.js' as string) as Promise<{ default: (o: unknown) => Promise<unknown> }>,
    import('harfbuzzjs/hbjs.js' as string) as Promise<{ default: (i: unknown) => HbApi }>,
  ]);
  const instance = await createHB({ wasmBinary: wasm });
  const hb = hbjs(instance);
  const fonts = new Map<string, HbFont>();
  return {
    name: 'harfbuzz',
    shape(fontKey, fontBytes, text, rtl) {
      let font = fonts.get(fontKey);
      if (!font) {
        const blob = hb.createBlob(fontBytes);
        const face = hb.createFace(blob, 0);
        font = hb.createFont(face);
        fonts.set(fontKey, font);
      }
      const buf = hb.createBuffer();
      try {
        buf.addText(text);
        buf.guessSegmentProperties();
        buf.setDirection(rtl ? 'rtl' : 'ltr');
        hb.shape(font, buf);
        return buf.json().map((g) => ({ gid: g.g, cluster: g.cl, ax: g.ax, dx: g.dx, dy: g.dy }));
      } finally {
        buf.destroy();
      }
    },
  };
}

type FkLayoutFont = {
  layout(text: string, features?: unknown, script?: string, language?: string, direction?: string): {
    glyphs: { id: number; codePoints: number[] }[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[];
  };
};

/** Shaper based on fontkit's own OpenType layout engine (no wasm needed). */
export function createFontkitShaper(getFont: (key: string) => FkLayoutFont | undefined): Shaper {
  return {
    name: 'fontkit',
    shape(fontKey, _bytes, text, rtl) {
      const f = getFont(fontKey);
      if (!f) return null;
      const run = f.layout(text, undefined, undefined, undefined, rtl ? 'rtl' : 'ltr');
      // Reconstruct clusters from code points (in logical order).
      const logical = rtl ? run.glyphs.slice().reverse() : run.glyphs;
      const clusters: number[] = [];
      let idx = 0;
      for (const g of logical) {
        clusters.push(idx);
        idx += String.fromCodePoint(...(g.codePoints.length ? g.codePoints : [])).length;
      }
      if (rtl) clusters.reverse();
      return run.glyphs.map((g, i) => ({
        gid: g.id,
        cluster: clusters[i] ?? 0,
        ax: run.positions[i].xAdvance,
        dx: run.positions[i].xOffset,
        dy: run.positions[i].yOffset,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Bidi
// ---------------------------------------------------------------------------

let bidi: ReturnType<typeof bidiFactory> | null = null;
const getBidi = () => (bidi ??= bidiFactory());

export interface BidiRun {
  text: string;
  start: number;
  level: number;
  rtl: boolean;
}

const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Split a single line into directional runs in VISUAL order. */
export function bidiRuns(text: string, baseDir: 'auto' | 'ltr' | 'rtl' = 'auto'): BidiRun[] {
  if (!STRONG_RTL.test(text) && baseDir !== 'rtl') return [{ text, start: 0, level: 0, rtl: false }];
  const b = getBidi();
  const { levels } = b.getEmbeddingLevels(text, baseDir === 'auto' ? undefined : baseDir);
  const runs: BidiRun[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || levels[i] !== levels[start]) {
      runs.push({ text: text.slice(start, i), start, level: levels[start], rtl: levels[start] % 2 === 1 });
      start = i;
    }
  }
  // Rule L2: reverse sequences at each level from highest to lowest odd level.
  const maxLevel = Math.max(...runs.map((r) => r.level));
  const minOdd = Math.min(...runs.map((r) => r.level).filter((l) => l % 2 === 1).concat([maxLevel + 1]));
  for (let lvl = maxLevel; lvl >= minOdd && lvl >= 1; lvl--) {
    let i = 0;
    while (i < runs.length) {
      if (runs[i].level >= lvl) {
        let j = i;
        while (j < runs.length && runs[j].level >= lvl) j++;
        const seg = runs.slice(i, j).reverse();
        runs.splice(i, j - i, ...seg);
        i = j;
      } else i++;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------

export type Script = 'latin' | 'bengali' | 'arabic' | 'devanagari' | 'hebrew' | 'cjk' | 'common';

export function scriptOf(cp: number): Script {
  if (cp >= 0x0980 && cp <= 0x09ff) return 'bengali';
  if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return 'arabic';
  if (cp >= 0x0900 && cp <= 0x097f) return 'devanagari';
  if (cp >= 0x0590 && cp <= 0x05ff) return 'hebrew';
  if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2fa1f)) return 'cjk';
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f) || (cp >= 0x370 && cp <= 0x52f) || (cp >= 0x1e00 && cp <= 0x1fff)) return 'latin';
  // Zero-width joiners / combining marks / punctuation / digits follow context.
  return 'common';
}
