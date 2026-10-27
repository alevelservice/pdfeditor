/**
 * Simple-font encodings (Standard, WinAnsi, MacRoman, Symbol, ZapfDingbats)
 * and an Adobe Glyph List subset for glyph-name -> Unicode resolution.
 */
import { Encodings } from '@pdf-lib/standard-fonts';

type Mapping = Record<number, [number, string]>;

function fromStdFonts(enc: { unicodeMappings?: Mapping }): { names: string[]; unicode: number[] } {
  const m = (enc as unknown as { unicodeMappings: Mapping }).unicodeMappings;
  const names: string[] = new Array(256).fill('');
  const unicode: number[] = new Array(256).fill(0);
  for (const [uStr, [code, glyph]] of Object.entries(m)) {
    const u = Number(uStr);
    if (!names[code] || u < unicode[code]) {
      names[code] = glyph;
      unicode[code] = u;
    }
  }
  return { names, unicode };
}

const WIN = fromStdFonts(Encodings.WinAnsi as never);
const SYMBOL = fromStdFonts(Encodings.Symbol as never);
const DINGBATS = fromStdFonts(Encodings.ZapfDingbats as never);

const ASCII_NAMES: string[] = (() => {
  const n: string[] = new Array(128).fill('');
  for (let c = 32; c < 127; c++) n[c] = WIN.names[c];
  return n;
})();

const STANDARD_HIGH: Record<number, string> = {
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin', 167: 'section',
  168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft', 172: 'guilsinglleft',
  173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash', 178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered',
  182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase', 185: 'quotedblbase', 186: 'quotedblright',
  187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand', 191: 'questiondown', 193: 'grave', 194: 'acute',
  195: 'circumflex', 196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring',
  203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE', 227: 'ordfeminine',
  232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash',
  249: 'oslash', 250: 'oe', 251: 'germandbls',
};

const MAC_HIGH = (
  'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ' +
  'ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ' +
  'ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet ' +
  'paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus ' +
  'lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae ' +
  'oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ' +
  'ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright ' +
  'divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl ' +
  'periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave ' +
  'Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi ' +
  'circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron'
).split(' ');

export const StandardEncoding: string[] = (() => {
  const n = new Array(256).fill('');
  for (let c = 0; c < 128; c++) n[c] = ASCII_NAMES[c];
  n[39] = 'quoteright';
  n[96] = 'quoteleft';
  for (const [c, g] of Object.entries(STANDARD_HIGH)) n[Number(c)] = g;
  return n;
})();

export const WinAnsiEncoding: string[] = WIN.names;

export const MacRomanEncoding: string[] = (() => {
  const n = new Array(256).fill('');
  for (let c = 0; c < 128; c++) n[c] = ASCII_NAMES[c];
  n[39] = 'quotesingle';
  n[96] = 'grave';
  MAC_HIGH.forEach((g, i) => (n[128 + i] = g));
  return n;
})();

export const SymbolEncoding: string[] = SYMBOL.names;
export const ZapfDingbatsEncoding: string[] = DINGBATS.names;

