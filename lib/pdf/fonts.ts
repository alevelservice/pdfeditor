/**
 * Font handling for new / replacement text:
 *  - glyph coverage check against the original (embedded) font
 *  - matching a similar bundled font (metric-compatible Arimo/Tinos/Cousine
 *    for Helvetica/Times/Courier, Noto for complex scripts)
 *  - embedding as Type0/CIDFontType2 (Identity-H, CID = original GID,
 *    CIDToGIDMap -> subset GID) with a ToUnicode CMap
 *  - shaping (HarfBuzz / fontkit) + bidi so Arabic, Hebrew, Bengali,
 *    Devanagari and CJK render correctly.
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Font as StdFont } from '@pdf-lib/standard-fonts';
import { buildToUnicodeCMap } from './cmap';
import { encodeWinAnsi, WinAnsiEncoding } from './encodings';
import type { PdfFont } from './fontinfo';
import { flateStream, N } from './objects';
import { bidiRuns, createFontkitShaper, scriptOf, type Script, type Shaper } from './shaping';
import type { FontWarning } from './types';
import type { Subsetter } from './subset';

/** A positioned glyph ready to be written into a content stream. */
export interface ShapedGlyph {
  /** Character code written in the string (GID for Identity-H fonts). -1 = pure gap. */
  code: number;
  /** Bytes per code (1 or 2); 0 for gaps. */
  len: number;
  /** Desired advance in 1000ths of the font size. */
  ax: number;
  /** Width the PDF viewer will use for this code (1000 units). */
  w: number;
  dx: number;
  dy: number;
  text: string;
  isSpace: boolean;
}

export interface Segment {
  font: TextFontRef;
  glyphs: ShapedGlyph[];
}

/** Font usable for writing: either already in the page resources or a new resource. */
export type TextFontRef =
  | { kind: 'existing'; resName: string; name: string; ascent: number; descent: number }
  | { kind: 'new'; ref: PDFRef; key: string; name: string; ascent: number; descent: number };

export interface FontFaceDef {
  family: string;
  weight: 400 | 700;
  italic: boolean;
  file: string;
  scripts: Script[];
  generic: 'sans' | 'serif' | 'mono';
}

export const FONT_FACES: FontFaceDef[] = [
  ...(['Arimo', 'Tinos', 'Cousine'] as const).flatMap((fam) =>
    ([[400, false], [400, true], [700, false], [700, true]] as const).map(([w, it]) => ({
      family: fam,
      weight: w,
      italic: it,
      file: `${fam}_${w === 400 ? '400Regular' : '700Bold'}${it ? '_Italic' : ''}.ttf`,
      scripts: ['latin', 'common'] as Script[],
      generic: (fam === 'Arimo' ? 'sans' : fam === 'Tinos' ? 'serif' : 'mono') as FontFaceDef['generic'],
    })),
  ),
  ...([
    ['Noto Sans Bengali', 'NotoSansBengali', 'bengali'],
    ['Noto Naskh Arabic', 'NotoNaskhArabic', 'arabic'],
    ['Noto Sans Devanagari', 'NotoSansDevanagari', 'devanagari'],
    ['Noto Sans Hebrew', 'NotoSansHebrew', 'hebrew'],
  ] as const).flatMap(([family, base, script]) =>
    ([400, 700] as const).map((w) => ({
      family,
      weight: w,
      italic: false,
      file: `${base}_${w === 400 ? '400Regular' : '700Bold'}.ttf`,
      scripts: [script, 'common'] as Script[],
      generic: 'sans' as const,
    })),
  ),
  { family: 'Noto Sans SC', weight: 400, italic: false, file: 'cjk:NotoSansSC_400Regular.ttf', scripts: ['cjk', 'common'], generic: 'sans' },
  { family: 'Noto Sans SC', weight: 700, italic: false, file: 'cjk:NotoSansSC_700Bold.ttf', scripts: ['cjk', 'common'], generic: 'sans' },
];

export const FONT_FAMILIES = Array.from(new Set(FONT_FACES.map((f) => f.family)));
export { FAMILY_LABELS } from './fontList';

const SCRIPT_FAMILY: Record<Script, string> = {
  latin: 'Arimo',
  common: 'Arimo',
  bengali: 'Noto Sans Bengali',
  arabic: 'Noto Naskh Arabic',
  devanagari: 'Noto Sans Devanagari',
  hebrew: 'Noto Sans Hebrew',
  cjk: 'Noto Sans SC',
};

