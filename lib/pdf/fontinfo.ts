/**
 * Reads fonts already present in a PDF: decodes character codes to Unicode
 * and widths, and checks whether new text can be re-encoded with the
 * embedded (possibly subset) font program.
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Font as StdFont } from '@pdf-lib/standard-fonts';
import { CMap } from './cmap';
import { encodingByName, glyphNameToUnicode, StandardEncoding, SymbolEncoding, WinAnsiEncoding, ZapfDingbatsEncoding } from './encodings';
import { asDict, dictGet, getDict, getName, getNumber, lookup, N, numArray, streamBytes } from './objects';
import type { FontSummary } from './types';

export interface DecodedGlyph {
  code: number;
  len: number;
  unicode: string;
  /** Horizontal displacement in glyph space * 1000 (i.e. text space units per 1000 font size). */
  width: number;
  /** True for single-byte code 32 (word spacing applies). */
  isSpace: boolean;
}

type FkFont = {
  numGlyphs: number;
  unitsPerEm: number;
  getGlyph(id: number): { path: { commands: unknown[] }; advanceWidth: number };
  characterToGlyph(cp: number): { id: number; path: { commands: unknown[] } };
};

const STANDARD_ALIASES: [RegExp, string][] = [
  [/^(Arial|Helvetica|ArialMT|Arimo|LiberationSans)/i, 'Helvetica'],
  [/^(Times|TimesNewRoman|Tinos|LiberationSerif)/i, 'Times'],
  [/^(Courier|CourierNew|Cousine|LiberationMono)/i, 'Courier'],
  [/^Symbol/i, 'Symbol'],
  [/^ZapfDingbats|^Dingbats/i, 'ZapfDingbats'],
];

export function standardFontFor(baseFont: string, bold: boolean, italic: boolean): string | null {
  const clean = baseFont.replace(/^[A-Z]{6}\+/, '');
  for (const [re, fam] of STANDARD_ALIASES) {
    if (!re.test(clean)) continue;
    if (fam === 'Symbol' || fam === 'ZapfDingbats') return fam;
    if (fam === 'Helvetica') return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica';
    if (fam === 'Courier') return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier';
    return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  }
  return null;
}

const stdCache = new Map<string, StdFont>();
function loadStd(name: string): StdFont {
  let f = stdCache.get(name);
  if (!f) {
    f = StdFont.load(name as never);
    stdCache.set(name, f);
  }
  return f;
}

export class PdfFont {
  subtype: string;
  baseFont: string;
  family: string;
  isType0: boolean;
  isType3: boolean;
  embedded = false;
  isSubset: boolean;
  bold = false;
  italic = false;
  serif = false;
  monospace = false;
  symbolic = false;
  ascent = 0.8;
  descent = -0.2;
  /** Type3 font matrix scale (glyph space -> text space). */
  type3Scale = 0.001;
  vertical = false;

  private cmap: CMap | null = null;
  private toUni: CMap | null = null;
  private encoding: string[] = [];
  private differences = new Set<number>();
  private simpleWidths = new Map<number, number>();
  private missingWidth = 0;
  private cidWidths = new Map<number, number>();
  private dw = 1000;
  private std: StdFont | null = null;
  private fk: FkFont | null = null;
  private cidToGid: Uint8Array | null = null;
  private reverse: Map<string, { code: number; len: number }> | null = null;
  readonly usedCodes = new Set<number>();
  warnings: string[] = [];