export function encodingByName(name: string | undefined): string[] | null {
  switch (name) {
    case 'WinAnsiEncoding': return WinAnsiEncoding;
    case 'MacRomanEncoding': return MacRomanEncoding;
    case 'StandardEncoding': return StandardEncoding;
    case 'MacExpertEncoding': return StandardEncoding;
    case 'Symbol': return SymbolEncoding;
    case 'ZapfDingbats': return ZapfDingbatsEncoding;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Glyph names -> Unicode
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, number> = {};
const addMapping = (m: Mapping) => {
  for (const [uStr, [, glyph]] of Object.entries(m)) {
    const u = Number(uStr);
    if (GLYPHS[glyph] === undefined || (glyph === 'space' && u === 32)) GLYPHS[glyph] = u;
  }
};
addMapping((Encodings.WinAnsi as unknown as { unicodeMappings: Mapping }).unicodeMappings);
addMapping((Encodings.Symbol as unknown as { unicodeMappings: Mapping }).unicodeMappings);
addMapping((Encodings.ZapfDingbats as unknown as { unicodeMappings: Mapping }).unicodeMappings);
GLYPHS.space = 32;

Object.assign(GLYPHS, {
  fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, fraction: 0x2044, dotlessi: 0x0131, dotlessj: 0x0237,
  Lslash: 0x0141, lslash: 0x0142, quotesingle: 0x27, quoteright: 0x2019, quoteleft: 0x2018, ring: 0x02da,
  breve: 0x02d8, dotaccent: 0x02d9, hungarumlaut: 0x02dd, ogonek: 0x02db, caron: 0x02c7, circumflex: 0x02c6,
  tilde: 0x02dc, notequal: 0x2260, infinity: 0x221e, lessequal: 0x2264, greaterequal: 0x2265, partialdiff: 0x2202,
  summation: 0x2211, product: 0x220f, pi: 0x03c0, integral: 0x222b, Omega: 0x2126, radical: 0x221a,
  approxequal: 0x2248, Delta: 0x2206, lozenge: 0x25ca, apple: 0xf8ff, mu: 0x00b5, minus: 0x2212,
  nbspace: 0x00a0, nonbreakingspace: 0x00a0, sfthyphen: 0x00ad, softhyphen: 0x00ad, Euro: 0x20ac, euro: 0x20ac,
  hyphen: 0x2d, grave: 0x60, macron: 0xaf, periodcentered: 0xb7, bullet: 0x2022, ellipsis: 0x2026,
  endash: 0x2013, emdash: 0x2014, trademark: 0x2122, registered: 0xae, copyright: 0xa9, degree: 0xb0,
  Gbreve: 0x011e, gbreve: 0x011f, Idotaccent: 0x0130, Scedilla: 0x015e, scedilla: 0x015f, Zcaron: 0x017d,
  zcaron: 0x017e, Scaron: 0x0160, scaron: 0x0161, Ccaron: 0x010c, ccaron: 0x010d, Ecaron: 0x011a, ecaron: 0x011b,
  Rcaron: 0x0158, rcaron: 0x0159, Uring: 0x016e, uring: 0x016f, Aogonek: 0x0104, aogonek: 0x0105,
  Eogonek: 0x0118, eogonek: 0x0119, Nacute: 0x0143, nacute: 0x0144, Sacute: 0x015a, sacute: 0x015b,
  Zacute: 0x0179, zacute: 0x017a, Zdotaccent: 0x017b, zdotaccent: 0x017c, Cacute: 0x0106, cacute: 0x0107,
  Ohungarumlaut: 0x0150, ohungarumlaut: 0x0151, Uhungarumlaut: 0x0170, uhungarumlaut: 0x0171,
  Amacron: 0x0100, amacron: 0x0101, Emacron: 0x0112, emacron: 0x0113, Imacron: 0x012a, imacron: 0x012b,
  Omacron: 0x014c, omacron: 0x014d, Umacron: 0x016a, umacron: 0x016b, Dcroat: 0x0110, dcroat: 0x0111,
  Dcaron: 0x010e, dcaron: 0x010f, Tcaron: 0x0164, tcaron: 0x0165, Lcaron: 0x013d, lcaron: 0x013e,
  Lacute: 0x0139, lacute: 0x013a, Racute: 0x0154, racute: 0x0155, Ncaron: 0x0147, ncaron: 0x0148,
  Tcommaaccent: 0x0162, tcommaaccent: 0x0163, Scommaaccent: 0x0218, scommaaccent: 0x0219,
  Gcommaaccent: 0x0122, gcommaaccent: 0x0123, Kcommaaccent: 0x0136, kcommaaccent: 0x0137,
  Lcommaaccent: 0x013b, lcommaaccent: 0x013c, Ncommaaccent: 0x0145, ncommaaccent: 0x0146,
  Rcommaaccent: 0x0156, rcommaaccent: 0x0157, Iogonek: 0x012e, iogonek: 0x012f, Uogonek: 0x0172, uogonek: 0x0173,
  Edotaccent: 0x0116, edotaccent: 0x0117, commaaccent: 0xf6c3, arrowleft: 0x2190, arrowright: 0x2192,
  arrowup: 0x2191, arrowdown: 0x2193, checkmark: 0x2713, onehalf: 0xbd, onequarter: 0xbc, threequarters: 0xbe,
  dollar: 0x24, at: 0x40, numbersign: 0x23, percent: 0x25, ampersand: 0x26,
  Alpha: 0x0391, Beta: 0x0392, Gamma: 0x0393, Epsilon: 0x0395, Zeta: 0x0396, Eta: 0x0397, Theta: 0x0398,
  Iota: 0x0399, Kappa: 0x039a, Lambda: 0x039b, Mu: 0x039c, Nu: 0x039d, Xi: 0x039e, Omicron: 0x039f, Pi: 0x03a0,
  Rho: 0x03a1, Sigma: 0x03a3, Tau: 0x03a4, Upsilon: 0x03a5, Phi: 0x03a6, Chi: 0x03a7, Psi: 0x03a8,
  alpha: 0x03b1, beta: 0x03b2, gamma: 0x03b3, delta: 0x03b4, epsilon: 0x03b5, zeta: 0x03b6, eta: 0x03b7,
  theta: 0x03b8, iota: 0x03b9, kappa: 0x03ba, lambda: 0x03bb, nu: 0x03bd, xi: 0x03be, omicron: 0x03bf,
  rho: 0x03c1, sigma: 0x03c3, sigma1: 0x03c2, tau: 0x03c4, upsilon: 0x03c5, phi: 0x03c6, chi: 0x03c7,
  psi: 0x03c8, omega: 0x03c9,
});

/** Resolve a glyph name to a Unicode string ('' when unknown). */
export function glyphNameToUnicode(name: string): string {
  if (!name) return '';
  const direct = GLYPHS[name];
  if (direct !== undefined) return String.fromCodePoint(direct);
  // Strip suffixes like "a.sc", "one.oldstyle"
  const dot = name.indexOf('.');
  if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));
  // Ligatures "f_f_i"
  if (name.includes('_')) return name.split('_').map(glyphNameToUnicode).join('');
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) {
    let s = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    if (cp <= 0x10ffff) return String.fromCodePoint(cp);
  }
  if (name.length === 1) return name;
  // gXX / cidXX / aXX / GXX numeric names cannot be resolved without context.
  return '';
}

/** Reverse lookup Unicode -> glyph name (for building Differences). */
export function unicodeToGlyphName(cp: number): string {
  for (const [k, v] of Object.entries(GLYPHS)) if (v === cp) return k;
  return 'uni' + cp.toString(16).toUpperCase().padStart(4, '0');
}

export const WinAnsiUnicode: number[] = WIN.unicode;

/** Encode a string into WinAnsi bytes, or null if a character is not encodable. */
export function encodeWinAnsi(text: string): Uint8Array | null {
  const out: number[] = [];
  const m = (Encodings.WinAnsi as unknown as { unicodeMappings: Mapping }).unicodeMappings;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const e = m[cp];
    if (!e) return null;
    out.push(e[0]);
  }
  return Uint8Array.from(out);
}