export type FontLoader = (file: string) => Promise<Uint8Array>;

/** Pick a bundled family resembling an existing PDF font. */
export function matchFamily(f: { serif: boolean; monospace: boolean; baseFont: string }): string {
  const name = f.baseFont.toLowerCase();
  if (f.monospace || /courier|mono|consol/.test(name)) return 'Cousine';
  if (f.serif || /times|georgia|garamond|cambria|minion|palatino|book|serif/.test(name)) return 'Tinos';
  return 'Arimo';
}

type FkGlyph = { id: number; advanceWidth: number; path: { commands: unknown[] } };
type FkFont = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  postscriptName: string;
  numGlyphs: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  cff?: unknown;
  hasGlyphForCodePoint(cp: number): boolean;
  getGlyph(id: number): FkGlyph;
  glyphForCodePoint(cp: number): FkGlyph;
  layout: never;
};

function randomTag(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += String.fromCharCode(65 + ((h >>> (i * 5)) % 26));
  }
  return s;
}

/** A TrueType/OpenType font embedded by the editor. */
export class EmbeddedFont {
  readonly fk: FkFont;
  readonly upem: number;
  readonly isCFF: boolean;
  readonly ref: PDFRef;
  private cidRef: PDFRef;
  private descRef: PDFRef;
  private fileRef: PDFRef;
  private toUniRef: PDFRef;
  private c2gRef: PDFRef;
  /** CID -> glyph id and CID -> Unicode text. CIDs are glyph ids, except when the same glyph
   * needs a different ToUnicode mapping (shaped clusters); then an extra CID is allocated. */
  private cidGid = new Map<number, number>();
  private cidText = new Map<number, string>();
  private keyCid = new Map<string, number>();
  private nextCid: number;
  private dirty = true;
  private tag: string;
  readonly ascent: number;
  readonly descent: number;

  constructor(ctx: PDFContext, readonly key: string, readonly face: FontFaceDef, readonly bytes: Uint8Array) {
    this.fk = fontkit.create(bytes as never) as unknown as FkFont;
    this.upem = this.fk.unitsPerEm || 1000;
    this.isCFF = !!this.fk.cff;
    this.ref = ctx.nextRef();
    this.cidRef = ctx.nextRef();
    this.descRef = ctx.nextRef();
    this.fileRef = ctx.nextRef();
    this.toUniRef = ctx.nextRef();
    this.c2gRef = ctx.nextRef();
    this.tag = randomTag(key + Date.now() + Math.random());
    this.ascent = this.fk.ascent / this.upem;
    this.descent = this.fk.descent / this.upem;
    this.nextCid = this.fk.numGlyphs;
  }

  private cidFor(gid: number, text: string): number {
    const key = `${gid}|${text}`;
    const known = this.keyCid.get(key);
    if (known !== undefined) return known;
    let cid = gid;
    if (this.cidGid.has(gid) && !this.isCFF && this.nextCid < 0xffff) cid = this.nextCid++;
    else if (this.cidGid.has(gid)) return gid;
    this.cidGid.set(cid, gid);
    this.cidText.set(cid, text);
    this.keyCid.set(key, cid);
    this.dirty = true;
    return cid;
  }

  get psName(): string {
    return (this.fk.postscriptName || this.face.family.replace(/\s+/g, '')).replace(/[^A-Za-z0-9-]/g, '');
  }

  hasChar(cp: number): boolean {
    try {
      return this.fk.hasGlyphForCodePoint(cp);
    } catch {
      return false;
    }
  }

  widthOf(gid: number): number {
    return (this.fk.getGlyph(gid).advanceWidth * 1000) / this.upem;
  }