  constructor(private ctx: PDFContext, public dict: PDFDict, public resourceName: string, public ref?: PDFRef) {
    this.subtype = getName(ctx, dict, 'Subtype') ?? 'Type1';
    this.baseFont = getName(ctx, dict, 'BaseFont') ?? (this.subtype === 'Type3' ? 'Type3' : 'Unknown');
    this.isSubset = /^[A-Z]{6}\+/.test(this.baseFont);
    this.isType0 = this.subtype === 'Type0';
    this.isType3 = this.subtype === 'Type3';
    this.family = this.baseFont.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0];
    try {
      this.init();
    } catch (e) {
      this.warnings.push(`Font ${this.baseFont}: ${(e as Error).message}`);
    }
  }

  private init() {
    const ctx = this.ctx;
    let descDict: PDFDict | undefined;
    let descendant: PDFDict | undefined;
    if (this.isType0) {
      const desc = dictGet(ctx, this.dict, 'DescendantFonts');
      const arr = desc instanceof PDFArray ? desc : undefined;
      descendant = arr ? asDict(lookup(ctx, arr.get(0))) : undefined;
      descDict = getDict(ctx, descendant, 'FontDescriptor');
      // Encoding CMap
      const enc = dictGet(ctx, this.dict, 'Encoding');
      if (enc instanceof PDFName) this.cmap = CMap.predefined(enc.decodeText());
      else if (enc instanceof PDFStream) this.cmap = new CMap().parse(streamBytes(enc));
      else this.cmap = CMap.identity();
      this.vertical = this.cmap.vertical;
      // Widths
      this.dw = getNumber(ctx, descendant, 'DW', 1000);
      const w = dictGet(ctx, descendant, 'W');
      if (w instanceof PDFArray) this.parseCidWidths(w);
      // CIDToGIDMap
      const c2g = dictGet(ctx, descendant, 'CIDToGIDMap');
      if (c2g instanceof PDFStream) this.cidToGid = streamBytes(c2g);
    } else {
      descDict = getDict(ctx, this.dict, 'FontDescriptor');
      const first = getNumber(ctx, this.dict, 'FirstChar', 0);
      const widths = numArray(ctx, this.dict.get(N('Widths')));
      widths.forEach((w, i) => this.simpleWidths.set(first + i, w));
      this.missingWidth = getNumber(ctx, descDict, 'MissingWidth', 0);
      if (this.isType3) {
        const fm = numArray(ctx, this.dict.get(N('FontMatrix')));
        if (fm.length === 6) this.type3Scale = fm[0];
      }
    }

    // Descriptor / style flags
    const flags = getNumber(ctx, descDict, 'Flags', 0);
    const weight = getNumber(ctx, descDict, 'FontWeight', 400);
    const italicAngle = getNumber(ctx, descDict, 'ItalicAngle', 0);
    const name = this.baseFont;
    this.monospace = (flags & 1) !== 0 || /courier|mono|consol|cousine/i.test(name);
    this.serif = ((flags & 2) !== 0 || /times|serif|roman|georgia|garamond|minion|cambria|palatino|tinos|book/i.test(name)) && !/sans/i.test(name);
    this.symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
    this.italic = (flags & 64) !== 0 || italicAngle !== 0 || /italic|oblique/i.test(name);
    this.bold = weight >= 600 || (flags & 262144) !== 0 || /bold|black|heavy|semibold|demi/i.test(name);
    const asc = getNumber(ctx, descDict, 'Ascent', 0);
    const des = getNumber(ctx, descDict, 'Descent', 0);
    if (asc > 0) this.ascent = asc / 1000;
    if (des < 0) this.descent = des / 1000;
    if (this.isType3) {
      this.ascent = 0.8;
      this.descent = -0.2;
    }

    // Embedded program
    const ff2 = dictGet(ctx, descDict, 'FontFile2');
    const ff3 = dictGet(ctx, descDict, 'FontFile3');
    const ff1 = dictGet(ctx, descDict, 'FontFile');
    this.embedded = !!(ff1 || ff2 || ff3) || this.isType3;
    const prog = ff2 instanceof PDFStream ? ff2 : ff3 instanceof PDFStream && getName(ctx, ff3.dict, 'Subtype') === 'OpenType' ? ff3 : null;
    if (prog) {
      try {
        this.fk = fontkit.create(streamBytes(prog) as never) as unknown as FkFont;
      } catch {
        this.fk = null;
      }
    }

    // ToUnicode
    const tu = dictGet(ctx, this.dict, 'ToUnicode');
    if (tu instanceof PDFStream) {
      try {
        this.toUni = new CMap().parse(streamBytes(tu));
      } catch {
        this.toUni = null;
      }
    }

    if (!this.isType0) this.initSimpleEncoding();
    if (!this.embedded && !this.isType0) {
      const stdName = standardFontFor(this.baseFont, this.bold, this.italic);
      if (stdName) this.std = loadStd(stdName);
    }
  }

  private initSimpleEncoding() {
    const ctx = this.ctx;
    const enc = dictGet(ctx, this.dict, 'Encoding');
    const fam = this.family.toLowerCase();
    let base: string[] | null = null;
    if (fam.startsWith('symbol')) base = SymbolEncoding;
    else if (fam.includes('dingbats')) base = ZapfDingbatsEncoding;
    let diffs: PDFArray | undefined;
    if (enc instanceof PDFName) base = encodingByName(enc.decodeText()) ?? base;
    else if (enc instanceof PDFDict) {
      base = encodingByName(getName(ctx, enc, 'BaseEncoding')) ?? base;
      const d = dictGet(ctx, enc, 'Differences');
      if (d instanceof PDFArray) diffs = d;
    }
    if (!base) base = this.subtype === 'TrueType' && !this.symbolic ? WinAnsiEncoding : StandardEncoding;
    this.encoding = base.slice();
    if (diffs) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const v = lookup(ctx, diffs.get(i));
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) {
          this.encoding[code] = v.decodeText();
          this.differences.add(code);
          code++;
        }
      }
    }
  }

  private parseCidWidths(w: PDFArray) {
    const ctx = this.ctx;
    let i = 0;
    while (i < w.size()) {
      const first = lookup(ctx, w.get(i));
      const second = lookup(ctx, w.get(i + 1));
      if (!(first instanceof PDFNumber)) break;
      if (second instanceof PDFArray) {
        const start = first.asNumber();
        for (let j = 0; j < second.size(); j++) {
          const x = lookup(ctx, second.get(j));
          if (x instanceof PDFNumber) this.cidWidths.set(start + j, x.asNumber());
        }
        i += 2;
      } else {
        const last = lookup(ctx, w.get(i + 1));
        const wv = lookup(ctx, w.get(i + 2));
        if (last instanceof PDFNumber && wv instanceof PDFNumber) {
          const lo = first.asNumber();
          const hi = Math.min(last.asNumber(), lo + 0xffff);
          for (let c = lo; c <= hi; c++) this.cidWidths.set(c, wv.asNumber());
        }
        i += 3;
      }
    }
  }

  private simpleUnicode(code: number): string {
    const t = this.toUni?.toUnicode(code, 1);
    if (t !== undefined) return t;
    const gname = this.encoding[code];
    if (gname) {
      const u = glyphNameToUnicode(gname);
      if (u) return u;
    }
    if (this.symbolic && code >= 32) return String.fromCharCode(code);
    return code >= 32 && code < 127 ? String.fromCharCode(code) : '';
  }

  private simpleWidth(code: number): number {
    let w = this.simpleWidths.get(code);
    if (w === undefined) {
      if (this.std) {
        const g = this.encoding[code] || 'space';
        const sw = this.std.getWidthOfGlyph(g);
        w = typeof sw === 'number' ? sw : this.missingWidth || 500;
      } else w = this.missingWidth || (this.simpleWidths.size ? 0 : 500);
    }
    if (this.isType3) return w * this.type3Scale * 1000;
    return w;
  }

  private cidWidth(cid: number): number {
    return this.cidWidths.get(cid) ?? this.dw;
  }

  decode(bytes: Uint8Array): DecodedGlyph[] {
    const out: DecodedGlyph[] = [];
    if (this.isType0 && this.cmap) {
      for (const { code, len } of this.cmap.codes(bytes)) {
        const cid = this.cmap.toCID(code, len);
        let u = this.toUni?.toUnicode(code, len);
        if (u === undefined && this.cmap.codeIsUnicode) u = String.fromCharCode(code);
        this.usedCodes.add(code);
        out.push({ code, len, unicode: u ?? '', width: this.cidWidth(cid), isSpace: len === 1 && code === 32 });
      }
      return out;
    }
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes[i];
      this.usedCodes.add(code);
      out.push({ code, len: 1, unicode: this.simpleUnicode(code), width: this.simpleWidth(code), isSpace: code === 32 });
    }
    return out;
  }

  /** Width (1000 units) for a code; used when re-encoding. */
  widthOf(code: number, len: number): number {
    if (this.isType0 && this.cmap) return this.cidWidth(this.cmap.toCID(code, len));
    return this.simpleWidth(code);
  }

  private reverseMap(): Map<string, { code: number; len: number }> {
    if (this.reverse) return this.reverse;
    const rev = this.toUni ? this.toUni.reverseUnicode() : new Map<string, { code: number; len: number }>();
    if (!this.isType0) {
      for (let c = 0; c < 256; c++) {
        const n = this.encoding[c];
        if (!n) continue;
        const u = glyphNameToUnicode(n);
        if (u && !rev.has(u)) rev.set(u, { code: c, len: 1 });
      }
    } else if (this.cmap?.codeIsUnicode && !this.toUni) {
      // Codes are UTF-16; reverse is trivial and handled in encode().
    }
    this.reverse = rev;
    return rev;
  }

  private glyphPresent(code: number, len: number, unicode: string): boolean {
    if (this.isType3) return false;
    if (/^\s$/.test(unicode)) return true;
    if (this.fk) {
      try {
        if (this.isType0) {
          const cid = this.cmap!.toCID(code, len);
          let gid = cid;
          if (this.cidToGid && this.cidToGid.length >= cid * 2 + 2) gid = (this.cidToGid[cid * 2] << 8) | this.cidToGid[cid * 2 + 1];
          if (gid <= 0 || gid >= this.fk.numGlyphs) return false;
          return this.fk.getGlyph(gid).path.commands.length > 0;
        }
        const cands = [unicode.codePointAt(0) ?? -1, 0xf000 + code, code];
        for (const cp of cands) {
          if (cp < 0) continue;
          const g = this.fk.characterToGlyph(cp);
          if (g && g.id > 0 && g.path.commands.length > 0) return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    if (!this.embedded) return this.widthOf(code, len) > 0;
    // Embedded Type1 / bare CFF: we cannot inspect outlines; rely on evidence of use.
    if (!this.isSubset) return this.widthOf(code, len) > 0;
    return this.usedCodes.has(code) || this.differences.has(code);
  }

  /**
   * Encode text with this font. Returns null if any character cannot be
   * encoded or its glyph is missing from the embedded subset.
   */
  encode(text: string): { bytes: Uint8Array; glyphs: DecodedGlyph[] } | null {
    if (this.isType3) return null;
    const rev = this.reverseMap();
    const out: number[] = [];
    const glyphs: DecodedGlyph[] = [];
    const chars = Array.from(text);
    let i = 0;
    while (i < chars.length) {
      let found: { code: number; len: number } | undefined;
      let used = 1;
      for (let n = Math.min(3, chars.length - i); n >= 1; n--) {
        const s = chars.slice(i, i + n).join('');
        const e = rev.get(s);
        if (e) {
          found = e;
          used = n;
          break;
        }
      }
      const s = chars.slice(i, i + used).join('');
      if (!found && this.isType0 && this.cmap?.codeIsUnicode && !this.toUni) {
        const cp = s.charCodeAt(0);
        found = { code: cp, len: 2 };
      }
      if (!found && !this.isType0 && s === ' ' ) found = { code: 32, len: 1 };
      if (!found) return null;
      if (!this.glyphPresent(found.code, found.len, s)) return null;
      for (let b = found.len - 1; b >= 0; b--) out.push((found.code >> (8 * b)) & 0xff);
      glyphs.push({ code: found.code, len: found.len, unicode: s, width: this.widthOf(found.code, found.len), isSpace: found.len === 1 && found.code === 32 });
      i += used;
    }
    return { bytes: Uint8Array.from(out), glyphs };
  }

  summary(): FontSummary {
    return {
      resourceName: this.resourceName,
      baseFont: this.baseFont,
      family: this.family,
      subtype: this.subtype,
      embedded: this.embedded,
      bold: this.bold,
      italic: this.italic,
      serif: this.serif,
      monospace: this.monospace,
      type3: this.isType3,
    };
  }
}

/** Per-document cache of PdfFont objects keyed by font dict identity. */
export class FontCache {
  private byRef = new Map<string, PdfFont>();
  private byDict = new WeakMap<PDFDict, PdfFont>();
  constructor(private ctx: PDFContext) {}

  get(fontObj: unknown, resourceName: string): PdfFont | null {
    let ref: PDFRef | undefined;
    let dict: PDFDict | undefined;
    if (fontObj instanceof PDFRef) {
      ref = fontObj;
      const key = `${ref.objectNumber}_${ref.generationNumber}`;
      const c = this.byRef.get(key);
      if (c) return c;
      dict = asDict(this.ctx.lookup(ref));
    } else dict = asDict(fontObj as never);
    if (!dict) return null;
    const cached = this.byDict.get(dict);
    if (cached) return cached;
    const f = new PdfFont(this.ctx, dict, resourceName, ref);
    this.byDict.set(dict, f);
    if (ref) this.byRef.set(`${ref.objectNumber}_${ref.generationNumber}`, f);
    return f;
  }

  clear() {
    this.byRef.clear();
    this.byDict = new WeakMap();
  }
}