  /** Shape a single-direction run and register used glyphs. */
  /**
   * Shape a single-direction run and register used glyphs. `exact` is false when
   * the glyph -> text mapping cannot be expressed by ToUnicode alone (reordered
   * or ligated clusters); callers then add /ActualText.
   */
  shape(shaper: Shaper, text: string, rtl: boolean): { glyphs: ShapedGlyph[]; exact: boolean } {
    const raw = shaper.shape(this.key, this.bytes, text, rtl) ?? [];
    const clusters = Array.from(new Set(raw.map((g) => g.cluster))).sort((a, b) => a - b);
    const clusterText = (c: number) => {
      const i = clusters.indexOf(c);
      const end = i + 1 < clusters.length ? clusters[i + 1] : text.length;
      return text.slice(c, end);
    };
    // Per cluster: give every glyph its own characters when the glyphs' code points
    // cover the cluster text exactly (as a multiset); otherwise the first glyph gets all.
    const texts = new Map<number, string>();
    let exact = true;
    const byCluster = new Map<number, number[]>();
    raw.forEach((g, i) => {
      if (!byCluster.has(g.cluster)) byCluster.set(g.cluster, []);
      byCluster.get(g.cluster)!.push(i);
    });
    for (const [cl, idxs] of byCluster) {
      const ct = clusterText(cl);
      if (idxs.length === 1) {
        texts.set(idxs[0], ct);
        continue;
      }
      const own = idxs.map((i) => {
        try {
          // fontkit caches glyphs with empty codePoints; ask the cmap processor directly.
          const proc = (this.fk as unknown as { _cmapProcessor?: { codePointsForGlyph(g: number): number[] } })._cmapProcessor;
          const cps = proc ? proc.codePointsForGlyph(raw[i].gid) : [];
          return cps.length === 1 ? String.fromCodePoint(cps[0]) : '';
        } catch {
          return '';
        }
      });
      // Keep glyphs whose own character belongs to the cluster; give the leftover
      // characters to the first glyph without one (e.g. positional vowel-sign forms).
      const remaining = Array.from(ct);
      const assigned = own.map((ch) => {
        const at = ch ? remaining.indexOf(ch) : -1;
        if (at < 0) return '';
        remaining.splice(at, 1);
        return ch;
      });
      const rest = remaining.join('');
      if (rest) {
        const k = assigned.findIndex((x) => !x);
        if (k >= 0) assigned[k] = rest;
        else assigned[0] += rest;
      }
      idxs.forEach((i, k) => texts.set(i, assigned[k]));
      const visual = assigned.join('');
      if (visual !== (rtl ? Array.from(ct).reverse().join('') : ct) || assigned.some((x) => !x)) exact = false;
    }
    const out: ShapedGlyph[] = raw.map((g, i) => {
      const t = texts.get(i) ?? '';
      const cid = this.cidFor(g.gid, t);
      return {
        code: cid,
        len: 2,
        ax: (g.ax * 1000) / this.upem,
        w: this.widthOf(g.gid),
        dx: (g.dx * 1000) / this.upem,
        dy: (g.dy * 1000) / this.upem,
        text: t,
        isSpace: t === ' ',
      };
    });
    return { glyphs: out, exact };
  }

  /** Write / rewrite all font objects. Safe to call repeatedly. */
  async finalize(ctx: PDFContext, subsetter?: Subsetter | null): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const cids = [...this.cidGid.keys()].sort((a, b) => a - b);
    const gids = Array.from(new Set(this.cidGid.values())).sort((a, b) => a - b);
    const baseName = `${this.tag}+${this.psName}`;
    let fontFile: Uint8Array;
    let c2g: Uint8Array | null = null;
    // Subset with HarfBuzz keeping glyph ids; without a subsetter embed the full font.
    fontFile = this.bytes;
    if (subsetter) {
      try {
        fontFile = subsetter.subset(this.bytes, gids);
      } catch {
        fontFile = this.bytes;
      }
    }
    if (!this.isCFF) {
      // CIDs are original glyph ids (identity) plus extra CIDs for alternate ToUnicode mappings.
      const maxCid = cids.length ? cids[cids.length - 1] : 0;
      c2g = new Uint8Array((maxCid + 1) * 2);
      for (const [cid, gid] of this.cidGid) {
        c2g[cid * 2] = gid >> 8;
        c2g[cid * 2 + 1] = gid & 0xff;
      }
    }

    // Widths
    const W: (PDFNumber | PDFArray)[] = [];
    let i = 0;
    const cw = (cid: number) => PDFNumber.of(Math.round(this.widthOf(this.cidGid.get(cid) ?? cid)));
    while (i < cids.length) {
      const start = cids[i];
      const ws: PDFNumber[] = [cw(start)];
      let j = i + 1;
      while (j < cids.length && cids[j] === cids[j - 1] + 1) {
        ws.push(cw(cids[j]));
        j++;
      }
      W.push(PDFNumber.of(start), ctx.obj(ws) as PDFArray);
      i = j;
    }

    const scaleU = (v: number) => Math.round((v * 1000) / this.upem);
    const bb = this.fk.bbox;
    let flags = 32; // nonsymbolic
    if (this.face.generic === 'serif') flags |= 2;
    if (this.face.generic === 'mono') flags |= 1;
    if (this.face.italic) flags |= 64;

    const fileDict: Record<string, PDFName | PDFNumber> = this.isCFF ? { Subtype: N('OpenType') } : { Length1: PDFNumber.of(fontFile.length) };
    ctx.assign(this.fileRef, flateStream(ctx, fontFile, fileDict));
    if (c2g) ctx.assign(this.c2gRef, flateStream(ctx, c2g));
    ctx.assign(this.toUniRef, flateStream(ctx, buildToUnicodeCMap(this.cidText, 2)));

    const desc = ctx.obj({
      Type: 'FontDescriptor',
      FontName: baseName,
      Flags: flags,
      FontBBox: [scaleU(bb.minX), scaleU(bb.minY), scaleU(bb.maxX), scaleU(bb.maxY)],
      ItalicAngle: this.fk.italicAngle || 0,
      Ascent: scaleU(this.fk.ascent),
      Descent: scaleU(this.fk.descent),
      CapHeight: scaleU(this.fk.capHeight || this.fk.ascent),
      StemV: this.face.weight >= 700 ? 140 : 80,
    }) as PDFDict;
    desc.set(N(this.isCFF ? 'FontFile3' : 'FontFile2'), this.fileRef);
    ctx.assign(this.descRef, desc);

    const cid = ctx.obj({
      Type: 'Font',
      Subtype: this.isCFF ? 'CIDFontType0' : 'CIDFontType2',
      BaseFont: baseName,
      DW: 1000,
    }) as PDFDict;
    cid.set(N('CIDSystemInfo'), ctx.obj({ Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }));
    cid.set(N('FontDescriptor'), this.descRef);
    cid.set(N('W'), ctx.obj(W));
    if (c2g) cid.set(N('CIDToGIDMap'), this.c2gRef);
    ctx.assign(this.cidRef, cid);

    const type0 = ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: baseName, Encoding: 'Identity-H' }) as PDFDict;
    type0.set(N('DescendantFonts'), ctx.obj([this.cidRef]));
    type0.set(N('ToUnicode'), this.toUniRef);
    ctx.assign(this.ref, type0);
  }
}

/** Standard-14 font used when no font files can be loaded (WinAnsi only). */
class StandardFontHandle {
  readonly ref: PDFRef;
  private std: StdFont;
  readonly ascent: number;
  readonly descent: number;
  constructor(ctx: PDFContext, readonly key: string, readonly psName: string) {
    this.std = StdFont.load(psName as never);
    this.ascent = ((this.std.Ascender as number) || 718) / 1000;
    this.descent = ((this.std.Descender as number) || -207) / 1000;
    this.ref = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: psName, Encoding: 'WinAnsiEncoding' }));
  }
  layout(text: string): ShapedGlyph[] | null {
    const bytes = encodeWinAnsi(text);
    if (!bytes) return null;
    const chars = Array.from(text);
    return Array.from(bytes).map((code, i) => {
      const enc = (this.std as unknown as { getWidthOfGlyph(n: string): number | void });
      const name = winAnsiGlyphName(code);
      const w = (enc.getWidthOfGlyph(name) as number) || 500;
      return { code, len: 1, ax: w, w, dx: 0, dy: 0, text: chars[i], isSpace: code === 32 };
    });
  }
}

const winAnsiGlyphName = (code: number) => WinAnsiEncoding[code] || 'space';

export interface LayoutRequest {
  text: string;
  family?: string;
  bold?: boolean;
  italic?: boolean;
  /** Try to reuse this existing font first (keeps the original look). */
  existing?: { font: PdfFont; resName: string } | null;
  /** Base direction for bidi. */
  dir?: 'auto' | 'ltr' | 'rtl';
}

export interface LayoutResult {
  segments: Segment[];
  warnings: FontWarning[];
  /** Total advance in 1000ths of font size (excluding Tc). */
  advance: number;
  usedExisting: boolean;
  /** Set when the text should also be recorded as /ActualText (complex-script clusters). */
  actualText?: string;
}

export class FontManager {
  private faces = new Map<string, EmbeddedFont>();
  private std = new Map<string, StandardFontHandle>();
  private loading = new Map<string, Promise<EmbeddedFont | null>>();
  private failed = new Set<string>();
  private fallbackShaper: Shaper;

  constructor(private ctx: PDFContext, private loader: FontLoader | null, private shaper: Shaper | null, private subsetter: Subsetter | null = null) {
    this.fallbackShaper = createFontkitShaper((key) => this.faces.get(key)?.fk as never);
  }

  setContext(ctx: PDFContext) {
    this.ctx = ctx;
    this.faces.clear();
    this.std.clear();
    this.loading.clear();
  }

  get activeShaper(): Shaper {
    return this.shaper ?? this.fallbackShaper;
  }

  private faceDef(family: string, bold: boolean, italic: boolean): FontFaceDef | null {
    const cands = FONT_FACES.filter((f) => f.family === family);
    if (!cands.length) return null;
    const want = bold ? 700 : 400;
    return (
      cands.find((f) => f.weight === want && f.italic === italic) ??
      cands.find((f) => f.weight === want) ??
      cands.find((f) => f.italic === italic) ??
      cands[0]
    );
  }

  async face(family: string, bold = false, italic = false): Promise<EmbeddedFont | null> {
    const def = this.faceDef(family, bold, italic);
    if (!def || !this.loader) return null;
    const key = def.file;
    const existing = this.faces.get(key);
    if (existing) return existing;
    if (this.failed.has(key)) return null;
    let p = this.loading.get(key);
    if (!p) {
      p = (async () => {
        try {
          const bytes = await this.loader!(def.file);
          const f = new EmbeddedFont(this.ctx, key, def, bytes);
          this.faces.set(key, f);
          return f;
        } catch {
          this.failed.add(key);
          return null;
        }
      })();
      this.loading.set(key, p);
    }
    return p;
  }

  /** Register a user-uploaded font file under a custom family name. */
  registerCustomFont(family: string, bytes: Uint8Array): void {
    const def: FontFaceDef = { family, weight: 400, italic: false, file: `custom:${family}`, scripts: ['latin', 'common'], generic: 'sans' };
    if (!FONT_FACES.find((f) => f.file === def.file)) FONT_FACES.push(def);
    this.faces.set(def.file, new EmbeddedFont(this.ctx, def.file, def, bytes));
  }

  private standard(family: string, bold: boolean, italic: boolean): StandardFontHandle {
    const base = family === 'Tinos' ? 'Times' : family === 'Cousine' ? 'Courier' : 'Helvetica';
    let ps: string;
    if (base === 'Times') ps = bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
    else ps = `${base}${bold || italic ? '-' : ''}${bold ? 'Bold' : ''}${italic ? 'Oblique' : ''}`;
    let h = this.std.get(ps);
    if (!h) {
      h = new StandardFontHandle(this.ctx, ps, ps);
      this.std.set(ps, h);
    }
    return h;
  }

  /** Lay out a single line of text into font segments (visual order). */
  async layout(req: LayoutRequest): Promise<LayoutResult> {
    const warnings: FontWarning[] = [];
    const text = req.text;
    // 1. Try the original font (exact look, no new font needed).
    if (req.existing && !req.existing.font.isType3) {
      const enc = encodeWithExisting(req.existing.font, text);
      if (enc) {
        const advance = enc.reduce((s, g) => s + g.ax, 0);
        return {
          segments: [{ font: { kind: 'existing', resName: req.existing.resName, name: req.existing.font.baseFont, ascent: req.existing.font.ascent, descent: req.existing.font.descent }, glyphs: enc }],
          warnings,
          advance,
          usedExisting: true,
        };
      }
    }
    const family = req.family ?? (req.existing ? matchFamily(req.existing.font) : 'Arimo');
    const bold = req.bold ?? req.existing?.font.bold ?? false;
    const italic = req.italic ?? req.existing?.font.italic ?? false;
    if (req.existing) {
      warnings.push({
        original: req.existing.font.baseFont,
        substitute: family,
        reason: req.existing.font.isType3
          ? 'Type3 fonts cannot be re-encoded; text was re-set with a similar font.'
          : 'Some characters are not present in the embedded font subset; a similar font was embedded.',
      });
    }

    const primary = await this.face(family, bold, italic);
    if (!primary) {
      // No font files available: standard 14 fonts (WinAnsi only).
      const h = this.standard(family, bold, italic);
      const glyphs = h.layout(text);
      if (!glyphs) throw new Error('Text contains characters that require a Unicode font, but no font files could be loaded.');
      warnings.push({ original: req.existing?.font.baseFont ?? family, substitute: h.psName, reason: 'Font files unavailable; used a standard PDF font.' });
      return {
        segments: [{ font: { kind: 'new', ref: h.ref, key: h.key, name: h.psName, ascent: h.ascent, descent: h.descent }, glyphs }],
        warnings,
        advance: glyphs.reduce((s, g) => s + g.ax, 0),
        usedExisting: false,
      };
    }

    const segments: Segment[] = [];
    let needsActual = false;
    for (const run of bidiRuns(text, req.dir ?? 'auto')) {
      // Split by font coverage in logical order.
      const pieces: { face: EmbeddedFont; text: string }[] = [];
      let curFace: EmbeddedFont | null = null;
      let buf = '';
      for (const ch of run.text) {
        const cp = ch.codePointAt(0)!;
        let f: EmbeddedFont | null = null;
        const sc = scriptOf(cp);
        if (sc === 'common' && curFace && curFace.hasChar(cp)) f = curFace;
        else if (primary.hasChar(cp)) f = primary;
        else {
          const fam = SCRIPT_FAMILY[sc];
          const alt = fam ? await this.face(fam, bold, false) : null;
          if (alt && alt.hasChar(cp)) f = alt;
          else if (curFace && curFace.hasChar(cp)) f = curFace;
          else f = primary; // will render .notdef - better than dropping
          if (alt && f === alt && !warnings.some((w) => w.substitute === alt.face.family)) {
            warnings.push({ original: family, substitute: alt.face.family, reason: `Characters of script "${sc}" are rendered with ${alt.face.family}.` });
          }
        }
        if (f !== curFace && buf) {
          pieces.push({ face: curFace!, text: buf });
          buf = '';
        }
        curFace = f;
        buf += ch;
      }
      if (buf && curFace) pieces.push({ face: curFace, text: buf });
      const shaped = pieces.map((p) => {
        const r = p.face.shape(this.activeShaper, p.text, run.rtl);
        if (!r.exact) needsActual = true;
        return {
          font: { kind: 'new' as const, ref: p.face.ref, key: p.face.key, name: p.face.psName, ascent: p.face.ascent, descent: p.face.descent },
          glyphs: r.glyphs,
        };
      });
      if (run.rtl) shaped.reverse();
      segments.push(...shaped);
    }
    const advance = segments.reduce((s, seg) => s + seg.glyphs.reduce((a, g) => a + g.ax, 0), 0);
    if (bidiRuns(text, req.dir ?? 'auto').some((r) => r.rtl)) needsActual = true;
    return { segments: mergeSegments(segments), warnings, advance, usedExisting: false, actualText: needsActual ? text : undefined };
  }

  /** Measure text width in 1000ths of the font size. */
  async measure(req: LayoutRequest): Promise<number> {
    return (await this.layout(req)).advance;
  }

  async finalizeAll(): Promise<void> {
    for (const f of this.faces.values()) await f.finalize(this.ctx, this.subsetter);
  }
}

function mergeSegments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.font.kind === 'new' && s.font.kind === 'new' && last.font.key === s.font.key) last.glyphs.push(...s.glyphs);
    else out.push({ font: s.font, glyphs: [...s.glyphs] });
  }
  return out;
}

/**
 * Encode with an existing PDF font. Spaces that are not encodable are turned
 * into positioning gaps (common in PDFs that never encode a space glyph).
 */
export function encodeWithExisting(font: PdfFont, text: string): ShapedGlyph[] | null {
  const direct = font.encode(text);
  const toShaped = (gl: NonNullable<ReturnType<PdfFont['encode']>>['glyphs']): ShapedGlyph[] =>
    gl.map((g) => ({ code: g.code, len: g.len, ax: g.width, w: g.width, dx: 0, dy: 0, text: g.unicode, isSpace: g.isSpace }));
  if (direct) return toShaped(direct.glyphs);
  if (!text.includes(' ')) return null;
  const words = text.split(' ');
  const out: ShapedGlyph[] = [];
  const gap = font.monospace ? 600 : 278;
  for (let i = 0; i < words.length; i++) {
    if (i > 0) out.push({ code: -1, len: 0, ax: gap, w: 0, dx: 0, dy: 0, text: ' ', isSpace: false });
    if (!words[i]) continue;
    const e = font.encode(words[i]);
    if (!e) return null;
    out.push(...toShaped(e.glyphs));
  }
  return out;
}

